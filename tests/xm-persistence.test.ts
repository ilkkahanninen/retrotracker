import { describe, expect, it } from "vitest";

import { emptyXmSong } from "~/core/xm/format";
import { setXmCell } from "~/core/xm/mutations";
import {
  projectFromBytes,
  projectToBytes,
  type SessionInputs,
} from "~/state/persistence";

/**
 * Pure round-trip tests for FT2 `.retro` persistence. Use the
 * Uint8Array-bytes path (`projectToBytes` / `projectFromBytes`) — this
 * file runs in node, where localStorage doesn't exist; saveSession /
 * loadSession would silently swallow on the writer side.
 */

const baseInputs = (overrides: Partial<SessionInputs> = {}): SessionInputs => ({
  song: emptyXmSong(),
  filename: "demo.xm",
  infoText: "",
  view: "pattern",
  cursor: { order: 0, row: 0, channel: 0, field: "note" },
  currentSample: 1,
  currentOctave: 2,
  editStep: 1,
  ...overrides,
});

describe("FT2 .retro persistence", () => {
  it("round-trips an XmSong through projectToBytes + projectFromBytes", () => {
    let song = emptyXmSong();
    song.title = "FT2 saved";
    song = setXmCell(song, 0, 5, 0, { note: 49, instrument: 1 });
    const bytes = projectToBytes(baseInputs({ song }));
    const loaded = projectFromBytes(bytes);
    expect(loaded).not.toBeNull();
    expect(loaded!.song.format).toBe("FT2");
    if (loaded!.song.format !== "FT2") throw new Error("expected FT2");
    expect(loaded!.song.title).toBe("FT2 saved");
    expect(loaded!.song.patterns[0]!.rows[5]![0]!.note).toBe(49);
    expect(loaded!.song.patterns[0]!.rows[5]![0]!.instrument).toBe(1);
  });

  it("preserves channelCount through round-trip", () => {
    const song = { ...emptyXmSong(), channelCount: 16 };
    song.patterns = [
      {
        rows: Array.from({ length: 64 }, () =>
          Array.from({ length: 16 }, () => ({
            note: 0,
            instrument: 0,
            volumeColumn: 0,
            effect: 0,
            effectParam: 0,
          })),
        ),
        rowCount: 64,
      },
    ];
    const bytes = projectToBytes(baseInputs({ song }));
    const loaded = projectFromBytes(bytes);
    expect(loaded!.song.format).toBe("FT2");
    if (loaded!.song.format !== "FT2") throw new Error("expected FT2");
    expect(loaded!.song.channelCount).toBe(16);
  });

  it("filename / view / cursor / editStep are preserved", () => {
    const bytes = projectToBytes(
      baseInputs({
        filename: "saved.xm",
        view: "info",
        cursor: { order: 0, row: 12, channel: 2, field: "note" },
        editStep: 4,
      }),
    );
    const loaded = projectFromBytes(bytes)!;
    expect(loaded.filename).toBe("saved.xm");
    expect(loaded.view).toBe("info");
    expect(loaded.cursor).toEqual({
      order: 0,
      row: 12,
      channel: 2,
      field: "note",
    });
    expect(loaded.editStep).toBe(4);
  });

  it('payload carries format="FT2" so the reader picks parseXm', () => {
    const song = emptyXmSong();
    const bytes = projectToBytes(baseInputs({ song }));
    const json = JSON.parse(new TextDecoder().decode(bytes));
    expect(json.format).toBe("FT2");
    expect(json.v).toBe(9);
  });

  it("PT2 payload still round-trips (regression)", async () => {
    // The widening of SessionInputs.song to Song must not break the PT2 path.
    const { emptySong } = await import("~/core/mod/format");
    const song = emptySong();
    song.title = "Pt2";
    const bytes = projectToBytes({
      song,
      filename: "demo.mod",
      infoText: "",
      view: "pattern",
      cursor: { order: 0, row: 0, channel: 0, field: "note" },
      currentSample: 1,
      currentOctave: 2,
      editStep: 1,
    });
    const loaded = projectFromBytes(bytes);
    expect(loaded!.song.format).toBe("PT2");
  });
});
