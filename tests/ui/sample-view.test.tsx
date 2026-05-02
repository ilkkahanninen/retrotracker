import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR } from '../../src/state/cursor';
import { setSong, setTransport, setPlayPos, clearHistory, song } from '../../src/state/song';
import { setCurrentSample, setCurrentOctave } from '../../src/state/edit';
import { setView, view } from '../../src/state/view';

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

describe('view switching', () => {
  it('starts in the pattern view by default', () => {
    const { container } = render(() => <App />);
    expect(view()).toBe('pattern');
    // Pattern view shows the order pane.
    expect(container.querySelector('.app__order')).not.toBeNull();
    // The sample editor stays mounted (so toggling the view doesn't
    // rebuild its DOM), but its wrapper carries `view-hidden` while
    // pattern view is active.
    expect(container.querySelector('.sampleview-wrapper.view-hidden')).not.toBeNull();
  });

  it('clicking the Sample tab switches to the sample editor and hides the order pane', async () => {
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(container.querySelectorAll<HTMLButtonElement>('.viewtabs button')[1]!);
    expect(view()).toBe('sample');
    // Sample wrapper is now visible, pattern wrapper carries view-hidden.
    expect(container.querySelector('.sampleview-wrapper.view-hidden')).toBeNull();
    expect(container.querySelector('.patternpane.view-hidden')).not.toBeNull();
    expect(container.querySelector('.app__order')).toBeNull();
  });

  it('F2 / F3 toggle the view', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{F3}');
    expect(view()).toBe('sample');
    await user.keyboard('{F2}');
    expect(view()).toBe('pattern');
  });

  it('the active tab carries the .viewtab--active class', async () => {
    const { container } = render(() => <App />);
    const tabs = container.querySelectorAll<HTMLElement>('.viewtabs button');
    expect(tabs[0]!.classList.contains('viewtab--active')).toBe(true);
    expect(tabs[1]!.classList.contains('viewtab--active')).toBe(false);
    setView('sample');
    expect(tabs[0]!.classList.contains('viewtab--active')).toBe(false);
    expect(tabs[1]!.classList.contains('viewtab--active')).toBe(true);
  });
});

describe('SampleView: metadata editing', () => {
  it('typing in the name input writes the name through commitEdit', () => {
    setView('sample');
    const { container } = render(() => <App />);
    setCurrentSample(3);
    const input = container.querySelector<HTMLInputElement>('.samplemeta input[type="text"]')!;
    // fireEvent rather than user.type — the input is controlled and a tiny
    // race between Solid's value-rebind and userEvent's per-key dispatch
    // drops characters. The handler is the same code path either way.
    fireEvent.input(input, { target: { value: 'kick' } });
    expect(song()!.samples[2]!.name).toBe('kick');
  });

  it('volume input clamps to 0..64', () => {
    setView('sample');
    const { container } = render(() => <App />);
    const inputs = container.querySelectorAll<HTMLInputElement>('.samplemeta input[type="number"]');
    // Find the Volume input by its label text.
    let volume: HTMLInputElement | null = null;
    for (const el of inputs) {
      const label = el.closest('label')!;
      if (label.textContent!.includes('Volume')) volume = el;
    }
    expect(volume).not.toBeNull();
    fireEvent.input(volume!, { target: { value: '999' } });
    expect(song()!.samples[0]!.volume).toBe(64);
    fireEvent.input(volume!, { target: { value: '-1' } });
    expect(song()!.samples[0]!.volume).toBe(0);
  });

  it('finetune input encodes signed values back to PT\'s nibble layout', () => {
    setView('sample');
    const { container } = render(() => <App />);
    const inputs = container.querySelectorAll<HTMLInputElement>('.samplemeta input[type="number"]');
    let finetune: HTMLInputElement | null = null;
    for (const el of inputs) {
      const label = el.closest('label')!;
      if (label.textContent!.includes('Finetune')) finetune = el;
    }
    expect(finetune).not.toBeNull();
    fireEvent.input(finetune!, { target: { value: '-1' } });
    expect(song()!.samples[0]!.finetune).toBe(15); // -1 → stored as 15
    fireEvent.input(finetune!, { target: { value: '7' } });
    expect(song()!.samples[0]!.finetune).toBe(7);
    fireEvent.input(finetune!, { target: { value: '-8' } });
    expect(song()!.samples[0]!.finetune).toBe(8);
  });

  it('Clear button is disabled for an empty slot', () => {
    setView('sample');
    const { container } = render(() => <App />);
    const buttons = container.querySelectorAll<HTMLButtonElement>('.sampleview__actions button');
    const clearBtn = Array.from(buttons).find((b) => b.textContent === 'Clear sample')!;
    expect(clearBtn.disabled).toBe(true);
  });

  it('Clear button resets a populated sample', async () => {
    setView('sample');
    const { container } = render(() => <App />);
    // App.onMount has now seeded `song()` with an emptySong; populate sample 1.
    const s0 = song()!;
    setSong({
      ...s0,
      samples: s0.samples.map((sm, i) => i === 0
        ? { ...sm, name: 'kick', lengthWords: 8, volume: 64, data: new Int8Array(16) }
        : sm),
    });
    const user = userEvent.setup();
    const buttons = container.querySelectorAll<HTMLButtonElement>('.sampleview__actions button');
    const clearBtn = Array.from(buttons).find((b) => b.textContent === 'Clear sample')!;
    expect(clearBtn.disabled).toBe(false);
    await user.click(clearBtn);
    expect(song()!.samples[0]!.lengthWords).toBe(0);
    expect(song()!.samples[0]!.name).toBe('');
  });
});

describe('SampleView: WAV loading', () => {
  it('loading a WAV updates the current slot\'s data, length, name, volume', async () => {
    setView('sample');
    setCurrentSample(2);
    const { container } = render(() => <App />);

    // Build a synthetic 16-bit mono WAV in memory and feed it through the
    // file input. We use 256 frames so the C-2 default resampler (which
    // downsamples 22050 Hz → ~8287 Hz, ratio ~2.66) still emits a non-trivial
    // output buffer.
    const { writeWav } = await import('../../src/core/audio/wav');
    const wav = writeWav({
      sampleRate: 22050,
      channels: [new Float32Array(256).fill(0.5)],
    }, { bitsPerSample: 16 });
    // Copy into a fresh ArrayBuffer so File's BlobPart narrowing is satisfied.
    const buf = new ArrayBuffer(wav.byteLength);
    new Uint8Array(buf).set(wav);
    const file = new File([buf], 'snare.wav', { type: 'audio/wav' });

    const input = container.querySelector<HTMLInputElement>('.sampleview__actions input[type="file"]')!;
    const user = userEvent.setup();
    await user.upload(input, file);

    const s = song()!.samples[1]!;
    expect(s.name).toBe('snare');
    expect(s.volume).toBe(64);
    // 256 frames @ 22050 Hz resampled to ~8287 Hz → ~96 frames.
    expect(s.data.byteLength).toBeGreaterThan(80);
    expect(s.data.byteLength).toBeLessThan(110);
    // 0.5 → ~64 in int8.
    expect(s.data[0]).toBe(64);
  });
});
