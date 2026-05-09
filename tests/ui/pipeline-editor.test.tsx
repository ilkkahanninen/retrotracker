import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App";
import { setCursor, INITIAL_CURSOR } from "../../src/state/cursor";
import {
  setSong,
  setTransport,
  setPlayPos,
  clearHistory,
  song,
} from "../../src/state/song";
import {
  currentSample,
  setCurrentSample,
  setCurrentOctave,
} from "../../src/state/edit";
import { setView } from "../../src/state/view";
import {
  setWorkbench,
  clearAllWorkbenches,
  getWorkbench,
} from "../../src/state/sampleWorkbench";
import { writeWav } from "../../src/core/audio/wav";
import {
  runPipeline as runPipelineSync,
  type SampleWorkbench,
  type EffectNode,
  type PtTransformerParams,
} from "../../src/core/audio/sampleWorkbench";
import type { WavData } from "../../src/core/audio/wav";

/**
 * Compact fixture shape for `seedSampleWithWorkbench` — these tests pre-date
 * the SampleSource union and inline `{ source, sourceName, chain, pt }` for
 * brevity. The seed helper translates to the new sampler-source shape.
 */
interface LegacyWorkbenchFixture {
  source: WavData;
  sourceName: string;
  chain: EffectNode[];
  pt: PtTransformerParams;
}

function fixtureToWorkbench(f: LegacyWorkbenchFixture): SampleWorkbench {
  return {
    source: { kind: "sampler", wav: f.source, sourceName: f.sourceName },
    chain: f.chain,
    pt: f.pt,
    alt: null,
  };
}

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setView("pattern");
  clearAllWorkbenches();
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  resetState();
});

/** Build a stereo WAV byte buffer for `user.upload`. */
function makeStereoWav(): File {
  const wav = writeWav(
    {
      sampleRate: 44100,
      channels: [
        new Float32Array([0.5, 0.5, -0.5, -0.5]),
        new Float32Array([0.25, 0.25, -0.25, -0.25]),
      ],
    },
    { bitsPerSample: 16 },
  );
  const buf = new ArrayBuffer(wav.byteLength);
  new Uint8Array(buf).set(wav);
  return new File([buf], "stereo-test.wav", { type: "audio/wav" });
}

/**
 * Seed a known workbench for slot 0 and write its pipeline output into the
 * song so the UI's view of the slot matches the workbench. Requires that
 * App has already mounted (so `song()` is non-null).
 */
function seedSampleWithWorkbench(fixture: LegacyWorkbenchFixture): void {
  const s = song();
  if (!s)
    throw new Error(
      "seedSampleWithWorkbench needs a mounted song; render(App) first",
    );
  const wb = fixtureToWorkbench(fixture);
  setWorkbench(0, wb);
  // Apply the pipeline so the slot's int8 data matches what the editor shows.
  // We mimic what App's writeWorkbenchToSong does, but inline to avoid pulling
  // it through props (the test only cares about end state).
  const data = runPipelineSync(wb);
  setSong({
    ...s,
    samples: s.samples.map((sm, i) =>
      i === 0
        ? {
            ...sm,
            name: "demo",
            volume: 64,
            lengthWords: data.byteLength >> 1,
            data,
          }
        : sm,
    ),
  });
}

describe("pipeline: WAV load creates a workbench", () => {
  it("loading a stereo WAV produces a workbench with the source intact and an empty chain", async () => {
    setView("sample");
    setCurrentSample(2); // load into slot 2 (index 1)
    const { container } = render(() => <App />);
    const fileInput = container.querySelector<HTMLInputElement>(
      '.sampleview__actions input[type="file"]',
    )!;
    await userEvent.setup().upload(fileInput, makeStereoWav());
    // The change handler does `await file.arrayBuffer()` before populating
    // the workbench — wait for the resulting state instead of reading
    // synchronously after `upload` resolves.
    await waitFor(() => expect(getWorkbench(1)).toBeDefined());

    const wb = getWorkbench(1)!;
    if (wb.source.kind !== "sampler")
      throw new Error("expected sampler source");
    expect(wb.source.wav.sampleRate).toBe(44100);
    expect(wb.source.wav.channels).toHaveLength(2);
    expect(wb.chain).toEqual([]);
    expect(wb.pt.monoMix).toBe("average");
    // Pipeline ran: slot 1 received int8 data.
    expect(song()!.samples[1]!.lengthWords).toBeGreaterThan(0);
  });
});

