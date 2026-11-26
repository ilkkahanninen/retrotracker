/**
 * Regression: UI state that indexes into the song (cursor, play position,
 * pattern selection, mute arrays, waveform selection, …) lives outside the
 * undo history and outside the song signal. Undo / redo, song load,
 * pause-at-playhead and the XM row / channel-count actions used to leave
 * it pointing at things that no longer exist.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptySong } from "../src/core/mod/format";
import { insertOrder, setCell } from "../src/core/mod/mutations";
import { emptyXmSong } from "../src/core/xm/format";
import {
  setXmChannelCount,
  setXmPatternRowCount,
} from "../src/core/xm/mutations";
import type { XmSong } from "../src/core/xm/types";
import {
  mutedChannels,
  soloedChannels,
  toggleMute,
  toggleSolo,
  isChannelMuted,
} from "../src/state/channelMute";
import { channelLevels } from "../src/state/channelLevel";
import { cursor, setCursor } from "../src/state/cursor";
import { setXmCursor, xmCursor } from "../src/state/cursorXm";
import { insertOrderSlot } from "../src/state/orderEdit";
import { insertXmOrderSlot } from "../src/state/xmOrderEdit";
import { backspaceCell, extendSelection } from "../src/state/patternEdit";
import { loadSession, saveSession } from "../src/state/persistence";
import { playFromCursorRespectingMode } from "../src/state/playback";
import { reconcileUiToSong } from "../src/state/reconcile";
import {
  setSampleSelection,
  sampleSelection,
} from "../src/state/sampleSelection";
import {
  selectedEffectIndex,
  setSelectedEffectIndex,
} from "../src/state/selectedEffect";
import {
  selection,
  setSelection,
  setXmSelection,
  xmSelection,
} from "../src/state/selection";
import { applyLoadedSession } from "../src/state/session";
import { setFollowPlayback } from "../src/state/settings";
import {
  clearHistory,
  commitEdit,
  playPos,
  pt2Song,
  redo,
  setPlayPos,
  setSong,
  setTransport,
  undo,
  xm2Song,
} from "../src/state/song";
import {
  currentXmInstrument,
  setCurrentXmInstrument,
} from "../src/state/xmEdit";
import {
  setXmChannelCountAction,
  setXmRowCountAtCursor,
} from "../src/state/xmPatternEdit";
import {
  setXmSelectedEffectIndex,
  xmSelectedEffectIndex,
} from "../src/state/xmSampleEdit";
import {
  setXmSampleSelection,
  xmSampleSelection,
} from "../src/state/xmSampleSelection";

function xmSong(channels = 8): XmSong {
  return setXmChannelCount(emptyXmSong(), channels);
}

/** PT song with `orders` order slots and a note on every row of ch 0. */
function ptSong(orders = 3) {
  let s = emptySong();
  for (let i = 1; i < orders; i++) s = insertOrder(s, 0);
  for (let o = 0; o < orders; o++) {
    for (let row = 0; row < 64; row++) {
      s = setCell(s, o, row, 0, { period: 428, sample: 1 });
    }
  }
  return s;
}

function reset() {
  setSong(null);
  setTransport("idle");
  setFollowPlayback(true);
  clearHistory();
  setPlayPos({ order: 0, row: 0 });
}
beforeEach(reset);
afterEach(reset);

describe("undo / redo re-clamp position state (PT)", () => {
  beforeEach(() => applyLoadedSession({ song: emptySong(), filename: null }));

  it("undoing an order insert pulls cursor and playPos back in range", () => {
    insertOrderSlot();
    expect(cursor().order).toBe(1);
    undo();
    expect(pt2Song()!.songLength).toBe(1);
    expect(cursor().order).toBe(0);
    expect(playPos().order).toBe(0);
  });

  it("redo of a shrink clamps too", () => {
    insertOrderSlot();
    undo();
    redo();
    setCursor({ ...cursor(), order: 1 });
    undo();
    expect(cursor().order).toBe(0);
  });

  it("drops a selection whose order vanished", () => {
    insertOrderSlot();
    setSelection({
      order: 1,
      startRow: 0,
      endRow: 4,
      startChannel: 0,
      endChannel: 0,
    });
    undo();
    expect(selection()).toBeNull();
  });

  it("leaves in-range state alone", () => {
    commitEdit((s) => setCell(s, 0, 5, 0, { period: 428, sample: 1 }));
    const c = { order: 0, row: 5, channel: 2, field: "note" as const };
    setCursor(c);
    const sel = {
      order: 0,
      startRow: 1,
      endRow: 3,
      startChannel: 0,
      endChannel: 1,
    };
    setSelection(sel);
    undo();
    expect(cursor()).toBe(c);
    expect(selection()).toBe(sel);
  });
});

