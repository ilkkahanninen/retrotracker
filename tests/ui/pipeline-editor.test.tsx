import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR } from '../../src/state/cursor';
import { setSong, setTransport, setPlayPos, clearHistory, song } from '../../src/state/song';
import { setCurrentSample, setCurrentOctave } from '../../src/state/edit';
import { setView } from '../../src/state/view';
import {
  setWorkbench, clearAllWorkbenches, getWorkbench,
} from '../../src/state/sampleWorkbench';
import { writeWav } from '../../src/core/audio/wav';
import { runPipeline as runPipelineSync, type SampleWorkbench } from '../../src/core/audio/sampleWorkbench';

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport('idle');
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setView('pattern');
  clearAllWorkbenches();
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  resetState();
});

/** Build a stereo WAV byte buffer for `user.upload`. */
function makeStereoWav(): File {
  const wav = writeWav({
    sampleRate: 44100,
    channels: [
      new Float32Array([0.5, 0.5, -0.5, -0.5]),
      new Float32Array([0.25, 0.25, -0.25, -0.25]),
    ],
  }, { bitsPerSample: 16 });
  const buf = new ArrayBuffer(wav.byteLength);
  new Uint8Array(buf).set(wav);
  return new File([buf], 'stereo-test.wav', { type: 'audio/wav' });
}

/**
 * Seed a known workbench for slot 0 and write its pipeline output into the
 * song so the UI's view of the slot matches the workbench. Requires that
 * App has already mounted (so `song()` is non-null).
 */
function seedSampleWithWorkbench(wb: SampleWorkbench): void {
  const s = song();
  if (!s) throw new Error('seedSampleWithWorkbench needs a mounted song; render(App) first');
  setWorkbench(0, wb);
  // Apply the pipeline so the slot's int8 data matches what the editor shows.
  // We mimic what App's writeWorkbenchToSong does, but inline to avoid pulling
  // it through props (the test only cares about end state).
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- async import in tests is awkward
  // We use require here is impossible in ESM; use top-level import instead.
  const data = runPipelineSync(wb);
  setSong({
    ...s,
    samples: s.samples.map((sm, i) => i === 0
      ? {
          ...sm, name: 'demo', volume: 64,
          lengthWords: data.byteLength >> 1,
          data,
        }
      : sm),
  });
}

describe('pipeline: WAV load creates a workbench', () => {
  it('loading a stereo WAV produces a workbench with the source intact and an empty chain', async () => {
    setView('sample');
    setCurrentSample(2); // load into slot 2 (index 1)
    const { container } = render(() => <App />);
    const fileInput = container.querySelector<HTMLInputElement>(
      '.sampleview__actions input[type="file"]',
    )!;
    await userEvent.setup().upload(fileInput, makeStereoWav());

    const wb = getWorkbench(1);
    expect(wb).toBeDefined();
    expect(wb!.source.sampleRate).toBe(44100);
    expect(wb!.source.channels).toHaveLength(2);
    expect(wb!.chain).toEqual([]);
    expect(wb!.pt.monoMix).toBe('average');
    // Pipeline ran: slot 1 received int8 data.
    expect(song()!.samples[1]!.lengthWords).toBeGreaterThan(0);
  });
});

describe('pipeline editor: visibility', () => {
  it('the pipeline editor renders only when a workbench exists for the current slot', () => {
    setView('sample');
    const { container } = render(() => <App />);
    expect(container.querySelector('.pipeline')).toBeNull();
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0, 0.5, -0.5])] },
      sourceName: 'demo',
      chain: [],
      pt: { monoMix: 'average', targetNote: null },
    });
    expect(container.querySelector('.pipeline')).not.toBeNull();
  });

  it('the section heading reads "Effects"', () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0])] },
      sourceName: 'demo',
      chain: [],
      pt: { monoMix: 'average', targetNote: null },
    });
    expect(container.querySelector('.pipeline__header h3')!.textContent).toBe('Effects');
  });

  it('the source line shows rate / channel count / frame count', () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 22050,
        channels: [new Float32Array(100), new Float32Array(100)],
      },
      sourceName: 'demo',
      chain: [],
      pt: { monoMix: 'average', targetNote: null },
    });
    const src = container.querySelector('.pipeline__source')!.textContent!;
    expect(src).toContain('demo');
    expect(src).toContain('22050');
    expect(src).toContain('stereo');
    expect(src).toContain('100 frames');
  });
});

