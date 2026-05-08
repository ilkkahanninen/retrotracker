import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { App } from "../../src/App";
import { emptySong } from "../../src/core/mod/format";
import { CHANNELS } from "../../src/core/mod/types";
import type { Sample, Song } from "../../src/core/mod/types";
import {
  setSong,
  setTransport,
  setPlayMode,
  setPlayPos,
  clearHistory,
  song,
  transport,
} from "../../src/state/song";
import {
  ensureEngine,
  disposeEngine,
  playFromStart,
  stopPlayback,
} from "../../src/state/playback";
import { setCursor, INITIAL_CURSOR } from "../../src/state/cursor";
import { setView } from "../../src/state/view";
import { resetChannelMute, toggleMute } from "../../src/state/channelMute";
import { setSettings } from "../../src/state/settings";
import { clearAllWorkbenches } from "../../src/state/sampleWorkbench";
import {
  installRecordingEngine,
  type RecordingEngine,
} from "../lib/recording-engine";

/**
 * Engine-sync test bed.
 *
 * Drives the App with a `RecordingEngine` swapped in for the real
 * `AudioEngine` and asserts on the message stream the App's reactive
 * forwarders produce. Covers the surface where we kept finding bugs:
 * cached preferences flowing to a freshly-created engine, mid-playback
 * sample / song-shape edits going out as the right messages, and the
 * inverse — no spam when the transport isn't playing.
 *
 * The replayer / parser / accuracy tests cover the wire format itself;
 * this bed only checks that App pushes messages through the right gates,
 * with the right arguments, in the right order.
 */

function resetState(): void {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  setPlayMode(null);
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setView("pattern");
  resetChannelMute();
  clearAllWorkbenches();
  setSettings({ paulaModel: "A1200", stereoSeparation: 20 });
}

let fake: RecordingEngine;

beforeEach(() => {
  resetState();
  fake = installRecordingEngine();
});

afterEach(async () => {
  cleanup();
  await disposeEngine();
  vi.restoreAllMocks();
  resetState();
});

describe("engine creation: cached preferences forwarded reactively", () => {
  it("pushes the current mute / Paula model / stereo separation when the engine first appears", async () => {
    // Pre-set everything BEFORE the engine exists. The App's reactive
    // effects subscribe to these signals, but since the engine is null,
    // no messages go out. The moment the engine signal flips to
    // non-null, every effect re-runs and forwards its cached state.
    setSong(emptySong());
    toggleMute(2);
    setSettings({ paulaModel: "A500", stereoSeparation: 50 });

    render(() => <App />);

    // Trigger lazy-creation of the engine. ensureEngine awaits
    // AudioEngine.create (mocked), then `setCurrentEngine(fake)` flips
    // the signal — Solid schedules dependent effects on the next
    // microtask, so we yield once for them to run.
    await ensureEngine();
    await waitFor(() =>
      expect(fake.callsTo("setStereoSeparation").length).toBeGreaterThan(0),
    );

    // Stereo separation: forwarded once with the cached value.
    expect(fake.callsTo("setStereoSeparation")).toEqual([
      { method: "setStereoSeparation", args: [50] },
    ]);
    // Paula model: same.
    expect(fake.callsTo("setPaulaModel")).toEqual([
      { method: "setPaulaModel", args: ["A500"] },
    ]);
    // Mute: one call per channel, with channel 2 = true and the rest false.
    const muteCalls = fake.callsTo("setChannelMuted");
    expect(muteCalls).toHaveLength(CHANNELS);
    for (let ch = 0; ch < CHANNELS; ch++) {
      expect(muteCalls.find((c) => c.args[0] === ch)?.args[1]).toBe(ch === 2);
    }
  });

  it("forwards subsequent preference changes through the same path", async () => {
    setSong(emptySong());
    render(() => <App />);
    await ensureEngine();
    await waitFor(() =>
      expect(fake.callsTo("setPaulaModel").length).toBeGreaterThan(0),
    );
    fake.reset();

    // `settings` is a single signal returning the whole Settings object,
    // so each `setSettings(...)` re-runs every settings-reading effect
    // with whatever the current value is — including the ones whose
    // tracked field didn't change. That's wasted bandwidth but not a
    // correctness issue, so we assert on "the latest value forwarded
    // for the changed field" rather than total call count.
    const lastArg = (m: string): unknown => fake.callsTo(m).at(-1)?.args[0];

    setSettings({ paulaModel: "A500" });
    await waitFor(() => expect(lastArg("setPaulaModel")).toBe("A500"));

    setSettings({ stereoSeparation: 0 });
    await waitFor(() => expect(lastArg("setStereoSeparation")).toBe(0));

    toggleMute(0);
    await waitFor(() =>
      expect(
        fake
          .callsTo("setChannelMuted")
          .some((c) => c.args[0] === 0 && c.args[1] === true),
      ).toBe(true),
    );
  });
});

