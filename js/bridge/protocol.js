import {
  CHUNK_SIZE,
  computeProgress,
  iterateBlobChunks,
  waitForBufferedAmountLow,
} from './chunks.js';

const CONTROL_KIND = 'control';
const CHUNK_PACKET = 1;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function createTransferId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return Math.random().toString(16).slice(2, 14);
}

function serializeTransfer(record) {
  return {
    id: record.id,
    direction: record.direction,
    status: record.status,
    kind: record.meta.kind,
    name: record.meta.name,
    mimeType: record.meta.mimeType,
    size: record.totalBytes,
    transferredBytes: record.direction === 'outgoing' ? record.sentBytes : record.receivedBytes,
    progress: record.direction === 'outgoing'
      ? computeProgress(record.sentBytes, record.totalBytes)
      : computeProgress(record.receivedBytes, record.totalBytes),
    startedAt: record.startedAt,
    error: record.error || '',
  };
}

function controlMessage(action, payload) {
  return JSON.stringify({ kind: CONTROL_KIND, action, ...payload });
}

function encodeChunkPacket(transferId, arrayBuffer) {
  const transferIdBytes = textEncoder.encode(transferId);
  const chunkBytes = new Uint8Array(arrayBuffer);
  const packet = new Uint8Array(2 + transferIdBytes.length + chunkBytes.byteLength);
  packet[0] = CHUNK_PACKET;
  packet[1] = transferIdBytes.length;
  packet.set(transferIdBytes, 2);
  packet.set(chunkBytes, 2 + transferIdBytes.length);
  return packet.buffer;
}

function decodeChunkPacket(data) {
  const view = new Uint8Array(data);
  if (view[0] !== CHUNK_PACKET) {
    return null;
  }

  const transferIdLength = view[1];
  const transferIdBytes = view.slice(2, 2 + transferIdLength);
  const chunkBytes = view.slice(2 + transferIdLength);
  return {
    transferId: textDecoder.decode(transferIdBytes),
    chunk: chunkBytes.buffer.slice(chunkBytes.byteOffset, chunkBytes.byteOffset + chunkBytes.byteLength),
  };
}

export class TransferProtocol extends EventTarget {
  constructor({ transport, chunkSize = CHUNK_SIZE } = {}) {
    super();
    this.transport = transport;
    this.chunkSize = chunkSize;
    this.outgoingTransfers = new Map();
    this.incomingTransfers = new Map();

    this.handleTransportMessage = this.handleTransportMessage.bind(this);
    this.handleTransportClosed = this.handleTransportClosed.bind(this);

    this.transport.addEventListener('message', this.handleTransportMessage);
    this.transport.addEventListener('closed', this.handleTransportClosed);
    this.transport.addEventListener('session-ended', this.handleTransportClosed);
  }

  async sendText(text) {
    const blob = new Blob([text], {
      type: 'text/plain;charset=utf-8',
    });

    return this.sendBlob({
      kind: 'text',
      blob,
      name: 'dbridgr-note.txt',
      mimeType: blob.type,
    });
  }

  async sendFile({ kind, file }) {
    if (!file) {
      throw new Error('Choose something to bridge first.');
    }

    return this.sendBlob({
      kind,
      blob: file,
      name: file.name || `${kind}-${Date.now()}`,
      mimeType: file.type || 'application/octet-stream',
    });
  }

  async sendBlob({ kind, blob, name, mimeType }) {
    if (!this.transport.isOpen()) {
      throw new Error('Pair both devices before sending content.');
    }

    const transferId = createTransferId();
    const meta = {
      kind,
      name,
      mimeType: mimeType || blob.type || 'application/octet-stream',
      size: blob.size || 0,
    };

    const record = {
      id: transferId,
      direction: 'outgoing',
      status: 'sending',
      meta,
      sentBytes: 0,
      totalBytes: meta.size,
      startedAt: Date.now(),
    };

    this.outgoingTransfers.set(transferId, record);
    this.emitTransfer('start', record);

    try {
      this.transport.send(controlMessage('start', { transferId, meta }));

      for await (const { buffer } of iterateBlobChunks(blob, this.chunkSize)) {
        await waitForBufferedAmountLow(this.transport.getChannel());
        this.transport.send(encodeChunkPacket(transferId, buffer));
        record.sentBytes += buffer.byteLength;
        this.emitTransfer('progress', record);
      }

      this.transport.send(controlMessage('complete', { transferId }));
      record.status = 'complete';
      this.emitTransfer('complete', record);
      this.outgoingTransfers.delete(transferId);
      return transferId;
    } catch (error) {
      record.status = 'error';
      record.error = error instanceof Error ? error.message : 'Transfer failed.';
      this.emitTransfer('error', record);
      this.outgoingTransfers.delete(transferId);
      this.safeSendControl('error', {
        transferId,
        message: record.error,
      });
      throw error;
    }
  }

