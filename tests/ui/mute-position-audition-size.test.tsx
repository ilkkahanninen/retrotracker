/**
 * Regressions for:
 *  - mute / solo flags being destroyed by a channel-count shrink, so
 *    undoing the shrink brought the channels back unmuted;
 *  - a worklet position report arriving after stop overwriting the play
 *    position that stop had just snapped to the cursor;
 *  - XM keyboard audition ignoring the mixer interpolation / ramp settings;
 *  - the project-size indicator never warning before autosave failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

import { App } from "../../src/App";
import { workbenchFromWavData } from "../../src/core/audio/sampleWorkbench";
import { emptySong } from "../../src/core/mod/format";
import { emptyXmInstrument, emptyXmSong } from "../../src/core/xm/format";
import { setXmChannelCount } from "../../src/core/xm/mutations";
import {
  isChannelMuted,
  mutedChannels,
  resetChannelMute,
  soloedChannels,
  toggleMute,
  toggleSolo,
} from "../../src/state/channelMute";
import { INITIAL_CURSOR, setCursor } from "../../src/state/cursor";
import { resetXmCursor } from "../../src/state/cursorXm";
import { clearSession } from "../../src/state/persistence";
import {
  disposeEngine,
  playFromStart,
  stopPlayback,
} from "../../src/state/playback";
import {
  clearAllWorkbenches,
  setWorkbench,
} from "../../src/state/sampleWorkbench";
import { applyLoadedSession } from "../../src/state/session";
import { setFollowPlayback, setSettings } from "../../src/state/settings";
import {
  clearHistory,
  playPos,
  redo,
  setPlayPos,
  setSong,
  setTransport,
  undo,
} from "../../src/state/song";
import { setView } from "../../src/state/view";
import { setCurrentXmInstrument } from "../../src/state/xmEdit";
import { setXmChannelCountAction } from "../../src/state/xmPatternEdit";
import { previewXmNote, stopXmPreview } from "../../src/state/xmPreview";
import {
  XmPreviewVoice,
  type XmPreviewVoiceOptions,
} from "../../src/core/audio/xmPreviewVoice";
import type { XmSong } from "../../src/core/xm/types";
import {
  installRecordingEngine,
  type RecordingEngine,
} from "../lib/recording-engine";

function reset() {
  setSong(null);
  setTransport("idle");
  clearHistory();
  resetChannelMute();
  setCursor({ ...INITIAL_CURSOR });
  resetXmCursor();
  setPlayPos({ order: 0, row: 0 });
  setCurrentXmInstrument(1);
  setView("pattern");
  setFollowPlayback(true);
  setSettings({ ft2Interpolation: "linear", ft2Ramping: true });
  clearAllWorkbenches();
  clearSession();
}
beforeEach(reset);
afterEach(async () => {
  cleanup();
  await disposeEngine();
  vi.restoreAllMocks();
  reset();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("mute / solo survive a channel-count round trip", () => {
  beforeEach(() =>
    applyLoadedSession({
      song: setXmChannelCount(emptyXmSong(), 8),
      filename: null,
    }),
  );

  it("undoing a shrink brings the removed channels back with their flags", () => {
    toggleMute(6);
    toggleSolo(5);
    toggleSolo(1);
    setXmChannelCountAction(4);
    expect(mutedChannels()).toHaveLength(4);

    undo();
    expect(mutedChannels()).toHaveLength(8);
    expect(mutedChannels()[6]).toBe(true);
    expect(soloedChannels()[5]).toBe(true);
    expect(soloedChannels()[1]).toBe(true);

    redo();
    expect(mutedChannels()).toHaveLength(4);
    expect(soloedChannels()).toEqual([false, true, false, false]);
  });

  it("a hidden solo does not silence the remaining channels", () => {
    toggleSolo(6);
    setXmChannelCountAction(4);
    expect(soloedChannels()).toEqual([false, false, false, false]);
    for (let ch = 0; ch < 4; ch++) expect(isChannelMuted(ch)).toBe(false);
  });

  it("hidden channels cannot be toggled", () => {
    setXmChannelCountAction(4);
    toggleMute(6);
    setXmChannelCountAction(8);
    expect(mutedChannels()[6]).toBe(false);
  });

  it("loading another song clears hidden flags too", () => {
    toggleMute(6);
    setXmChannelCountAction(4);
    applyLoadedSession({
      song: setXmChannelCount(emptyXmSong(), 8),
      filename: null,
    });
    expect(mutedChannels()).toEqual(new Array(8).fill(false));
  });
});

describe("worklet position reports", () => {
  let fake: RecordingEngine;
  beforeEach(() => {
    fake = installRecordingEngine();
  });

  it("move playPos while playing and are ignored after stop", async () => {
    setSong(emptySong());
    setTransport("ready");
    setCursor({ order: 0, row: 12, channel: 0, field: "note" });

    await playFromStart();
    fake.onPosition!(0, 5);
    expect(playPos()).toEqual({ order: 0, row: 5 });

    stopPlayback();
    expect(playPos()).toEqual({ order: 0, row: 12 }); // snapped to cursor
    fake.onPosition!(0, 6); // report that was already in flight
    expect(playPos()).toEqual({ order: 0, row: 12 });
  });

  it("are accepted again on the next play, before transport flips", async () => {
    setSong(emptySong());
    setTransport("ready");
    await playFromStart();
    stopPlayback();

    const playing = playFromStart();
    await settle();
    fake.onPosition!(0, 1);
    await playing;
    expect(playPos()).toEqual({ order: 0, row: 1 });
  });

  it("are ignored once a new song has been loaded", async () => {
    setSong(emptySong());
    setTransport("ready");
    await playFromStart();
    applyLoadedSession({ song: emptySong(), filename: "next.mod" });
    fake.onPosition!(0, 40);
    expect(playPos()).toEqual({ order: 0, row: 0 });
  });
});

describe("XM keyboard audition follows the mixer settings", () => {
  let fake: RecordingEngine;
  beforeEach(() => {
    fake = installRecordingEngine();
    const song = emptyXmSong();
    const inst = emptyXmInstrument();
    const data = new Int8Array(16);
    for (let i = 0; i < 16; i++) {
      data[i] = Math.round(Math.sin((2 * Math.PI * i) / 16) * 100);
    }
    inst.samples[0] = {
      ...inst.samples[0]!,
      data,
      loopStart: 0,
      loopLength: 16,
      loopType: "forward",
    };
    song.instruments = [inst];
    setSong(song);
    setTransport("ready");
  });

  /** Audition a note and render what the preview worklet would play:
   *  the song and mixer settings the engine was handed, through the same
   *  `XmPreviewVoice` the worklet runs. */
  async function audition(): Promise<Float32Array> {
    previewXmNote(0);
    await settle();
    const [song, opts] = fake.callsTo("startXmPreview").at(-1)!.args as [
      XmSong,
      XmPreviewVoiceOptions,
    ];
    stopXmPreview();
    const voice = new XmPreviewVoice(44100);
    voice.start(song, opts);
    const left = new Float32Array(4096);
    voice.process(left, new Float32Array(4096), 4096);
    return left;
  }
  const differ = (a: Float32Array, b: Float32Array, from = 0) => {
    for (let i = from; i < a.length; i++) if (a[i] !== b[i]) return true;
    return false;
  };

  it("interpolation mode changes the auditioned audio", async () => {
    const linear = await audition();
    setSettings({ ft2Interpolation: "none" });
    const none = await audition();
    setSettings({ ft2Interpolation: "sinc8" });
    const sinc = await audition();
    expect(differ(linear, none, 1024)).toBe(true);
    expect(differ(linear, sinc, 1024)).toBe(true);
    // 'none' holds each source sample: repeated output frames.
    let repeats = 0;
    for (let i = 1025; i < none.length; i++) {
      if (none[i] === none[i - 1]) repeats++;
    }
    expect(repeats).toBeGreaterThan(500);
  });

  it("ramping off starts the note at full gain", async () => {
    const ramped = await audition();
    setSettings({ ft2Ramping: false });
    const stepped = await audition();
    // Frame 1 of the sine is non-zero in the source; with the ramp on it
    // is still nearly silent, with it off it is at full level.
    expect(Math.abs(stepped[1]!)).toBeGreaterThan(Math.abs(ramped[1]!) * 5);
  });
});