describe("live-edit forwarder", () => {
  /** Build a song shaped enough for the forwarder to diff against. */
  function withSampleEdit(s: Song, slot: number, patch: Partial<Sample>): Song {
    const samples = s.samples.slice();
    samples[slot] = { ...samples[slot]!, ...patch };
    return { ...s, samples };
  }

  it("pushes setSampleData when a sample slot's reference changes mid-playback", async () => {
    setSong(emptySong());
    render(() => <App />);
    await playFromStart();
    await waitFor(() => expect(transport()).toBe("playing"));
    // The play path issued load + playFrom + the engine-creation
    // preference forwarders. Drop them so the next assertion only sees
    // forwarder activity caused by the sample edit.
    fake.reset();

    setSong(withSampleEdit(song()!, 3, { volume: 32 }));

    await waitFor(() => expect(fake.callsTo("setSampleData").length).toBe(1));
    const call = fake.callsTo("setSampleData")[0]!;
    expect(call.args[0]).toBe(3);
    expect((call.args[1] as Sample).volume).toBe(32);
    // Reference-diff: untouched slots produce no messages.
    expect(fake.callsTo("setSampleData")).toHaveLength(1);
  });

  it("pushes replaceSong when the order list changes mid-playback", async () => {
    // Two-pattern song so we can flip an order entry between valid
    // pattern indices without hitting the writer's range guard.
    const base = emptySong();
    setSong({
      ...base,
      patterns: [base.patterns[0]!, base.patterns[0]!],
      orders: base.orders.slice(),
      songLength: 1,
    });
    render(() => <App />);
    await playFromStart();
    await waitFor(() => expect(transport()).toBe("playing"));
    fake.reset();

    const cur = song()!;
    const newOrders = cur.orders.slice();
    newOrders[1] = 1;
    setSong({ ...cur, orders: newOrders, songLength: 2 });

    await waitFor(() => expect(fake.callsTo("replaceSong")).toHaveLength(1));
    // Sample slots didn't change; no setSampleData should fire alongside.
    expect(fake.callsTo("setSampleData")).toHaveLength(0);
  });

  it("does NOT push setSampleData / replaceSong when the transport is not playing", async () => {
    setSong(emptySong());
    render(() => <App />);
    // Bring the engine up but stay in "ready" — no play.
    await ensureEngine();
    await waitFor(() =>
      expect(fake.callsTo("setPaulaModel").length).toBeGreaterThan(0),
    );
    fake.reset();

    // Mutate a sample reference and the order list. With transport=ready
    // the live-edit effect short-circuits its engine read, so neither
    // forwarder should fire.
    setSong(withSampleEdit(song()!, 1, { volume: 16 }));
    const cur = song()!;
    const orders = cur.orders.slice();
    orders[0] = 0;
    setSong({ ...cur, orders });

    // Wait one Solid microtask cycle for any phantom effect to surface.
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.callsTo("setSampleData")).toHaveLength(0);
    expect(fake.callsTo("replaceSong")).toHaveLength(0);
  });

  it("stops forwarding the moment the transport flips back to ready", async () => {
    setSong(emptySong());
    render(() => <App />);
    await playFromStart();
    await waitFor(() => expect(transport()).toBe("playing"));

    stopPlayback();
    await waitFor(() => expect(transport()).toBe("ready"));
    fake.reset();

    setSong(withSampleEdit(song()!, 2, { volume: 8 }));

    await Promise.resolve();
    await Promise.resolve();
    expect(fake.callsTo("setSampleData")).toHaveLength(0);
  });
});

describe("play path: engine receives load before playFrom", () => {
  it("issues load, then playFrom, in that order", async () => {
    setSong(emptySong());
    render(() => <App />);
    fake.reset();

    await playFromStart();

    // load and playFrom should appear in order, separated by zero or
    // more preference-forwarder calls (which are out of band — they
    // run between the engine's appearance and the play path's load).
    const indexOf = (m: string) => fake.calls.findIndex((c) => c.method === m);
    expect(indexOf("load")).toBeGreaterThan(-1);
    expect(indexOf("playFrom")).toBeGreaterThan(-1);
    expect(indexOf("load")).toBeLessThan(indexOf("playFrom"));
  });
});
