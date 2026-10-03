/**
 * Rendering, part two: Ink components that draw a `Frame`. Every line is
 * already sized by `view`, so Ink never has to wrap text; it only places
 * the bordered panes and clips the body in small windows.
 */
import { Box, Text } from 'ink';
import { memo } from 'react';

import type { Line } from './text';
import { APP_PADDING, type Body, type Frame, type Pane } from './view';

/** Lines are rebuilt every frame; compare them by content so unchanged rows skip React work. */
function sameLine(a: Line, b: Line): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index++) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined || left.text !== right.text || left.style !== right.style) {
      return false;
    }
  }
  return true;
}

function samePane(a: Pane, b: Pane): boolean {
  if (a === b) {
    return true;
  }
  if (a.width !== b.width || a.height !== b.height || a.lines.length !== b.lines.length) {
    return false;
  }
  return a.lines.every((line, index) => sameLine(line, b.lines[index] ?? []));
}

/** One terminal row. An empty line still needs a cell, or Ink would collapse it. */
const LineView = memo(
  function LineView({ line }: { line: Line }) {
    const only = line.length === 1 ? line[0] : undefined;
    if (line.length === 0 || (only !== undefined && only.text === '')) {
      return <Text> </Text>;
    }
    if (only !== undefined) {
      const { bold, dim, inverse } = only.style;
      return (
        <Text wrap="truncate-end" bold={bold} dimColor={dim} inverse={inverse}>
          {only.text}
        </Text>
      );
    }
    return (
      <Text wrap="truncate-end">
        {line.map(({ text, style }, index) => (
          <Text key={index} bold={style.bold} dimColor={style.dim} inverse={style.inverse}>
            {text}
          </Text>
        ))}
      </Text>
    );
  },
  (prev, next) => sameLine(prev.line, next.line),
);

/**
 * A rounded, padded pane. Ink, like Lip Gloss v2, counts border and padding
 * inside the box size; the height is a minimum so taller content grows the
 * pane instead of being cut, as in Go.
 */
const PaneView = memo(
  function PaneView({ pane }: { pane: Pane }) {
    return (
      <Box
        borderStyle="round"
        padding={1}
        flexDirection="column"
        flexShrink={0}
        width={pane.width + 2}
        minHeight={pane.height + 4}
      >
        {pane.lines.map((line, index) => (
          <LineView key={index} line={line} />
        ))}
      </Box>
    );
  },
  (prev, next) => samePane(prev.pane, next.pane),
);

/**
 * The two panes. In a small window they sit in a clip box, so the window
 * cuts them instead of pushing the footer off screen.
 */
function BodyView({ body }: { body: Body }) {
  const panes = (
    <Box flexDirection={body.vertical ? 'column' : 'row'} alignItems="flex-start" alignSelf="flex-start" flexShrink={0}>
      <PaneView pane={body.list} />
      <PaneView pane={body.detail} />
    </Box>
  );
  if (!body.clipped) {
    return panes;
  }
  return (
    <Box width={body.width} height={body.height} overflow="hidden" flexShrink={0}>
      {panes}
    </Box>
  );
}

/** Draws a whole frame inside the outer margin. */
export function FrameView({ frame }: { frame: Frame }) {
  const clipped = frame.clipHeight !== null;
  return (
    <Box
      flexDirection="column"
      paddingTop={APP_PADDING}
      paddingLeft={APP_PADDING}
      // A frame taller than the window shows its top rows, margin or not.
      paddingBottom={clipped ? 0 : APP_PADDING}
      height={frame.clipHeight ?? undefined}
      overflow={clipped ? 'hidden' : 'visible'}
      flexShrink={0}
    >
      {frame.rows.map((row, index) =>
        row.kind === 'line' ? <LineView key={index} line={row.line} /> : <BodyView key={index} body={row.body} />,
      )}
    </Box>
  );
}
