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

function isReviveRecommendedError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /not connected yet|Pair both devices before sending content/i.test(message);
}

function getFirstImageFile(source) {
  if (!source) {
    return null;
  }

  for (const entry of Array.from(source)) {
    if (entry instanceof File && entry.type.startsWith('image/')) {
      return entry;
    }

    if (entry.kind === 'file') {
      const file = typeof entry.getAsFile === 'function' ? entry.getAsFile() : null;
      if (file?.type?.startsWith('image/')) {
        return file;
      }
    }
  }

  return null;
}

function isTextEntryElement(target) {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || Boolean(target?.isContentEditable);
}

function clipboardHasPlainText(clipboardData) {
  return Array.from(clipboardData?.types || []).some((type) => type === 'text/plain' || type === 'text/html');
}

async function readClipboardImageFile() {
  if (!navigator.clipboard?.read) {
    return null;
  }

  const clipboardItems = await navigator.clipboard.read();
  for (const item of clipboardItems) {
    const imageType = item.types.find((type) => type.startsWith('image/'));
    if (!imageType) {
      continue;
    }

    const blob = await item.getType(imageType);
    const extension = imageType.split('/')[1] || 'png';
    return new File([blob], `clipboard-image.${extension}`, { type: blob.type || imageType });
  }

  return null;
}

