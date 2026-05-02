import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@solidjs/testing-library';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR } from '../../src/state/cursor';
import { setSong, setTransport, setPlayPos, clearHistory, song } from '../../src/state/song';
import { setCurrentSample, setCurrentOctave } from '../../src/state/edit';
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
afterEach(() => { cleanup(); resetState(); });

/** Stamp some bytes into slot 0 so loop editing has a non-zero target. */
function seedSampleData(): void {
  const s = song()!;
  setSong({
    ...s,
    samples: s.samples.map((sm, i) => i === 0
      ? { ...sm, name: 'demo', volume: 64, lengthWords: 100, loopStartWords: 0, loopLengthWords: 1, data: new Int8Array(200) }
      : sm),
  });
}

describe('SampleView: loop toggle', () => {
  it('checking the toggle enables looping over the whole sample', () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleData();
    const toggle = container.querySelector<HTMLInputElement>('.samplemeta__toggle input[type="checkbox"]')!;
    expect(toggle.checked).toBe(false);
    fireEvent.change(toggle, { target: { checked: true } });
    expect(song()!.samples[0]!.loopStartWords).toBe(0);
    expect(song()!.samples[0]!.loopLengthWords).toBe(100); // whole sample
  });

  it('unchecking the toggle restores the PT no-loop sentinel (loopLengthWords=1)', () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleData();
    setSong({
      ...song()!,
      samples: song()!.samples.map((sm, i) => i === 0
        ? { ...sm, loopStartWords: 10, loopLengthWords: 50 }
        : sm),
    });
    const toggle = container.querySelector<HTMLInputElement>('.samplemeta__toggle input[type="checkbox"]')!;
    expect(toggle.checked).toBe(true);
    fireEvent.change(toggle, { target: { checked: false } });
    expect(song()!.samples[0]!.loopLengthWords).toBe(1);
    // loopStart preserved so toggling back on retains intent.
    expect(song()!.samples[0]!.loopStartWords).toBe(10);
  });

  it('toggle is disabled when the slot is empty', () => {
    setView('sample');
    const { container } = render(() => <App />);
    // Slot 1 is empty by default (lengthWords=0).
    const toggle = container.querySelector<HTMLInputElement>('.samplemeta__toggle input[type="checkbox"]')!;
    expect(toggle.disabled).toBe(true);
  });
});