  async handleTransportMessage(event) {
    const payload = event.detail;

    if (typeof payload === 'string') {
      await this.handleControlMessage(payload);
      return;
    }

    if (payload instanceof ArrayBuffer) {
      this.handleChunkMessage(payload);
      return;
    }

    if (ArrayBuffer.isView(payload)) {
      this.handleChunkMessage(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
    }
  }

  async handleControlMessage(serializedPayload) {
    let message;
    try {
      message = JSON.parse(serializedPayload);
    } catch {
      return;
    }

    if (message.kind !== CONTROL_KIND) {
      return;
    }

    switch (message.action) {
      case 'start':
        this.startIncomingTransfer(message.transferId, message.meta);
        return;
      case 'complete':
        await this.completeIncomingTransfer(message.transferId);
        return;
      case 'cancel':
      case 'error':
        this.failIncomingTransfer(message.transferId, message.message || 'Transfer cancelled.');
        return;
      default:
        return;
    }
  }

  startIncomingTransfer(transferId, meta) {
    const record = {
      id: transferId,
      direction: 'incoming',
      status: 'receiving',
      meta,
      chunks: [],
      receivedBytes: 0,
      totalBytes: meta.size || 0,
      startedAt: Date.now(),
    };

    this.incomingTransfers.set(transferId, record);
    this.emitTransfer('start', record);
  }

  handleChunkMessage(payload) {
    const decodedChunk = decodeChunkPacket(payload);
    if (!decodedChunk) {
      return;
    }

    const record = this.incomingTransfers.get(decodedChunk.transferId);
    if (!record) {
      return;
    }

    record.chunks.push(decodedChunk.chunk);
    record.receivedBytes += decodedChunk.chunk.byteLength;
    this.emitTransfer('progress', record);
  }

  async completeIncomingTransfer(transferId) {
    const record = this.incomingTransfers.get(transferId);
    if (!record) {
      return;
    }

    const blob = new Blob(record.chunks, {
      type: record.meta.mimeType || 'application/octet-stream',
    });

    record.status = 'complete';
    this.emitTransfer('complete', record);
    this.dispatchEvent(new CustomEvent('received', {
      detail: {
        id: record.id,
        kind: record.meta.kind,
        name: record.meta.name,
        mimeType: record.meta.mimeType,
        size: record.totalBytes,
        receivedAt: Date.now(),
        blob,
      },
    }));
    this.incomingTransfers.delete(transferId);
  }

  failIncomingTransfer(transferId, message) {
    const record = this.incomingTransfers.get(transferId);
    if (!record) {
      return;
    }

    record.status = 'error';
    record.error = message;
    this.emitTransfer('error', record);
    this.incomingTransfers.delete(transferId);
  }

  handleTransportClosed() {
    this.failAllTransfers('The connection closed before the transfer finished.');
  }

  failAllTransfers(message) {
    for (const record of this.outgoingTransfers.values()) {
      record.status = 'error';
      record.error = message;
      this.emitTransfer('error', record);
    }

    for (const record of this.incomingTransfers.values()) {
      record.status = 'error';
      record.error = message;
      this.emitTransfer('error', record);
    }

    this.outgoingTransfers.clear();
    this.incomingTransfers.clear();
  }

  safeSendControl(action, payload) {
    try {
      if (this.transport.isOpen()) {
        this.transport.send(controlMessage(action, payload));
      }
    } catch {
      // Ignore secondary errors after the primary transfer failure.
    }
  }

  emitTransfer(stage, record) {
    this.dispatchEvent(new CustomEvent('transfer-update', {
      detail: {
        stage,
        ...serializeTransfer(record),
      },
    }));
  }

  destroy() {
    this.transport.removeEventListener('message', this.handleTransportMessage);
    this.transport.removeEventListener('closed', this.handleTransportClosed);
    this.transport.removeEventListener('session-ended', this.handleTransportClosed);
    this.failAllTransfers('The transfer layer was reset.');
  }
}