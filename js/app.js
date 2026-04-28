import { clearStoredNamespace } from './core/storage.js';
import { getDiagnosticsSnapshot, getInstallHelpText, registerServiceWorker } from './core/pwa.js';
import { resolveInitialTheme, setTheme } from './core/theme.js';
import { isOverSoftLimit, needsLargeTransferWarning, SOFT_FILE_LIMIT_BYTES } from './bridge/chunks.js';
import { BridgeSession } from './bridge/session.js';
import { createInitialState, createStore } from './state/store.js';
import { clearChildren, createElement, formatClockTime, formatExpiry, qs, qsa } from './utils/dom.js';
import {
  blobToText,
  buildSelectionMetadata,
  buildTextDownloadName,
  createObjectUrl,
  downloadBlob,
  formatBytes,
  normalizeCodeInput,
  revokeAllObjectUrls,
  revokeObjectUrl,
  shareBlob,
  supportsClipboardRead,
} from './utils/files.js';

const MAX_TRANSFER_ITEMS = 16;
const MAX_RECEIVED_ITEMS = 18;
const TOAST_DURATION_MS = 4200;

function humanizeStatus(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function updateTransferItems(list, transfer) {
  const nextList = [...list];
  const index = nextList.findIndex((item) => item.id === transfer.id);
  if (index === -1) {
    nextList.unshift(transfer);
  } else {
    nextList[index] = { ...nextList[index], ...transfer };
  }

  nextList.sort((left, right) => right.startedAt - left.startedAt);
  return nextList.slice(0, MAX_TRANSFER_ITEMS);
}

function shouldDisableSend(connectionStatus) {
  return connectionStatus !== 'connected';
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', 'true');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  document.body.append(helper);
  helper.select();
  document.execCommand('copy');
  helper.remove();
}

function revokeRemovedReceivedItems(previousItems, nextItems) {
  const nextIds = new Set(nextItems.map((item) => item.id));
  previousItems.forEach((item) => {
    if (!nextIds.has(item.id) && item.objectUrl) {
      revokeObjectUrl(item.objectUrl);
    }
  });
}

function createReceivedItem(rawItem) {
  return {
    ...rawItem,
    id: rawItem.id,
  };
}

export function bootstrapApp({ initialTheme } = {}) {
  const store = createStore(createInitialState(initialTheme || resolveInitialTheme()));
  const session = new BridgeSession();
  const refs = buildRefs();

  function showToast(message, tone = 'info') {
    const toast = createElement('div', {
      className: 'toast',
      text: message,
      attributes: {
        'data-tone': tone,
      },
    });
    refs.toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), TOAST_DURATION_MS);
  }

  function setScreen(screen) {
    store.update((state) => ({
      ...state,
      screen,
    }));
  }

  function setJoinSheetOpen(joinSheetOpen) {
    store.update((state) => ({
      ...state,
      joinSheetOpen,
    }));

    if (joinSheetOpen) {
      window.setTimeout(() => refs.joinCodeInput.focus(), 30);
    }
  }

  function setJoinCode(joinCode) {
    const normalizedCode = normalizeCodeInput(joinCode);
    store.update((state) => ({
      ...state,
      joinCode: normalizedCode,
    }));
  }

  function setTextComposerValue(value) {
    store.update((state) => ({
      ...state,
      composers: {
        ...state.composers,
        text: {
          ...state.composers.text,
          value,
        },
      },
    }));
  }

  function getSelectionHelp(kind, file) {
    if (!file) {
      switch (kind) {
        case 'photo':
          return 'Camera capture support depends on the device browser.';
        case 'video':
          return 'Large videos can strain iPhone memory. A warning appears before big transfers.';
        default:
          return 'Files stay peer-to-peer after the session is paired.';
      }
    }

    if (isOverSoftLimit(file)) {
      return `This file is above the default soft limit of ${formatBytes(SOFT_FILE_LIMIT_BYTES)} for reliability.`;
    }

    if (needsLargeTransferWarning(file)) {
      return `This selection is ${formatBytes(file.size)}. Large transfers can fail or exhaust iPhone memory.`;
    }

    switch (kind) {
      case 'photo':
        return 'Ready to send as soon as the bridge is connected.';
      case 'video':
        return 'Ready to send. Keep the screen awake for long video transfers.';
      default:
        return 'Ready to send over the active bridge.';
    }
  }

  function setSelectedFile(kind, file) {
    const currentState = store.getState();
    const currentComposer = currentState.composers[kind];
    if (currentComposer.previewUrl) {
      revokeObjectUrl(currentComposer.previewUrl);
    }

    const previewUrl = file && (kind === 'photo' || kind === 'video') ? createObjectUrl(file) : '';
    store.update((state) => ({
      ...state,
      composers: {
        ...state.composers,
        [kind]: {
          ...state.composers[kind],
          file,
          previewUrl,
          warning: getSelectionHelp(kind, file),
          error: '',
        },
      },
    }));
  }

  function setConnectionState(connectionPatch) {
    store.update((state) => ({
      ...state,
      connection: {
        ...state.connection,
        ...connectionPatch,
      },
    }));
  }

  function setDiagnostics(diagnosticsPatch) {
    store.update((state) => ({
      ...state,
      diagnostics: {
        ...state.diagnostics,
        ...diagnosticsPatch,
      },
    }));
  }

  function addTransferUpdate(transfer) {
    store.update((state) => ({
      ...state,
      activeTransfers: updateTransferItems(state.activeTransfers, transfer),
    }));
  }

  async function addReceivedItem(payload) {
    const item = createReceivedItem({
      id: payload.id,
      kind: payload.kind,
      name: payload.name,
      mimeType: payload.mimeType,
      size: payload.size,
      receivedAt: payload.receivedAt,
      blob: payload.blob,
      objectUrl: '',
      text: '',
    });

    if (payload.kind === 'text') {
      item.text = await blobToText(payload.blob);
    } else {
      item.objectUrl = createObjectUrl(payload.blob);
    }

    const previousItems = store.getState().receivedItems;
    const nextItems = [item, ...previousItems].slice(0, MAX_RECEIVED_ITEMS);
    revokeRemovedReceivedItems(previousItems, nextItems);
    store.update((state) => ({
      ...state,
      receivedItems: nextItems,
    }));

    showToast(`Received ${payload.kind === 'text' ? 'text' : payload.name}.`, 'success');
  }

  function renderConnection(connection) {
    refs.connectionStatus.textContent = humanizeStatus(connection.status);
    refs.connectionStatus.dataset.status = connection.status;
    refs.bridgeCode.textContent = connection.code || '----';
    refs.codeExpiry.textContent = connection.code ? formatExpiry(connection.expiresAt) : 'Host to generate a temporary code.';
    refs.peerLabel.textContent = connection.peerLabel;
    refs.peerNote.textContent = connection.peerNote;
    refs.connectionNote.textContent = connection.error || connection.note;

    refs.disconnectButton.disabled = connection.status === 'idle';
    refs.hostButton.textContent = connection.status === 'idle' ? 'Host a Bridge' : 'Host New Bridge';
    refs.openJoinButton.textContent = connection.status === 'idle' ? 'Join with Code' : 'Join Another Code';
  }

  function renderTabs(state) {
    refs.screenNavButtons.forEach((button) => {
      const isActive = button.dataset.screenTarget === state.screen;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-current', isActive ? 'page' : 'false');
    });

    refs.screens.forEach((screen) => {
      screen.classList.toggle('is-active', screen.dataset.screen === state.screen);
    });

    refs.composerTabs.forEach((button) => {
      const isActive = button.dataset.composerTarget === state.activeComposer;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    });

    refs.composerCards.forEach((card) => {
      card.classList.toggle('is-active', card.dataset.composer === state.activeComposer);
    });
  }

  function renderJoinSheet(state) {
    refs.joinSheet.hidden = !state.joinSheetOpen;
    refs.joinSheet.style.display = state.joinSheetOpen ? 'grid' : 'none';
    refs.joinCodeInput.value = state.joinCode;
    refs.joinButton.disabled = state.joinCode.length !== 4;
  }

  function renderTextComposer(state) {
    refs.textInput.value = state.composers.text.value;
    refs.pasteTextButton.disabled = !supportsClipboardRead();
    refs.sendTextButton.disabled = shouldDisableSend(state.connection.status) || !state.composers.text.value.trim();
  }

  function renderSelectionCard(container, composer, kind) {
    clearChildren(container);

    if (!composer.file) {
      container.append(createElement('p', {
        className: 'selection-card__empty',
        text: kind === 'photo'
          ? 'No photo selected yet.'
          : kind === 'video'
            ? 'No video selected yet.'
            : 'No file selected yet.',
      }));
      return;
    }

    if (kind === 'photo') {
      const image = createElement('img', {
        className: 'selection-card__media',
        attributes: {
          alt: composer.file.name || 'Selected photo preview',
          src: composer.previewUrl,
        },
      });
      container.append(image);
    }

    if (kind === 'video') {
      const video = createElement('video', {
        className: 'selection-card__media',
        attributes: {
          controls: 'controls',
          playsinline: 'playsinline',
          src: composer.previewUrl,
        },
      });
      container.append(video);
    }

    const metadata = buildSelectionMetadata(composer.file);
    const meta = createElement('div', {
      className: 'selection-meta',
    });
    meta.append(
      createElement('strong', { text: metadata.name }),
      createElement('span', { text: formatBytes(metadata.size) }),
      createElement('span', { text: metadata.mimeType })
    );
    container.append(meta);
  }

  function renderComposers(state) {
    renderTextComposer(state);
    renderSelectionCard(refs.photoSelection, state.composers.photo, 'photo');
    renderSelectionCard(refs.videoSelection, state.composers.video, 'video');
    renderSelectionCard(refs.fileSelection, state.composers.file, 'file');

    refs.photoWarning.textContent = state.composers.photo.warning || 'Camera capture support depends on the device browser.';
    refs.videoWarning.textContent = state.composers.video.warning || 'Large videos can strain iPhone memory. A warning appears before big transfers.';
    refs.fileWarning.textContent = state.composers.file.warning || 'Files stay peer-to-peer after the session is paired.';

    refs.sendPhotoButton.disabled = shouldDisableSend(state.connection.status) || !state.composers.photo.file;
    refs.sendVideoButton.disabled = shouldDisableSend(state.connection.status) || !state.composers.video.file;
    refs.sendFileButton.disabled = shouldDisableSend(state.connection.status) || !state.composers.file.file;
  }

  function renderTransfers(transfers) {
    clearChildren(refs.transferList);

    if (!transfers.length) {
      refs.transferList.append(createElement('p', {
        className: 'empty-state',
        text: 'No active transfers yet.',
      }));
      return;
    }

    transfers.forEach((transfer) => {
      const card = createElement('article', { className: 'transfer-item' });
      const header = createElement('div', { className: 'transfer-item__header' });
      header.append(
        createElement('strong', {
          text: `${transfer.direction === 'outgoing' ? 'Sending' : 'Receiving'} ${transfer.kind}`,
        }),
        createElement('span', {
          text: humanizeStatus(transfer.status),
        })
      );

      const title = createElement('p', {
        className: 'transfer-item__meta',
        text: `${transfer.name} • ${formatBytes(transfer.transferredBytes)} / ${formatBytes(transfer.size)}`,
      });

      const progress = createElement('div', { className: 'transfer-item__progress' });
      const bar = createElement('span');
      bar.style.width = `${Math.max(6, Math.round(transfer.progress * 100))}%`;
      progress.append(bar);

      card.append(header, title, progress);
      if (transfer.error) {
        card.append(createElement('p', {
          className: 'transfer-item__meta',
          text: transfer.error,
        }));
      }
      refs.transferList.append(card);
    });
  }

  function renderReceivedItemCard(item) {
    const card = createElement('article', {
      className: `received-card ${item.kind === 'text' ? 'received-card--text' : ''}`,
    });

    const header = createElement('div', { className: 'received-card__header' });
    header.append(
      createElement('strong', {
        text: item.kind === 'text' ? 'Text received' : item.name,
      }),
      createElement('span', {
        text: formatClockTime(item.receivedAt),
      })
    );
    card.append(header);

    if (item.kind === 'text') {
      const body = createElement('div', { className: 'received-text' });
      body.setAttribute('tabindex', '0');
      body.setAttribute('role', 'textbox');
      body.setAttribute('aria-readonly', 'true');
      body.textContent = item.text;
      card.append(body);
    }

    if (item.kind === 'photo') {
      card.append(createElement('img', {
        className: 'received-card__media',
        attributes: {
          alt: item.name,
          src: item.objectUrl,
        },
      }));
    }

    if (item.kind === 'video') {
      card.append(createElement('video', {
        className: 'received-card__media',
        attributes: {
          src: item.objectUrl,
          controls: 'controls',
          playsinline: 'playsinline',
        },
      }));
    }

    if (item.kind !== 'text') {
      const fileMeta = createElement('div', { className: 'received-file-meta' });
      fileMeta.append(
        createElement('span', { text: formatBytes(item.size) }),
        createElement('span', { text: item.mimeType || 'application/octet-stream' }),
        createElement('span', { text: `Received ${formatClockTime(item.receivedAt)}` })
      );
      card.append(fileMeta);
    }

    const actions = createElement('div', { className: 'received-card__actions' });
    if (item.kind === 'text') {
      actions.append(
        createElement('button', {
          className: 'button button--ghost',
          text: 'Copy',
          attributes: {
            'data-action': 'copy-text',
            'data-item-id': item.id,
            type: 'button',
          },
        }),
        createElement('button', {
          className: 'button button--secondary',
          text: 'Download',
          attributes: {
            'data-action': 'download-item',
            'data-item-id': item.id,
            type: 'button',
          },
        })
      );
    } else {
      actions.append(
        createElement('button', {
          className: 'button button--ghost',
          text: 'Share',
          attributes: {
            'data-action': 'share-item',
            'data-item-id': item.id,
            type: 'button',
          },
        }),
        createElement('button', {
          className: 'button button--secondary',
          text: 'Download',
          attributes: {
            'data-action': 'download-item',
            'data-item-id': item.id,
            type: 'button',
          },
        })
      );
    }

    card.append(actions);
    return card;
  }

  function renderReceived(receivedItems) {
    clearChildren(refs.receivedList);

    if (!receivedItems.length) {
      refs.receivedList.append(createElement('p', {
        className: 'empty-state',
        text: 'Incoming text, photos, videos, and files will appear here.',
      }));
      return;
    }

    receivedItems.forEach((item) => {
      refs.receivedList.append(renderReceivedItemCard(item));
    });
  }

  function renderTheme(state) {
    refs.themeToggle.checked = state.theme === 'dark';
    refs.themeToggleLabel.textContent = state.theme === 'dark' ? 'Dark mode on' : 'Dark mode off';
  }

  function renderDiagnostics(diagnostics) {
    refs.installHelp.textContent = getInstallHelpText();
    refs.diagnosticOnline.textContent = `Network: ${diagnostics.online ? 'online' : 'offline'}`;
    refs.diagnosticDisplay.textContent = `Display mode: ${diagnostics.standalone ? 'standalone' : 'browser'}`;
    refs.diagnosticServiceWorker.textContent = `Offline shell cache: ${diagnostics.serviceWorkerReady ? 'ready' : 'not registered'}`;
  }

  function render(state) {
    renderTabs(state);
    renderConnection(state.connection);
    renderJoinSheet(state);
    renderComposers(state);
    renderTransfers(state.activeTransfers);
    renderReceived(state.receivedItems);
    renderTheme(state);
    renderDiagnostics(state.diagnostics);
  }

  async function handleHost() {
    try {
      await session.host();
      showToast('Bridge code generated.', 'success');
    } catch (error) {
      showToast(error.message || 'Could not host a new bridge.', 'error');
    }
  }

  async function handleJoin() {
    const code = normalizeCodeInput(store.getState().joinCode);
    if (code.length !== 4) {
      showToast('Enter a valid 4-digit code.', 'error');
      return;
    }

    try {
      await session.join(code);
      setJoinSheetOpen(false);
      showToast(`Joining bridge ${code}.`, 'success');
    } catch (error) {
      showToast(error.message || 'Could not join that code.', 'error');
    }
  }

  async function handleDisconnect() {
    await session.disconnect();
    showToast('Bridge disconnected.', 'info');
  }

  async function ensureTransferAllowed(file, noun) {
    if (!file) {
      throw new Error(`Choose a ${noun} first.`);
    }
    if (isOverSoftLimit(file)) {
      throw new Error(`This ${noun} is above the default soft limit of ${formatBytes(SOFT_FILE_LIMIT_BYTES)}.`);
    }
    if (needsLargeTransferWarning(file)) {
      const confirmed = window.confirm(`This ${noun} is ${formatBytes(file.size)}. Large transfers can fail or exhaust iPhone memory. Continue?`);
      if (!confirmed) {
        return false;
      }
    }
    return true;
  }

  async function handleSendText() {
    try {
      await session.sendText(store.getState().composers.text.value);
      showToast('Text sent across the bridge.', 'success');
    } catch (error) {
      showToast(error.message || 'Could not send that text.', 'error');
    }
  }

  async function handleSendFile(kind, noun) {
    const file = store.getState().composers[kind].file;
    try {
      const allowed = await ensureTransferAllowed(file, noun);
      if (!allowed) {
        return;
      }
      await session.sendFile({ kind, file });
      showToast(`${noun.charAt(0).toUpperCase() + noun.slice(1)} sent across the bridge.`, 'success');
    } catch (error) {
      showToast(error.message || `Could not send that ${noun}.`, 'error');
    }
  }

  async function handleShareItem(item) {
    const shared = await shareBlob({
      blob: item.blob,
      filename: item.name,
      title: `dBridgr ${item.kind}`,
      text: item.kind === 'photo' || item.kind === 'video' ? 'Shared from dBridgr.' : item.name,
    });

    if (shared) {
      return;
    }

    if (item.objectUrl && (item.kind === 'photo' || item.kind === 'video')) {
      window.open(item.objectUrl, '_blank', 'noopener');
      showToast('Share is unavailable here, so the item was opened in a new tab.', 'info');
      return;
    }

    downloadBlob(item.blob, item.name || 'download');
    showToast('Share is unavailable here, so a download started instead.', 'info');
  }

  async function handleReceivedAction(event) {
    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) {
      return;
    }

    const item = store.getState().receivedItems.find((entry) => entry.id === actionTarget.dataset.itemId);
    if (!item) {
      return;
    }

    if (actionTarget.dataset.action === 'copy-text') {
      await copyTextToClipboard(item.text);
      showToast('Text copied.', 'success');
      return;
    }

    if (actionTarget.dataset.action === 'download-item') {
      const filename = item.kind === 'text' ? buildTextDownloadName() : item.name;
      downloadBlob(item.blob, filename);
      showToast('Download started.', 'success');
      return;
    }

    if (actionTarget.dataset.action === 'share-item') {
      await handleShareItem(item);
    }
  }

  function refreshDiagnostics(extra = {}) {
    setDiagnostics({
      ...getDiagnosticsSnapshot(),
      ...extra,
    });
  }

  function resetLocalState() {
    const state = store.getState();
    revokeRemovedReceivedItems(state.receivedItems, []);
    clearStoredNamespace();
    const nextTheme = setTheme(window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    store.update((currentState) => ({
      ...currentState,
      theme: nextTheme,
      receivedItems: [],
      activeTransfers: [],
    }));
    refreshDiagnostics({ serviceWorkerReady: state.diagnostics.serviceWorkerReady });
    showToast('Local preferences and received history were cleared.', 'success');
  }

  function buildRefs() {
    return {
      bridgeCode: qs('#bridge-code'),
      codeExpiry: qs('#code-expiry'),
      clearLocalButton: qs('#clear-local-button'),
      clearTextButton: qs('#clear-text-button'),
      closeJoinButton: qs('#close-join-button'),
      composerCards: qsa('[data-composer]'),
      composerTabs: qsa('[data-composer-target]'),
      connectionNote: qs('#connection-note'),
      connectionStatus: qs('#connection-status'),
      diagnosticDisplay: qs('#diagnostic-display'),
      diagnosticOnline: qs('#diagnostic-online'),
      diagnosticServiceWorker: qs('#diagnostic-service-worker'),
      disconnectButton: qs('#disconnect-button'),
      fileSelection: qs('#file-selection'),
      fileWarning: qs('#file-warning'),
      genericFileInput: qs('#generic-file-input'),
      hostButton: qs('#host-button'),
      installHelp: qs('#install-help'),
      joinButton: qs('#join-button'),
      joinCodeInput: qs('#join-code-input'),
      joinSheet: qs('#join-sheet'),
      openJoinButton: qs('#open-join-button'),
      pasteTextButton: qs('#paste-text-button'),
      peerLabel: qs('#peer-label'),
      peerNote: qs('#peer-note'),
      photoCameraInput: qs('#photo-camera-input'),
      photoLibraryInput: qs('#photo-library-input'),
      photoSelection: qs('#photo-selection'),
      photoWarning: qs('#photo-warning'),
      receivedList: qs('#received-list'),
      screens: qsa('[data-screen]'),
      screenNavButtons: qsa('[data-screen-target]'),
      sendFileButton: qs('#send-file-button'),
      sendPhotoButton: qs('#send-photo-button'),
      sendTextButton: qs('#send-text-button'),
      sendVideoButton: qs('#send-video-button'),
      textInput: qs('#text-input'),
      themeToggle: qs('#theme-toggle'),
      themeToggleLabel: qs('#theme-toggle-label'),
      toastRegion: qs('#toast-region'),
      transferList: qs('#transfer-list'),
      videoCameraInput: qs('#video-camera-input'),
      videoLibraryInput: qs('#video-library-input'),
      videoSelection: qs('#video-selection'),
      videoWarning: qs('#video-warning'),
    };
  }

  refs.hostButton.addEventListener('click', handleHost);
  refs.openJoinButton.addEventListener('click', () => setJoinSheetOpen(true));
  refs.disconnectButton.addEventListener('click', handleDisconnect);
  refs.joinButton.addEventListener('click', handleJoin);
  refs.closeJoinButton.addEventListener('click', () => setJoinSheetOpen(false));
  qs('#cancel-join-button').addEventListener('click', () => setJoinSheetOpen(false));
  refs.joinCodeInput.addEventListener('input', (event) => setJoinCode(event.target.value));
  refs.textInput.addEventListener('input', (event) => setTextComposerValue(event.target.value));
  refs.pasteTextButton.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      setTextComposerValue(text);
    } catch {
      showToast('Clipboard access was blocked by the browser.', 'error');
    }
  });
  refs.clearTextButton.addEventListener('click', () => setTextComposerValue(''));
  refs.sendTextButton.addEventListener('click', handleSendText);
  refs.sendPhotoButton.addEventListener('click', () => handleSendFile('photo', 'photo'));
  refs.sendVideoButton.addEventListener('click', () => handleSendFile('video', 'video'));
  refs.sendFileButton.addEventListener('click', () => handleSendFile('file', 'file'));
  refs.themeToggle.addEventListener('change', () => {
    const nextTheme = setTheme(refs.themeToggle.checked ? 'dark' : 'light');
    store.update((state) => ({
      ...state,
      theme: nextTheme,
    }));
  });
  refs.clearLocalButton.addEventListener('click', () => {
    if (window.confirm('Clear the local theme preference and in-memory received history?')) {
      resetLocalState();
    }
  });
  refs.receivedList.addEventListener('click', (event) => {
    void handleReceivedAction(event);
  });

  qsa('[data-open-input]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = qs(`#${button.dataset.openInput}`);
      input?.click();
    });
  });

  refs.photoCameraInput.addEventListener('change', (event) => setSelectedFile('photo', event.target.files?.[0] || null));
  refs.photoLibraryInput.addEventListener('change', (event) => setSelectedFile('photo', event.target.files?.[0] || null));
  refs.videoCameraInput.addEventListener('change', (event) => setSelectedFile('video', event.target.files?.[0] || null));
  refs.videoLibraryInput.addEventListener('change', (event) => setSelectedFile('video', event.target.files?.[0] || null));
  refs.genericFileInput.addEventListener('change', (event) => setSelectedFile('file', event.target.files?.[0] || null));

  refs.screenNavButtons.forEach((button) => {
    button.addEventListener('click', () => setScreen(button.dataset.screenTarget));
  });

  refs.composerTabs.forEach((button) => {
    button.addEventListener('click', () => {
      store.update((state) => ({
        ...state,
        activeComposer: button.dataset.composerTarget,
      }));
    });
  });

  session.addEventListener('state', (event) => {
    setConnectionState(event.detail);
  });

  session.addEventListener('transfer-update', (event) => {
    addTransferUpdate(event.detail);
  });

  session.addEventListener('received', (event) => {
    void addReceivedItem(event.detail);
  });

  session.addEventListener('notice', (event) => {
    showToast(event.detail.message, event.detail.tone);
  });

  store.subscribe(render);

  refreshDiagnostics();
  render(store.getState());

  registerServiceWorker().then((result) => {
    refreshDiagnostics({ serviceWorkerReady: result.registered });
  });

  const deepLinkCode = normalizeCodeInput(new URLSearchParams(window.location.search).get('code'));
  if (deepLinkCode.length === 4) {
    setJoinCode(deepLinkCode);
    setJoinSheetOpen(true);
    showToast(`Code ${deepLinkCode} was loaded from the link.`, 'info');
  }

  window.addEventListener('online', () => refreshDiagnostics());
  window.addEventListener('offline', () => refreshDiagnostics());
  window.addEventListener('beforeunload', () => {
    revokeAllObjectUrls();
  });

  return {
    session,
    store,
  };
}