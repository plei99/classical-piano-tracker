/**
 * A port of the subset of Go's text/tabwriter the CLI uses:
 * `tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)`.
 *
 * Cells are tab-terminated; the text after a line's last tab is not part of
 * any column. A column's width is set per *block*: a run of consecutive lines
 * that all have a cell in that column. Widths count runes, as Go does.
 */
import { runeCount } from './gostr';

/** Minwidth 0, tabwidth 0, padding 2, space padding, no flags. */
export class TabWriter {
  private buffer = '';

  constructor(private readonly padding = 2) {}

  write(text: string): void {
    this.buffer += text;
  }

  /** Returns the aligned text and clears the buffer. */
  flush(): string {
    const text = this.buffer;
    this.buffer = '';
    return align(text, this.padding);
  }
}

function align(text: string, padding: number): string {
  const lines = text.split('\n').map((line) => line.split('\t'));
  const out: string[] = [];
  formatBlock(lines, 0, lines.length, [], padding, out);
  return out.join('');
}

/**
 * Go's `Writer.format`: finds each block for the next column, recursing to
 * the right once that column's width is known.
 */
function formatBlock(
  lines: string[][],
  line0: number,
  line1: number,
  widths: number[],
  padding: number,
  out: string[],
): void {
  const column = widths.length;
  const hasCell = (line: string[]) => column + 1 < line.length;
  let current = line0;
  while (current < line1) {
    if (!hasCell(lines[current]!)) {
      current++;
      continue;
    }
    writeLines(lines, line0, current, widths, out);
    line0 = current;

    let width = 0;
    while (current < line1 && hasCell(lines[current]!)) {
      width = Math.max(width, runeCount(lines[current]![column]!) + padding);
      current++;
    }

    widths.push(width);
    formatBlock(lines, line0, current, widths, padding, out);
    widths.pop();
    line0 = current;
  }
  writeLines(lines, line0, line1, widths, out);
}

function writeLines(lines: string[][], line0: number, line1: number, widths: number[], out: string[]): void {
  for (let idx = line0; idx < line1; idx++) {
    const line = lines[idx]!;
    line.forEach((cell, col) => {
      out.push(cell);
      const width = widths[col];
      if (width !== undefined) {
        out.push(' '.repeat(Math.max(0, width - runeCount(cell))));
      }
    });
    // The final segment is an unterminated line; Go writes it as-is.
    if (idx + 1 < lines.length) {
      out.push('\n');
    }
  }
}
