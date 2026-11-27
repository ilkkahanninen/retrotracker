import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

import { InstrumentView } from "../../src/components/InstrumentView";
import { xmC4Rate } from "../../src/core/audio/xmFreqTable";
import { emptyXmInstrument, emptyXmSong } from "../../src/core/xm/format";
import { setXmCell } from "../../src/core/xm/mutations";
import { tuneForSampleRate } from "../../src/core/xm/sampleImport";
import { resetXmCursor, setXmCursor } from "../../src/state/cursorXm";
import {
  clearHistory,
  setSong,
  setTransport,
  xm2Song,
} from "../../src/state/song";
import {
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "../../src/state/xmEdit";
import {
  clearAllXmWorkbenches,
  getXmWorkbench,
} from "../../src/state/xmSampleWorkbench";

/**
 * The "Fit length" row in the FT2 pipeline's terminal panel and its
 * calculator — the FT2 counterpart of PT's "Length (ticks)" + Calc.
 */

const LEN = 4000;

beforeEach(() => {
  let s = emptyXmSong();
  const inst = emptyXmInstrument();
  inst.samples[0] = {
    ...inst.samples[0]!,
    ...tuneForSampleRate(22050),
    data: new Int8Array(LEN).fill(40),
    bits: 8,
  };
  s.instruments = [inst];
  // Row 4 sets the tempo to 150 — the calculator should pick it up.
  s = setXmCell(s, 0, 4, 0, { effect: 0x0f, effectParam: 150 });
  setSong(s);
  resetXmCursor();
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
  clearAllXmWorkbenches();
  clearHistory();
});
afterEach(() => {
  cleanup();
  setSong(null);
  clearHistory();
});

const sample = () => xm2Song()!.instruments[0]!.samples[0]!;
const framesFor = (ticks: number, bpm: number) =>
  Math.round(
    ((ticks * 2.5) / bpm) *
      xmC4Rate(sample().relativeNote, sample().finetune, true)!,
  );

function mount() {
  return render(() => <InstrumentView song={xm2Song()!} />);
}

function commit(input: HTMLElement, value: string): void {
  fireEvent.input(input, { target: { value } });
  fireEvent.change(input);
}

describe("FT2 pipeline: Fit length", () => {
  it("typing ticks fits the sample at the shown tempo; clearing undoes it", () => {
    const view = mount();
    const ticks = view.getByLabelText(
      "Fit length in ticks",
    ) as HTMLInputElement;
    expect(ticks.value).toBe("");
    // No fit yet: nothing resamples, so no resampler picker.
    expect(view.queryByLabelText("Resample mode")).toBeNull();

    commit(ticks, "96");
    expect(getXmWorkbench(1, 0)!.xm.playingLength).toEqual({
      ticks: 96,
      bpm: 125,
    });
    expect(sample().data.length).toBe(framesFor(96, 125));
    expect(view.getByLabelText("Resample mode")).toBeTruthy();

    commit(view.getByLabelText("Fit length in ticks"), "");
    expect(getXmWorkbench(1, 0)!.xm.playingLength).toBeUndefined();
    expect(sample().data.length).toBe(LEN);
  });

  it("changing the tempo field re-fits", () => {
    const view = mount();
    commit(view.getByLabelText("Fit length in ticks"), "96");
    commit(view.getByLabelText("Fit length tempo in BPM"), "150");
    expect(getXmWorkbench(1, 0)!.xm.playingLength).toEqual({
      ticks: 96,
      bpm: 150,
    });
    expect(sample().data.length).toBe(framesFor(96, 150));
  });

  it("Calc pre-fills speed / tempo from the cursor row and applies rows × speed", () => {
    setXmCursor({ order: 0, row: 4, channel: 0, field: "note" });
    const view = mount();
    fireEvent.click(view.getByRole("button", { name: "Calc" }));
    const dialog = view.getByRole("dialog");
    const inputs = dialog.querySelectorAll<HTMLInputElement>("input");
    // Rows, Speed, Tempo — the Fxx on the cursor's own row counts.
    expect(inputs[1]!.value).toBe("6");
    expect(inputs[2]!.value).toBe("150");
    fireEvent.input(inputs[0]!, { target: { value: "32" } });
    expect(dialog.textContent).toContain("192 ticks at 150 BPM");
    fireEvent.click(view.getByRole("button", { name: "Apply" }));
    expect(getXmWorkbench(1, 0)!.xm.playingLength).toEqual({
      ticks: 192,
      bpm: 150,
    });
    expect(sample().data.length).toBe(framesFor(192, 150));
    expect(view.queryByRole("dialog")).toBeNull();
  });

  it("the resampler picker changes the mode without changing the length", () => {
    const view = mount();
    commit(view.getByLabelText("Fit length in ticks"), "96");
    const select = view.getByLabelText("Resample mode") as HTMLSelectElement;
    expect(select.value).toBe("sinc");
    fireEvent.change(select, { target: { value: "linear" } });
    expect(getXmWorkbench(1, 0)!.xm.resampleMode).toBe("linear");
    expect(sample().data.length).toBe(framesFor(96, 125));
  });
});