describe("pipeline editor: visibility", () => {
  it("the pipeline editor renders only when a workbench exists for the current slot", () => {
    setView("sample");
    const { container } = render(() => <App />);
    expect(container.querySelector(".pipeline")).toBeNull();
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0, 0.5, -0.5])],
      },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null },
    });
    expect(container.querySelector(".pipeline")).not.toBeNull();
  });

  it('the section heading reads "Effects"', () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0])] },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null },
    });
  });

  it("the source line shows rate / channel count / frame count", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 22050,
        channels: [new Float32Array(100), new Float32Array(100)],
      },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null },
    });
    const src = container.querySelector(".pipeline__source")!.textContent!;
    expect(src).toContain("demo");
    expect(src).toContain("22050");
    expect(src).toContain("stereo");
    expect(src).toContain("100 frames");
  });
});

/**
 * The Crop/Cut/Reverse/Fade-in/Fade-out/Gain/Normalize buttons live in the
 * SampleView's selection action row (next to the waveform). Helper to grab
 * one by visible label, since all buttons in that row share the same class.
 */
function findEffectButton(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  for (const btn of container.querySelectorAll<HTMLButtonElement>(
    ".sampleview__selection button",
  )) {
    if (btn.textContent?.trim() === label) return btn;
  }
  throw new Error(`No effect button labelled "${label}"`);
}

/**
 * Open the Edit ▾ dropdown in the header and click the item that starts
 * with `label` (e.g. "Undo", "Redo"). Used in place of the old
 * `button[title="Undo (⌘Z)"]` query — those buttons moved into the menu.
 */
function clickEditMenu(container: HTMLElement, label: string): void {
  let trigger: HTMLButtonElement | null = null;
  for (const btn of container.querySelectorAll<HTMLButtonElement>(
    ".menu__button",
  )) {
    if (btn.textContent?.startsWith("Edit")) {
      trigger = btn;
      break;
    }
  }
  if (!trigger) throw new Error("Edit menu button not found");
  fireEvent.click(trigger);
  for (const item of container.querySelectorAll<HTMLElement>(".menu__item")) {
    if (item.textContent?.startsWith(label)) {
      fireEvent.click(item);
      return;
    }
  }
  throw new Error(`No edit-menu item labelled "${label}"`);
}

describe("pipeline editor: add / remove / reorder", () => {
  it("clicking the Gain button appends a default-param node", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0, 1, -1])] },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null },
    });
    await userEvent.setup().click(findEffectButton(container, "Volume"));
    expect(getWorkbench(0)!.chain).toHaveLength(1);
    expect(getWorkbench(0)!.chain[0]!.kind).toBe("volume");
  });

  it("the × button removes the node at that row", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0, 1, -1])] },
      sourceName: "demo",
      chain: [
        { kind: "normalize" },
        { kind: "reverse", params: { startFrame: 0, endFrame: 3 } },
      ],
      pt: { monoMix: "average", targetNote: null },
    });
    const removeBtn = container.querySelector<HTMLButtonElement>(
      '.effect-node__controls button[aria-label="Remove effect 1"]',
    )!;
    await userEvent.setup().click(removeBtn);
    expect(getWorkbench(0)!.chain).toEqual([
      { kind: "reverse", params: { startFrame: 0, endFrame: 3 } },
    ]);
  });

  it("the ↓ button swaps with the next node", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0, 1])] },
      sourceName: "demo",
      chain: [
        { kind: "normalize" },
        { kind: "reverse", params: { startFrame: 0, endFrame: 3 } },
      ],
      pt: { monoMix: "average", targetNote: null },
    });
    const downBtn = container.querySelector<HTMLButtonElement>(
      '.effect-node__controls button[aria-label="Move effect 1 down"]',
    )!;
    await userEvent.setup().click(downBtn);
    const chain = getWorkbench(0)!.chain;
    expect(chain[0]!.kind).toBe("reverse");
    expect(chain[1]!.kind).toBe("normalize");
  });
});

describe("pipeline editor: live param updates re-run the pipeline", () => {
  it("a volume envelope chain entry re-renders the int8 result in the song slot", () => {
    setView("sample");
    const { container } = render(() => <App />);
    // Seed with a 2-point volume envelope at gain 2 — flat ×2 across the source.
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0, 0.25, -0.25])],
      },
      sourceName: "demo",
      chain: [
        {
          kind: "volume",
          params: {
            points: [
              { frame: 0, value: 2 },
              { frame: 2, value: 2 },
            ],
          },
        },
      ],
      pt: { monoMix: "average", targetNote: null },
    });
    // 0.25 × 2 = 0.5 → int8 64 (≈127*0.5). -0.25 × 2 = -0.5 → -64.
    const data = song()!.samples[0]!.data;
    expect(data[0]).toBe(0);
    expect(Math.abs(data[1]! - 64)).toBeLessThanOrEqual(1);
    expect(Math.abs(data[2]! + 64)).toBeLessThanOrEqual(1);
    // The chain editor renders the envelope as a one-line summary, not a slider.
    expect(container.querySelector(".effect-node__hint")?.textContent).toMatch(
      /points/,
    );
  });

  it("switching mono mix on a stereo source changes the int8 output", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([1, 1]), new Float32Array([-1, -1])],
      },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null },
    });
    // average → 0,0
    expect(Array.from(song()!.samples[0]!.data)).toEqual([0, 0]);
    const monoSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Mono mix"]',
    )!;
    fireEvent.change(monoSelect, { target: { value: "left" } });
    // left → 1, 1 → 127, 127
    expect(Array.from(song()!.samples[0]!.data)).toEqual([127, 127]);
    fireEvent.change(monoSelect, { target: { value: "right" } });
    expect(Array.from(song()!.samples[0]!.data)).toEqual([-127, -127]);
  });
});