describe("undo / redo re-clamp position state (XM)", () => {
  beforeEach(() => applyLoadedSession({ song: xmSong(8), filename: null }));

  it("undoing a row-count increase clamps the cursor row", () => {
    setXmRowCountAtCursor(128);
    setXmCursor({ ...xmCursor(), row: 100 });
    undo();
    const rows = xm2Song()!.patterns[xm2Song()!.orders[0]!]!.rowCount;
    expect(rows).toBe(64);
    expect(xmCursor().row).toBe(63);
  });

  it("undoing a channel-count increase clamps the cursor channel", () => {
    setXmChannelCountAction(12);
    setXmCursor({ ...xmCursor(), channel: 11 });
    undo();
    expect(xm2Song()!.channelCount).toBe(8);
    expect(xmCursor().channel).toBe(7);
  });

  it("undoing an order insert clamps the cursor order", () => {
    insertXmOrderSlot();
    expect(xmCursor().order).toBe(1);
    undo();
    expect(xmCursor().order).toBe(0);
  });

  it("a row-count shrink drops a selection reaching past the end", () => {
    setXmRowCountAtCursor(128);
    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 127,
      startChannel: 0,
      endChannel: 0,
    });
    setXmRowCountAtCursor(32);
    expect(xmSelection()).toBeNull();
  });
});

describe("XM channel-count changes resize mute / solo", () => {
  beforeEach(() => applyLoadedSession({ song: xmSong(8), filename: null }));

  it("shrinking past a solo'd channel does not silence the song", () => {
    toggleSolo(6);
    setXmChannelCountAction(4);
    expect(soloedChannels()).toEqual([false, false, false, false]);
    expect(mutedChannels()).toHaveLength(4);
    for (let ch = 0; ch < 4; ch++) expect(isChannelMuted(ch)).toBe(false);
  });

  it("keeps the flags of channels that survive", () => {
    toggleMute(1);
    toggleSolo(2);
    setXmChannelCountAction(4);
    expect(mutedChannels()[1]).toBe(true);
    expect(soloedChannels()[2]).toBe(true);
  });

  it("new channels can be muted after growing", () => {
    setXmChannelCountAction(12);
    expect(mutedChannels()).toHaveLength(12);
    expect(channelLevels()).toHaveLength(12);
    toggleMute(10);
    expect(mutedChannels()[10]).toBe(true);
  });

  it("undo of a channel-count change resizes back", () => {
    setXmChannelCountAction(12);
    undo();
    expect(mutedChannels()).toHaveLength(8);
  });
});

describe("pause at playhead", () => {
  it("drops the pre-playback selection so Backspace hits the cursor cell", async () => {
    applyLoadedSession({ song: ptSong(3), filename: null });
    setFollowPlayback(false); // edits allowed mid-playback; irrelevant once paused
    setCursor({ order: 0, row: 4, channel: 0, field: "note" });
    extendSelection({ order: 0, row: 8, channel: 0, field: "note" });
    expect(selection()).not.toBeNull();

    setTransport("playing");
    setPlayPos({ order: 2, row: 30 });
    await playFromCursorRespectingMode(); // Option+Space while playing = pause

    expect(cursor()).toMatchObject({ order: 2, row: 30 });
    expect(selection()).toBeNull();

    backspaceCell();
    // Order 0 rows 4..8 (the old selection) must be untouched.
    const s = pt2Song()!;
    const pat0 = s.patterns[s.orders[0]!]!;
    for (let row = 4; row <= 8; row++)
      expect(pat0.rows[row]![0]!.period).toBe(428);
  });
});

