//! A port of the subset of Go's `text/tabwriter` the CLI uses:
//! `tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)`.
//!
//! Cells are tab-terminated; the text after a line's last tab is not part of
//! any column. A column's width is set per *block*: a run of consecutive
//! lines that all have a cell in that column. Widths count runes, as Go does.

use std::fmt;
use std::io::{self, Write};

/// Buffers tab-separated text until [`TabWriter::flush`] aligns it.
pub struct TabWriter {
    buf: String,
    padding: usize,
}

impl TabWriter {
    /// Minwidth 0, tabwidth 0, padding 2, space padding, no flags.
    pub fn new() -> TabWriter {
        TabWriter { buf: String::new(), padding: 2 }
    }

    /// Writes the aligned text to `out` and clears the buffer.
    pub fn flush(&mut self, out: &mut dyn Write) -> io::Result<()> {
        let text = std::mem::take(&mut self.buf);
        out.write_all(align(&text, self.padding).as_bytes())
    }
}

impl fmt::Write for TabWriter {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        self.buf.push_str(s);
        Ok(())
    }
}

fn align(text: &str, padding: usize) -> String {
    let lines: Vec<Vec<&str>> = text.split('\n').map(|line| line.split('\t').collect()).collect();
    let mut out = String::with_capacity(text.len());
    let mut widths = Vec::new();
    format_block(&lines, 0, lines.len(), &mut widths, padding, &mut out);
    out
}

/// Go's `Writer.format`: finds each block for the next column, recursing
/// to the right once that column's width is known.
fn format_block(
    lines: &[Vec<&str>],
    mut line0: usize,
    line1: usize,
    widths: &mut Vec<usize>,
    padding: usize,
    out: &mut String,
) {
    let column = widths.len();
    let has_cell = |line: &Vec<&str>| column + 1 < line.len();
    let mut this = line0;
    while this < line1 {
        if !has_cell(&lines[this]) {
            this += 1;
            continue;
        }
        write_lines(lines, line0, this, widths, out);
        line0 = this;

        let mut width = 0;
        while this < line1 && has_cell(&lines[this]) {
            width = width.max(lines[this][column].chars().count() + padding);
            this += 1;
        }

        widths.push(width);
        format_block(lines, line0, this, widths, padding, out);
        widths.pop();
        line0 = this;
    }
    write_lines(lines, line0, line1, widths, out);
}

fn write_lines(lines: &[Vec<&str>], line0: usize, line1: usize, widths: &[usize], out: &mut String) {
    for (idx, line) in lines.iter().enumerate().take(line1).skip(line0) {
        for (col, cell) in line.iter().enumerate() {
            out.push_str(cell);
            if let Some(&width) = widths.get(col) {
                let pad = width.saturating_sub(cell.chars().count());
                out.extend(std::iter::repeat_n(' ', pad));
            }
        }
        // The final segment is an unterminated line; Go writes it as-is.
        if idx + 1 < lines.len() {
            out.push('\n');
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use super::*;

    fn render(text: &str) -> String {
        let mut tw = TabWriter::new();
        tw.write_str(text).unwrap();
        let mut out = Vec::new();
        tw.flush(&mut out).unwrap();
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn aligns_columns_with_padding() {
        assert_eq!(render("a\tbb\tc\naaa\tb\tc\n"), "a    bb  c\naaa  b   c\n");
    }

    #[test]
    fn last_cell_does_not_affect_width() {
        assert_eq!(render("x\tlong trailing text\nxyz\ty\n"), "x    long trailing text\nxyz  y\n");
    }

    #[test]
    fn blocks_end_at_lines_without_the_column() {
        // The plain middle line splits column 0 into two independent blocks.
        assert_eq!(render("a\t1\nplain\nlonger\t2\n"), "a  1\nplain\nlonger  2\n");
        // A line with fewer cells ends the column-1 block only.
        assert_eq!(render("a\tb\tc\nlong\td\nx\tyyyy\tz\n"), "a     b  c\nlong  d\nx     yyyy  z\n");
    }

    #[test]
    fn widths_count_runes_and_keep_empty_cells() {
        assert_eq!(render("Frédéric\t1\nAb\t\t2\n"), "Frédéric  1\nAb          2\n");
    }

    #[test]
    fn unterminated_final_line_is_written_without_newline() {
        assert_eq!(render("a\tb\nccc\td"), "a    b\nccc  d");
    }
}
