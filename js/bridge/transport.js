import { BUFFER_LOW_WATER_MARK } from './chunks.js';

const OFFER_STUCK_TIMEOUT_MS = 9000;
const READY_SIGNAL_COOLDOWN_MS = 1500;
const RECONNECT_DELAY_MS = 800;

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  {
    urls: 'turn:global.relay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:global.relay.metered.ca:80?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:global.relay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turns:global.relay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

function describeError(error, fallbackMessage) {
  return error instanceof Error ? error.message : fallbackMessage;
}

export class WebRtcTransport extends EventTarget {
  constructor({ signaling, iceServers = DEFAULT_ICE_SERVERS } = {}) {
    super();
    this.signaling = signaling;
    this.iceServers = iceServers;
    this.peerConnection = null;
    this.dataChannel = null;
    this.sessionInfo = null;
    this.role = null;
    this.negotiationStarted = false;
    this.offerStuckTimer = null;
    this.lastReadySignalAt = 0;
    this.restartingHost = false;
    this.reconnecting = false;
    this.disconnecting = false;
    this.reconnectTimer = null;
    this.pendingRemoteCandidates = [];
    this.connectionStartedAt = 0;

    this.handleSignalingMessage = this.handleSignalingMessage.bind(this);
    this.handleSignalingStreamError = this.handleSignalingStreamError.bind(this);
  }

  async host(sessionInfo) {
    this.sessionInfo = { ...sessionInfo, role: 'host' };
    this.role = 'host';
    this.createPeerConnection();
    this.connectionStartedAt = Date.now();
    this.bindSignaling();

    const dataChannel = this.peerConnection.createDataChannel('dbridgr', {
      ordered: true,
    });
    this.setupDataChannel(dataChannel);
    this.signaling.connectStream(this.sessionInfo);
    this.emitState('hosting');
  }

  async join(sessionInfo) {
    this.sessionInfo = { ...sessionInfo, role: 'guest' };
    this.role = 'guest';
    this.createPeerConnection();
    this.connectionStartedAt = Date.now();
    this.bindSignaling();

    this.peerConnection.ondatachannel = (event) => {
      this.setupDataChannel(event.channel);
    };

    this.signaling.connectStream(this.sessionInfo);
    void this.sendReadySignal(true);
    this.emitState('joining');
  }

  createPeerConnection() {
    this.peerConnection = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pendingRemoteCandidates = [];

    this.peerConnection.onicecandidate = (event) => {
      if (!event.candidate || !this.sessionInfo) {
        return;
      }
      this.signaling.send(this.sessionInfo.code, this.sessionInfo.clientId, 'ice', event.candidate).catch((error) => {
        this.reportError(error, 'Could not send an ICE candidate.');
      });
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (!this.peerConnection) {
        return;
      }
      const connectionState = this.peerConnection.connectionState || 'new';
      if (connectionState === 'disconnected' || connectionState === 'failed' || connectionState === 'closed') {
        if (!this.disconnecting && this.sessionInfo) {
          void this.scheduleReconnect();
          return;
        }
      }
      if (connectionState === 'connected' && !this.isOpen()) {
        this.emitState('connecting');
        return;
      }
      this.emitState(connectionState);
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      if (!this.peerConnection) {
        return;
      }

      const iceState = this.peerConnection.iceConnectionState;
      if ((iceState === 'failed' || iceState === 'disconnected') && this.sessionInfo && !this.disconnecting) {
        void this.scheduleReconnect();
        return;
      }
    };
  }

  bindSignaling() {
    this.signaling.addEventListener('message', this.handleSignalingMessage);
    this.signaling.addEventListener('stream-error', this.handleSignalingStreamError);
  }

  unbindSignaling() {
    this.signaling.removeEventListener('message', this.handleSignalingMessage);
    this.signaling.removeEventListener('stream-error', this.handleSignalingStreamError);
  }

  setupDataChannel(channel) {
    this.dataChannel = channel;
    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.bufferedAmountLowThreshold = BUFFER_LOW_WATER_MARK;

    this.dataChannel.onopen = () => {
      this.clearOfferStuckTimer();
      this.reconnecting = false;
      this.dispatchEvent(new CustomEvent('open'));
      this.emitState('connected');
    };

    this.dataChannel.onclose = () => {
      this.dispatchEvent(new CustomEvent('closed'));
      if (this.sessionInfo && !this.disconnecting) {
        this.emitState('reconnecting');
      }
      this.emitState(this.peerConnection?.connectionState || 'closed');
    };

    this.dataChannel.onerror = () => {
      this.reportError(new Error('The data channel reported an error.'), 'The data channel reported an error.');
    };

    this.dataChannel.onmessage = (event) => {
      this.dispatchEvent(new CustomEvent('message', { detail: event.data }));
    };
  }

  async handleSignalingMessage(event) {
    const payload = event.detail;

    if (this.isStaleSignal(payload)) {
      return;
    }

    try {
      switch (payload.type) {
      case 'ready': {
        if (payload.from !== 'guest' || this.role !== 'host') {
          return;
        }
        if (this.needsInitialOffer() && !this.negotiationStarted) {
          await this.createAndSendOffer();
          return;
        }
        if (this.shouldRestartHostNegotiation()) {
          await this.restartConnection();
        }
        return;
      }
      case 'peer-state':
        this.dispatchEvent(new CustomEvent('peer-state', {
          detail: {
            ...payload,
            peerPresent: this.role === 'host' ? payload.guestPresent : payload.hostPresent,
          },
        }));
        if (this.role === 'host' && payload.guestPresent && this.needsInitialOffer() && !this.negotiationStarted) {
          await this.createAndSendOffer();
        }
        if (this.role === 'guest' && payload.hostPresent && !this.isOpen()) {
          void this.sendReadySignal();
        }
        return;
      case 'offer':
        await this.handleOffer(payload.data);
        return;
      case 'answer':
        await this.handleAnswer(payload.data);
        return;
      case 'ice':
        await this.handleIceCandidate(payload.data);
        return;
      case 'session-ended':
        this.dispatchEvent(new CustomEvent('session-ended', { detail: payload }));
        return;
      default:
        return;
      }
    } catch (error) {
      this.reportError(error, 'Failed to process a signaling message.');
    }
  }

  handleSignalingStreamError(event) {
    this.dispatchEvent(new CustomEvent('stream-warning', { detail: event.detail }));
  }

  async createAndSendOffer(options = {}) {
    if (!this.peerConnection || !this.sessionInfo || this.negotiationStarted) {
      return;
    }
    if (this.peerConnection.signalingState !== 'stable' || this.peerConnection.localDescription) {
      return;
    }

    this.negotiationStarted = true;
    try {
      const offer = await this.peerConnection.createOffer(options);
      await this.peerConnection.setLocalDescription(offer);
      await this.signaling.send(
        this.sessionInfo.code,
        this.sessionInfo.clientId,
        'offer',
        this.peerConnection.localDescription || offer
      );
      this.armOfferStuckTimer();
    } catch (error) {
      this.negotiationStarted = false;
      const message = describeError(error, 'Could not create the connection offer.');
      if (this.role === 'host' && /m-lines/i.test(message)) {
        await this.restartConnection();
        return;
      }
      this.reportError(error, 'Could not create the connection offer.');
    }
  }

  async handleOffer(offer) {
    if (!this.peerConnection || this.role !== 'guest') {
      return;
    }

    try {
      if (this.peerConnection.signalingState === 'have-local-offer') {
        await this.peerConnection.setLocalDescription({ type: 'rollback' });
      }
      await this.peerConnection.setRemoteDescription(offer);
      await this.flushPendingRemoteCandidates();
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      await this.signaling.send(this.sessionInfo.code, this.sessionInfo.clientId, 'answer', answer);
    } catch (error) {
      this.reportError(error, 'Could not answer the bridge offer.');
    }
  }

  async handleAnswer(answer) {
    if (!this.peerConnection || this.role !== 'host' || this.peerConnection.signalingState !== 'have-local-offer') {
      return;
    }

    try {
      await this.peerConnection.setRemoteDescription(answer);
      await this.flushPendingRemoteCandidates();
      this.negotiationStarted = false;
      this.clearOfferStuckTimer();
    } catch (error) {
      this.reportError(error, 'Could not finalize the bridge connection.');
    }
  }

  async sendReadySignal(force = false) {
    if (!this.sessionInfo || this.role !== 'guest') {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastReadySignalAt < READY_SIGNAL_COOLDOWN_MS) {
      return;
    }

    this.lastReadySignalAt = now;

    try {
      await this.signaling.send(this.sessionInfo.code, this.sessionInfo.clientId, 'ready', {
        at: now,
      });
    } catch {
      // Ready ping is best effort; polling will retry naturally.
    }
  }

  async sendControl(type, data) {
    if (!this.sessionInfo) {
      return;
    }

    return this.signaling.send(this.sessionInfo.code, this.sessionInfo.clientId, type, data);
  }

  isStaleSignal(payload) {
    return Boolean(
      payload?.sentAt
      && this.connectionStartedAt
      && payload.sentAt < this.connectionStartedAt
      && payload.type !== 'peer-state'
      && payload.type !== 'session-ended'
    );
  }

  shouldRestartHostNegotiation() {
    return Boolean(
      this.role === 'host'
      && this.peerConnection
      && this.sessionInfo
      && this.peerConnection.signalingState === 'stable'
      && (this.peerConnection.localDescription || this.peerConnection.currentRemoteDescription)
    );
  }

  async scheduleReconnect() {
    if (!this.sessionInfo || this.disconnecting) {
      return;
    }

    this.reconnecting = true;
    this.emitState('reconnecting');

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.restartConnection();
    }, RECONNECT_DELAY_MS);
  }

  armOfferStuckTimer() {
    this.clearOfferStuckTimer();
    this.offerStuckTimer = window.setTimeout(() => {
      if (!this.peerConnection || !this.sessionInfo || this.role !== 'host' || this.isOpen()) {
        return;
      }

      // If answer never arrived, rebuild and retry from a fresh RTCPeerConnection.
      if (!this.peerConnection.currentRemoteDescription) {
        void this.restartHostNegotiation();
      }
    }, OFFER_STUCK_TIMEOUT_MS);
  }

  needsInitialOffer() {
    return Boolean(
      this.role === 'host'
      && this.peerConnection
      && this.sessionInfo
      && !this.isOpen()
      && this.peerConnection.signalingState === 'stable'
      && !this.peerConnection.localDescription
      && !this.peerConnection.currentRemoteDescription
    );
  }

  clearOfferStuckTimer() {
    if (this.offerStuckTimer !== null) {
      window.clearTimeout(this.offerStuckTimer);
      this.offerStuckTimer = null;
    }
  }

  async restartConnection() {
    if (!this.sessionInfo || this.disconnecting || this.restartingHost) {
      return;
    }

    this.restartingHost = true;
    this.reconnecting = false;
    this.clearOfferStuckTimer();
    this.negotiationStarted = false;
    this.pendingRemoteCandidates = [];

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      if (this.dataChannel) {
        this.dataChannel.close();
        this.dataChannel = null;
      }

      if (this.peerConnection) {
        this.peerConnection.close();
        this.peerConnection = null;
      }

      this.createPeerConnection();
      this.connectionStartedAt = Date.now();
      this.signaling.connectStream(this.sessionInfo);

      if (this.role === 'host') {
        const dataChannel = this.peerConnection.createDataChannel('dbridgr', {
          ordered: true,
        });
        this.setupDataChannel(dataChannel);
        await this.createAndSendOffer();
        return;
      }

      this.peerConnection.ondatachannel = (event) => {
        this.setupDataChannel(event.channel);
      };
      await this.sendReadySignal(true);
    } finally {
      this.restartingHost = false;
    }
  }

  async handleIceCandidate(candidate) {
    if (!this.peerConnection || !candidate) {
      return;
    }

    if (!this.peerConnection.remoteDescription) {
      this.pendingRemoteCandidates.push(candidate);
      return;
    }

    try {
      await this.peerConnection.addIceCandidate(candidate);
    } catch (error) {
      this.reportError(error, 'Could not add a network candidate.');
    }
  }

  async flushPendingRemoteCandidates() {
    while (this.pendingRemoteCandidates.length) {
      const candidate = this.pendingRemoteCandidates.shift();
      await this.peerConnection.addIceCandidate(candidate);
    }
  }

  emitState(connectionState) {
    this.dispatchEvent(new CustomEvent('statechange', {
      detail: {
        connectionState,
        role: this.role,
      },
    }));
  }

  reportError(error, fallbackMessage) {
    this.dispatchEvent(new CustomEvent('error', {
      detail: {
        message: describeError(error, fallbackMessage),
      },
    }));
  }

  getChannel() {
    return this.dataChannel;
  }

  isOpen() {
    return Boolean(this.dataChannel && this.dataChannel.readyState === 'open');
  }

  send(data) {
    if (!this.isOpen()) {
      throw new Error('The bridge is not connected yet.');
    }
    this.dataChannel.send(data);
  }

  async disconnect() {
    this.clearOfferStuckTimer();
    this.disconnecting = true;
    this.reconnecting = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.unbindSignaling();
    this.signaling.close();

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.negotiationStarted = false;
    this.lastReadySignalAt = 0;
    this.restartingHost = false;
    this.disconnecting = false;
    this.pendingRemoteCandidates = [];
    this.connectionStartedAt = 0;
    this.sessionInfo = null;
    this.role = null;
  }
}