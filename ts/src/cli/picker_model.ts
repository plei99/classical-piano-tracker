/**
 * The onboarding pickers as pure state machines: a multi-select for the
 * pianist allowlist and a single-choice list for the LLM provider and model.
 * They mirror the Go build's small Bubble Tea models (same keys, layout,
 * scrolling window, and overflow hints), so tests drive them without a
 * terminal; picker_ink.tsx is the only part that touches one.
 */
import stringWidth from 'string-width';

/** The height and width assumed before the terminal reports its size. */
const DEFAULT_HEIGHT = 24;
const DEFAULT_WIDTH = 80;

/**
 * Input to a picker. Key names follow Bubble Tea's `KeyPressMsg.String()`
 * ("up", "k", "space", "enter", "ctrl+c", ...); anything else is ignored.
 */
export type PickerMsg = { type: 'key'; key: string } | { type: 'resize'; width: number; height: number };

/** One rendered row; the cursor row is bold. */
export interface ViewLine {
  text: string;
  bold: boolean;
}

export interface Update<M> {
  model: M;
  /** The picker is finished (confirmed or canceled). */
  quit: boolean;
}

interface Window<T> {
  visible: T[];
  offset: number;
  hiddenAbove: boolean;
  hiddenBelow: boolean;
}

/**
 * The slice of a list that fits on screen when `reserved` rows go to
 * headers, keeping the cursor centered when possible so long lists stay
 * usable in small terminals.
 */
function visibleWindow<T>(items: readonly T[], cursor: number, height: number, reserved: number): Window<T> {
  if (items.length === 0) {
    return { visible: [], offset: 0, hiddenAbove: false, hiddenBelow: false };
  }
  const rows = height <= 0 ? DEFAULT_HEIGHT : height;
  const available = Math.min(Math.max(rows - reserved, 3), items.length);
  let start = Math.max(cursor - Math.trunc(available / 2), 0);
  if (start + available > items.length) {
    start = Math.max(items.length - available, 0);
  }
  const end = Math.min(start + available, items.length);
  return { visible: items.slice(start, end), offset: start, hiddenAbove: start > 0, hiddenBelow: end < items.length };
}

/** lipgloss MaxWidth: cuts a line to `width` terminal cells without an ellipsis. */
export function truncateToWidth(text: string, width: number): string {
  if (stringWidth(text) <= width) {
    return text;
  }
  let out = '';
  let used = 0;
  for (const char of text) {
    const w = stringWidth(char);
    if (used + w > width) {
      break;
    }
    out += char;
    used += w;
  }
  return out;
}

function windowLines<T>(
  lines: ViewLine[],
  total: number,
  win: Window<T>,
  width: number,
  cursor: number,
  row: (item: T, idx: number) => string,
): void {
  const maxWidth = width <= 0 ? DEFAULT_WIDTH : width;
  if (win.hiddenAbove) {
    lines.push({ text: `  ... ${win.offset} more above`, bold: false });
  }
  win.visible.forEach((item, i) => {
    const idx = win.offset + i;
    lines.push({ text: truncateToWidth(row(item, idx), maxWidth), bold: idx === cursor });
  });
  if (win.hiddenBelow) {
    lines.push({ text: `  ... ${total - (win.offset + win.visible.length)} more below`, bold: false });
  }
}

/** The plain-text frame (Bubble Tea's `View().Content` without styling). */
export function renderLines(lines: ViewLine[]): string {
  return lines.map((line) => `${line.text}\n`).join('');
}

// ---- Pianist multi-select ----

export interface PianistSelectionModel {
  readonly pianists: readonly string[];
  readonly selected: ReadonlySet<number>;
  readonly cursor: number;
  readonly canceled: boolean;
  readonly width: number;
  readonly height: number;
}

/**
 * Starts with every pianist selected, so confirming right away keeps the
 * full default list.
 */
export function newPianistSelectionModel(pianists: readonly string[]): PianistSelectionModel {
  return {
    pianists: [...pianists],
    selected: new Set(pianists.map((_, idx) => idx)),
    cursor: 0,
    canceled: false,
    width: 0,
    height: 0,
  };
}