describe("pipeline editor: resample-mode selector", () => {
  it("changing the resample mode re-runs the pipeline (output diverges from linear)", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    // Use a varying source so the resamplers diverge — a flat input would
    // round to identical int8 under both algorithms.
    const N = 256;
    const ch = new Float32Array(N);
    for (let i = 0; i < N; i++)
      ch[i] = Math.sin((2 * Math.PI * 3000 * i) / 44100);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [ch] },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: 12, resampleMode: "linear" },
    });
    const before = Array.from(song()!.samples[0]!.data);

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Resample mode"]',
    )!;
    fireEvent.change(select, { target: { value: "sinc" } });

    expect(getWorkbench(0)!.pt.resampleMode).toBe("sinc");
    const after = Array.from(song()!.samples[0]!.data);
    expect(after).not.toEqual(before);
  });

  it("the resample-mode select is hidden when targetNote is null", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array(8).fill(0.5)] },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null, resampleMode: "linear" },
    });
    expect(
      container.querySelector('select[aria-label="Resample mode"]'),
    ).toBeNull();
  });
});

describe("pipeline editor: dither toggle", () => {
  it("checking the Dither checkbox flips pt.dither on the workbench", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0, 0.5, -0.5])],
      },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null, resampleMode: "linear" },
    });
    expect(getWorkbench(0)!.pt.dither).toBeFalsy();

    const cb = container.querySelector<HTMLInputElement>(
      'input[aria-label="Dither"]',
    )!;
    expect(cb.checked).toBe(false);
    fireEvent.click(cb);
    expect(getWorkbench(0)!.pt.dither).toBe(true);
  });

  it("the Dither checkbox is visible even when targetNote is null", async () => {
    // Quantisation runs on every export, regardless of resample, so the
    // checkbox stays available — unlike the resample-mode dropdown which
    // hides itself when there's no rate change.
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array(8).fill(0.5)] },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null, resampleMode: "linear" },
    });
    expect(
      container.querySelector('input[aria-label="Dither"]'),
    ).not.toBeNull();
  });
});

