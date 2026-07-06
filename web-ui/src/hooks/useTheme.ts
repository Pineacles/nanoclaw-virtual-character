import { useCallback, useEffect, useState } from 'react';
import {
  type Theme,
  getStoredTheme,
  setStoredTheme,
  resolveTheme,
  applyTheme,
} from '../lib/theme';

export function useTheme() {
  const [stored, setStored] = useState<Theme>(getStoredTheme);
  const resolved = resolveTheme(stored);

  // Apply .dark class whenever resolved theme changes
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // Also apply on mount immediately (before first paint)
  useEffect(() => {
    applyTheme(resolveTheme(getStoredTheme()));
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setStoredTheme(t);
    setStored(t);
  }, []);

  const toggle = useCallback(() => {
    setTheme(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setTheme]);

  return { theme: stored, resolved, setTheme, toggle };
}
