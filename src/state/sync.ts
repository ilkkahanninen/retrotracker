import { createEffect } from "solid-js";
import type { Sample, ModSong } from "../core/mod/types";
import type { XmInstrument } from "../core/xm/types";
import { channelCount as channelCountOf } from "../core/song";
import { pt2Song, song, transport, xm2Song } from "./song";
import { currentEngine } from "./playback";
import { isChannelMuted } from "./channelMute";
import { settings } from "./settings";

/**
 * Reactive forwarders that keep the audio engine in sync with the editor.
 * Call inside a Solid reactive scope (App's `onMount`) so the effects
 * dispose with it.
 *
 * Each effect reads `currentEngine()` unconditionally. `?.` on a
 * possibly-null engine read would skip both the call AND the dependency
 * registration, leaving the effect dead for the rest of the session if
 * the engine wasn't ready on first run.
 *
 * The live-song forwarder no-ops while transport isn't playing — the
 * next play call's `engine.load(song)` picks everything up in one shot.
 */
export function installEngineSync(): void {
  createEffect(() => {
    const eng = currentEngine();
    const s = song();
    const n = s ? channelCountOf(s) : 0;
    for (let ch = 0; ch < n; ch++) {
      const muted = isChannelMuted(ch);
      if (eng) eng.setChannelMuted(ch, muted);
    }
  });

  createEffect(() => {
    const model = settings().paulaModel;
    const eng = currentEngine();
    eng?.setPaulaModel(model);
  });

  createEffect(() => {
    const sep = settings().stereoSeparation;
    const eng = currentEngine();
    eng?.setStereoSeparation(sep);
  });

  createEffect(() => {
    const interpolation = settings().ft2Interpolation;
    const ramping = settings().ft2Ramping;
    const eng = currentEngine();
    eng?.setXmMixer(interpolation, ramping);
  });

  createEffect(() => {
    const gain = settings().masterGain;
    const eng = currentEngine();
    eng?.setMasterGain(gain);
  });

  // Forward Song↔Pattern toggle to the running replayer so the user's
  // header-toggle / hotkey-`c` flips take effect mid-playback. While
  // transport is idle the flag is captured at the next `playFrom` call,
  // so we only need to push it while playing.
  createEffect(() => {
    const loopPat = settings().loopPattern;
    const playing = transport() === "playing";
    const eng = currentEngine();
    if (playing && eng) eng.setLoopPattern(loopPat);
  });

  // PT-only: reference-diff sample-array + order-list / pattern-array
  // against the previous render's snapshot and forward changes through
  // engine.setSampleData / engine.replaceSong. FT2 has its own block
  // below.
  let prevSamples: Sample[] | null = null;
  let prevOrders: ModSong["orders"] | null = null;
  let prevPatterns: ModSong["patterns"] | null = null;
  let prevSongLength: number | null = null;
  createEffect(() => {
    const s = pt2Song();
    const playing = transport() === "playing";
    if (!s) {
      prevSamples = null;
      prevOrders = null;
      prevPatterns = null;
      prevSongLength = null;
      return;
    }
    const eng = playing ? currentEngine() : null;
    if (eng && prevSamples) {
      for (let i = 0; i < s.samples.length; i++) {
        const cur = s.samples[i]!;
        const prev = prevSamples[i];
        if (cur !== prev) eng.setSampleData(i, cur);
      }
    }
    if (
      eng &&
      (s.orders !== prevOrders ||
        s.patterns !== prevPatterns ||
        s.songLength !== prevSongLength) &&
      prevOrders !== null
    ) {
      eng.replaceSong(s);
    }
    prevSamples = s.samples;
    prevOrders = s.orders;
    prevPatterns = s.patterns;
    prevSongLength = s.songLength;
  });

  // FT2: forward order-list / pattern-array / channelCount edits to the
  // worklet so live tweaks (insert order, change channel count) take
  // effect on the next row processed. Instrument edits (sample pipeline,
  // loop points, envelopes) go out one instrument at a time through
  // engine.setXmInstrument — the FT2 counterpart of setSampleData.
  let prevXmInstruments: XmInstrument[] | null = null;
  let prevXmOrders: number[] | null = null;
  let prevXmPatterns: unknown[] | null = null;
  let prevXmSongLength: number | null = null;
  let prevXmChannelCount: number | null = null;
  createEffect(() => {
    const s = xm2Song();
    const playing = transport() === "playing";
    if (!s) {
      prevXmInstruments = null;
      prevXmOrders = null;
      prevXmPatterns = null;
      prevXmSongLength = null;
      prevXmChannelCount = null;
      return;
    }
    const eng = playing ? currentEngine() : null;
    if (
      eng &&
      (s.orders !== prevXmOrders ||
        s.patterns !== prevXmPatterns ||
        s.songLength !== prevXmSongLength ||
        s.channelCount !== prevXmChannelCount ||
        // A list that grew or shrank can't be patched slot by slot.
        s.instruments.length !== prevXmInstruments?.length) &&
      prevXmOrders !== null
    ) {
      // The whole song, instruments included.
      eng.replaceSong(s);
    } else if (
      eng &&
      prevXmInstruments &&
      s.instruments !== prevXmInstruments
    ) {
      for (let i = 0; i < s.instruments.length; i++) {
        const cur = s.instruments[i]!;
        if (cur !== prevXmInstruments[i]) eng.setXmInstrument(i, cur);
      }
    }
    prevXmInstruments = s.instruments;
    prevXmOrders = s.orders;
    prevXmPatterns = s.patterns;
    prevXmSongLength = s.songLength;
    prevXmChannelCount = s.channelCount;
  });
}
