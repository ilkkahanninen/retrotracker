import { createSignal } from "solid-js";
import { AudioEngine } from "../core/audio/engine";
import type { Sample } from "../core/mod/types";
import {
  song,
  setTransport,
  setPlayMode,
  setPlayPos,
  transport,
  playMode,
} from "./song";
import { cursor } from "./cursor";
import { setChannelLevels } from "./channelLevel";
import * as preview from "./preview";

/**
 * Audio playback orchestration. Owns the lazily-created AudioEngine and
 * the transport-state mutations that go with each Play / Stop. Pulled out
 * of App.tsx so the engine and the play paths live next to each other.
 */

/**
 * Reactive handle on the lazily-created AudioEngine.
 *
 * Reactive (a Solid signal) so the per-engine sync effects in App.tsx
 * (channel mute, Paula filter model, stereo separation) automatically
 * re-run when the engine first appears or is disposed. Before this was
 * a signal, those effects only saw user-input changes and missed the
 * "engine just got created" event entirely — `ensureEngine` had to do
 * a parallel one-shot push of the cached preferences to compensate. With
 * the signal, the reactive path is the only path; engine creation /
 * disposal is just another tick the effects respond to. Removing that
 * second sync surface is the whole point — every preference now flows
 * through one channel.
 *
 * `currentEngine` is exported as the bare signal accessor (not a wrapper
 * function) so existing call sites that read `currentEngine()` get
 * reactive tracking for free inside `createEffect`.
 */
const [currentEngine, setCurrentEngine] = createSignal<AudioEngine | null>(
  null,
);
export { currentEngine };

/**
 * In-flight `AudioEngine.create()` promise, deduped across concurrent
 * `ensureEngine` callers. Without this, two near-simultaneous calls (e.g.
 * a piano-key audition firing the moment the user hits the play hotkey)
 * would each `await AudioEngine.create()`, both write to the engine
 * signal, and one of the AudioContexts would be orphaned without ever
 * being closed.
 */
let creating: Promise<AudioEngine | null> | null = null;

/**
 * Lazy-create the AudioEngine. Returns null when the AudioContext can't
 * be constructed (jsdom, browsers gating it behind a user gesture we
 * haven't received). Callers must handle null and treat it as "no audio
 * side-effect" rather than crashing.
 *
 * Cached preferences (channel mute, Paula model, stereo separation) are
 * NOT pushed here — App.tsx wires reactive effects on each that fire
 * automatically when the engine signal flips from null to non-null. This
 * keeps the sync surface to a single channel.
 */
export async function ensureEngine(): Promise<AudioEngine | null> {
  const existing = currentEngine();
  if (existing) return existing;
  if (creating) return creating;
  creating = (async () => {
    try {
      const eng = await AudioEngine.create();
      eng.onPosition = (order, row) => setPlayPos({ order, row });
      eng.onLevels = (peaks) => setChannelLevels(peaks);
      setCurrentEngine(eng);
      return eng;
    } catch {
      return null;
    } finally {
      creating = null;
    }
  })();
  return creating;
}

/**
 * Ensure the engine exists and push the current ModSong into it before play.
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
export function livePreviewSwap(
  slot: number,
  sample: Sample,
  period: number,
): void {
  preview.updatePreviewData(slot, sample);
  // The engine is created lazily, but if we're swapping a live preview
  // it must already exist. No need to await — slider drags fire many
  // updates per second and we want them queued, not awaited.
  const eng = currentEngine();
  if (eng) void eng.previewNote(sample, period);
}

export function stopPlayback(): void {
  currentEngine()?.stop();
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

/**
 * Mid-playback jump: tell the engine to restart its replayer at
 * `(order, 0)` while keeping `transport === "playing"` and the current
 * `playMode` (song vs. pattern-loop). Used by the order list's click
 * handler so the user can re-route playback without stopping first.
 *
 * The cached song already lives in the worklet (we got here via a play
 * call), so we don't `prepareEngine` — that would re-`load` the song and
 * undo any sample edits we hot-swapped in. We also push the new playPos
 * synchronously so the playhead UI snaps immediately rather than
 * waiting for the worklet's first `pos` event after the new replayer
 * starts. No-op when the engine doesn't exist (jsdom / pre-unlock).
 */
export async function jumpPlaybackToOrder(order: number): Promise<void> {
  // Snap playPos synchronously so the playhead UI moves on click.
  // Done before the engine check because the worklet's first `pos`
  // event after `playFrom` would arrive late (and never in environments
  // without an AudioContext, like jsdom). A no-op engine call below
  // doesn't change the user-visible jump.
  setPlayPos({ order, row: 0 });
  const eng = currentEngine();
  if (!eng) return;
  await eng.playFrom(order, 0, { loopPattern: playMode() === "pattern" });
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
  currentEngine()?.stop();
}

/** Cancel an in-flight previewNote (sample audition keyup). */
export function stopEnginePreview(): void {
  currentEngine()?.stopPreview();
}

/** Tear down the engine on app unmount. Clear the signal first so reactive
 *  effects stop pushing to a disposing engine; then close the AudioContext. */
export async function disposeEngine(): Promise<void> {
  const eng = currentEngine();
  if (!eng) return;
  setCurrentEngine(null);
  await eng.dispose();
}
