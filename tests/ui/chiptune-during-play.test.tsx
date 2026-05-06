import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";
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
import {
  workbenchFromChiptune,
  type SampleWorkbench,
} from "../../src/core/audio/sampleWorkbench";
import { defaultChiptuneParams } from "../../src/core/audio/chiptune";
import { emptySong } from "../../src/core/mod/format";

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

/** Drag the chiptune Cycle-frames slider to a new value (raw, before snap). */
function dragCycleSlider(container: HTMLElement, raw: number): void {
  const slider = [
    ...container.querySelectorAll<HTMLInputElement>(".chiptune .slider__range"),
  ].find((el) => {
    const label = el.closest(".slider")?.querySelector(".slider__label");
    return label?.textContent === "Cycle frames";
  })!;
  fireEvent.input(slider, { target: { value: String(raw) } });
}

describe("chiptune editor: edits during playback are committed to the song", () => {
  it("changing a chiptune param mid-playback updates song.samples[slot].data", () => {
    // Reproduce the user's flow: load a song with a chiptune workbench, set
    // transport to playing, drag a synth slider, verify the int8 in the
    // current slot was actually rewritten. Without the commit firing, the
    // sample data would still match the original render and the next
    // `engine.load` on restart would feed the worklet stale audio.
    setSong(emptySong());
    setView("sample");
    setCurrentSample(1);
    const initialWb: SampleWorkbench = workbenchFromChiptune(
      defaultChiptuneParams(),
    );
    setWorkbench(0, initialWb);
    const { container } = render(() => <App />);

    // Trigger an initial render so song.samples[0].data is populated. The
    // App's `setWorkbench` doesn't write into the song by itself — that
    // happens via `commitEditWithWorkbenches` paths. Easiest way to seed:
    // drag the slider once before playback. (The user's bug is about
    // mid-playback edits NOT landing, so seeding with one edit before play
    // is fair game.)
    dragCycleSlider(container, 64);
    const before = song()!.samples[0]!.data;
    expect(before.length).toBeGreaterThan(0);

    // Now playing — drag the slider to a different cycle length and
    // confirm the song's int8 was rewritten. With cycleFrames=128 the
    // synth produces 128 frames vs. 64 — different length, definitely
    // different bytes.
    setTransport("playing");
    dragCycleSlider(container, 128);

    const after = song()!.samples[0]!.data;
    expect(after).not.toBe(before);
    expect(after.length).not.toBe(before.length);
    // The workbench's source params should also reflect the new value.
    const wb = getWorkbench(0)!;
    expect(wb.source.kind).toBe("chiptune");
    if (wb.source.kind === "chiptune") {
      expect(wb.source.params.cycleFrames).toBe(128);
    }
  });
});
