/**
 * Rendering, part two: lays a `Frame` out on a grid of terminal cells and
 * returns its rows as styled text. The geometry is the one the Go Lip Gloss
 * layout used: the outer margin, rounded
 * bordered panes with one cell of padding, side by side or stacked, and
 * clipping in small windows.
 */
import chalk from 'chalk';

import { type Line, type Style, width } from './text';
import { APP_PADDING, type Body, type Frame, type Pane } from './view';

const BOLD = 1;
const DIM = 2;
const INVERSE = 4;

/** Rounded border characters (cli-boxes "round"). */
const BORDER = { topLeft: '╭', top: '─', topRight: '╮', side: '│', bottomLeft: '╰', bottom: '─', bottomRight: '╯' };

/**
 * Text that takes one cell per UTF-16 unit: `SIMPLE` in text.ts plus the box
 * drawing characters of the borders, so neither needs grapheme segmentation.
 */
const ONE_CELL = /^[\x20-\x7e -¬®-˿‐-‧‰-⁞─-╿]*$/;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function styleBits(style: Style): number {
  return (style.bold === true ? BOLD : 0) | (style.dim === true ? DIM : 0) | (style.inverse === true ? INVERSE : 0);
}

/** Styles text with chalk, which leaves it plain when the terminal takes no styles. */
function styled(text: string, bits: number): string {
  if ((bits & DIM) !== 0) {
    text = chalk.dim(text);
  }
  if ((bits & BOLD) !== 0) {
    text = chalk.bold(text);
  }
  if ((bits & INVERSE) !== 0) {
    text = chalk.inverse(text);
  }
  return text;
}

/** A clipping rectangle: [left, right) x [top, bottom). */
interface Clip {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function intersect(a: Clip, b: Clip): Clip {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

/** Terminal cells: each holds a grapheme (empty for the right half of a wide character) and its style bits. */
class Grid {
  private readonly chars: string[][] = [];
  private readonly styles: number[][] = [];

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    for (let y = 0; y < rows; y++) {
      this.chars.push(new Array<string>(columns).fill(' '));
      this.styles.push(new Array<number>(columns).fill(0));
    }
  }

  get bounds(): Clip {
    return { left: 0, top: 0, right: this.columns, bottom: this.rows };
  }

  /** Writes `text` from (x, y) rightward, dropping whatever falls outside `clip`. Returns the next x. */
  text(x: number, y: number, text: string, style: number, clip: Clip): number {
    const chars = this.chars[y];
    const styles = this.styles[y];
    if (chars === undefined || styles === undefined || y < clip.top || y >= clip.bottom) {
      return x + width(text);
    }
    if (ONE_CELL.test(text)) {
      for (let index = 0; index < text.length; index++, x++) {
        if (x >= clip.left && x < clip.right) {
          chars[x] = text.charAt(index);
          styles[x] = style;
        }
      }
      return x;
    }
    for (const { segment } of segmenter.segment(text)) {
      const cells = width(segment);
      if (cells === 0) {
        // Joins the previous cell, as the terminal draws it.
        if (x > clip.left && x - 1 < clip.right) {
          chars[x - 1] = (chars[x - 1] ?? '') + segment;
        }
        continue;
      }
      if (x >= clip.left && x + cells <= clip.right) {
        chars[x] = segment;
        styles[x] = style;
        for (let extra = 1; extra < cells; extra++) {
          chars[x + extra] = '';
          styles[x + extra] = style;
        }
      }
      x += cells;
    }
    return x;
  }

  line(x: number, y: number, line: Line, clip: Clip): void {
    for (const span of line) {
      x = this.text(x, y, span.text, styleBits(span.style), clip);
    }
  }

  /** One row as styled text, unstyled trailing blanks dropped. */
  row(y: number): string {
    const chars = this.chars[y] ?? [];
    const styles = this.styles[y] ?? [];
    let end = chars.length;
    while (end > 0 && chars[end - 1] === ' ' && styles[end - 1] === 0) {
      end--;
    }
    let out = '';
    let run = '';
    let current = 0;
    for (let x = 0; x < end; x++) {
      const style = styles[x] ?? 0;
      if (style !== current) {
        out += current === 0 ? run : styled(run, current);
        run = '';
        current = style;
      }
      run += chars[x] ?? '';
    }
    return out + (current === 0 ? run : styled(run, current));
  }
}

/** Outer size of a pane, border included (border and padding count inside the box). */
function paneBox(pane: Pane): { width: number; height: number } {
  return { width: pane.width + 2, height: Math.max(pane.height, pane.lines.length) + 4 };
}

function drawPane(grid: Grid, pane: Pane, x: number, y: number, clip: Clip): void {
  const box = paneBox(pane);
  const inner = Math.max(0, box.width - 2);
  grid.text(x, y, BORDER.topLeft + BORDER.top.repeat(inner) + BORDER.topRight, 0, clip);
  for (let row = 1; row < box.height - 1; row++) {
    grid.text(x, y + row, BORDER.side, 0, clip);
    grid.text(x + box.width - 1, y + row, BORDER.side, 0, clip);
  }
  grid.text(x, y + box.height - 1, BORDER.bottomLeft + BORDER.bottom.repeat(inner) + BORDER.bottomRight, 0, clip);
  // Text sits inside the border and the padding, cut at the padding.
  const content = intersect(clip, { left: x + 2, top: y + 2, right: x + box.width - 2, bottom: y + box.height - 2 });
  pane.lines.forEach((line, index) => grid.line(x + 2, y + 2 + index, line, content));
}

function drawBody(grid: Grid, body: Body, x: number, y: number, clip: Clip): void {
  const area = body.clipped
    ? intersect(clip, { left: x, top: y, right: x + body.width, bottom: y + body.height })
    : clip;
  drawPane(grid, body.list, x, y, area);
  const list = paneBox(body.list);
  if (body.vertical) {
    drawPane(grid, body.detail, x, y + list.height, area);
  } else {
    drawPane(grid, body.detail, x + list.width, y, area);
  }
}

/**
 * A frame's terminal rows as styled text, top to bottom, the outer margin
 * included, cut at the window's `columns`.
 */
export function frameRows(frame: Frame, columns: number): string[] {
  const height = frame.clipHeight ?? frame.height;
  const grid = new Grid(columns, height);
  const clip = grid.bounds;
  let y = APP_PADDING;
  for (const row of frame.rows) {
    if (y >= height) {
      break;
    }
    if (row.kind === 'line') {
      grid.line(APP_PADDING, y, row.line, clip);
      y += 1;
    } else {
      drawBody(grid, row.body, APP_PADDING, y, clip);
      y += row.body.height;
    }
  }
  const rows: string[] = [];
  for (let index = 0; index < height; index++) {
    rows.push(grid.row(index));
  }
  return rows;
}
