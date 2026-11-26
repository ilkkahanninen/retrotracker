/**
 * Regression: the boot-time session restore in App.tsx was a hand-rolled
 * copy of `applyLoadedSession` that had drifted — it sized the mute / solo
 * arrays for PT's 4 channels (so channels 5+ of an FT2 song couldn't be
 * muted after a reload) and never seeded the XM cursor.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

import { App } from "../../src/App";
import { emptyXmSong } from "../../src/core/xm/format";
import {
  setXmChannelCount,
  setXmPatternRowCount,
} from "../../src/core/xm/mutations";
import { channelLevels } from "../../src/state/channelLevel";
import {
  mutedChannels,
  resetChannelMute,
  soloedChannels,
  toggleMute,
} from "../../src/state/channelMute";
import { resetXmCursor, xmCursor } from "../../src/state/cursorXm";
import { saveSession } from "../../src/state/persistence";
import { cloudOrigin, setCloudOrigin } from "../../src/state/session";
import {
  clearHistory,
  dirty,
  setSong,
  setTransport,
  transport,
  xm2Song,
} from "../../src/state/song";
import { setView } from "../../src/state/view";

function reset() {
  setSong(null);
  setTransport("idle");
  clearHistory();
  resetChannelMute();
  resetXmCursor();
  setCloudOrigin(null);
  setView("pattern");
  localStorage.clear();
}
beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

describe("boot restore of an FT2 session", () => {
  beforeEach(() => {
    let song = setXmChannelCount(emptyXmSong(), 8);
    song = setXmPatternRowCount(song, song.orders[0]!, 128);
    saveSession({
      song,
      filename: "eight.xm",
      view: "pattern",
      cursor: { order: 0, row: 100, channel: 6, field: "note" },
      currentSample: 1,
      currentOctave: 2,
      editStep: 1,
      mutedChannels: Array.from({ length: 8 }, (_, i) => i === 5),
      soloedChannels: Array.from({ length: 8 }, () => false),
      cloudOrigin: { resource: "modules", name: "eight.xm" },
    });
  });

  it("sizes mute / solo / level arrays to the song's channel count", () => {
    render(() => <App />);
    expect(xm2Song()!.channelCount).toBe(8);
    expect(mutedChannels()).toHaveLength(8);
    expect(soloedChannels()).toHaveLength(8);
    expect(channelLevels()).toHaveLength(8);
    expect(mutedChannels()[5]).toBe(true);
    // The bug: toggling channel 7 silently no-oped after a reload.
    toggleMute(7);
    expect(mutedChannels()[7]).toBe(true);
  });

  it("restores the XM cursor position", () => {
    render(() => <App />);
    expect(xmCursor()).toMatchObject({ order: 0, row: 100, channel: 6 });
  });

  it("keeps the cloud origin, a ready transport and a clean dirty flag", () => {
    render(() => <App />);
    expect(cloudOrigin()).toEqual({ resource: "modules", name: "eight.xm" });
    expect(transport()).toBe("ready");
    expect(dirty()).toBe(false);
  });
});