export function updatePianistSelection(m: PianistSelectionModel, msg: PickerMsg): Update<PianistSelectionModel> {
  if (msg.type === 'resize') {
    return { model: { ...m, width: msg.width, height: msg.height }, quit: false };
  }
  switch (msg.key) {
    case 'ctrl+c':
    case 'q':
      return { model: { ...m, canceled: true }, quit: true };
    case 'up':
    case 'k':
      return { model: { ...m, cursor: Math.max(m.cursor - 1, 0) }, quit: false };
    case 'down':
    case 'j':
      return { model: { ...m, cursor: m.cursor < m.pianists.length - 1 ? m.cursor + 1 : m.cursor }, quit: false };
    case 'space': {
      const selected = new Set(m.selected);
      if (!selected.delete(m.cursor)) {
        selected.add(m.cursor);
      }
      return { model: { ...m, selected }, quit: false };
    }
    case 'enter':
      return { model: m, quit: true };
    default:
      return { model: m, quit: false };
  }
}

export function visiblePianists(m: PianistSelectionModel): Window<string> {
  return visibleWindow(m.pianists, m.cursor, m.height, 6);
}

export function pianistSelectionLines(m: PianistSelectionModel): ViewLine[] {
  const total = m.pianists.length;
  const lines: ViewLine[] = [
    { text: 'Select pianists for the initial allowlist.', bold: false },
    { text: 'Up/down or j/k: move   space: toggle   enter: confirm   q: cancel', bold: false },
    { text: `Selected: ${m.selected.size} of ${total}   Current: ${m.cursor + 1} of ${total}`, bold: false },
    { text: '', bold: false },
  ];
  windowLines(lines, total, visiblePianists(m), m.width, m.cursor, (pianist, idx) => {
    const cursor = idx === m.cursor ? '>' : ' ';
    const check = m.selected.has(idx) ? 'x' : ' ';
    return `${cursor} [${check}] ${pianist}`;
  });
  if (m.selected.size === 0) {
    lines.push({ text: '', bold: false }, { text: 'Select at least one pianist before confirming.', bold: false });
  }
  return lines;
}

/** The selection in original display order, ready for the allowlist. */
export function selectedPianists(m: PianistSelectionModel): string[] {
  if (m.pianists.length === 0) {
    throw new Error('selection source must not be empty');
  }
  if (m.selected.size === 0) {
    throw new Error('selection must include at least one pianist');
  }
  return m.pianists.filter((_, idx) => m.selected.has(idx));
}

// ---- Single choice ----

export interface SingleChoiceModel {
  readonly title: string;
  readonly help: string;
  readonly options: readonly string[];
  readonly cursor: number;
  readonly canceled: boolean;
  readonly width: number;
  readonly height: number;
}

export function newSingleChoiceModel(
  title: string,
  help: string,
  options: readonly string[],
  initial: number,
): SingleChoiceModel {
  return {
    title,
    help,
    options: [...options],
    cursor: initial < 0 || initial >= options.length ? 0 : initial,
    canceled: false,
    width: 0,
    height: 0,
  };
}

export function updateSingleChoice(m: SingleChoiceModel, msg: PickerMsg): Update<SingleChoiceModel> {
  if (msg.type === 'resize') {
    return { model: { ...m, width: msg.width, height: msg.height }, quit: false };
  }
  switch (msg.key) {
    case 'ctrl+c':
    case 'q':
      return { model: { ...m, canceled: true }, quit: true };
    case 'up':
    case 'k':
      return { model: { ...m, cursor: Math.max(m.cursor - 1, 0) }, quit: false };
    case 'down':
    case 'j':
      return { model: { ...m, cursor: m.cursor < m.options.length - 1 ? m.cursor + 1 : m.cursor }, quit: false };
    case 'enter':
      return { model: m, quit: true };
    default:
      return { model: m, quit: false };
  }
}

export function visibleOptions(m: SingleChoiceModel): Window<string> {
  return visibleWindow(m.options, m.cursor, m.height, 5);
}

export function singleChoiceLines(m: SingleChoiceModel): ViewLine[] {
  const total = m.options.length;
  const lines: ViewLine[] = [
    { text: m.title, bold: false },
    { text: m.help, bold: false },
  ];
  if (total > 0) {
    lines.push({ text: `Current: ${m.cursor + 1} of ${total}`, bold: false }, { text: '', bold: false });
  }
  windowLines(lines, total, visibleOptions(m), m.width, m.cursor, (option, idx) => {
    return `${idx === m.cursor ? '>' : ' '} ${option}`;
  });
  return lines;
}

/** The confirmed option (Go's post-run checks in runSingleChoiceSelection). */
export function chosenOption(m: SingleChoiceModel): string {
  const option = m.options[m.cursor];
  if (option === undefined) {
    throw new Error(`selection cursor ${m.cursor} out of range`);
  }
  return option;
}
