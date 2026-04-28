import { getStoredValue, setStoredValue } from './storage.js';

const THEME_KEY = 'theme';

export function resolveInitialTheme() {
  const storedTheme = getStoredValue(THEME_KEY, null);
  if (storedTheme === 'light' || storedTheme === 'dark') {
    return storedTheme;
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function setTheme(theme) {
  const normalizedTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = normalizedTheme;
  document.documentElement.style.colorScheme = normalizedTheme;
  setStoredValue(THEME_KEY, normalizedTheme);
  return normalizedTheme;
}

export function initTheme() {
  return setTheme(resolveInitialTheme());
}

export function toggleTheme(currentTheme) {
  return setTheme(currentTheme === 'dark' ? 'light' : 'dark');
}