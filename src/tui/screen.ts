/**
 * Rendering, part three: puts frame rows on the terminal, rewriting only
 * the rows that changed since the last frame.
 */

const ESC = '\u001B[';
/** Begin and end synchronized update: the terminal shows the frame at once, not row by row. */
const BEGIN_SYNC = `${ESC}?2026h`;
const END_SYNC = `${ESC}?2026l`;
const HIDE_CURSOR = `${ESC}?25l`;
const CLEAR_SCREEN = `${ESC}2J`;
const CLEAR_LINE = `${ESC}2K`;

export interface ScreenOutput {
  write(data: string): unknown;
  readonly isTTY?: boolean;
}

export class Screen {
  private shown: readonly string[] = [];
  private stale = true;

  constructor(private readonly out: ScreenOutput) {}

  /** Forgets what the terminal shows (after a resize), so the next draw repaints everything. */
  invalidate(): void {
    this.stale = true;
  }

  draw(rows: readonly string[]): void {
    let data = '';
    if (this.stale) {
      data += CLEAR_SCREEN;
      this.shown = [];
      this.stale = false;
    }
    const height = Math.max(rows.length, this.shown.length);
    for (let y = 0; y < height; y++) {
      const row = rows[y] ?? '';
      if (row !== (this.shown[y] ?? '')) {
        data += `${ESC}${y + 1};1H${CLEAR_LINE}${row}`;
      }
    }
    this.shown = rows;
    if (data === '') {
      return;
    }
    data = HIDE_CURSOR + data;
    this.out.write(this.out.isTTY === true ? BEGIN_SYNC + data + END_SYNC : data);
  }
}
