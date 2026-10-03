/**
 * Cell-width-aware string helpers: measuring, truncating, and wrapping text
 * the way Lip Gloss and x/ansi did in the Go build, so pane layouts line up
 * cell for cell.
 */
import stringWidth from 'string-width';

/** Text attributes the TUI uses. Lip Gloss "faint" is Ink's `dimColor`. */
export interface Style {
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly inverse?: boolean;
}

/** A run of text in one style. Styles are shared constants, so they compare by identity. */
export interface Span {
  readonly text: string;
  readonly style: Style;
}

/** One terminal row of styled spans. */
export type Line = readonly Span[];

/** Lip Gloss expands each tab to four spaces before rendering. */
const TAB = '    ';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Characters that are always one cell wide and never join a neighbor into a
 * larger grapheme cluster: printable ASCII, Latin-1 through Latin Extended-B
 * (minus the soft hyphen), and General Punctuation dashes, quotes and
 * ellipses. Nearly every classical track title ("Scherzo – Più lento") is
 * made only of these, so it can be measured and cut per UTF-16 unit instead
 * of by the much slower grapheme segmentation.
 */
const SIMPLE = /^[\x20-\x7e\u00a0-\u00ac\u00ae-\u02ff\u2010-\u2027\u2030-\u205e]*$/;

/** Terminal cell width of `value`. Control characters count as zero, as in Go. */
export function width(value: string): number {
  if (SIMPLE.test(value)) {
    return value.length;
  }
  return stringWidth(value);
}

/** Cell width of one grapheme cluster. */
function graphemeWidth(grapheme: string): number {
  if (grapheme.length === 1) {
    const code = grapheme.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) {
      return 1;
    }
  }
  return stringWidth(grapheme);
}

/** Total cell width of a styled line. */
export function lineWidth(line: Line): number {
  let cells = 0;
  for (const span of line) {
    cells += width(span.text);
  }
  return cells;
}

/** Replaces tabs with spaces, returning the input when there are none. */
export function expandTabs(value: string): string {
  return value.includes('\t') ? value.replaceAll('\t', TAB) : value;
}

/**
 * Cuts `value` to at most `maxWidth` cells, ending in "..." when there is
 * room for it (ansi.Truncate). Cutting by grapheme clusters keeps accented
 * names intact and never splits a wide character.
 */
export function truncate(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  const tail = maxWidth <= 3 ? '' : '...';
  const limit = maxWidth - tail.length;
  if (SIMPLE.test(value)) {
    return value.length <= maxWidth ? value : value.slice(0, limit) + tail;
  }
  if (stringWidth(value) <= maxWidth) {
    return value;
  }
  let used = 0;
  let end = 0;
  for (const { segment, index } of segmenter.segment(value)) {
    const cells = graphemeWidth(segment);
    if (used + cells > limit) {
      break;
    }
    used += cells;
    end = index + segment.length;
  }
  return value.slice(0, end) + tail;
}

/** Truncates user text to `maxWidth` cells after expanding tabs. */
export function fit(value: string, maxWidth: number): string {
  return truncate(expandTabs(value), maxWidth);
}

/** Go's unicode.IsSpace set, which strings.Fields splits on. */
const GO_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/**
 * Greedy word wrap used for opinions: paragraphs split on newlines, words on
 * whitespace, and a word longer than `maxWidth` stays on its own line (the
 * pane's own wrap then breaks it, as Lip Gloss did).
 */