describe("pipeline editor: target-note selector", () => {
  it("changing the target note re-runs the pipeline and resamples to that rate", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array(256).fill(1)] },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null },
    });
    const before = song()!.samples[0]!.lengthWords;
    expect(before).toBe(128); // 256 frames / 2 bytes-per-word, no resample

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Target note"]',
    )!;
    fireEvent.change(select, { target: { value: "12" } }); // C-2
    // 256 frames at 44100 Hz → ~48 frames at ~8287 Hz → ~24 words.
    const after = song()!.samples[0]!.lengthWords;
    expect(after).toBeGreaterThan(20);
    expect(after).toBeLessThan(30);
  });

  it('selecting "(none)" disables resampling — back to source rate', () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array(256).fill(1)] },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: 12 }, // resampled to ~48 frames
    });
    expect(song()!.samples[0]!.lengthWords).toBeLessThan(30);

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Target note"]',
    )!;
    fireEvent.change(select, { target: { value: "" } });
    expect(song()!.samples[0]!.lengthWords).toBe(128);
  });

  it("blurs selects and checkboxes after commit so piano keys flow to shortcuts", () => {
    // Regression: selects and checkboxes kept focus after the user changed a
    // value, so subsequent letter keys were swallowed (selects type-search
    // options; focused checkboxes don't, but bare-key shortcuts skip on any
    // focused select per `focusKind` in shortcuts.ts). The fix is a blur-on-
    // commit listener at the SampleView root.
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array(8).fill(0.5)] },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: 12 },
    });
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Target note"]',
    )!;
    select.focus();
    expect(document.activeElement).toBe(select);
    fireEvent.change(select, { target: { value: "24" } }); // C-3
    expect(document.activeElement).not.toBe(select);

    const cb = container.querySelector<HTMLInputElement>(
      'input[aria-label="Dither"]',
    )!;
    cb.focus();
    expect(document.activeElement).toBe(cb);
    fireEvent.click(cb);
    expect(document.activeElement).not.toBe(cb);
  });

  it("changing the target note scales loop points proportionally", () => {
    // Regression: switching target-note resampled the int8 to a new length
    // but kept loopStartWords / loopLengthWords literal — the loop pointed
    // at a different proportional region (or got clamped to the new tail).
    // After the fix, the loop window's relative position is preserved.
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array(256).fill(1)] },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null },
    });
    // Configure a real loop on the slot directly (mirrors a user dragging
    // the loop handles on the waveform). Loop covers bytes 64..192 of a
    // 256-byte sample — i.e. the middle 50%.
    const before = song()!;
    setSong({
      ...before,
      samples: before.samples.map((sm, i) =>
        i === 0 ? { ...sm, loopStartWords: 32, loopLengthWords: 64 } : sm,
      ),
    });
    expect(song()!.samples[0]!.lengthWords).toBe(128);
    expect(song()!.samples[0]!.loopStartWords).toBe(32);
    expect(song()!.samples[0]!.loopLengthWords).toBe(64);

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Target note"]',
    )!;
    fireEvent.change(select, { target: { value: "12" } }); // C-2 → ~48 frames

    const after = song()!.samples[0]!;
    expect(after.lengthWords).toBeLessThan(30);
    // Loop window stays at the middle ~50% of the (now shorter) sample.
    // Allow a 1-word tolerance for word-aligned rounding.
    const startFrac = after.loopStartWords / after.lengthWords;
    const endFrac =
      (after.loopStartWords + after.loopLengthWords) / after.lengthWords;
    expect(startFrac).toBeGreaterThan(0.2);
    expect(startFrac).toBeLessThan(0.3);
    expect(endFrac).toBeGreaterThan(0.7);
    expect(endFrac).toBeLessThan(0.8);
    // And it remains a real loop, not the no-loop sentinel.
    expect(after.loopLengthWords).toBeGreaterThan(1);
  });
});

describe("pipeline editor: editing params preserves input focus", () => {
  // Regression: every keystroke flowed through patchEffect → new chain item
  // reference → keyed <For>/<Show>/<Match> children disposed and remounted,
  // killing focus on each character. The structural fix (Index + non-keyed
  // Show/Match) is observable here: the same DOM input survives many edits.
  it("an effect-node param input is preserved across consecutive patches", () => {
    // The volume envelope no longer renders a slider in the chain editor
    // (it's edited on the waveform overlay), but other effects with sliders
    // still do — use a crossfade slider to verify the same DOM-preservation
    // contract holds.
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        // Need enough frames + a loop so crossfade is meaningful.
        channels: [new Float32Array(200).fill(0.5)],
      },
      sourceName: "demo",
      chain: [{ kind: "crossfade", params: { length: 4 } }],
      pt: { monoMix: "average", targetNote: null },
    });
    const first =
      container.querySelector<HTMLInputElement>(".effect-node input")!;
    fireEvent.input(first, { target: { value: "8" } });
    fireEvent.input(first, { target: { value: "12" } });
    fireEvent.input(first, { target: { value: "16" } });
    const after =
      container.querySelector<HTMLInputElement>(".effect-node input")!;
    expect(after).toBe(first); // same DOM node — no remount, focus would survive
    expect(getWorkbench(0)!.chain[0]).toEqual({
      kind: "crossfade",
      params: { length: 16 },
    });
  });

  it("the volume metadata input is preserved when the pipeline re-runs", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array(200).fill(0.5)],
      },
      sourceName: "demo",
      chain: [{ kind: "crossfade", params: { length: 4 } }],
      pt: { monoMix: "average", targetNote: null },
    });
    const inputs = container.querySelectorAll<HTMLInputElement>(
      '.samplemeta input[type="range"]',
    );
    let volumeBefore: HTMLInputElement | null = null;
    for (const el of inputs) {
      if (el.closest("label")!.textContent!.includes("Volume"))
        volumeBefore = el;
    }
    expect(volumeBefore).not.toBeNull();
    // Trigger a pipeline patch by editing the crossfade length.
    const slider =
      container.querySelector<HTMLInputElement>(".effect-node input")!;
    fireEvent.input(slider, { target: { value: "12" } });
    let volumeAfter: HTMLInputElement | null = null;
    for (const el of container.querySelectorAll<HTMLInputElement>(
      '.samplemeta input[type="range"]',
    )) {
      if (el.closest("label")!.textContent!.includes("Volume"))
        volumeAfter = el;
    }
    expect(volumeAfter).toBe(volumeBefore);
  });
});

