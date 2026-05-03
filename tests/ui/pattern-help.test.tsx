import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR } from '../../src/state/cursor';
import { setSong, setTransport, setPlayPos, clearHistory, setDirty } from '../../src/state/song';
import { setCurrentSample, setCurrentOctave, setEditStep } from '../../src/state/edit';
import { setView } from '../../src/state/view';
import { setInfoText } from '../../src/state/info';
import { emptySong, PERIOD_TABLE } from '../../src/core/mod/format';
import { clearSession } from '../../src/state/persistence';
import { setSelection, makeSelection } from '../../src/state/selection';
import { MOD_LABEL } from '../../src/state/platform';

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport('idle');
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setEditStep(1);
  setDirty(false);
  setView('pattern');
  setInfoText('');
  clearSession();
}

beforeEach(() => { resetState(); });
afterEach(() => { cleanup(); resetState(); });

/** Build an empty song, then write `note` into cell (order=0, row=0, ch=0). */
function songWithCell(note: { period?: number; sample?: number; effect?: number; effectParam?: number }) {
  const s = emptySong();
  const cell = s.patterns[0]!.rows[0]![0]!;
  cell.period = note.period ?? 0;
  cell.sample = note.sample ?? 0;
  cell.effect = note.effect ?? 0;
  cell.effectParam = note.effectParam ?? 0;
  return s;
}

function helpText(container: HTMLElement): string {
  return container.querySelector('.patternhelp')!.textContent!.replace(/\s+/g, ' ').trim();
}

describe('PatternHelp: empty cell', () => {
  it('shows placeholders for every segment when the cell is empty', () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const t = helpText(container);
    expect(t).toMatch(/Note\s*—/);
    expect(t).toMatch(/Sample\s*—.*no change/);
    expect(t).toMatch(/Effect\s*\.\.\.\s*·\s*none/);
  });
});

describe('PatternHelp: note + sample fields', () => {
  it('shows the note name for a non-empty period', () => {
    // C-2 sits at finetune-row 0, slot 12 in PERIOD_TABLE.
    const period = PERIOD_TABLE[0]![12]!;
    setSong(songWithCell({ period }));
    const { container } = render(() => <App />);
    expect(helpText(container)).toMatch(/Note\s*C-2/);
  });

  it('shows the sample slot in hex with its name', () => {
    const s = songWithCell({ sample: 0x0c });
    s.samples[11]!.name = 'kick';
    setSong(s);
    const { container } = render(() => <App />);
    expect(helpText(container)).toMatch(/Sample\s*0C\s*·\s*kick/);
  });
});

describe('PatternHelp: effect breakdown', () => {
  it('split-nibble effect (Vibrato 4xy) explains hi=speed, lo=depth', () => {
    setSong(songWithCell({ effect: 0x4, effectParam: 0xa4 }));
    const { container } = render(() => <App />);
    const t = helpText(container);
    expect(t).toMatch(/4A4/);
    expect(t).toMatch(/Vibrato/);
    expect(t).toMatch(/A\s*=\s*speed/);
    expect(t).toMatch(/4\s*=\s*depth/);
  });

  it('whole-param effect (Set volume Cxx) reports the value range', () => {
    setSong(songWithCell({ effect: 0xc, effectParam: 0x40 }));
    const { container } = render(() => <App />);
    const t = helpText(container);
    expect(t).toMatch(/C40/);
    expect(t).toMatch(/Set volume/);
    expect(t).toMatch(/64\s*\(0\.\.64\)/);
  });

  it('extended effect (E4x) decodes the vibrato waveform', () => {
    setSong(songWithCell({ effect: 0xe, effectParam: 0x42 }));
    const { container } = render(() => <App />);
    const t = helpText(container);
    expect(t).toMatch(/E42/);
    expect(t).toMatch(/E4x Vibrato waveform/);
    expect(t).toMatch(/square/);
  });

  it('Fxx with param < 0x20 reports speed; ≥ 0x20 reports tempo', () => {
    setSong(songWithCell({ effect: 0xf, effectParam: 0x06 }));
    const { container: c1 } = render(() => <App />);
    expect(helpText(c1)).toMatch(/Set speed.*6 ticks\/row/);
    cleanup();

    setSong(songWithCell({ effect: 0xf, effectParam: 0x7d }));
    const { container: c2 } = render(() => <App />);
    expect(helpText(c2)).toMatch(/Set tempo.*125 BPM/);
  });

  it('Pattern break (Dxy) decodes the decimal target row', () => {
    setSong(songWithCell({ effect: 0xd, effectParam: 0x16 })); // 0x16 → row 16 decimal
    const { container } = render(() => <App />);
    expect(helpText(container)).toMatch(/Pattern break.*to row 16/);
  });
});

