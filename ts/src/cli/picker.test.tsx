import type { Key } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { MemoryOut } from './testutil';
import { Picker, keyName, runSingleChoiceSelection } from './picker_ink';
import {
  type PianistSelectionModel,
  type PickerMsg,
  type SingleChoiceModel,
  newPianistSelectionModel,
  newSingleChoiceModel,
  pianistSelectionLines,
  renderLines,
  selectedPianists,
  singleChoiceLines,
  truncateToWidth,
  updatePianistSelection,
  updateSingleChoice,
  visibleOptions,
  visiblePianists,
} from './picker_model';

const key = (name: string): PickerMsg => ({ type: 'key', key: name });

function pressAll(model: PianistSelectionModel, ...names: string[]): PianistSelectionModel {
  return names.reduce((m, name) => updatePianistSelection(m, key(name)).model, model);
}

const view = (model: PianistSelectionModel) => renderLines(pianistSelectionLines(model));

describe('pianist selection model', () => {
  // Go: TestPianistSelectionModelToggleAndSelectionOrder
  it('toggles and keeps selection order', () => {
    const model = pressAll(newPianistSelectionModel(['A', 'B', 'C']), 'space', 'down', 'space');
    expect(selectedPianists(model)).toEqual(['C']);
  });

  // Go: TestPianistSelectionModelRejectsEmptySelection
  it('rejects an empty selection', () => {
    const model = pressAll(newPianistSelectionModel(['A']), 'space');
    expect(() => selectedPianists(model)).toThrow('selection must include at least one pianist');
    expect(view(model)).toContain('\nSelect at least one pianist before confirming.\n');
    expect(() => selectedPianists(newPianistSelectionModel([]))).toThrow('selection source must not be empty');
  });

  // Go: TestPianistSelectionModelViewIncludesControls
  it('shows the controls', () => {
    const content = view(newPianistSelectionModel(['A', 'B']));
    for (const want of ['space: toggle', 'enter: confirm', '[x] A']) {
      expect(content).toContain(want);
    }
    expect(content).toBe(
      'Select pianists for the initial allowlist.\n' +
        'Up/down or j/k: move   space: toggle   enter: confirm   q: cancel\n' +
        'Selected: 2 of 2   Current: 1 of 2\n\n> [x] A\n  [x] B\n',
    );
  });

  // Go: TestPianistSelectionModelVisiblePianistsTracksCursorWindow
  it('tracks the cursor with the visible window', () => {
    const model = { ...newPianistSelectionModel(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']), height: 10, cursor: 6 };
    const { visible, offset, hiddenAbove, hiddenBelow } = visiblePianists(model);
    expect(offset).toBe(4);
    expect(hiddenAbove).toBe(true);
    expect(hiddenBelow).toBe(false);
    expect(visible).toEqual(['E', 'F', 'G', 'H']);
  });

  // Go: TestPianistSelectionModelViewShowsOverflowHints
  it('shows overflow hints', () => {
    const model = { ...newPianistSelectionModel(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']), height: 10, cursor: 3 };
    const content = view(model);
    expect(content).toContain('... 1 more above');
    expect(content).toContain('... 3 more below');
  });

  it('moves within bounds, confirms, and cancels', () => {
    let model = newPianistSelectionModel(['A', 'B']);
    model = pressAll(model, 'j', 'j');
    expect(model.cursor).toBe(1);
    model = pressAll(model, 'k', 'up', 'alt+q', 'x');
    expect(model.cursor).toBe(0);
    expect(updatePianistSelection(model, key('enter'))).toEqual({ model, quit: true });
    for (const cancel of ['q', 'ctrl+c']) {
      const result = updatePianistSelection(model, key(cancel));
      expect(result.quit).toBe(true);
      expect(result.model.canceled).toBe(true);
    }
    const resized = updatePianistSelection(model, { type: 'resize', width: 30, height: 9 });
    expect(resized).toEqual({ model: { ...model, width: 30, height: 9 }, quit: false });
  });

  it('cuts long rows to the terminal width like lipgloss MaxWidth', () => {
    const model = { ...newPianistSelectionModel(['Arturo Benedetti Michelangeli']), width: 12 };
    expect(view(model)).toContain('\n> [x] Arturo\n');
    expect(truncateToWidth('漢字漢字', 5)).toBe('漢字');
  });
});

describe('single choice model', () => {
  const press = (model: SingleChoiceModel, ...names: string[]) =>
    names.reduce((m, name) => updateSingleChoice(m, key(name)).model, model);

  it('moves within bounds and renders', () => {
    let model = newSingleChoiceModel('Pick', 'help text', ['one', 'two', 'three'], 7);
    expect(model.cursor).toBe(0);
    model = press(model, 'up');
    expect(model.cursor).toBe(0);
    model = press(model, 'down', 'space');
    expect(model.cursor).toBe(1);
    expect(renderLines(singleChoiceLines(model))).toBe('Pick\nhelp text\nCurrent: 2 of 3\n\n  one\n> two\n  three\n');
    expect(singleChoiceLines(model).map((line) => line.bold)).toEqual([false, false, false, false, false, true, false]);
    const canceled = updateSingleChoice(model, key('q'));
    expect(canceled.quit).toBe(true);
    expect(canceled.model.canceled).toBe(true);
  });

  it('scrolls the window with the cursor', () => {
    const options = Array.from({ length: 20 }, (_, idx) => `model-${idx + 1}`);
    const model = { ...newSingleChoiceModel('Pick', 'help', options, 19), height: 10 };
    const { visible, offset, hiddenAbove, hiddenBelow } = visibleOptions(model);
    expect([visible.length, offset, hiddenAbove, hiddenBelow]).toEqual([5, 15, true, false]);
    expect(renderLines(singleChoiceLines(model))).toContain('  ... 15 more above\n');
  });

  it('matches the Go window math', () => {
    const window = (len: number, cursor: number, height: number) => {
      const model = { ...newPianistSelectionModel(Array.from({ length: len }, String)), cursor, height };
      const { visible, offset } = visiblePianists(model);
      return [offset, offset + visible.length];
    };
    expect(window(0, 0, 10)).toEqual([0, 0]);
    expect(window(8, 0, 10)).toEqual([0, 4]);
    expect(window(8, 3, 10)).toEqual([1, 5]);
    expect(window(8, 7, 10)).toEqual([4, 8]);
    // Tiny terminals still show three rows; an unknown height means 24.
    expect(window(8, 0, 2)).toEqual([0, 3]);
    expect(window(30, 0, 0)).toEqual([0, 18]);
    expect(window(2, 1, 0)).toEqual([0, 2]);
  });

  it('requires options', async () => {
    await expect(runSingleChoiceSelection(process.stdin, new MemoryOut(), 't', 'h', [], 0)).rejects.toThrow(
      'single-choice selection requires at least one option',
    );
  });
});

function inkKey(overrides: Partial<Key>): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  };
}

describe('Ink picker', () => {
  it('maps Ink keys to Bubble Tea key names', () => {
    expect(keyName('c', inkKey({ ctrl: true }))).toBe('ctrl+c');
    expect(keyName('x', inkKey({ ctrl: true }))).toBeNull();
    expect(keyName('q', inkKey({ meta: true }))).toBeNull();
    expect(keyName('', inkKey({ upArrow: true }))).toBe('up');
    expect(keyName('', inkKey({ downArrow: true }))).toBe('down');
    expect(keyName('\r', inkKey({ return: true }))).toBe('enter');
    expect(keyName(' ', inkKey({}))).toBe('space');
    expect(keyName('j', inkKey({}))).toBe('j');
    expect(keyName('ab', inkKey({}))).toBeNull();
  });

  it('renders frames and reports the confirmed state', async () => {
    let done: PianistSelectionModel | undefined;
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
    const { stdin, lastFrame, unmount } = render(
      <Picker
        initial={newPianistSelectionModel(['A', 'B', 'C'])}
        update={updatePianistSelection}
        lines={pianistSelectionLines}
        onDone={(model) => {
          done = model;
        }}
      />,
    );
    await tick();
    expect(lastFrame()).toContain('> [x] A');

    stdin.write(' ');
    await tick();
    stdin.write('j');
    await tick();
    expect(lastFrame()).toContain('Selected: 2 of 3   Current: 2 of 3');
    expect(lastFrame()).toContain('  [ ] A\n> [x] B');

    stdin.write('\r');
    await tick();
    expect(done).toBeDefined();
    expect(selectedPianists(done!)).toEqual(['B', 'C']);
    unmount();
  });
});
