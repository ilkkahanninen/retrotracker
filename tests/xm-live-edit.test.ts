import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell } from "~/core/xm/mutations";
import type { XmSong } from "~/core/xm/types";
import { resetXmCursor } from "~/state/cursorXm";
import { clearXmSelection, setXmSelection } from "~/state/selection";
import { setFollowPlayback } from "~/state/settings";
import { clearHistory, setSong, setTransport, xm2Song } from "~/state/song";
import {
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "~/state/xmEdit";
import {
  patchXmSample,
  renameXmInstrument,
  setXmFadeout,
} from "~/state/xmInstrumentEdit";
import {
  bounceXmSelectionToInstrument,
  copyXmSampleRange,
  cropXmCurrentSampleToSelection,
  cutXmSampleRange,
  pasteXmSampleBytes,
} from "~/state/xmSampleEdit";
import { clearAllXmWorkbenches } from "~/state/xmSampleWorkbench";

/**
 * FT2 edits that PT mode allows while the song plays, whatever Follow
 * says — sample settings, rename, instrument parameters, crop / cut /
 * paste. They used to be dropped silently under Play + Follow.
 */

function seed(): void {
  let s: XmSong = emptyXmSong();
  const inst = emptyXmInstrument();
  inst.name = "bass";
  inst.samples[0] = {
    ...inst.samples[0]!,
    data: new Int8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    bits: 8,
    volume: 64,
  };
  s.instruments = [inst];
  s = setXmCell(s, 0, 0, 0, { note: 49, instrument: 1 });
  setSong(s);
  resetXmCursor();
  clearXmSelection();
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  clearAllXmWorkbenches();
  clearHistory();
  setFollowPlayback(true);
  setTransport("playing");
}

beforeEach(seed);
afterEach(() => {
  setTransport("idle");
  setSong(null);
  clearHistory();
});

const inst = () => xm2Song()!.instruments[0]!;
const sample = () => inst().samples[0]!;

describe("FT2 edits while playing with Follow on", () => {
  it("sample settings apply", () => {
    patchXmSample(1, { volume: 20, finetune: 16, relativeNote: 3 }, 0);
    expect(sample().volume).toBe(20);
    expect(sample().finetune).toBe(16);
    expect(sample().relativeNote).toBe(3);
  });

  it("loop settings apply", () => {
    patchXmSample(1, { loopType: "forward", loopStart: 2, loopLength: 4 }, 0);
    expect(sample().loopType).toBe("forward");
    expect(sample().loopStart).toBe(2);
    expect(sample().loopLength).toBe(4);
  });

  it("instrument rename and fadeout apply", () => {
    renameXmInstrument(1, "lead");
    setXmFadeout(1, 512);
    expect(inst().name).toBe("lead");
    expect(inst().fadeout).toBe(512);
  });

  it("crop applies", () => {
    cropXmCurrentSampleToSelection(2, 6);
    expect(Array.from(sample().data)).toEqual([3, 4, 5, 6]);
  });

  it("cut removes the range as well as copying it", () => {
    cutXmSampleRange(0, 2);
    expect(Array.from(sample().data)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("paste replaces the sample", () => {
    copyXmSampleRange(0, 3);
    pasteXmSampleBytes();
    expect(Array.from(sample().data)).toEqual([1, 2, 3]);
  });
});

describe("FT2 bounce during playback", () => {
  const select = () =>
    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 3,
      startChannel: 0,
      endChannel: 0,
    });

  it("is refused while Follow locks editing", () => {
    select();
    bounceXmSelectionToInstrument();
    expect(xm2Song()!.instruments).toHaveLength(1);
  });

  it("goes through with Follow off, as PT's does", () => {
    setFollowPlayback(false);
    select();
    bounceXmSelectionToInstrument();
    expect(xm2Song()!.instruments).toHaveLength(2);
    setFollowPlayback(true);
  });
});
