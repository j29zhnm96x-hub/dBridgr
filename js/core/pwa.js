const SW_VERSION = '2026-04-28-3';

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return { supported: false, registered: false };
  }

  try {
    const registration = await navigator.serviceWorker.register(`./sw.js?v=${SW_VERSION}`, { scope: './' });
    return { supported: true, registered: true, registration };
  } catch (error) {
    return { supported: true, registered: false, error };
  }
}

export function isStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function isIos() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent) || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
}

export function getInstallHelpText() {
  if (isIos()) {
    return isStandaloneMode()
      ? 'dBridgr is already running from your home screen.'
      : 'Open dBridgr in Safari, tap Share, then choose Add to Home Screen.';
  }

  return isStandaloneMode()
    ? 'dBridgr is already installed as an app shell.'
    : 'Use your browser menu and choose Install App or Add to Home Screen for a standalone launch experience.';
}

export function getDiagnosticsSnapshot() {
  return {
    online: navigator.onLine,
    standalone: isStandaloneMode(),
    ios: isIos(),
  };
}