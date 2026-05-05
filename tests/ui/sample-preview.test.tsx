import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR } from '../../src/state/cursor';
import { setSong, setTransport, setPlayPos, clearHistory, song } from '../../src/state/song';
import { currentOctave, setCurrentSample, setCurrentOctave } from '../../src/state/edit';
import { setView } from '../../src/state/view';

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport('idle');
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setView('pattern');
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  resetState();
});

/**
 * Asserting the audio output isn't possible in jsdom — `engine.previewNote`
 * is a no-op when the engine hasn't been created (and we never call play).
 * So we verify the *behaviour boundary* instead: piano keys in sample view
 * MUST NOT write to the song (no commitEdit), and Z/X MUST adjust currentOctave.
 */

describe('piano keys in sample view: preview only', () => {
  it("'a' does not write any cell to the song", async () => {
    setView('sample');
    render(() => <App />);
    const before = song();
    const user = userEvent.setup();
    await user.keyboard('a');
    // Reference equality: commitEdit creates a new Song; if it didn't run,
    // we still hold the same reference.
    expect(song()).toBe(before);
  });

  it('the piano key still works regardless of cursor field', async () => {
    setView('sample');
    setCursor({ order: 0, row: 0, channel: 0, field: 'sampleHi' }); // hex field
    render(() => <App />);
    const before = song();
    const user = userEvent.setup();
    await user.keyboard('a');
    // No commit; the hex shortcut is also gated to (transport && hex field)
    // but its `run` writes to the song. With sample view active the piano
    // shortcut wins instead — verifies the routing.
    expect(song()).toBe(before);
  });

  it('switching back to pattern view restores write-on-press behaviour', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setView('pattern');
    await user.keyboard('a'); // C in current octave (2 → noteIdx 12 → period 428)
    const c = song()!.patterns[0]!.rows[0]![0]!;
    expect(c.period).toBeGreaterThan(0);
  });
});

describe('octave change works in sample view', () => {
  it("'x' raises the current octave", async () => {
    setView('sample');
    render(() => <App />);
    setCurrentOctave(2);
    await userEvent.setup().keyboard('x');
    expect(currentOctave()).toBe(3);
  });

  it("'z' lowers the current octave", async () => {
    setView('sample');
    render(() => <App />);
    setCurrentOctave(2);
    await userEvent.setup().keyboard('z');
    expect(currentOctave()).toBe(1);
  });
});

describe('typing in inputs no longer fires bare-letter shortcuts', () => {
  it("'z' typed in the sample-name input does not change the octave", async () => {
    setView('sample');
    const { container } = render(() => <App />);
    setCurrentSample(1);
    setCurrentOctave(2);
    const input = container.querySelector<HTMLInputElement>('.samplemeta input[type="text"]')!;
    input.focus();
    await userEvent.setup().keyboard('z');
    // Octave stays put — focus-skip in the dispatcher kept the shortcut from firing.
    expect(currentOctave()).toBe(2);
    expect(input.value).toBe('z');
  });

  it("'a' typed in the sample-name input does not preview-play (no song mutation)", async () => {
    setView('sample');
    const { container } = render(() => <App />);
    const before = song();
    const input = container.querySelector<HTMLInputElement>('.samplemeta input[type="text"]')!;
    input.focus();
    await userEvent.setup().keyboard('a');
    // Song mutates only via `onInput` on the focused input (name='a'); no
    // separate piano-shortcut path fires. We don't assert reference equality
    // because the input itself triggers a setSample commit; instead, prove
    // the cell remained empty (piano shortcut would write a period there).
    expect(song()!.patterns[0]!.rows[0]![0]!.period).toBe(before!.patterns[0]!.rows[0]![0]!.period);
  });

  it('mod-key shortcuts still fire while an input is focused', () => {
    // If focus-skip swallowed mod shortcuts the user could never save (or
    // run other ⌘-chord actions) while typing in the name field. We press
    // Cmd+] — "insert order slot" — since it's mod-gated, has no view
    // restriction, and is observable via songLength growing. Drive a raw
    // KeyboardEvent so the position-mapped matcher sees the BracketRight
    // code regardless of how userEvent escapes brackets.
    setView('sample');
    const { container } = render(() => <App />);
    const input = container.querySelector<HTMLInputElement>('.samplemeta input[type="text"]')!;
    input.focus();
    setCurrentOctave(3);
    const before = song()!.songLength;
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ']', code: 'BracketRight', metaKey: true,
    }));
    expect(song()!.songLength).toBe(before + 1);
  });
});

describe('range slider focus: piano keys still fire, navigation keys reach the slider', () => {
  it("'z' (octave down) fires while a range input is focused — slider doesn't consume letters", async () => {
    setView('sample');
    const { container } = render(() => <App />);
    setCurrentSample(1);
    setCurrentOctave(2);
    // Switch the slot to chiptune so the synth panel renders with sliders.
    const chiptuneBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.source-picker button'),
    ).find((b) => b.textContent === 'Chiptune')!;
    chiptuneBtn.click();
    const range = container.querySelector<HTMLInputElement>('.chiptune input[type="range"]')!;
    range.focus();
    await userEvent.setup().keyboard('z');
    // Letter passed through to the global piano-row Z shortcut → octave dropped.
    expect(currentOctave()).toBe(1);
  });
});
