/**
 * Light/dark appearance. "auto" follows the operating system; an explicit
 * choice is remembered per browser. The early script in theme-boot.ts
 * applies the saved choice before first paint so the page never flashes.
 */
import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'auto' | 'light' | 'dark';

export const THEME_KEY = 'tracker-theme';

export function readTheme(storage: Pick<Storage, 'getItem'> = localStorage): ThemeChoice {
  try {
    const saved = storage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'auto';
  } catch {
    return 'auto';
  }
}

/** Sets `data-theme` on <html>; "auto" removes it so the media query decides. */
export function applyTheme(choice: ThemeChoice, root: HTMLElement = document.documentElement): void {
  if (choice === 'auto') {
    delete root.dataset['theme'];
  } else {
    root.dataset['theme'] = choice;
  }
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => readTheme());
  useEffect(() => applyTheme(choice), [choice]);
  const choose = useCallback((next: ThemeChoice) => {
    try {
      if (next === 'auto') {
        localStorage.removeItem(THEME_KEY);
      } else {
        localStorage.setItem(THEME_KEY, next);
      }
    } catch {
      // Private mode: the choice still applies for this visit.
    }
    setChoice(next);
  }, []);
  return [choice, choose];
}
