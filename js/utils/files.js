const trackedObjectUrls = new Set();

export function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** exponent);
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function normalizeCodeInput(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 4);
}

export function buildSelectionMetadata(file) {
  if (!file) {
    return null;
  }

  return {
    name: file.name || 'Untitled',
    size: file.size || 0,
    mimeType: file.type || 'application/octet-stream',
    lastModified: file.lastModified || Date.now(),
  };
}

export function createObjectUrl(blob) {
  const objectUrl = URL.createObjectURL(blob);
  trackedObjectUrls.add(objectUrl);
  return objectUrl;
}

export function revokeObjectUrl(objectUrl) {
  if (!objectUrl) {
    return;
  }
  if (trackedObjectUrls.has(objectUrl)) {
    trackedObjectUrls.delete(objectUrl);
  }
  URL.revokeObjectURL(objectUrl);
}

export function revokeAllObjectUrls() {
  trackedObjectUrls.forEach((objectUrl) => URL.revokeObjectURL(objectUrl));
  trackedObjectUrls.clear();
}

export function downloadBlob(blob, filename) {
  const objectUrl = createObjectUrl(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename || 'download';
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => revokeObjectUrl(objectUrl), 1500);
}

export async function shareBlob({ blob, filename, title, text }) {
  if (!navigator.share) {
    return false;
  }

  const files = blob ? [new File([blob], filename || 'dbridgr-file', { type: blob.type || 'application/octet-stream' })] : undefined;
  const sharePayload = { title, text };

  if (files && navigator.canShare?.({ files })) {
    sharePayload.files = files;
  }

  try {
    await navigator.share(sharePayload);
    return true;
  } catch {
    return false;
  }
}

export async function blobToText(blob) {
  return new TextDecoder().decode(await blob.arrayBuffer());
}

export function buildTextDownloadName() {
  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  return `dbridgr-text-${timestamp}.txt`;
}

export function supportsClipboardRead() {
  return Boolean(navigator.clipboard?.readText);
}