describe("pipeline editor: re-run preserves user-set sample metadata", () => {
  it("a manual volume change is not clobbered by a subsequent pipeline edit", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0, 0.5, -0.5])],
      },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null },
    });
    // Tweak the volume by hand via the metadata UI.
    const inputs = container.querySelectorAll<HTMLInputElement>(
      '.samplemeta input[type="range"]',
    );
    let volume: HTMLInputElement | null = null;
    for (const el of inputs) {
      if (el.closest("label")!.textContent!.includes("Volume")) volume = el;
    }
    fireEvent.input(volume!, { target: { value: "32" } });
    expect(song()!.samples[0]!.volume).toBe(32);

    // Now add a Gain effect — pipeline re-runs.
    await userEvent.setup().click(findEffectButton(container, "Volume"));

    // Volume should still be 32, not reset to 64.
    expect(song()!.samples[0]!.volume).toBe(32);
  });
});

describe("pipeline editor: re-run preserves user-set loop", () => {
  // Regression: every workbench re-run went through replaceSampleData, which
  // hard-coded loop back to (0, 1). Editing any effect param wiped the loop.
  it("a configured loop survives a subsequent pipeline edit", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array(200).fill(0.5)],
      },
      sourceName: "demo",
      // Crossfade has a slider in the chain editor; volume's editor lives
      // on the waveform overlay, so we pick crossfade to drive a re-run
      // through a chain-editor input without leaving the panel.
      chain: [{ kind: "crossfade", params: { length: 4 } }],
      pt: { monoMix: "average", targetNote: null },
    });
    // Configure a loop directly on the song (mirrors what dragging the
    // waveform handles produces).
    const s0 = song()!;
    setSong({
      ...s0,
      samples: s0.samples.map((sm, i) =>
        i === 0 ? { ...sm, loopStartWords: 4, loopLengthWords: 12 } : sm,
      ),
    });
    expect(song()!.samples[0]!.loopStartWords).toBe(4);
    expect(song()!.samples[0]!.loopLengthWords).toBe(12);

    // Tweak the crossfade slider — pipeline re-runs, sample data is rewritten.
    const slider =
      container.querySelector<HTMLInputElement>(".effect-node input")!;
    fireEvent.input(slider, { target: { value: "8" } });

    // Loop should still be there.
    expect(song()!.samples[0]!.loopStartWords).toBe(4);
    expect(song()!.samples[0]!.loopLengthWords).toBe(12);
  });
});

describe("pipeline editor: effect buttons append range-aware nodes (non-destructive)", () => {
  // Crop/Cut still require a selection (and can't be driven without canvas
  // drag in jsdom), but Reverse / Fade in / Fade out fall back to a sane
  // whole-sample default range when no selection is active. Clicking the
  // button appends a node onto the chain — the same chain-append path
  // selection-aware applies use, just with the default range.
  it("Reverse with no selection appends a reverse effect spanning the whole chain output", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array(256).fill(0.5)],
      },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null }, // no resample → chain out = 256
    });
    await userEvent.setup().click(findEffectButton(container, "Reverse"));
    const chain = getWorkbench(0)!.chain;
    expect(chain).toHaveLength(1);
    const node = chain[0]!;
    expect(node.kind).toBe("reverse");
    if (node.kind === "reverse") {
      expect(node.params.startFrame).toBe(0);
      expect(node.params.endFrame).toBe(256);
    }
  });

  it("Volume button appends a 2-point flat envelope spanning the chain output", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array(2048).fill(0.5)],
      },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null },
    });
    await userEvent.setup().click(findEffectButton(container, "Volume"));
    const chain = getWorkbench(0)!.chain;
    expect(chain).toHaveLength(1);
    const node = chain[0]!;
    expect(node.kind).toBe("volume");
    if (node.kind === "volume") {
      expect(node.params.points).toHaveLength(2);
      // Endpoints span the chain-stage's input length and start at gain 1.
      expect(node.params.points[0]!).toEqual({ frame: 0, value: 1 });
      expect(node.params.points[1]!.frame).toBe(2047);
      expect(node.params.points[1]!.value).toBe(1);
    }
  });
});

