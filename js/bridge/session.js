import { SignalingClient } from './signaling.js';
import { WebRtcTransport } from './transport.js';
import { TransferProtocol } from './protocol.js';

function createIdleState(note = 'Create a code on one device, then join it from the other device.') {
  return {
    status: 'idle',
    role: null,
    code: '',
    expiresAt: null,
    peerPresent: false,
    peerLabel: 'Waiting for pairing',
    peerNote: 'Bidirectional transfers become available after pairing.',
    note,
    error: '',
  };
}

export class BridgeSession extends EventTarget {
  constructor({ signalingBaseUrl } = {}) {
    super();
    this.signalingBaseUrl = signalingBaseUrl;
    this.state = createIdleState();
    this.sessionInfo = null;

    this.handleTransportState = this.handleTransportState.bind(this);
    this.handleTransportError = this.handleTransportError.bind(this);
    this.handlePeerState = this.handlePeerState.bind(this);
    this.handleSessionEnded = this.handleSessionEnded.bind(this);
    this.handleTransferUpdate = this.handleTransferUpdate.bind(this);
    this.handleReceivedItem = this.handleReceivedItem.bind(this);
    this.handleStreamWarning = this.handleStreamWarning.bind(this);

    this.createRuntime();
  }

  createRuntime() {
    this.signaling = new SignalingClient(this.signalingBaseUrl);
    this.transport = new WebRtcTransport({ signaling: this.signaling });
    this.protocol = new TransferProtocol({ transport: this.transport });

    this.transport.addEventListener('statechange', this.handleTransportState);
    this.transport.addEventListener('error', this.handleTransportError);
    this.transport.addEventListener('peer-state', this.handlePeerState);
    this.transport.addEventListener('session-ended', this.handleSessionEnded);
    this.transport.addEventListener('stream-warning', this.handleStreamWarning);
    this.protocol.addEventListener('transfer-update', this.handleTransferUpdate);
    this.protocol.addEventListener('received', this.handleReceivedItem);
  }

  async destroyRuntime() {
    if (this.protocol) {
      this.protocol.removeEventListener('transfer-update', this.handleTransferUpdate);
      this.protocol.removeEventListener('received', this.handleReceivedItem);
      this.protocol.destroy();
      this.protocol = null;
    }

    if (this.transport) {
      this.transport.removeEventListener('statechange', this.handleTransportState);
      this.transport.removeEventListener('error', this.handleTransportError);
      this.transport.removeEventListener('peer-state', this.handlePeerState);
      this.transport.removeEventListener('session-ended', this.handleSessionEnded);
      this.transport.removeEventListener('stream-warning', this.handleStreamWarning);
      await this.transport.disconnect();
      this.transport = null;
    }

    if (this.signaling) {
      this.signaling.close();
      this.signaling = null;
    }
  }

  async resetRuntime() {
    await this.destroyRuntime();
    this.createRuntime();
  }

  getSnapshot() {
    return { ...this.state };
  }

  setState(patch) {
    this.state = {
      ...this.state,
      ...patch,
    };

    this.dispatchEvent(new CustomEvent('state', {
      detail: this.getSnapshot(),
    }));
  }

  emitNotice(message, tone = 'info') {
    this.dispatchEvent(new CustomEvent('notice', {
      detail: { message, tone },
    }));
  }

  async host() {
    await this.resetRuntime();
    const sessionInfo = await this.signaling.createSession();
    this.sessionInfo = { ...sessionInfo, role: 'host' };

    this.setState({
      ...createIdleState('The code is live. Share it with the other device to start pairing.'),
      status: 'hosting',
      role: 'host',
      code: sessionInfo.code,
      expiresAt: sessionInfo.expiresAt,
      peerLabel: 'Waiting for a joiner',
      peerNote: 'When someone joins, the WebRTC data channel will negotiate automatically.',
    });

    await this.transport.host(this.sessionInfo);
    return this.getSnapshot();
  }

  async join(code) {
    await this.resetRuntime();
    const sessionInfo = await this.signaling.joinSession(code);
    this.sessionInfo = { ...sessionInfo, role: 'guest' };

    this.setState({
      ...createIdleState('Joining the temporary bridge and waiting for negotiation.'),
      status: 'joining',
      role: 'guest',
      code: sessionInfo.code,
      expiresAt: sessionInfo.expiresAt,
      peerLabel: 'Host found',
      peerNote: 'Waiting for the host to finish the WebRTC offer/answer exchange.',
    });

    await this.transport.join(this.sessionInfo);
    return this.getSnapshot();
  }

