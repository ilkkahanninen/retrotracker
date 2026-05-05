import { AudioEngine } from "../core/audio/engine";
import type { Sample } from "../core/mod/types";
import { CHANNELS } from "../core/mod/types";
import {
  song,
  setTransport,
  setPlayMode,
  setPlayPos,
  transport,
  playMode,
} from "./song";
import { cursor } from "./cursor";
import { isChannelMuted } from "./channelMute";
import { setChannelLevels } from "./channelLevel";
import * as preview from "./preview";
import { settings } from "./settings";

/**
 * Audio playback orchestration. Owns the lazily-created AudioEngine and
 * the transport-state mutations that go with each Play / Stop. Pulled out
 * of App.tsx so the engine and the play paths live next to each other.
 */

let engine: AudioEngine | null = null;

/**
 * Lazy-create the AudioEngine. Returns null when the AudioContext can't
 * be constructed (jsdom, browsers gating it behind a user gesture we
 * haven't received). Callers must handle null and treat it as "no audio
 * side-effect" rather than crashing.
 */
export async function ensureEngine(): Promise<AudioEngine | null> {
  if (engine) return engine;
  try {
    engine = await AudioEngine.create();
    engine.onPosition = (order, row) => setPlayPos({ order, row });
    engine.onLevels = (peaks) => setChannelLevels(peaks);
    // Sync the current per-channel mute gate. Without this, anything the
    // user toggled before the engine existed would silently fail to apply
    // on first play.
    for (let ch = 0; ch < CHANNELS; ch++) {
      engine.setChannelMuted(ch, isChannelMuted(ch));
    }
    // Same reasoning for the Paula model: a user who picked A500 before
    // the audio context was unlocked would otherwise hear the first
    // playthrough through A1200 filters until the next preference change.
    engine.setPaulaModel(settings().paulaModel);
    engine.setStereoSeparation(settings().stereoSeparation);
    return engine;
  } catch {
    return null;
  }
}

/**
 * Read the current engine without lazily constructing it. Used by reactive
 * effects that push state changes to the worklet — no engine yet means
 * nothing to push, and the next `ensureEngine` will sync the state itself.
 */
export function currentEngine(): AudioEngine | null {
  return engine;
}

/**
 * Ensure the engine exists and push the current Song into it before play.
 * The worklet keeps its own copy of the song, so without this every edit
 * would only show up in the UI — the user would press Play and hear the
 * pre-edit version. Returns null if no song is loaded or the engine
 * couldn't be created.
 */
async function prepareEngine(): Promise<AudioEngine | null> {
  const eng = await ensureEngine();
  if (!eng) return null;
  const s = song();
  if (!s) return null;
  eng.load(s);
  return eng;
}

/**
 * Fire-and-forget audition: lazy-creates the engine if needed, no-ops on
 * failure. Also kicks off the visual playhead tracker so the waveform can
 * draw a position cursor — that runs off performance.now() and doesn't
 * depend on the engine resolving, so the cursor appears immediately even
 * if the AudioContext is still warming up.
 */
export function triggerPreview(
  slot: number,
  sample: Sample,
  period: number,
): void {
  preview.startPreview(slot, sample, period);
  void ensureEngine()
    .then((eng) => {
      if (eng) void eng.previewNote(sample, period);
    })
    .catch(() => {
      /* silent — preview is a best-effort side-effect */
    });
}

/**
 * Smoothly swap the audio + visual data of the in-flight preview on
 * `slot` to reflect a fresh sample. No-op if nothing is currently
 * previewing that slot. Used during synth slider drags so the user hears
 * the edit without the click of a stop+restart.
 *
 * The visual playhead retargets its data without resetting its start
 * time (no cursor jump); the engine crossfades AudioBufferSource voices
 * over a few ms (no pop).
 */
export function livePreviewSwap(slot: number, sample: Sample, period: number): void {
  preview.updatePreviewData(slot, sample);
  // The engine is created lazily, but if we're swapping a live preview
  // it must already exist. No need to await — slider drags fire many
  // updates per second and we want them queued, not awaited.
  if (engine) void engine.previewNote(sample, period);
}

export function stopPlayback(): void {
  engine?.stop();
  setTransport("ready");
  setPlayMode(null);
  // Snap the playhead to the cursor so the row tint jumps back to where
  // the user is editing, instead of freezing wherever the song happened
  // to be when stop fired.
  const c = cursor();
  setPlayPos({ order: c.order, row: c.row });
}

export async function playFromStart(): Promise<void> {
  const eng = await prepareEngine();
  if (!eng) return;
  await eng.playFrom(0, 0);
  setTransport("playing");
  setPlayMode("song");
}

export async function playFromCursor(): Promise<void> {
  const c = cursor();
  const eng = await prepareEngine();
  if (!eng) return;
  await eng.playFrom(c.order, c.row);
  setTransport("playing");
  setPlayMode("song");
}

export async function playPatternFromStart(): Promise<void> {
  const c = cursor();
  const eng = await prepareEngine();
  if (!eng) return;
  await eng.playFrom(c.order, 0, { loopPattern: true });
  setTransport("playing");
  setPlayMode("pattern");
}

export async function playPatternFromCursor(): Promise<void> {
  const c = cursor();
  const eng = await prepareEngine();
  if (!eng) return;
  await eng.playFrom(c.order, c.row, { loopPattern: true });
  setTransport("playing");
  setPlayMode("pattern");
}

/** Header "Play song" button: starts the song from order 0 / row 0 when
 *  stopped or already playing the pattern; stops when already in song
 *  mode. Mirrors the bare Space shortcut. */
export async function togglePlaySong(): Promise<void> {
  if (transport() === "playing" && playMode() === "song") stopPlayback();
  else await playFromStart();
}

/** Header "Play pattern" button: loops the cursor's pattern from row 0
 *  when stopped or playing the whole song; stops when already looping
 *  the pattern. Mirrors Option+Space. */
export async function togglePlayPattern(): Promise<void> {
  if (transport() === "playing" && playMode() === "pattern") stopPlayback();
  else await playPatternFromStart();
}

/** Halt the engine without touching transport state — used when swapping
 *  the loaded song so the worklet doesn't keep mixing the old one. */
export function stopEngine(): void {
  engine?.stop();
}

/** Cancel an in-flight previewNote (sample audition keyup). */
export function stopEnginePreview(): void {
  engine?.stopPreview();
}

/** Tear down the engine on app unmount. */
export async function disposeEngine(): Promise<void> {
  await engine?.dispose();
  engine = null;
}
