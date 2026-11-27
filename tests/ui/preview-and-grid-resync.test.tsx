/**
 * Regressions found in the browser pass:
 *  - a piano key tapped before the audio engine existed (first note after
 *    page load) started its preview AFTER the key-up's stop had already
 *    run, so a looped sample droned with nothing left to stop it;
 *  - the pattern grid's scroll went stale while the pattern view was
 *    hidden, so cursor moves made meanwhile (order jump, undo, load) left
 *    the cursor off-screen when the view came back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

import { App } from "../../src/App";
import { AudioEngine } from "../../src/core/audio/engine";
import { emptySong } from "../../src/core/mod/format";
import { insertOrder, replaceSampleData } from "../../src/core/mod/mutations";
import { emptyXmInstrument, emptyXmSong } from "../../src/core/xm/format";
import { setCursor, INITIAL_CURSOR } from "../../src/state/cursor";
import { resetXmCursor, setXmCursor } from "../../src/state/cursorXm";
import { clearSession } from "../../src/state/persistence";
import {
  disposeEngine,
  stopEnginePreview,
  triggerPreview,
} from "../../src/state/playback";
import { clearHistory, setSong, setTransport } from "../../src/state/song";
import { setView } from "../../src/state/view";
import { setCurrentXmInstrument } from "../../src/state/xmEdit";
import { previewXmNote, stopXmPreview } from "../../src/state/xmPreview";
import {
  installRecordingEngine,
  type RecordingEngine,
} from "../lib/recording-engine";

function reset() {
  setSong(null);
  setTransport("idle");
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  resetXmCursor();
  setCurrentXmInstrument(1);
  setView("pattern");
  clearSession();
}
beforeEach(reset);
afterEach(async () => {
  cleanup();
  await disposeEngine();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  reset();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("preview start vs. an earlier stop", () => {
  let fake: RecordingEngine;
  const sample = () =>
    replaceSampleData(emptySong(), 0, new Int8Array(64).fill(40), {
      volume: 64,
      loopStartWords: 0,
      loopLengthWords: 32,
    }).samples[0]!;

  beforeEach(() => {
    fake = installRecordingEngine();
  });

  it("a key released before the engine exists never starts the note", async () => {
    triggerPreview(0, sample(), 428); // key down — engine creation begins
    stopEnginePreview(); // key up — no engine yet, nothing to stop
    await settle();
    expect(fake.callsTo("previewNote")).toHaveLength(0);
  });

  it("a held key still starts once the engine is ready, then stops", async () => {
    triggerPreview(0, sample(), 428);
    await settle();
    expect(fake.callsTo("previewNote")).toHaveLength(1);
    stopEnginePreview();
    expect(fake.callsTo("stopPreview")).toHaveLength(1);
  });

  it("a stop only cancels starts that were pending at the time", async () => {
    triggerPreview(0, sample(), 428);
    stopEnginePreview();
    triggerPreview(0, sample(), 404); // second key, still held
    await settle();
    const calls = fake.callsTo("previewNote");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[1]).toBe(404);
  });

  it("XM: a tap before the engine exists never starts the note", async () => {
    const song = emptyXmSong();
    const inst = emptyXmInstrument();
    inst.samples[0]!.data = new Int8Array(64).fill(40);
    song.instruments = [inst];
    setSong(song);
    setTransport("ready");
    previewXmNote(0);
    stopXmPreview();
    await settle();
    expect(fake.callsTo("startXmPreview")).toHaveLength(0);

    previewXmNote(0); // engine now warm; held
    await settle();
    expect(fake.callsTo("startXmPreview")).toHaveLength(1);
  });
});

describe("AudioEngine: stop during preview warm-up", () => {
  it("drops a previewNote whose worklet was still loading when stop arrived", async () => {
    const posted: unknown[] = [];
    class FakeNode {
      port = { postMessage: (m: unknown) => posted.push(m), onmessage: null };
      connect() {}
      disconnect() {}
      addEventListener() {}
    }
    vi.stubGlobal("AudioWorkletNode", FakeNode);
    let releaseModule!: () => void;
    const moduleLoaded = new Promise<void>((r) => (releaseModule = r));
    const ctx = {
      state: "running",
      sampleRate: 48000,
      resume: async () => {},
      close: async () => {},
      audioWorklet: { addModule: () => moduleLoaded },
    };
    const Engine = AudioEngine as unknown as new (
      ctx: unknown,
      node: unknown,
      gain: unknown,
    ) => AudioEngine;
    const eng = new Engine(ctx, new FakeNode(), { gain: {} });
    const sample = replaceSampleData(emptySong(), 0, new Int8Array(64).fill(9))
      .samples[0]!;

    const pending = eng.previewNote(sample, 428);
    eng.stopPreview(); // arrives while addModule is still pending
    releaseModule();
    await pending;
    expect(
      posted.filter((m) => (m as { type: string }).type === "set"),
    ).toEqual([]);

    // A later note is unaffected.
    await eng.previewNote(sample, 428);
    expect(
      posted.filter((m) => (m as { type: string }).type === "set"),
    ).toHaveLength(1);
  });
});

describe("pattern grid re-syncs its scroll when it becomes visible again", () => {
  /** jsdom has no layout: emulate a scroller that, like a real one, has
   *  no height and ignores scrollTop writes while `display: none`. */
  function emulateScroller(el: HTMLElement) {
    const state = { hidden: false, top: 0, height: 400 };
    Object.defineProperty(el, "clientHeight", {
      get: () => (state.hidden ? 0 : state.height),
    });
    Object.defineProperty(el, "scrollTop", {
      get: () => (state.hidden ? 0 : state.top),
      set: (v: number) => {
        if (!state.hidden) state.top = Math.max(0, v);
      },
    });
    return state;
  }

  let roCallbacks: Array<(h: number) => void>;
  beforeEach(() => {
    roCallbacks = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: ResizeObserverCallback) {}
        observe() {
          roCallbacks.push((h) =>
            this.cb(
              [{ contentRect: { width: 600, height: h } }] as never,
              this as never,
            ),
          );
        }
        disconnect() {}
      },
    );
  });

  const ROW = 19; // any positive row height works; assertions are relative

  it.each(["PT2", "FT2"] as const)(
    "%s: a cursor jump made while hidden is scrolled into view on return",
    async (format) => {
      if (format === "PT2") {
        setSong(insertOrder(emptySong(), 0));
      } else {
        const s = emptyXmSong();
        setSong({
          ...s,
          songLength: 2,
          orders: [s.orders[0]!, s.orders[0]!, ...s.orders.slice(2)],
        });
      }
      setTransport("ready");
      const { container } = render(() => <App />);
      const scroller = container.querySelector<HTMLElement>(
        ".patternpane .patgrid__rows",
      )!;
      const sc = emulateScroller(scroller);
      const resize = (h: number) => roCallbacks.forEach((cb) => cb(h));
      resize(400);

      const far = { order: 1, row: 60, channel: 0, field: "note" as const };
      if (format === "PT2") setCursor(far);
      else setXmCursor(far);
      await settle();
      expect(sc.top).toBeGreaterThan(60 * ROW); // scrolled deep into order 1

      // Hide the pane; jump the cursor back to the very top meanwhile.
      sc.hidden = true;
      resize(0);
      const top = { order: 0, row: 0, channel: 0, field: "note" as const };
      if (format === "PT2") setCursor(top);
      else setXmCursor(top);
      await settle();

      // Show it again: the browser restores the old offset...
      sc.hidden = false;
      expect(sc.top).toBeGreaterThan(60 * ROW);
      resize(400);
      await settle();
      // ...and the grid must bring the cursor row (row 0) back into view.
      expect(sc.top).toBe(0);
    },
  );

  it("leaves the scroll alone when the cursor row is still visible", async () => {
    setSong(insertOrder(emptySong(), 0));
    setTransport("ready");
    const { container } = render(() => <App />);
    const scroller = container.querySelector<HTMLElement>(
      ".patternpane .patgrid__rows",
    )!;
    const sc = emulateScroller(scroller);
    const resize = (h: number) => roCallbacks.forEach((cb) => cb(h));
    resize(400);
    setCursor({ order: 1, row: 60, channel: 0, field: "note" });
    await settle();
    const before = sc.top;

    sc.hidden = true;
    resize(0);
    sc.hidden = false;
    resize(400);
    await settle();
    expect(sc.top).toBe(before);
  });
});