describe("loading a song resets selection state", () => {
  it("clears pattern / waveform selections and selected-effect markers", () => {
    applyLoadedSession({ song: ptSong(2), filename: "a.mod" });
    setSelection({
      order: 1,
      startRow: 0,
      endRow: 10,
      startChannel: 0,
      endChannel: 3,
    });
    setSampleSelection({ start: 1000, end: 5000 });
    setSelectedEffectIndex(2);

    applyLoadedSession({ song: emptySong(), filename: "b.mod" });
    expect(selection()).toBeNull();
    expect(sampleSelection()).toBeNull();
    expect(selectedEffectIndex()).toBeNull();
  });

  it("resets XM selections and the instrument cursor", () => {
    applyLoadedSession({ song: xmSong(8), filename: "a.xm" });
    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 63,
      startChannel: 0,
      endChannel: 7,
    });
    setXmSampleSelection({ start: 1000, end: 5000 });
    setXmSelectedEffectIndex(1);
    setCurrentXmInstrument(7);

    applyLoadedSession({ song: xmSong(4), filename: "b.xm" });
    expect(xmSelection()).toBeNull();
    expect(xmSampleSelection()).toBeNull();
    expect(xmSelectedEffectIndex()).toBeNull();
    expect(currentXmInstrument()).toBe(1);
  });

  it("clamps a loaded cursor against the actual song", () => {
    applyLoadedSession({
      song: emptySong(), // one order
      filename: "a.mod",
      cursor: { order: 9, row: 10, channel: 2, field: "note" },
    });
    expect(cursor().order).toBe(0);
    expect(playPos().order).toBe(0);
  });
});

describe("session round-trip for XM projects", () => {
  let saved: unknown;
  beforeEach(() => {
    saved = (globalThis as { localStorage?: unknown }).localStorage;
    const m = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  });
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = saved;
  });

  function saveXm(song: XmSong) {
    const muted = Array.from({ length: 8 }, (_, i) => i === 5);
    const soloed = Array.from({ length: 8 }, () => false);
    saveSession({
      song,
      filename: "a.xm",
      view: "pattern",
      cursor: { order: 0, row: 100, channel: 6, field: "note" },
      currentSample: 1,
      currentOctave: 2,
      editStep: 1,
      mutedChannels: muted,
      soloedChannels: soloed,
    });
  }

  it("persists mute flags and cursor beyond PT's 4 channels / 64 rows", () => {
    let song = xmSong(8);
    song = setXmPatternRowCount(song, song.orders[0]!, 128);
    saveXm(song);
    const back = loadSession()!;
    expect(back.mutedChannels[5]).toBe(true);
    expect(back.cursor).toMatchObject({ row: 100, channel: 6 });
  });

  it("restoring sizes mute arrays to the song and seeds the XM cursor", () => {
    let song = xmSong(8);
    song = setXmPatternRowCount(song, song.orders[0]!, 128);
    saveXm(song);
    applyLoadedSession(loadSession()!);
    expect(mutedChannels()).toHaveLength(8);
    expect(mutedChannels()[5]).toBe(true);
    expect(channelLevels()).toHaveLength(8);
    expect(xmCursor()).toMatchObject({ order: 0, row: 100, channel: 6 });
    // Channels 5+ are toggleable after a restore.
    toggleMute(7);
    expect(mutedChannels()[7]).toBe(true);
  });

  it("clamps a persisted cursor that no longer fits the song", () => {
    saveXm(xmSong(4)); // 64 rows, 4 channels; cursor says row 100 / ch 6
    applyLoadedSession(loadSession()!);
    expect(xmCursor()).toMatchObject({ row: 63, channel: 3 });
  });

  it("PT sessions still write 4-entry mute arrays", () => {
    saveSession({
      song: emptySong(),
      filename: null,
      view: "pattern",
      cursor: { order: 0, row: 0, channel: 0, field: "note" },
      currentSample: 1,
      currentOctave: 2,
      editStep: 1,
      mutedChannels: [false, true, false, false],
      soloedChannels: [false, false, false, false],
    });
    expect(loadSession()!.mutedChannels).toEqual([false, true, false, false]);
  });
});

describe("reconcileUiToSong", () => {
  it("is a no-op without a song", () => {
    setSong(null);
    expect(() => reconcileUiToSong()).not.toThrow();
  });
});
