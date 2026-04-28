import { BUFFER_LOW_WATER_MARK } from './chunks.js';

const OFFER_RETRY_CHECK_MS = 1500;
const OFFER_RETRY_MAX_AGE_MS = 7000;

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
    this.lastOfferSentAt = 0;
    this.offerRetryTimer = null;
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
    this.startOfferRetryLoop();
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
    void this.sendReadySignal();
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
      if (this.peerConnection.iceConnectionState === 'failed') {
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
      this.stopOfferRetryLoop();
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
        if (this.needsInitialOffer()) {
          this.negotiationStarted = false;
          await this.createAndSendOffer({ iceRestart: this.lastOfferSentAt > 0 });
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
    if (this.peerConnection.signalingState !== 'stable') {
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
      this.lastOfferSentAt = Date.now();
    } catch (error) {
      this.negotiationStarted = false;
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
    } catch (error) {
      this.reportError(error, 'Could not finalize the bridge connection.');
    }
  }

  async sendReadySignal() {
    if (!this.sessionInfo || this.role !== 'guest') {
      return;
    }

    try {
      await this.signaling.send(this.sessionInfo.code, this.sessionInfo.clientId, 'ready', {
        at: Date.now(),
      });
    } catch {
      // Ready ping is best effort; polling will retry naturally.
    }
  }

  startOfferRetryLoop() {
    this.stopOfferRetryLoop();
    this.offerRetryTimer = window.setInterval(() => {
      if (!this.peerConnection || !this.sessionInfo || this.role !== 'host' || this.isOpen()) {
        return;
      }

      const canRetryInitialOffer = !this.peerConnection.currentRemoteDescription;
      const canRetryAfterIceFailure = Boolean(this.peerConnection.currentRemoteDescription)
        && (this.peerConnection.connectionState === 'failed' || this.peerConnection.iceConnectionState === 'failed');

      if (!canRetryInitialOffer && !canRetryAfterIceFailure) {
        return;
      }

      const offerAge = this.lastOfferSentAt ? Date.now() - this.lastOfferSentAt : Number.POSITIVE_INFINITY;
      if (!this.negotiationStarted || offerAge >= OFFER_RETRY_MAX_AGE_MS) {
        this.negotiationStarted = false;
        void this.createAndSendOffer({ iceRestart: canRetryAfterIceFailure || this.lastOfferSentAt > 0 });
      }
    }, OFFER_RETRY_CHECK_MS);
  }

  needsInitialOffer() {
    return Boolean(
      this.role === 'host'
      && this.peerConnection
      && this.sessionInfo
      && !this.isOpen()
      && !this.peerConnection.currentRemoteDescription
    );
  }

  stopOfferRetryLoop() {
    if (this.offerRetryTimer !== null) {
      window.clearInterval(this.offerRetryTimer);
      this.offerRetryTimer = null;
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
    this.stopOfferRetryLoop();
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
    this.lastOfferSentAt = 0;
    this.pendingRemoteCandidates = [];
    this.sessionInfo = null;
    this.role = null;
  }
}