describe("pipeline editor: shaper effect", () => {
  it("clicking the Shaper button appends a softClip node at half drive", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0, 0.5, -0.5])],
      },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null },
    });
    await userEvent.setup().click(findEffectButton(container, "Shaper"));
    const chain = getWorkbench(0)!.chain;
    expect(chain).toHaveLength(1);
    const node = chain[0]!;
    expect(node.kind).toBe("shaper");
    if (node.kind === "shaper") {
      expect(node.params.mode).toBe("softClip");
      // amount is now a 2-point flat envelope at 0.5 (not a scalar).
      expect(node.params.amount).toHaveLength(2);
      expect(node.params.amount[0]!.value).toBe(0.5);
      expect(node.params.amount[1]!.value).toBe(0.5);
    }
  });

  it("changing the mode select patches the chain entry and re-runs the pipeline", () => {
    setView("sample");
    const { container } = render(() => <App />);
    // hardClip with amount envelope = 1 will push 0.5 → ±1 → int8 ±127.
    // Start with mode 'none' (passthrough) so we can observe the int8 flip
    // when the user picks hardClip.
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0.5, -0.5])],
      },
      sourceName: "demo",
      chain: [
        {
          kind: "shaper",
          params: {
            mode: "none",
            amount: [
              { frame: 0, value: 1 },
              { frame: 1, value: 1 },
            ],
          },
        },
      ],
      pt: { monoMix: "average", targetNote: null },
    });
    // 0.5 → int8 64-ish under 'none' passthrough.
    expect(song()!.samples[0]!.data[0]!).not.toBe(127);

    // The shaper row's <select> is the only one in the .effect-node body.
    const select = container.querySelector<HTMLSelectElement>(
      ".effect-node select",
    )!;
    fireEvent.change(select, { target: { value: "hardClip" } });

    const node = getWorkbench(0)!.chain[0]!;
    expect(node.kind).toBe("shaper");
    if (node.kind === "shaper") {
      expect(node.params.mode).toBe("hardClip");
      // Amount envelope preserved across the mode change.
      expect(node.params.amount[0]!.value).toBe(1);
    }
    // 0.5 ×9 → 4.5 → clamp to +1 → int8 127.
    expect(song()!.samples[0]!.data[0]!).toBe(127);
    expect(song()!.samples[0]!.data[1]!).toBe(-127);
  });
});

describe("pipeline editor: undo/redo restores chain alongside song", () => {
  // Regression: workbenches lived in a separate signal map outside the song
  // history, so undoing an effect-add reverted the int8 in the waveform but
  // left the chain UI showing the new effect — desync the user could only
  // fix by reloading. Now both halves move together inside one history entry.
  it("undoing an Add Effect drops the new node from the chain", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0, 0.5, -0.5])],
      },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null },
    });
    expect(getWorkbench(0)!.chain).toHaveLength(0);

    await userEvent.setup().click(findEffectButton(container, "Volume"));
    expect(getWorkbench(0)!.chain).toHaveLength(1);

    // Drive Undo through the Edit ▾ menu — the buttons moved out of the
    // header into the dropdown, so this also exercises the live-disabled
    // state of the menu item.
    clickEditMenu(container, "Undo");

    expect(getWorkbench(0)!.chain).toHaveLength(0);
  });

  it("redoing a previously-undone Add Effect re-introduces the node", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0, 0.5, -0.5])],
      },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null },
    });

    await userEvent.setup().click(findEffectButton(container, "Volume"));
    clickEditMenu(container, "Undo");
    expect(getWorkbench(0)!.chain).toHaveLength(0);

    clickEditMenu(container, "Redo");

    expect(getWorkbench(0)!.chain).toHaveLength(1);
    expect(getWorkbench(0)!.chain[0]!.kind).toBe("volume");
  });

  it("undoing Clear Sample restores the workbench too", async () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0, 0.5, -0.5])],
      },
      sourceName: "demo",
      chain: [
        {
          kind: "volume",
          params: {
            points: [
              { frame: 0, value: 2 },
              { frame: 1, value: 2 },
            ],
          },
        },
      ],
      pt: { monoMix: "average", targetNote: null },
    });
    expect(getWorkbench(0)).toBeDefined();

    // The actions row now holds two buttons (Load WAV + Clear sample) when
    // a sampler workbench is active. Pick by accessible label so we don't
    // accidentally click the loader.
    const clearBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".sampleview__actions button",
      ),
    ).find((b) => b.textContent === "Clear sample")!;
    await userEvent.setup().click(clearBtn);
    expect(getWorkbench(0)).toBeUndefined();

    clickEditMenu(container, "Undo");

    expect(getWorkbench(0)).toBeDefined();
    expect(getWorkbench(0)!.chain).toHaveLength(1);
    expect(getWorkbench(0)!.chain[0]!.kind).toBe("volume");
  });
});

describe("pipeline editor: workbench is cleared on .mod load", () => {
  it("loading a fresh empty song clears any existing workbenches", () => {
    setWorkbench(
      0,
      fixtureToWorkbench({
        source: { sampleRate: 44100, channels: [new Float32Array([0])] },
        sourceName: "demo",
        chain: [],
        pt: { monoMix: "average", targetNote: null },
      }),
    );
    expect(getWorkbench(0)).toBeDefined();
    clearAllWorkbenches();
    expect(getWorkbench(0)).toBeUndefined();
  });
});

