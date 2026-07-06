export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'nc-theme';

export function getStoredTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY);
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  return 'system';
}

export function setStoredTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
}

/** Returns the resolved theme ('light' | 'dark') based on stored preference + system. */
export function resolveTheme(stored: Theme): 'light' | 'dark' {
  if (stored === 'light') return 'light';
  if (stored === 'dark') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Applies or removes the 'dark' class on <html>. */
export function applyTheme(resolved: 'light' | 'dark'): void {
  if (resolved === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}