export function wrapText(value: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || value === '') {
    return [''];
  }
  const lines: string[] = [];
  for (const paragraph of value.split('\n')) {
    const words = paragraph.split(GO_SPACE).filter((word) => word !== '');
    const first = words[0];
    if (first === undefined) {
      lines.push('');
      continue;
    }
    let line = first;
    let cells = width(first);
    for (const word of words.slice(1)) {
      const wordCells = width(word);
      if (cells + 1 + wordCells <= maxWidth) {
        line += ' ' + word;
        cells += 1 + wordCells;
        continue;
      }
      lines.push(line);
      line = word;
      cells = wordCells;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Caps `lines` at `height`, replacing the last kept line with `ellipsis`.
 * Zero or less means no limit, as in Go.
 */
export function trimLines<T>(lines: T[], height: number, ellipsis: T): T[] {
  if (height <= 0 || lines.length <= height) {
    return lines;
  }
  if (height <= 1) {
    return lines.slice(0, 1);
  }
  const trimmed = lines.slice(0, height - 1);
  trimmed.push(ellipsis);
  return trimmed;
}

/**
 * Joins key hints with a 3-space gap, starting a new line rather than
 * splitting a hint when the next one would overflow `maxWidth`.
 */
export function packHints(hints: readonly string[], maxWidth: number): string {
  let packed = '';
  let cells = 0;
  for (const hint of hints) {
    const hintCells = width(hint);
    if (cells === 0) {
      cells = hintCells;
    } else if (cells + 3 + hintCells <= maxWidth) {
      packed += '   ';
      cells += 3 + hintCells;
    } else {
      packed += '\n';
      cells = hintCells;
    }
    packed += hint;
  }
  return packed;
}

/** Unicode White_Space other than the no-break space, which x/ansi keeps inside words. */
function isBreakingSpace(grapheme: string): boolean {
  const first = grapheme.codePointAt(0);
  return first !== undefined && first !== 0xa0 && /^\s/u.test(grapheme);
}

/**
 * Port of x/ansi `Wrap(s, limit, "")`, which the Go footer applies to status
 * messages: a word wrap that also cuts words longer than the limit and
 * treats `-` as a breakpoint. Kept step-for-step identical, including the
 * different rules for ASCII and other characters, so long errors break on
 * the same columns as the Go build.
 */
export function hardWrap(value: string, limit: number): string {
  if (limit < 1) {
    return value;
  }
  let buf = '';
  let word = '';
  let space = '';
  let spaceWidth = 0;
  let curWidth = 0;
  let wordLen = 0;

  const addSpace = () => {
    curWidth += spaceWidth;
    buf += space;
    space = '';
    spaceWidth = 0;
  };
  const addWord = () => {
    if (word === '') {
      return;
    }
    addSpace();
    curWidth += wordLen;
    buf += word;
    word = '';
    wordLen = 0;
  };
  const addNewline = () => {
    buf += '\n';
    curWidth = 0;
    space = '';
    spaceWidth = 0;
  };
  // Keeps trailing spaces that still fit; drops them otherwise.
  const flushSpaces = () => {
    if (wordLen === 0) {
      if (curWidth + spaceWidth > limit) {
        curWidth = 0;
      } else {
        buf += space;
      }
      space = '';
      spaceWidth = 0;
    }
  };

  const ascii = (c: string) => {
    switch (c) {
      case '\n':
        flushSpaces();
        addWord();
        addNewline();
        return;
      case ' ':
      case '\t':
      case '\r':
      case '\v':
      case '\f':
        addWord();
        space += c;
        spaceWidth += 1;
        return;
      case '-':
        addSpace();
        if (curWidth + wordLen >= limit) {
          word += c;
          wordLen += 1;
        } else {
          addWord();
          buf += c;
          curWidth += 1;
        }
        return;
      default:
        if (curWidth === limit) {
          addNewline();
        }
        word += c;
        wordLen += 1;
        if (wordLen === limit) {
          addWord();
        }
        if (curWidth + wordLen + spaceWidth > limit) {
          addNewline();
        }
    }
  };

  const cluster = (grapheme: string) => {
    const cells = graphemeWidth(grapheme);
    if (isBreakingSpace(grapheme)) {
      addWord();
      space += grapheme;
      spaceWidth += cells;
      return;
    }
    if (wordLen + cells > limit) {
      addWord();
    }
    word += grapheme;
    wordLen += cells;
    if (curWidth + wordLen + spaceWidth > limit) {
      addNewline();
    }
    if (wordLen === limit) {
      addWord();
    }
  };

  // x/ansi steps over ASCII byte by byte and over everything else by
  // grapheme cluster; a run of non-ASCII text is segmented on its own so a
  // combining mark after an ASCII letter forms its own cluster, as in Go.
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) < 0x80) {
      ascii(value.charAt(index));
      index += 1;
      continue;
    }
    let end = index;
    while (end < value.length && value.charCodeAt(end) >= 0x80) {
      end += 1;
    }
    for (const { segment } of segmenter.segment(value.slice(index, end))) {
      cluster(segment);
    }
    index = end;
  }
  flushSpaces();
  addWord();
  return buf;
}

/** One styled grapheme, the unit `wrapLine` works on. */
interface Cell {
  readonly grapheme: string;
  readonly style: Style;
  readonly width: number;
}

