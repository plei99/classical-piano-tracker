/**
 * Translates Ink's `useInput` callbacks into key messages named the way
 * Bubble Tea v2 names them, so the reducer's key handling reads like Go's.
 */
import type { Key } from 'ink';

import type { KeyMsg } from './model';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function special(name: string, key: Key): KeyMsg {
  let prefix = '';
  if (key.ctrl) {
    prefix += 'ctrl+';
  }
  if (key.meta) {
    prefix += 'alt+';
  }
  if (key.shift) {
    prefix += 'shift+';
  }
  return { type: 'key', key: prefix + name, text: '' };
}

/** Names a single typed character, including the control bytes Ink passes through in text runs. */
function character(char: string): KeyMsg | null {
  switch (char) {
    case ' ':
      return { type: 'key', key: 'space', text: ' ' };
    case '\r':
    case '\n':
    case '\r\n':
      return { type: 'key', key: 'enter', text: '' };
    case '\t':
      return { type: 'key', key: 'tab', text: '' };
    case '\x7f':
    case '\b':
      return { type: 'key', key: 'backspace', text: '' };
  }
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x20) {
    // Other C0 controls are ctrl+letter.
    return { type: 'key', key: `ctrl+${String.fromCharCode(code + 0x60)}`, text: '' };
  }
  if (code === 0x7f || (code >= 0x80 && code < 0xa0)) {
    return null;
  }
  return { type: 'key', key: char, text: char };
}

/**
 * Converts one Ink input event into key messages. Ink delivers a run of
 * typed text (e.g. keys arriving faster than a frame) as one string, while
 * Bubble Tea reports each character separately; splitting keeps "jjj" three
 * moves and a quick "q" a quit.
 */
export function keyMessages(input: string, key: Key): KeyMsg[] {
  if (key.return) {
    return [special('enter', { ...key, shift: false })];
  }
  if (key.escape) {
    return [{ type: 'key', key: 'esc', text: '' }];
  }
  if (key.tab) {
    return [special('tab', { ...key, ctrl: false, meta: false })];
  }
  if (key.backspace) {
    return [special('backspace', key)];
  }
  if (key.delete) {
    return [special('delete', key)];
  }
  const named: [boolean, string][] = [
    [key.upArrow, 'up'],
    [key.downArrow, 'down'],
    [key.leftArrow, 'left'],
    [key.rightArrow, 'right'],
    [key.home, 'home'],
    [key.end, 'end'],
    [key.pageUp, 'pgup'],
    [key.pageDown, 'pgdown'],
  ];
  for (const [pressed, name] of named) {
    if (pressed) {
      return [special(name, key)];
    }
  }
  if (input === '') {
    return [];
  }
  if (key.ctrl) {
    return [{ type: 'key', key: `ctrl+${input.toLowerCase()}`, text: '' }];
  }
  if (key.meta) {
    return [{ type: 'key', key: `alt+${input}`, text: '' }];
  }
  const messages: KeyMsg[] = [];
  for (const { segment } of segmenter.segment(input)) {
    const message = character(segment);
    if (message !== null) {
      messages.push(message);
    }
  }
  return messages;
}