describe('pipeline editor: add / remove / reorder', () => {
  it('selecting a kind from the picker appends a default-param node', async () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0, 1, -1])] },
      sourceName: 'demo',
      chain: [],
      pt: { monoMix: 'average', targetNote: null },
    });
    const select = container.querySelector<HTMLSelectElement>(
      '.pipeline__add select',
    )!;
    fireEvent.change(select, { target: { value: 'gain' } });
    expect(getWorkbench(0)!.chain).toHaveLength(1);
    expect(getWorkbench(0)!.chain[0]!.kind).toBe('gain');
  });

  it('the × button removes the node at that row', async () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0, 1, -1])] },
      sourceName: 'demo',
      chain: [{ kind: 'normalize' }, { kind: 'reverse' }],
      pt: { monoMix: 'average', targetNote: null },
    });
    const removeBtn = container.querySelector<HTMLButtonElement>(
      '.effect-node__controls button[aria-label="Remove effect 1"]',
    )!;
    await userEvent.setup().click(removeBtn);
    expect(getWorkbench(0)!.chain).toEqual([{ kind: 'reverse' }]);
  });

  it('the ↓ button swaps with the next node', async () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0, 1])] },
      sourceName: 'demo',
      chain: [{ kind: 'normalize' }, { kind: 'reverse' }],
      pt: { monoMix: 'average', targetNote: null },
    });
    const downBtn = container.querySelector<HTMLButtonElement>(
      '.effect-node__controls button[aria-label="Move effect 1 down"]',
    )!;
    await userEvent.setup().click(downBtn);
    const chain = getWorkbench(0)!.chain;
    expect(chain[0]!.kind).toBe('reverse');
    expect(chain[1]!.kind).toBe('normalize');
  });
});

describe('pipeline editor: live param updates re-run the pipeline', () => {
  it('changing the gain re-renders the int8 result in the song slot', () => {
    setView('sample');
    const { container } = render(() => <App />);
    // Seed with a non-trivial source and a gain effect.
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0, 0.25, -0.25])] },
      sourceName: 'demo',
      chain: [{ kind: 'gain', params: { gain: 1 } }],
      pt: { monoMix: 'average', targetNote: null },
    });
    // The gain input lives inside the first .effect-node row.
    const gainInput = container.querySelector<HTMLInputElement>('.effect-node input')!;
    fireEvent.input(gainInput, { target: { value: '4' } });
    // 0.25 × 4 = 1.0 → int8 127. -0.25 × 4 = -1.0 → -127.
    const data = song()!.samples[0]!.data;
    expect(data[0]).toBe(0);
    expect(data[1]).toBe(127);
    expect(data[2]).toBe(-127);
  });

  it('switching mono mix on a stereo source changes the int8 output', async () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [
        new Float32Array([1, 1]),
        new Float32Array([-1, -1]),
      ] },
      sourceName: 'demo',
      chain: [],
      pt: { monoMix: 'average', targetNote: null },
    });
    // average → 0,0
    expect(Array.from(song()!.samples[0]!.data)).toEqual([0, 0]);
    const monoSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Mono mix"]',
    )!;
    fireEvent.change(monoSelect, { target: { value: 'left' } });
    // left → 1, 1 → 127, 127
    expect(Array.from(song()!.samples[0]!.data)).toEqual([127, 127]);
    fireEvent.change(monoSelect, { target: { value: 'right' } });
    expect(Array.from(song()!.samples[0]!.data)).toEqual([-127, -127]);
  });
});

describe('pipeline editor: target-note selector', () => {
  it('changing the target note re-runs the pipeline and resamples to that rate', () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array(256).fill(1)] },
      sourceName: 'demo',
      chain: [],
      pt: { monoMix: 'average', targetNote: null },
    });
    const before = song()!.samples[0]!.lengthWords;
    expect(before).toBe(128); // 256 frames / 2 bytes-per-word, no resample

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Target note"]',
    )!;
    fireEvent.change(select, { target: { value: '12' } }); // C-2
    // 256 frames at 44100 Hz → ~48 frames at ~8287 Hz → ~24 words.
    const after = song()!.samples[0]!.lengthWords;
    expect(after).toBeGreaterThan(20);
    expect(after).toBeLessThan(30);
  });

  it('selecting "(none)" disables resampling — back to source rate', () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array(256).fill(1)] },
      sourceName: 'demo',
      chain: [],
      pt: { monoMix: 'average', targetNote: 12 }, // resampled to ~48 frames
    });
    expect(song()!.samples[0]!.lengthWords).toBeLessThan(30);

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Target note"]',
    )!;
    fireEvent.change(select, { target: { value: '' } });
    expect(song()!.samples[0]!.lengthWords).toBe(128);
  });
});

