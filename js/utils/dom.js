export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function clearChildren(element) {
  element.textContent = '';
}

export function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);
  if (options.className) {
    element.className = options.className;
  }
  if (options.text) {
    element.textContent = options.text;
  }
  if (options.html) {
    element.innerHTML = options.html;
  }
  if (options.attributes) {
    Object.entries(options.attributes).forEach(([name, value]) => {
      if (value !== undefined && value !== null) {
        element.setAttribute(name, value);
      }
    });
  }
  return element;
}

export function formatClockTime(timestamp) {
  if (!timestamp) {
    return 'Just now';
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export function formatExpiry(expiresAt) {
  if (!expiresAt) {
    return 'Temporary session';
  }

  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
  if (minutes <= 1) {
    return 'Expires in about a minute';
  }
  return `Expires in about ${minutes} minutes`;
}