describe("duplicate sample", () => {
  it("copies sample data + workbench to the next empty slot and selects it", async () => {
    setView("sample");
    setCurrentSample(1);
    const { container } = render(() => <App />);

    // Load a WAV into slot 1.
    const fileInput = container.querySelector<HTMLInputElement>(
      '.sampleview__actions input[type="file"]',
    )!;
    await userEvent.setup().upload(fileInput, makeStereoWav());
    await waitFor(() =>
      expect(song()!.samples[0]!.lengthWords).toBeGreaterThan(0),
    );
    expect(song()!.samples[1]!.lengthWords).toBe(0);

    // Click Duplicate sample (the actions row holds Load WAV + Duplicate +
    // Clear; pick by accessible label).
    const dupBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".sampleview__actions button",
      ),
    ).find((b) => b.textContent === "Duplicate sample")!;
    await userEvent.setup().click(dupBtn);

    // Slot 2 (index 1) now has the same data and a copied workbench.
    expect(song()!.samples[1]!.data).toBe(song()!.samples[0]!.data);
    expect(getWorkbench(1)).toBeDefined();
    expect(getWorkbench(1)!.source.kind).toBe("sampler");
    // Selection follows the new slot — UI labels are 1-based.
    expect(currentSample()).toBe(2);
  });
});

describe("source picker: alt-stash round-trip", () => {
  it("Chiptune's full-loop doesn't bleed into the sampler when toggling back", async () => {
    // Repro: Load WAV → Chiptune (full-loop applied) → Sampler.
    // Before the fix, the slot's loop fields stayed at the chiptune full-loop
    // because writeWorkbenchToSongPure's else branch preserved old.loop.
    setView("sample");
    setCurrentSample(1);
    const { container } = render(() => <App />);

    const fileInput = container.querySelector<HTMLInputElement>(
      '.sampleview__actions input[type="file"]',
    )!;
    await userEvent.setup().upload(fileInput, makeStereoWav());
    // Fresh sampler has no loop — loopLengthWords sentinel is 1.
    await waitFor(() => expect(getWorkbench(0)).toBeDefined());
    expect(song()!.samples[0]!.loopLengthWords).toBe(1);

    const pickerButtons = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(".source-picker button"),
      );
    await userEvent
      .setup()
      .click(pickerButtons().find((b) => b.textContent === "Chiptune")!);
    // Chiptune fully looped.
    expect(song()!.samples[0]!.loopLengthWords).toBeGreaterThan(1);

    await userEvent
      .setup()
      .click(pickerButtons().find((b) => b.textContent === "Sampler")!);
    // Sampler half restored — loop should be back to the no-loop sentinel,
    // not the chiptune full-loop value.
    expect(song()!.samples[0]!.loopLengthWords).toBe(1);
  });

  it("Sampler → Chiptune stashes the WAV; Chiptune → Sampler restores it", async () => {
    setView("sample");
    setCurrentSample(1);
    const { container } = render(() => <App />);

    // Load a WAV → sampler workbench.
    const fileInput = container.querySelector<HTMLInputElement>(
      '.sampleview__actions input[type="file"]',
    )!;
    await userEvent.setup().upload(fileInput, makeStereoWav());
    await waitFor(() => expect(getWorkbench(0)).toBeDefined());
    const samplerWb = getWorkbench(0)!;
    expect(samplerWb.source.kind).toBe("sampler");
    expect(samplerWb.alt).toBeNull();

    // Click Chiptune in the source picker.
    const pickerButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".source-picker button"),
    );
    const chiptuneBtn = pickerButtons.find(
      (b) => b.textContent === "Chiptune",
    )!;
    await userEvent.setup().click(chiptuneBtn);
    const chiptuneWb = getWorkbench(0)!;
    expect(chiptuneWb.source.kind).toBe("chiptune");
    // The previous sampler half is now the alt stash.
    expect(chiptuneWb.alt?.source.kind).toBe("sampler");

    // Click Sampler — should restore the original WAV.
    const samplerBtn = pickerButtons.find((b) => b.textContent === "Sampler")!;
    await userEvent.setup().click(samplerBtn);
    const restoredWb = getWorkbench(0)!;
    expect(restoredWb.source.kind).toBe("sampler");
    if (restoredWb.source.kind !== "sampler")
      throw new Error("expected sampler");
    expect(restoredWb.source.sourceName).toBe("stereo-test");
    // And the chiptune we just left is now the alt.
    expect(restoredWb.alt?.source.kind).toBe("chiptune");
  });

  it("Chiptune → Sampler with no remembered WAV switches to an empty sampler view (chiptune kept as alt)", async () => {
    setView("sample");
    setCurrentSample(1);
    const { container } = render(() => <App />);

    // Start in chiptune (no prior sampler).
    const pickerButtons = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(".source-picker button"),
      );
    const chiptuneBtn = pickerButtons().find(
      (b) => b.textContent === "Chiptune",
    )!;
    await userEvent.setup().click(chiptuneBtn);
    expect(getWorkbench(0)?.source.kind).toBe("chiptune");

    // Clicking Sampler with no alt-sampler drops into empty-sampler view —
    // same UX as a fresh slot — and stashes the chiptune as alt.
    const samplerBtn = pickerButtons().find(
      (b) => b.textContent === "Sampler",
    )!;
    await userEvent.setup().click(samplerBtn);
    const wb = getWorkbench(0)!;
    expect(wb.source.kind).toBe("sampler");
    expect(wb.alt?.source.kind).toBe("chiptune");
    // Empty source: no audio data, no name yet.
    if (wb.source.kind !== "sampler") throw new Error("expected sampler");
    expect(wb.source.wav.channels[0]!.length).toBe(0);
    expect(wb.source.sourceName).toBe("");

    // Loading a WAV now populates the source; alt-chiptune carries over.
    const fileInput = container.querySelector<HTMLInputElement>(
      '.sampleview__actions input[type="file"]',
    )!;
    await userEvent.setup().upload(fileInput, makeStereoWav());
    // Upload's onChange handler reads the File asynchronously — wait
    // until the workbench actually has audio data before asserting.
    await waitFor(() => {
      const wb2 = getWorkbench(0);
      if (!wb2 || wb2.source.kind !== "sampler") throw new Error("not yet");
      expect(wb2.source.wav.channels[0]!.length).toBeGreaterThan(0);
    });
    const populated = getWorkbench(0)!;
    expect(populated.source.kind).toBe("sampler");
    expect(populated.alt?.source.kind).toBe("chiptune");
    if (populated.source.kind !== "sampler")
      throw new Error("expected sampler");
    expect(populated.source.wav.channels[0]!.length).toBeGreaterThan(0);
  });
});