async function readClipboardFile() {
  if (!navigator.clipboard?.read) {
    return null;
  }

  const clipboardItems = await navigator.clipboard.read();
  for (const item of clipboardItems) {
    const fileType = item.types.find((type) => !type.startsWith('text/'));
    if (!fileType) {
      continue;
    }

    const blob = await item.getType(fileType);
    const subtype = fileType.split('/')[1] || 'bin';
    const extension = /^[a-z0-9-]+$/i.test(subtype) && subtype.length <= 12 ? subtype : 'bin';
    return new File([blob], `clipboard-file.${extension}`, { type: blob.type || fileType });
  }

  return null;
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
  let photoPreviewRestoreFocus = null;

  // Disable double-tap-to-zoom on touch devices (fallback for iOS Safari)
  if (typeof window !== 'undefined' && 'ontouchstart' in window) {
    let __dbridgr_lastTouch = 0;
    document.addEventListener('touchend', function (e) {
      const now = Date.now();
      if (now - __dbridgr_lastTouch <= 300) {
        const tag = e.target && e.target.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !e.target.isContentEditable) {
          e.preventDefault();
        }
      }
      __dbridgr_lastTouch = now;
    }, { passive: false });
  }

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

  function setActiveComposer(activeComposer) {
    store.update((state) => ({
      ...state,
      activeComposer,
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
          return 'Tap Paste Photo, or use the camera/library buttons.';
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

  function openPhotoPreview(item, triggerElement) {
    if (!item || item.kind !== 'photo' || !item.objectUrl) {
      return;
    }

    photoPreviewRestoreFocus = triggerElement instanceof HTMLElement ? triggerElement : null;
    refs.photoPreviewTitle.textContent = item.name || 'Photo preview';
    refs.photoPreviewImage.alt = item.name || 'Previewed photo';
    refs.photoPreviewImage.src = item.objectUrl;
    refs.photoPreviewMeta.textContent = `${formatBytes(item.size)} • ${item.mimeType || 'image/*'} • Received ${formatClockTime(item.receivedAt)}`;
    refs.photoPreviewBackdrop.hidden = false;
    window.setTimeout(() => refs.closePhotoPreviewButton.focus(), 0);
  }

  function closePhotoPreview(restoreFocus = true) {
    refs.photoPreviewImage.removeAttribute('src');
    refs.photoPreviewImage.alt = '';
    refs.photoPreviewMeta.textContent = '';
    refs.photoPreviewBackdrop.hidden = true;

    const restoreTarget = photoPreviewRestoreFocus;
    photoPreviewRestoreFocus = null;
    if (restoreFocus && restoreTarget instanceof HTMLElement) {
      window.setTimeout(() => restoreTarget.focus(), 0);
    }
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
    const reviveHint = connection.status === 'connected' || connection.status === 'reconnecting'
      ? ' If the phone slept and sending stalls, tap Revive Bridge.'
      : '';
    refs.connectionNote.textContent = `${connection.error || connection.note}${reviveHint}`;

    refs.disconnectButton.disabled = connection.status === 'idle';
    refs.reviveBridgeButton.disabled = connection.status === 'idle';
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
          ? 'No photo selected yet. Tap Paste Photo, take one, or choose from library.'
          : kind === 'video'
            ? 'No video selected yet.'
            : 'No file selected yet. Tap Paste File or choose a file.',
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

    refs.photoWarning.textContent = state.composers.photo.warning || 'Tap Paste Photo, or use the camera/library buttons.';
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
        text: 'No transfer history yet.',
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
      const previewButton = createElement('button', {
        className: 'received-card__media-button',
        attributes: {
          'aria-label': `Preview ${item.name}`,
          'data-action': 'preview-photo',
          'data-item-id': item.id,
          title: 'Open photo preview',
          type: 'button',
        },
      });
      previewButton.append(createElement('img', {
        className: 'received-card__media',
        attributes: {
          alt: item.name,
          src: item.objectUrl,
        },
      }));
      card.append(previewButton);
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

  async function handleReviveBridge() {
    try {
      if (store.getState().connection.status === 'idle') {
        showToast('Host or join a bridge first.', 'error');
        return;
      }

      await session.revive();
    } catch (error) {
      showToast(error?.message || 'Could not revive the bridge.', 'error');
    }
  }

  async function handleClearSession() {
    const confirmed = window.confirm('Clear all sent and received data? This erases transfer history, current drafts, and selected media while keeping the bridge connection active.');
    if (!confirmed) {
      return;
    }

    clearHistoryState();
    showToast('All sent and received data cleared.', 'success');
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
      if (isReviveRecommendedError(error) && store.getState().connection.status !== 'idle') {
        showToast('The bridge may be asleep. Tap Revive Bridge, then try again.', 'error');
        refs.reviveBridgeButton.focus();
        return;
      }

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
      if (isReviveRecommendedError(error) && store.getState().connection.status !== 'idle') {
        showToast('The bridge may be asleep. Tap Revive Bridge, then try again.', 'error');
        refs.reviveBridgeButton.focus();
        return;
      }

      showToast(error.message || `Could not send that ${noun}.`, 'error');
    }
  }

  async function handlePastePhoto() {
    try {
      const imageFile = await readClipboardImageFile();
      if (!imageFile) {
        showToast('No image was found in the clipboard. Copy a photo first, then tap Paste Photo.', 'error');
        return;
      }

      void applyIncomingPhotoFile(imageFile, 'Photo pasted. Tap Bridge It when ready.');
    } catch (error) {
      showToast(error?.message || 'Clipboard image paste is not available here.', 'error');
    }
  }

  async function handlePasteFile() {
    try {
      const file = await readClipboardFile();
      if (!file) {
        showToast('No file was found in the clipboard. Copy a file first, then tap Paste File.', 'error');
        return;
      }

      setScreen('bridge');
      setActiveComposer('file');
      setSelectedFile('file', file);
      showToast('File pasted. Tap Bridge It when ready.', 'success');
    } catch (error) {
      showToast(error?.message || 'Clipboard file paste is not available here.', 'error');
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

    if (actionTarget.dataset.action === 'preview-photo') {
      openPhotoPreview(item, actionTarget);
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

  function applyIncomingPhotoFile(file, message) {
    if (!file) {
      return false;
    }

    setScreen('bridge');
    setActiveComposer('photo');
    setSelectedFile('photo', file);
    if (message) {
      showToast(message, 'success');
    }
    return true;
  }

  function clearHistoryState() {
    const state = store.getState();
    closePhotoPreview(false);
    revokeRemovedReceivedItems(state.receivedItems, []);
    setTextComposerValue('');
    setSelectedFile('photo', null);
    setSelectedFile('video', null);
    setSelectedFile('file', null);
    refs.photoCameraInput.value = '';
    refs.photoLibraryInput.value = '';
    refs.videoCameraInput.value = '';
    refs.videoLibraryInput.value = '';
    refs.genericFileInput.value = '';
    store.update((currentState) => ({
      ...currentState,
      activeTransfers: [],
      receivedItems: [],
    }));
    refreshDiagnostics({ serviceWorkerReady: state.diagnostics.serviceWorkerReady });
  }

  function buildRefs() {
    return {
      bridgeCode: qs('#bridge-code'),
      codeExpiry: qs('#code-expiry'),
      clearSessionButton: qs('#clear-session-button'),
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
      pastePhotoButton: qs('#paste-photo-button'),
      peerLabel: qs('#peer-label'),
      peerNote: qs('#peer-note'),
      photoCameraInput: qs('#photo-camera-input'),
      photoLibraryInput: qs('#photo-library-input'),
      photoPreviewBackdrop: qs('#photo-preview-backdrop'),
      photoPreviewImage: qs('#photo-preview-image'),
      photoPreviewMeta: qs('#photo-preview-meta'),
      photoPreviewTitle: qs('#photo-preview-title'),
      photoComposer: qs('[data-composer="photo"]'),
      photoSelection: qs('#photo-selection'),
      photoWarning: qs('#photo-warning'),
      receivedList: qs('#received-list'),
      screens: qsa('[data-screen]'),
      screenNavButtons: qsa('[data-screen-target]'),
      reviveBridgeButton: qs('#revive-bridge-button'),
      pasteFileButton: qs('#paste-file-button'),
      sendFileButton: qs('#send-file-button'),
      sendPhotoButton: qs('#send-photo-button'),
      sendTextButton: qs('#send-text-button'),
      sendVideoButton: qs('#send-video-button'),
      textInput: qs('#text-input'),
      themeToggle: qs('#theme-toggle'),
      themeToggleLabel: qs('#theme-toggle-label'),
      closePhotoPreviewButton: qs('#close-photo-preview-button'),
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
  refs.reviveBridgeButton.addEventListener('click', () => {
    void handleReviveBridge();
  });
  refs.disconnectButton.addEventListener('click', handleDisconnect);
  refs.joinButton.addEventListener('click', handleJoin);
  refs.closeJoinButton.addEventListener('click', () => setJoinSheetOpen(false));
  qs('#cancel-join-button')?.addEventListener('click', () => setJoinSheetOpen(false));
  refs.joinCodeInput.addEventListener('input', (event) => setJoinCode(event.target.value));
  refs.textInput.addEventListener('input', (event) => setTextComposerValue(event.target.value));
  refs.closePhotoPreviewButton.addEventListener('click', () => closePhotoPreview());
  refs.photoPreviewBackdrop.addEventListener('click', (event) => {
    if (event.target === refs.photoPreviewBackdrop) {
      closePhotoPreview();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !refs.photoPreviewBackdrop.hidden) {
      closePhotoPreview();
    }
  });
  refs.pastePhotoButton.addEventListener('click', () => {
    void handlePastePhoto();
  });
  refs.pasteFileButton.addEventListener('click', () => {
    void handlePasteFile();
  });
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
  refs.clearSessionButton.addEventListener('click', () => {
    void handleClearSession();
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
      setActiveComposer(button.dataset.composerTarget);
    });
  });

  document.addEventListener('paste', (event) => {
    const clipboardData = event.clipboardData;
    const imageFile = getFirstImageFile(clipboardData?.items) || getFirstImageFile(clipboardData?.files);
    if (!imageFile) {
      return;
    }

    if (isTextEntryElement(event.target) && clipboardHasPlainText(clipboardData)) {
      return;
    }

    event.preventDefault();
    void applyIncomingPhotoFile(imageFile, 'Photo pasted. Tap Bridge It when ready.');
  });

  document.addEventListener('dragover', (event) => {
    const imageFile = getFirstImageFile(event.dataTransfer?.items) || getFirstImageFile(event.dataTransfer?.files);
    if (!imageFile) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  });

  document.addEventListener('drop', (event) => {
    const imageFile = getFirstImageFile(event.dataTransfer?.items) || getFirstImageFile(event.dataTransfer?.files);
    if (!imageFile) {
      return;
    }

    event.preventDefault();
    void applyIncomingPhotoFile(imageFile, 'Photo dropped. Tap Bridge It when ready.');
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