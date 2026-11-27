import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { parseXm } from "~/core/xm/parser";
import type { XmSong } from "~/core/xm/types";
import { resetXmCursor, setXmCursor, xmCursor } from "~/state/cursorXm";
import { setInfoText } from "~/state/info";
import { io } from "~/state/io";
import { projectFromBytes } from "~/state/persistence";
import {
  applyLoadedSession,
  exportXm,
  moduleBytes,
  projectBytes,
  withInfoTextAsInstrumentNames,
  xmEditSnapshot,
} from "~/state/session";
import { clearHistory, setSong } from "~/state/song";
import {
  currentXmInstrument,
  currentXmOctave,
  currentXmSampleIndex,
  nextXmInstrument,
  prevXmInstrument,
  selectXmInstrument,
  setCurrentXmInstrument,
  setCurrentXmOctave,
  setCurrentXmSampleIndex,
} from "~/state/xmEdit";

/**
 * FT2 session state that PT mode already kept: where the editor was
 * (instrument, sample, octave, cursor field) across a save / load, and
 * the Info text travelling inside the exported module.
 */

function songWith(...sampleCounts: number[]): XmSong {
  const s = emptyXmSong();
  s.instruments = sampleCounts.map((n, i) => {
    const inst = emptyXmInstrument();
    inst.name = `inst ${i + 1}`;
    inst.samples = Array.from({ length: n }, () => inst.samples[0]!);
    return inst;
  });
  return s;
}

function reset(): void {
  setSong(null);
  resetXmCursor();
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setCurrentXmOctave(4);
  setInfoText("");
  clearHistory();
}
beforeEach(reset);
afterEach(reset);

describe("switching instrument", () => {
  it("goes back to the first sample, whichever way the switch is made", () => {
    const moves: Array<() => void> = [
      () => setCurrentXmInstrument(2),
      () => selectXmInstrument(2),
      () => nextXmInstrument(),
    ];
    for (const move of moves) {
      setCurrentXmInstrument(1);
      setCurrentXmSampleIndex(3);
      move();
      expect(currentXmInstrument()).toBe(2);
      expect(currentXmSampleIndex()).toBe(0);
    }
    setCurrentXmSampleIndex(3);
    prevXmInstrument();
    expect(currentXmSampleIndex()).toBe(0);
  });

  it("leaves the sample alone when the instrument doesn't actually change", () => {
    setCurrentXmSampleIndex(3);
    setCurrentXmInstrument(1);
    selectXmInstrument(1);
    prevXmInstrument(); // already at the first instrument
    expect(currentXmSampleIndex()).toBe(3);
  });
});

describe("FT2 editing state across save / load", () => {
  it("a saved project brings the editor back where it was", () => {
    applyLoadedSession({ song: songWith(1, 1, 4), filename: "a.xm" });
    setCurrentXmInstrument(3);
    setCurrentXmSampleIndex(2);
    setCurrentXmOctave(6);
    setXmCursor({ order: 0, row: 9, channel: 1, field: "effectLo" });
    expect(xmEditSnapshot()).toEqual({
      instrument: 3,
      sampleIndex: 2,
      octave: 6,
      field: "effectLo",
    });
    const bytes = projectBytes()!;

    // Something else gets loaded in between.
    applyLoadedSession({ song: songWith(1), filename: "b.xm" });
    expect(currentXmInstrument()).toBe(1);

    applyLoadedSession(projectFromBytes(bytes)!);
    expect(currentXmInstrument()).toBe(3);
    expect(currentXmSampleIndex()).toBe(2);
    expect(currentXmOctave()).toBe(6);
    expect(xmCursor()).toMatchObject({ row: 9, channel: 1, field: "effectLo" });
  });

  it("clamps a saved sample index to the samples the instrument has", () => {
    applyLoadedSession({
      song: songWith(1, 2),
      filename: "a.xm",
      xmEdit: { instrument: 2, sampleIndex: 9, octave: 3, field: "note" },
    });
    expect(currentXmInstrument()).toBe(2);
    expect(currentXmSampleIndex()).toBe(1);
  });

  it("a plain .xm load still starts on instrument 1, sample 0", () => {
    setCurrentXmInstrument(5);
    setCurrentXmSampleIndex(2);
    applyLoadedSession({ song: songWith(1, 1), filename: "a.xm" });
    expect(currentXmInstrument()).toBe(1);
    expect(currentXmSampleIndex()).toBe(0);
  });

  it("there is no FT2 editing state for a PT song", async () => {
    const { emptySong } = await import("~/core/mod/format");
    applyLoadedSession({ song: emptySong(), filename: "a.mod" });
    expect(xmEditSnapshot()).toBeUndefined();
  });
});

describe("Info text in the exported .xm", () => {
  const names = (s: XmSong) => s.instruments.map((i) => i.name);

  it("empty text leaves the song untouched", () => {
    const s = songWith(1, 1);
    expect(withInfoTextAsInstrumentNames(s, "")).toBe(s);
  });

  it("each line becomes an instrument name; the rest are blanked", () => {
    const out = withInfoTextAsInstrumentNames(
      songWith(1, 1, 1),
      "hello\nworld",
    );
    expect(names(out)).toEqual(["hello", "world", ""]);
  });

  it("appends instruments when there are more lines than instruments", () => {
    const song = songWith(1);
    const out = withInfoTextAsInstrumentNames(song, "a\nb\nc");
    expect(names(out)).toEqual(["a", "b", "c"]);
    // The original instrument keeps everything but its name.
    expect(out.instruments[0]!.samples).toBe(song.instruments[0]!.samples);
  });

  it("wraps long lines at the 22-character name width", () => {
    const out = withInfoTextAsInstrumentNames(
      songWith(1),
      "a line that is longer than twenty-two characters",
    );
    expect(names(out).every((n) => n.length <= 22)).toBe(true);
    expect(names(out).join(" ")).toBe(
      "a line that is longer than twenty-two characters",
    );
  });

  it("stops at the format's 128 instruments", () => {
    const text = Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n");
    expect(
      withInfoTextAsInstrumentNames(songWith(1), text).instruments,
    ).toHaveLength(128);
  });

  it("export and cloud bytes carry it, and it reads back as Info text", () => {
    const realDownload = io.download;
    const download = vi.fn();
    io.download = download;
    try {
      applyLoadedSession({ song: songWith(1, 1), filename: "song.xm" });
      setInfoText("made with\nretrotracker");
      exportXm();
      const exported = parseXm(
        (download.mock.calls[0]![1] as Uint8Array).slice()
          .buffer as ArrayBuffer,
      );
      expect(names(exported)).toEqual(["made with", "retrotracker"]);
      expect(
        names(parseXm(moduleBytes()!.slice().buffer as ArrayBuffer)),
      ).toEqual(["made with", "retrotracker"]);
    } finally {
      io.download = realDownload;
    }
  });

  it("with no Info text the instrument names are exported as they are", () => {
    applyLoadedSession({ song: songWith(1, 1), filename: "song.xm" });
    setInfoText("");
    expect(
      names(parseXm(moduleBytes()!.slice().buffer as ArrayBuffer)),
    ).toEqual(["inst 1", "inst 2"]);
  });
});
