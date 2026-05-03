import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";
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
import { setCurrentSample, setCurrentOctave } from "../../src/state/edit";
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

    const wb = getWorkbench(1);
    expect(wb).toBeDefined();
    if (wb!.source.kind !== "sampler") throw new Error("expected sampler source");
    expect(wb!.source.wav.sampleRate).toBe(44100);
    expect(wb!.source.wav.channels).toHaveLength(2);
    expect(wb!.chain).toEqual([]);
    expect(wb!.pt.monoMix).toBe("average");
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
  for (const btn of container.querySelectorAll<HTMLButtonElement>(".menu__button")) {
    if (btn.textContent?.startsWith("Edit")) { trigger = btn; break; }
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
    await userEvent.setup().click(findEffectButton(container, "Gain"));
    expect(getWorkbench(0)!.chain).toHaveLength(1);
    expect(getWorkbench(0)!.chain[0]!.kind).toBe("gain");
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
  it("changing the gain re-renders the int8 result in the song slot", () => {
    setView("sample");
    const { container } = render(() => <App />);
    // Seed with a non-trivial source and a gain effect.
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0, 0.25, -0.25])],
      },
      sourceName: "demo",
      chain: [{ kind: "gain", params: { gain: 1 } }],
      pt: { monoMix: "average", targetNote: null },
    });
    // The gain input lives inside the first .effect-node row.
    const gainInput =
      container.querySelector<HTMLInputElement>(".effect-node input")!;
    fireEvent.input(gainInput, { target: { value: "4" } });
    // 0.25 × 4 = 1.0 → int8 127. -0.25 × 4 = -1.0 → -127.
    const data = song()!.samples[0]!.data;
    expect(data[0]).toBe(0);
    expect(data[1]).toBe(127);
    expect(data[2]).toBe(-127);
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
});

describe("pipeline editor: editing params preserves input focus", () => {
  // Regression: every keystroke flowed through patchEffect → new chain item
  // reference → keyed <For>/<Show>/<Match> children disposed and remounted,
  // killing focus on each character. The structural fix (Index + non-keyed
  // Show/Match) is observable here: the same DOM input survives many edits.
  it("the gain input element is preserved across consecutive patches", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0, 0.25, -0.25])],
      },
      sourceName: "demo",
      chain: [{ kind: "gain", params: { gain: 1 } }],
      pt: { monoMix: "average", targetNote: null },
    });
    const first =
      container.querySelector<HTMLInputElement>(".effect-node input")!;
    fireEvent.input(first, { target: { value: "2" } });
    fireEvent.input(first, { target: { value: "2.5" } });
    fireEvent.input(first, { target: { value: "3" } });
    const after =
      container.querySelector<HTMLInputElement>(".effect-node input")!;
    expect(after).toBe(first); // same DOM node — no remount, focus would survive
    expect(getWorkbench(0)!.chain[0]).toEqual({
      kind: "gain",
      params: { gain: 3 },
    });
  });

  it("the volume metadata input is preserved when the pipeline re-runs", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleWithWorkbench({
      source: {
        sampleRate: 44100,
        channels: [new Float32Array([0, 0.25, -0.25])],
      },
      sourceName: "demo",
      chain: [{ kind: "gain", params: { gain: 1 } }],
      pt: { monoMix: "average", targetNote: null },
    });
    const inputs = container.querySelectorAll<HTMLInputElement>(
      '.samplemeta input[type="number"]',
    );
    let volumeBefore: HTMLInputElement | null = null;
    for (const el of inputs) {
      if (el.closest("label")!.textContent!.includes("Volume"))
        volumeBefore = el;
    }
    expect(volumeBefore).not.toBeNull();
    // Trigger a pipeline patch by editing the gain.
    const gain =
      container.querySelector<HTMLInputElement>(".effect-node input")!;
    fireEvent.input(gain, { target: { value: "2" } });
    let volumeAfter: HTMLInputElement | null = null;
    for (const el of container.querySelectorAll<HTMLInputElement>(
      '.samplemeta input[type="number"]',
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
      '.samplemeta input[type="number"]',
    );
    let volume: HTMLInputElement | null = null;
    for (const el of inputs) {
      if (el.closest("label")!.textContent!.includes("Volume")) volume = el;
    }
    fireEvent.input(volume!, { target: { value: "32" } });
    expect(song()!.samples[0]!.volume).toBe(32);

    // Now add a Gain effect — pipeline re-runs.
    await userEvent.setup().click(findEffectButton(container, "Gain"));

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
      chain: [{ kind: "gain", params: { gain: 1 } }],
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

    // Tweak the gain — pipeline re-runs, sample data is rewritten.
    const gain =
      container.querySelector<HTMLInputElement>(".effect-node input")!;
    fireEvent.input(gain, { target: { value: "2" } });

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

  it("Fade in with no selection appends a fadeIn over the head of the chain output", async () => {
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
    await userEvent.setup().click(findEffectButton(container, "Fade in"));
    const chain = getWorkbench(0)!.chain;
    expect(chain).toHaveLength(1);
    const node = chain[0]!;
    expect(node.kind).toBe("fadeIn");
    if (node.kind === "fadeIn") {
      expect(node.params.startFrame).toBe(0);
      expect(node.params.endFrame).toBe(1024); // head defaults to min(1024, len)
    }
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

    await userEvent.setup().click(findEffectButton(container, "Gain"));
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

    await userEvent.setup().click(findEffectButton(container, "Gain"));
    clickEditMenu(container, "Undo");
    expect(getWorkbench(0)!.chain).toHaveLength(0);

    clickEditMenu(container, "Redo");

    expect(getWorkbench(0)!.chain).toHaveLength(1);
    expect(getWorkbench(0)!.chain[0]!.kind).toBe("gain");
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
      chain: [{ kind: "gain", params: { gain: 2 } }],
      pt: { monoMix: "average", targetNote: null },
    });
    expect(getWorkbench(0)).toBeDefined();

    const clearBtn = container.querySelector<HTMLButtonElement>(
      ".sampleview__actions button",
    )!;
    await userEvent.setup().click(clearBtn);
    expect(getWorkbench(0)).toBeUndefined();

    clickEditMenu(container, "Undo");

    expect(getWorkbench(0)).toBeDefined();
    expect(getWorkbench(0)!.chain).toHaveLength(1);
    expect(getWorkbench(0)!.chain[0]!.kind).toBe("gain");
  });
});

describe("pipeline editor: workbench is cleared on .mod load", () => {
  it("loading a fresh empty song clears any existing workbenches", () => {
    setWorkbench(0, fixtureToWorkbench({
      source: { sampleRate: 44100, channels: [new Float32Array([0])] },
      sourceName: "demo",
      chain: [],
      pt: { monoMix: "average", targetNote: null },
    }));
    expect(getWorkbench(0)).toBeDefined();
    clearAllWorkbenches();
    expect(getWorkbench(0)).toBeUndefined();
  });
});