  async disconnect({ propagate = true } = {}) {
    const activeSession = this.sessionInfo;
    if (propagate && activeSession?.code) {
      try {
        await this.signaling.deleteSession(activeSession.code, activeSession.clientId);
      } catch {
        // Ignore signaling cleanup failures during disconnect.
      }
    }

    this.sessionInfo = null;
    await this.resetRuntime();
    this.setState(createIdleState());
  }

  async sendText(text) {
    const normalized = String(text || '');
    if (!normalized.trim()) {
      throw new Error('Enter some text before sending it.');
    }

    return this.protocol.sendText(normalized);
  }

  async sendFile({ kind, file }) {
    return this.protocol.sendFile({ kind, file });
  }

  handleTransportState(event) {
    const { connectionState } = event.detail;

    if (!this.sessionInfo) {
      return;
    }

    if (connectionState === 'connected') {
      this.setState({
        status: 'connected',
        peerLabel: this.state.role === 'host' ? 'Guest connected' : 'Connected to host',
        peerNote: 'The bridge is live in both directions.',
        note: 'Transfers now move device-to-device over the WebRTC data channel.',
        error: '',
      });
      return;
    }

    if (connectionState === 'disconnected' || connectionState === 'reconnecting') {
      this.setState({
        status: 'reconnecting',
        note: 'The peer link dropped. dBridgr is waiting to recover if the browser can reconnect.',
      });
      return;
    }

    if (connectionState === 'connecting' || connectionState === 'new') {
      this.setState({
        status: this.state.role === 'host' ? 'hosting' : 'joining',
        note: 'Negotiating the peer-to-peer data channel.',
      });
      return;
    }

    if (connectionState === 'failed') {
      this.setState({
        status: 'error',
        error: 'The bridge connection failed.',
        note: 'Disconnect and retry pairing. Some networks block or degrade peer connectivity.',
      });
      return;
    }

    if (connectionState === 'hosting' || connectionState === 'joining') {
      this.setState({ status: connectionState });
    }
  }

  handleTransportError(event) {
    this.setState({
      status: 'error',
      error: event.detail.message,
      note: event.detail.message,
    });
    this.emitNotice(event.detail.message, 'error');
  }

  handleStreamWarning(event) {
    if (this.state.status === 'connected') {
      this.emitNotice('The signaling stream blinked, but the peer connection is still active.', 'info');
      return;
    }

    this.setState({
      status: 'reconnecting',
      note: event.detail.message,
    });
  }

  handlePeerState(event) {
    const detail = event.detail;
    if (!this.sessionInfo) {
      return;
    }

    // If signaling recovered after a transient error, return to the active state.
    if (this.state.status === 'reconnecting') {
      this.setState({
        status: this.state.role === 'host' ? 'hosting' : 'joining',
        note: 'Signaling recovered. Waiting for the peer-to-peer channel.',
      });
    }

    if (this.state.role === 'host') {
      this.setState({
        peerPresent: detail.peerPresent,
        peerLabel: detail.guestPresent ? 'Joiner detected' : 'Waiting for a joiner',
        peerNote: detail.guestConnected
          ? 'The other device is on the signaling stream and ready to negotiate.'
          : 'Once the joiner opens the session, WebRTC negotiation begins.',
      });
      return;
    }

    this.setState({
      peerPresent: detail.peerPresent,
      peerLabel: detail.hostPresent ? 'Host reachable' : 'Waiting for the host',
      peerNote: detail.hostConnected
        ? 'The host is still watching the signaling stream.'
        : 'If the host closed the page, ask them to host again and share a fresh code.',
    });
  }

  async handleSessionEnded() {
    await this.resetRuntime();
    this.sessionInfo = null;
    this.setState(createIdleState('The bridge ended. Host a new code or join another one.'));
    this.emitNotice('The bridge session ended.', 'info');
  }

  handleTransferUpdate(event) {
    this.dispatchEvent(new CustomEvent('transfer-update', {
      detail: event.detail,
    }));
  }

  handleReceivedItem(event) {
    this.dispatchEvent(new CustomEvent('received', {
      detail: event.detail,
    }));
  }
}