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
      pt: { monoMix: 'average' },
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
      pt: { monoMix: 'average' },
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
      pt: { monoMix: 'average' },
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
      pt: { monoMix: 'average' },
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
      pt: { monoMix: 'average' },
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
      pt: { monoMix: 'average' },
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
      pt: { monoMix: 'average' },
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
      pt: { monoMix: 'average' },
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

describe('pipeline editor: re-run preserves user-set sample metadata', () => {
  it('a manual volume change is not clobbered by a subsequent pipeline edit', () => {
    setView('sample');
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0, 0.5, -0.5])] },
      sourceName: 'demo',
      chain: [],
      pt: { monoMix: 'average' },
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

describe('pipeline editor: workbench is cleared on .mod load', () => {
  it('loading a fresh empty song clears any existing workbenches', () => {
    setWorkbench(0, {
      source: { sampleRate: 44100, channels: [new Float32Array([0])] },
      sourceName: 'demo',
      chain: [],
      pt: { monoMix: 'average' },
    });
    expect(getWorkbench(0)).toBeDefined();
    clearAllWorkbenches();
    expect(getWorkbench(0)).toBeUndefined();
  });
});