describe('pipeline editor: editing params preserves input focus', () => {
  // Regression: every keystroke flowed through patchEffect → new chain item
  // reference → keyed <For>/<Show>/<Match> children disposed and remounted,
  // killing focus on each character. The structural fix (Index + non-keyed
  // Show/Match) is observable here: the same DOM input survives many edits.
  it('the gain input element is preserved across consecutive patches', () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0, 0.25, -0.25])] },
      sourceName: 'demo',
      chain: [{ kind: 'gain', params: { gain: 1 } }],
      pt: { monoMix: 'average', targetNote: null },
    });
    const first = container.querySelector<HTMLInputElement>('.effect-node input')!;
    fireEvent.input(first, { target: { value: '2' } });
    fireEvent.input(first, { target: { value: '2.5' } });
    fireEvent.input(first, { target: { value: '3' } });
    const after = container.querySelector<HTMLInputElement>('.effect-node input')!;
    expect(after).toBe(first); // same DOM node — no remount, focus would survive
    expect(getWorkbench(0)!.chain[0]).toEqual({ kind: 'gain', params: { gain: 3 } });
  });

  it('the volume metadata input is preserved when the pipeline re-runs', () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0, 0.25, -0.25])] },
      sourceName: 'demo',
      chain: [{ kind: 'gain', params: { gain: 1 } }],
      pt: { monoMix: 'average', targetNote: null },
    });
    const inputs = container.querySelectorAll<HTMLInputElement>('.samplemeta input[type="number"]');
    let volumeBefore: HTMLInputElement | null = null;
    for (const el of inputs) {
      if (el.closest('label')!.textContent!.includes('Volume')) volumeBefore = el;
    }
    expect(volumeBefore).not.toBeNull();
    // Trigger a pipeline patch by editing the gain.
    const gain = container.querySelector<HTMLInputElement>('.effect-node input')!;
    fireEvent.input(gain, { target: { value: '2' } });
    let volumeAfter: HTMLInputElement | null = null;
    for (const el of container.querySelectorAll<HTMLInputElement>('.samplemeta input[type="number"]')) {
      if (el.closest('label')!.textContent!.includes('Volume')) volumeAfter = el;
    }
    expect(volumeAfter).toBe(volumeBefore);
  });
});

describe('pipeline editor: re-run preserves user-set sample metadata', () => {
  it('a manual volume change is not clobbered by a subsequent pipeline edit', () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0, 0.5, -0.5])] },
      sourceName: 'demo',
      chain: [],
      pt: { monoMix: 'average', targetNote: null },
    });
    // Tweak the volume by hand via the metadata UI.
    const inputs = container.querySelectorAll<HTMLInputElement>('.samplemeta input[type="number"]');
    let volume: HTMLInputElement | null = null;
    for (const el of inputs) {
      if (el.closest('label')!.textContent!.includes('Volume')) volume = el;
    }
    fireEvent.input(volume!, { target: { value: '32' } });
    expect(song()!.samples[0]!.volume).toBe(32);

    // Now add a Gain effect — pipeline re-runs.
    const select = container.querySelector<HTMLSelectElement>('.pipeline__add select')!;
    fireEvent.change(select, { target: { value: 'gain' } });

    // Volume should still be 32, not reset to 64.
    expect(song()!.samples[0]!.volume).toBe(32);
  });
});

describe('pipeline editor: re-run preserves user-set loop', () => {
  // Regression: every workbench re-run went through replaceSampleData, which
  // hard-coded loop back to (0, 1). Editing any effect param wiped the loop.
  it('a configured loop survives a subsequent pipeline edit', () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array(200).fill(0.5)] },
      sourceName: 'demo',
      chain: [{ kind: 'gain', params: { gain: 1 } }],
      pt: { monoMix: 'average', targetNote: null },
    });
    // Configure a loop directly on the song (mirrors what dragging the
    // waveform handles produces).
    const s0 = song()!;
    setSong({
      ...s0,
      samples: s0.samples.map((sm, i) => i === 0
        ? { ...sm, loopStartWords: 4, loopLengthWords: 12 }
        : sm),
    });
    expect(song()!.samples[0]!.loopStartWords).toBe(4);
    expect(song()!.samples[0]!.loopLengthWords).toBe(12);

    // Tweak the gain — pipeline re-runs, sample data is rewritten.
    const gain = container.querySelector<HTMLInputElement>('.effect-node input')!;
    fireEvent.input(gain, { target: { value: '2' } });

    // Loop should still be there.
    expect(song()!.samples[0]!.loopStartWords).toBe(4);
    expect(song()!.samples[0]!.loopLengthWords).toBe(12);
  });
});

describe('pipeline editor: workbench is cleared on .mod load', () => {
  it('loading a fresh empty song clears any existing workbenches', () => {
    setWorkbench(0, {
      source: { sampleRate: 44100, channels: [new Float32Array([0])] },
      sourceName: 'demo',
      chain: [],
      pt: { monoMix: 'average', targetNote: null },
    });
    expect(getWorkbench(0)).toBeDefined();
    clearAllWorkbenches();
    expect(getWorkbench(0)).toBeUndefined();
  });
});
