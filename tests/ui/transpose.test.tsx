import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR } from '../../src/state/cursor';
import { setSong, setTransport, setPlayPos, clearHistory, song, setDirty } from '../../src/state/song';
import { setCurrentSample, setCurrentOctave, setEditStep } from '../../src/state/edit';
import { setView } from '../../src/state/view';
import { setInfoText } from '../../src/state/info';
import { setSelection, makeSelection } from '../../src/state/selection';
import { emptySong, PERIOD_TABLE } from '../../src/core/mod/format';
import { clearSession } from '../../src/state/persistence';

const F0 = PERIOD_TABLE[0]!;

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
  setSelection(null);
  clearSession();
}

beforeEach(() => { resetState(); });
afterEach(() => { cleanup(); resetState(); });

/** Build a song with a single C-2 at (order=0, row=0, channel=0). */
function songWithC2() {
  const s = emptySong();
  s.patterns[0]!.rows[0]![0]!.period = F0[12]!; // C-2
  return s;
}

describe('Transpose shortcuts: cursor cell (no selection)', () => {
  it('Shift + = transposes the cell at the cursor up 1 semitone', async () => {
    setSong(songWithC2());
    setCursor({ order: 0, row: 0, channel: 0, field: 'note' });
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{Shift>}={/Shift}');
    expect(song()!.patterns[0]!.rows[0]![0]!.period).toBe(F0[13]!); // C#-2
  });

  it('Shift + - transposes down 1 semitone', async () => {
    setSong(songWithC2());
    setCursor({ order: 0, row: 0, channel: 0, field: 'note' });
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{Shift>}-{/Shift}');
    expect(song()!.patterns[0]!.rows[0]![0]!.period).toBe(F0[11]!); // B-1
  });

  it('Cmd + Shift + = transposes up 1 octave', async () => {
    setSong(songWithC2());
    setCursor({ order: 0, row: 0, channel: 0, field: 'note' });
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{Meta>}{Shift>}={/Shift}{/Meta}');
    expect(song()!.patterns[0]!.rows[0]![0]!.period).toBe(F0[24]!); // C-3
  });

  it('Cmd + Shift + - transposes down 1 octave', async () => {
    setSong(songWithC2());
    setCursor({ order: 0, row: 0, channel: 0, field: 'note' });
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{Meta>}{Shift>}-{/Shift}{/Meta}');
    expect(song()!.patterns[0]!.rows[0]![0]!.period).toBe(F0[0]!); // C-1
  });
});

describe('Transpose shortcuts: selection scope', () => {
  it('with an active selection, Shift + = transposes every cell in the rectangle', async () => {
    const s = emptySong();
    s.patterns[0]!.rows[0]![0]!.period = F0[12]!; // C-2
    s.patterns[0]!.rows[1]![0]!.period = F0[14]!; // D-2
    s.patterns[0]!.rows[2]![1]!.period = F0[16]!; // E-2 — outside selection
    setSong(s);
    setCursor({ order: 0, row: 0, channel: 0, field: 'note' });
    setSelection(makeSelection(0, 0, 0, 1, 0));
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{Shift>}={/Shift}');
    expect(song()!.patterns[0]!.rows[0]![0]!.period).toBe(F0[13]!); // C#-2
    expect(song()!.patterns[0]!.rows[1]![0]!.period).toBe(F0[15]!); // D#-2
    // Outside the selection — untouched.
    expect(song()!.patterns[0]!.rows[2]![1]!.period).toBe(F0[16]!);
  });
});

describe('Transpose shortcuts: gating', () => {
  it('does nothing while playback is active', async () => {
    setSong(songWithC2());
    setTransport('playing');
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{Shift>}={/Shift}');
    expect(song()!.patterns[0]!.rows[0]![0]!.period).toBe(F0[12]!); // unchanged
  });

  it('leaves an empty cell empty (transpose never adds a note)', async () => {
    setSong(emptySong()); // every cell period=0
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{Shift>}={/Shift}');
    expect(song()!.patterns[0]!.rows[0]![0]!.period).toBe(0);
  });
});
