import { createEffect } from "solid-js";
import { CHANNELS } from "../core/mod/types";
import type { Sample, ModSong } from "../core/mod/types";
import { song, transport } from "./song";
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
    for (let ch = 0; ch < CHANNELS; ch++) {
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
    const gain = settings().masterGain;
    const eng = currentEngine();
    eng?.setMasterGain(gain);
  });

  // Reference-diff against the previous render's snapshot; mutation paths
  // always produce fresh objects when something changes, so `!==` is the
  // right gate.
  let prevSamples: Sample[] | null = null;
  let prevOrders: ModSong["orders"] | null = null;
  let prevPatterns: ModSong["patterns"] | null = null;
  let prevSongLength: number | null = null;
  createEffect(() => {
    const s = song();
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
}
