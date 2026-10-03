/**
 * Light/dark appearance. "auto" follows the operating system; an explicit
 * choice is remembered in the THEME_COOKIE cookie, which the server reads
 * to render `<html data-theme>` and the switch, so the page never flashes
 * the wrong theme and needs no boot script.
 */
import { useCallback, useEffect, useState } from 'react';

import { THEME_COOKIE } from '../api';

export type ThemeChoice = 'auto' | 'light' | 'dark';

/** Anything unrecognized is auto. */
export function parseTheme(value: string | undefined | null): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'auto';
}

/** The choice in a Cookie header (or `document.cookie`). */
export function themeFromCookies(header: string | undefined): ThemeChoice {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq >= 0 && part.slice(0, eq).trim() === THEME_COOKIE) {
      return parseTheme(part.slice(eq + 1).trim());
    }
  }
  return 'auto';
}

/** The Set-Cookie value (and `document.cookie` assignment) for a choice. */
export function themeCookie(choice: ThemeChoice): string {
  return `${THEME_COOKIE}=${choice}; Path=/; Max-Age=31536000; SameSite=Strict`;
}

/** What the server rendered: `data-theme` is absent for auto. */
export function renderedTheme(root: HTMLElement = document.documentElement): ThemeChoice {
  return parseTheme(root.dataset['theme']);
}

/** Sets `data-theme` on <html>; "auto" removes it so the media query decides. */
export function applyTheme(choice: ThemeChoice, root: HTMLElement = document.documentElement): void {
  if (choice === 'auto') {
    delete root.dataset['theme'];
  } else {
    root.dataset['theme'] = choice;
  }
}

/** Starts from the server-rendered choice, so the first client render matches the page. */
export function useTheme(initial: ThemeChoice): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(initial);
  useEffect(() => applyTheme(choice), [choice]);
  const choose = useCallback((next: ThemeChoice) => {
    document.cookie = themeCookie(next);
    setChoice(next);
  }, []);
  return [choice, choose];
}
