const PREFIX = 'dbridgr:';

function keyFor(name) {
  return `${PREFIX}${name}`;
}

export function getStoredValue(name, fallback = null) {
  try {
    const rawValue = window.localStorage.getItem(keyFor(name));
    return rawValue === null ? fallback : JSON.parse(rawValue);
  } catch {
    return fallback;
  }
}

export function setStoredValue(name, value) {
  try {
    window.localStorage.setItem(keyFor(name), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeStoredValue(name) {
  try {
    window.localStorage.removeItem(keyFor(name));
  } catch {
    // Ignore localStorage access issues.
  }
}

export function clearStoredNamespace() {
  try {
    const keys = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const currentKey = window.localStorage.key(index);
      if (currentKey && currentKey.startsWith(PREFIX)) {
        keys.push(currentKey);
      }
    }
    keys.forEach((storedKey) => window.localStorage.removeItem(storedKey));
  } catch {
    // Ignore localStorage access issues.
  }
}