describe('PatternHelp: tracks the cursor', () => {
  it('updates as the cursor moves to a different cell', () => {
    const s = emptySong();
    s.patterns[0]!.rows[0]![0]!.period = PERIOD_TABLE[0]![0]!; // C-1 at (0,0,0)
    s.patterns[0]!.rows[5]![2]!.period = PERIOD_TABLE[0]![24]!; // C-3 at (0,5,2)
    setSong(s);
    const { container } = render(() => <App />);
    expect(helpText(container)).toMatch(/Note\s*C-1/);

    setCursor({ order: 0, row: 5, channel: 2, field: 'note' });
    expect(helpText(container)).toMatch(/Note\s*C-3/);
  });
});

describe('PatternHelp: tips toggle', () => {
  it('the tips block is hidden by default and the toggle reads "Show tips"', () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    expect(container.querySelector('.patternhelp__tips')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>('.patternhelp__toggle')!;
    expect(toggle.textContent).toBe('Show tips');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('clicking the toggle opens the tips block and flips the label', () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const toggle = container.querySelector<HTMLButtonElement>('.patternhelp__toggle')!;
    fireEvent.click(toggle);
    expect(container.querySelector('.patternhelp__tips')).not.toBeNull();
    expect(toggle.textContent).toBe('Hide tips');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('pressing ? toggles the tips block', async () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const user = userEvent.setup();

    expect(container.querySelector('.patternhelp__tips')).toBeNull();
    await user.keyboard('{Shift>}/{/Shift}');
    expect(container.querySelector('.patternhelp__tips')).not.toBeNull();
    await user.keyboard('{Shift>}/{/Shift}');
    expect(container.querySelector('.patternhelp__tips')).toBeNull();
  });
});

describe('PatternHelp: context-sensitive tips', () => {
  it('on the note column, shows piano / edit step / sample / play / selection sections', () => {
    setSong(emptySong());
    setCursor({ order: 0, row: 0, channel: 0, field: 'note' });
    const { container } = render(() => <App />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.patternhelp__toggle')!);

    const titles = Array.from(
      container.querySelectorAll('.patternhelp__tip-title'),
    ).map((el) => el.textContent);
    expect(titles).toContain('Note entry');
    expect(titles).toContain('Edit step');
    expect(titles).toContain('Sample');
    expect(titles).toContain('Play');
    // Selection tips are visible on the note column too, so the user
    // can discover Shift+arrows / Cmd+C/V before making a first selection.
    expect(titles).toContain('Selection');
    expect(titles).not.toContain('Effects');
  });

  it('on an effect column, shows the 16-effect grid plus the 16 extended sub-commands', () => {
    setSong(emptySong());
    setCursor({ order: 0, row: 0, channel: 0, field: 'effectCmd' });
    const { container } = render(() => <App />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.patternhelp__toggle')!);

    const grids = container.querySelectorAll('.patternhelp__effect-grid');
    expect(grids.length).toBe(2);

    const mainCodes = Array.from(grids[0]!.querySelectorAll('.patternhelp__kbd'))
      .map((el) => el.textContent);
    expect(mainCodes).toContain('0xy');
    expect(mainCodes).toContain('4xy');
    expect(mainCodes).toContain('Fxx');
    expect(mainCodes.length).toBe(16);

    const extCodes = Array.from(grids[1]!.querySelectorAll('.patternhelp__kbd'))
      .map((el) => el.textContent);
    expect(extCodes).toContain('E0x');
    expect(extCodes).toContain('E4x'); // Vibrato waveform
    expect(extCodes).toContain('EFx');
    expect(extCodes.length).toBe(16);

    const titles = Array.from(
      container.querySelectorAll('.patternhelp__tip-title'),
    ).map((el) => el.textContent);
    expect(titles).toContain('Effects');
    expect(titles).toContain('Extended effects (Exy)');
    expect(titles).not.toContain('Note entry');
    expect(titles).not.toContain('Play');
  });

  it('with an active selection, shows only the Selection section regardless of cursor field', () => {
    setSong(emptySong());
    setCursor({ order: 0, row: 0, channel: 0, field: 'note' });
    setSelection(makeSelection(0, 0, 0, 3, 1));
    const { container } = render(() => <App />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.patternhelp__toggle')!);

    const titles = Array.from(
      container.querySelectorAll('.patternhelp__tip-title'),
    ).map((el) => el.textContent);
    expect(titles).toEqual(['Selection']);

    const selSection = container.querySelector('.patternhelp__tip-section')!;
    expect(selSection.textContent).toMatch(new RegExp(`${MOD_LABEL} \\+ C`));
    expect(selSection.textContent).toMatch(new RegExp(`${MOD_LABEL} \\+ V`));
  });

  it('with an active selection on the effect column, the effect grid is hidden', () => {
    setSong(emptySong());
    setCursor({ order: 0, row: 0, channel: 0, field: 'effectCmd' });
    setSelection(makeSelection(0, 0, 0, 3, 1));
    const { container } = render(() => <App />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.patternhelp__toggle')!);

    expect(container.querySelector('.patternhelp__effect-grid')).toBeNull();
    const titles = Array.from(
      container.querySelectorAll('.patternhelp__tip-title'),
    ).map((el) => el.textContent);
    expect(titles).toEqual(['Selection']);
  });
});