describe("project size warning", () => {
  function songWithSource(frames: number) {
    setSong(emptySong());
    setTransport("ready");
    const ch = new Float32Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = ((i % 200) - 100) / 100;
    setWorkbench(
      0,
      workbenchFromWavData({ sampleRate: 44100, channels: [ch] }, "big.wav"),
    );
  }
  const banner = (c: HTMLElement) =>
    c.querySelector<HTMLElement>(".share-banner--warn");

  it("says nothing for a small project", () => {
    songWithSource(1000);
    const { container } = render(() => <App />);
    expect(banner(container)).toBeNull();
  });

  it("warns when the project nears the browser-storage budget", () => {
    // 1.6M frames × 2 bytes ≈ 3.2 MB of PCM → ≈ 4.3 MB as base64.
    songWithSource(1_600_000);
    const { container } = render(() => <App />);
    const b = banner(container);
    expect(b).not.toBeNull();
    expect(b!.textContent).toContain("of the 5.00 MB");
  });

  it("says so when it is over, and can be dismissed", () => {
    songWithSource(2_200_000); // ≈ 5.9 MB as base64
    const { container } = render(() => <App />);
    const b = banner(container);
    expect(b!.textContent).toContain("over the 5.00 MB");
    fireEvent.click(b!.querySelector("button")!);
    expect(banner(container)).toBeNull();
  });
});