/**
 * Re-wraps a styled line wider than `limit`, reproducing the word wrap Lip
 * Gloss applies to every line of a fixed-width pane (`ansi.Wrap`): break at
 * spaces and after ASCII hyphens, hard-break words longer than the limit,
 * and drop spaces that land on a break.
 *
 * The Go layout only overflows in rare cases (a selected row with a
 * three-digit track ID, where the trailing highlight space is dropped, or a
 * help line in a narrow detail pane), so this is never on the hot path.
 */
export function wrapLine(line: Line, limit: number): Line[] {
  const cells: Cell[] = [];
  for (const span of line) {
    for (const { segment } of segmenter.segment(span.text)) {
      cells.push({ grapheme: segment, style: span.style, width: graphemeWidth(segment) });
    }
  }
  if (limit <= 0) {
    return [styledLine(cells)];
  }

  const lines: Cell[][] = [[]];
  let word: Cell[] = [];
  let space: Cell[] = [];
  let spaceWidth = 0;
  let lineCells = 0;
  let wordWidth = 0;
  const current = (): Cell[] => lines[lines.length - 1] as Cell[];

  const addSpace = () => {
    if (spaceWidth === 0 && space.length === 0) {
      return;
    }
    lineCells += spaceWidth;
    current().push(...space);
    space = [];
    spaceWidth = 0;
  };
  const addWord = () => {
    if (word.length === 0) {
      return;
    }
    addSpace();
    lineCells += wordWidth;
    current().push(...word);
    word = [];
    wordWidth = 0;
  };
  const addNewline = () => {
    lines.push([]);
    lineCells = 0;
    space = [];
    spaceWidth = 0;
  };

  for (const cell of cells) {
    const ascii = cell.grapheme.length === 1 && cell.grapheme.charCodeAt(0) < 0x80;
    if (!ascii) {
      if (isBreakingSpace(cell.grapheme)) {
        addWord();
        spaceWidth += cell.width;
        space.push(cell);
        continue;
      }
      if (wordWidth + cell.width > limit) {
        addWord();
      }
      wordWidth += cell.width;
      word.push(cell);
      if (lineCells + wordWidth + spaceWidth > limit) {
        addNewline();
      }
      if (wordWidth === limit) {
        addWord();
      }
      continue;
    }

    if (/\s/.test(cell.grapheme)) {
      addWord();
      spaceWidth += 1;
      space.push(cell);
    } else if (cell.grapheme === '-') {
      addSpace();
      if (lineCells + wordWidth >= limit) {
        wordWidth += 1;
        word.push(cell);
      } else {
        addWord();
        lineCells += 1;
        current().push(cell);
      }
    } else {
      if (lineCells === limit) {
        addNewline();
      }
      wordWidth += 1;
      word.push(cell);
      if (wordWidth === limit) {
        addWord();
      }
      if (lineCells + wordWidth + spaceWidth > limit) {
        addNewline();
      }
    }
  }

  if (wordWidth === 0) {
    if (lineCells + spaceWidth <= limit) {
      // Trailing spaces that still fit are preserved.
      current().push(...space);
    }
    space = [];
    spaceWidth = 0;
  }
  addWord();
  return lines.map(styledLine);
}

/** Rebuilds spans from cells, merging runs that share a style. */
function styledLine(cells: readonly Cell[]): Line {
  const spans: Span[] = [];
  let text = '';
  let style: Style | undefined;
  for (const cell of cells) {
    if (cell.style !== style) {
      if (style !== undefined) {
        spans.push({ text, style });
      }
      text = '';
      style = cell.style;
    }
    text += cell.grapheme;
  }
  if (style !== undefined) {
    spans.push({ text, style });
  }
  return spans;
}

/**
 * Cuts a styled line to `maxWidth` cells with no ellipsis, the way the
 * terminal renderer drops whatever falls past the window edge.
 */
export function clipLine(line: Line, maxWidth: number): Line {
  if (lineWidth(line) <= maxWidth) {
    return line;
  }
  const clipped: Span[] = [];
  let room = Math.max(0, maxWidth);
  for (const span of line) {
    if (room === 0) {
      break;
    }
    const cells = width(span.text);
    if (cells <= room) {
      clipped.push(span);
      room -= cells;
      continue;
    }
    let text = '';
    for (const { segment } of segmenter.segment(span.text)) {
      const segmentCells = graphemeWidth(segment);
      if (segmentCells > room) {
        break;
      }
      text += segment;
      room -= segmentCells;
    }
    clipped.push({ text, style: span.style });
    break;
  }
  return clipped;
}

export { dropLastRune } from '../app/strings';
