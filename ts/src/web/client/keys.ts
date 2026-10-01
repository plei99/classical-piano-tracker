/**
 * Browser key events, named the way the shared model expects (Bubble Tea's
 * key names, as the TUI produces them), so `j`, `/`, `enter`, `esc` and the
 * rest mean the same thing in both front ends.
 */
import type { KeyMsg } from '../../app/model';

const named: Record<string, string> = {
  Enter: 'enter',
  Escape: 'esc',
  Tab: 'tab',
  Backspace: 'backspace',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pgup',
  PageDown: 'pgdown',
  Delete: 'delete',
  ' ': 'space',
};

/** Translates a keydown into a model key message, or null for keys the model never sees. */
export function keyMessage(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): KeyMsg | null {
  // Browser and OS shortcuts (copy, reload, tab switching) stay theirs.
  if (event.metaKey || event.altKey) {
    return null;
  }
  const name = named[event.key];
  if (name !== undefined) {
    const key = event.shiftKey && name === 'tab' ? 'shift+tab' : event.ctrlKey ? `ctrl+${name}` : name;
    return { type: 'key', key, text: name === 'space' && !event.ctrlKey ? ' ' : '' };
  }
  if (event.key.length !== 1 && [...event.key].length !== 1) {
    // Modifier and function keys.
    return null;
  }
  if (event.ctrlKey) {
    return { type: 'key', key: `ctrl+${event.key.toLowerCase()}`, text: '' };
  }
  return { type: 'key', key: event.key, text: event.key };
}