describe("pipeline editor: bypass toggle", () => {
  it("clicking ⏻ on a chain entry sets the bypassed flag and dims the row", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0.5, -0.5])],
      },
      sourceName: "demo",
      // Volume × 2 will turn 0.5 into ±127 (clipped at int8 max). When
      // bypassed it falls back to ±64.
      chain: [
        {
          kind: "volume",
          params: {
            points: [
              { frame: 0, value: 2 },
              { frame: 1, value: 2 },
            ],
          },
        },
      ],
      pt: { monoMix: "average", targetNote: null },
    });
    expect(song()!.samples[0]!.data[0]!).toBe(127);

    const bypassBtn = container.querySelector<HTMLButtonElement>(
      ".effect-node__bypass",
    )!;
    fireEvent.click(bypassBtn);

    // State + DOM both updated.
    expect(getWorkbench(0)!.chain[0]!.bypassed).toBe(true);
    expect(
      container
        .querySelector(".effect-node")!
        .classList.contains("effect-node--bypassed"),
    ).toBe(true);
    // The pipeline re-ran without the volume × 2 — output halves.
    expect(song()!.samples[0]!.data[0]!).toBeLessThan(127);
  });

  it("clicking the bypass toggle a second time re-enables the effect", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0.5, -0.5])],
      },
      sourceName: "demo",
      chain: [
        {
          kind: "volume",
          params: {
            points: [
              { frame: 0, value: 2 },
              { frame: 1, value: 2 },
            ],
          },
        },
      ],
      pt: { monoMix: "average", targetNote: null },
    });
    const bypassBtn = container.querySelector<HTMLButtonElement>(
      ".effect-node__bypass",
    )!;
    fireEvent.click(bypassBtn);
    fireEvent.click(bypassBtn);
    // Field should be gone (clean toggle), effect runs again.
    const node = getWorkbench(0)!.chain[0]!;
    expect("bypassed" in node).toBe(false);
    expect(song()!.samples[0]!.data[0]!).toBe(127);
  });

  it("the bypass click doesn't deselect the chain entry (event propagation stopped)", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0.5])],
      },
      sourceName: "demo",
      chain: [
        {
          kind: "volume",
          params: {
            points: [
              { frame: 0, value: 1 },
              { frame: 1, value: 1 },
            ],
          },
        },
      ],
      pt: { monoMix: "average", targetNote: null },
    });
    // Select the entry first (click the row).
    fireEvent.click(container.querySelector(".effect-node")!);
    expect(
      container
        .querySelector(".effect-node")!
        .classList.contains("effect-node--selected"),
    ).toBe(true);
    // Click bypass — selection survives.
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".effect-node__bypass")!,
    );
    expect(
      container
        .querySelector(".effect-node")!
        .classList.contains("effect-node--selected"),
    ).toBe(true);
  });
});
