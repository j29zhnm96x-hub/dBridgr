import { BUFFER_LOW_WATER_MARK } from './chunks.js';

const OFFER_STUCK_TIMEOUT_MS = 9000;
const READY_SIGNAL_COOLDOWN_MS = 1500;

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
    this.pendingRemoteCandidates = [];

    this.handleSignalingMessage = this.handleSignalingMessage.bind(this);
    this.handleSignalingStreamError = this.handleSignalingStreamError.bind(this);
  }

  async host(sessionInfo) {
    this.sessionInfo = { ...sessionInfo, role: 'host' };
    this.role = 'host';
    this.createPeerConnection();
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

      if (this.peerConnection.iceConnectionState === 'failed') {
        if (this.role === 'host' && !this.isOpen()) {
          void this.restartHostNegotiation();
          return;
        }

        this.reportError(new Error('The peer connection failed.'), 'The peer connection failed.');
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
      this.dispatchEvent(new CustomEvent('open'));
      this.emitState('connected');
    };

    this.dataChannel.onclose = () => {
      this.dispatchEvent(new CustomEvent('closed'));
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

    try {
      switch (payload.type) {
      case 'ready': {
        if (this.needsInitialOffer() && !this.negotiationStarted) {
          await this.createAndSendOffer();
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
        if (payload.guestPresent && this.needsInitialOffer() && !this.negotiationStarted) {
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
        await this.restartHostNegotiation();
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
    if (!this.peerConnection || this.role !== 'host' || this.peerConnection.currentRemoteDescription) {
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

  async restartHostNegotiation() {
    if (!this.sessionInfo || this.role !== 'host' || this.restartingHost) {
      return;
    }

    this.restartingHost = true;
    this.clearOfferStuckTimer();
    this.negotiationStarted = false;
    this.pendingRemoteCandidates = [];

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
      const dataChannel = this.peerConnection.createDataChannel('dbridgr', {
        ordered: true,
      });
      this.setupDataChannel(dataChannel);
      await this.createAndSendOffer();
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
    this.pendingRemoteCandidates = [];
    this.sessionInfo = null;
    this.role = null;
  }
}