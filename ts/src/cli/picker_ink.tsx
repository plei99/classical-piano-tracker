/**
 * Runs the onboarding pickers in the terminal with Ink: the alternate
 * screen and raw key input, so arrow keys and space toggles work. The state
 * lives in picker_model.ts; this file only maps keys and paints frames.
 * Loaded lazily, so only `tracker onboarding` pays for React and Ink.
 */
import type { Readable } from 'node:stream';

import { type Key, Text, render, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useRef, useState } from 'react';

import { quote, wrap } from '../core/errors';
import type { Out } from './format';
import {
  type PickerMsg,
  type Update,
  type ViewLine,
  chosenOption,
  newPianistSelectionModel,
  newSingleChoiceModel,
  pianistSelectionLines,
  selectedPianists,
  singleChoiceLines,
  updatePianistSelection,
  updateSingleChoice,
} from './picker_model';

/** Bubble Tea's key names for the keys the pickers bind; null for the rest. */
export function keyName(input: string, key: Key): string | null {
  if (key.ctrl) {
    return input === 'c' ? 'ctrl+c' : null;
  }
  if (key.meta) {
    return null;
  }
  if (key.upArrow) return 'up';
  if (key.downArrow) return 'down';
  if (key.return) return 'enter';
  if (input === ' ') return 'space';
  return input.length === 1 ? input : null;
}

export interface PickerProps<M> {
  initial: M;
  update: (model: M, msg: PickerMsg) => Update<M>;
  lines: (model: M) => ViewLine[];
  onDone: (model: M) => void;
}

export function Picker<M>({ initial, update, lines, onDone }: PickerProps<M>) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const current = useRef(initial);
  const [model, setModel] = useState(initial);

  const dispatch = (msg: PickerMsg) => {
    const next = update(current.current, msg);
    current.current = next.model;
    setModel(next.model);
    if (next.quit) {
      onDone(next.model);
      exit();
    }
  };

  useEffect(() => dispatch({ type: 'resize', width: columns, height: rows }), [columns, rows]);
  useInput((input, key) => {
    const name = keyName(input, key);
    if (name !== null) {
      dispatch({ type: 'key', key: name });
    }
  });

  return (
    <Text>
      {lines(model).map((line, idx) => (
        <Text key={idx} bold={line.bold}>
          {idx > 0 ? '\n' : ''}
          {line.text}
        </Text>
      ))}
    </Text>
  );
}

/** Takes over the terminal until the picker finishes and returns its final state. */
async function runPicker<M>(
  input: Readable,
  output: Out,
  initial: M,
  update: PickerProps<M>['update'],
  lines: PickerProps<M>['lines'],
): Promise<M> {
  let final = initial;
  // Ink needs real TTY streams for raw input; the process streams are passed
  // through as-is, and any other stream fails inside Ink with its own error.
  const instance = render(
    <Picker
      initial={initial}
      update={update}
      lines={lines}
      onDone={(model) => {
        final = model;
      }}
    />,
    {
      stdin: input as NodeJS.ReadStream,
      stdout: output as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: true,
    },
  );
  await instance.waitUntilExit();
  return final;
}

export async function promptPianistSelection(input: Readable, output: Out, pianists: string[]): Promise<string[]> {
  let result;
  try {
    result = await runPicker(
      input,
      output,
      newPianistSelectionModel(pianists),
      updatePianistSelection,
      pianistSelectionLines,
    );
  } catch (err) {
    throw wrap('run pianist selection', err);
  }
  if (result.canceled) {
    throw new Error('pianist selection canceled');
  }
  const selected = selectedPianists(result);
  output.write('\n');
  return selected;
}

export async function runSingleChoiceSelection(
  input: Readable,
  output: Out,
  title: string,
  help: string,
  options: string[],
  initial: number,
): Promise<string> {
  if (options.length === 0) {
    throw new Error('single-choice selection requires at least one option');
  }
  let result;
  try {
    result = await runPicker(
      input,
      output,
      newSingleChoiceModel(title, help, options, initial),
      updateSingleChoice,
      singleChoiceLines,
    );
  } catch (err) {
    throw wrap(`run selection ${quote(title)}`, err);
  }
  if (result.canceled) {
    throw new Error('selection canceled');
  }
  const choice = chosenOption(result);
  output.write('\n');
  return choice;
}
