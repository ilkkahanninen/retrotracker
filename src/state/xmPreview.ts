/**
 * FT2-mode note preview. Runs `XmReplayer` on the main thread with a
 * synthetic single-channel song that triggers the current instrument
 * at the requested note. The rendered PCM goes to the engine's
 * AudioBufferSourceNode path so the full XM voice model — volume +
 * panning envelopes, autovibrato, fadeout, ping-pong loop, finetune,
 * 16-bit samples, relative-note offset — all sound correct in the
 * audition.
 *
 * Live editing while a preview is in flight is handled by
 * `xmLivePreviewSwap` below: any workbench mutation (chiptune slider,
 * chain effect param) re-renders a fresh buffer at the same note and
 * stops+replays it. The voice loses phase continuity across the swap
 * (vs. PT2's gapless Paula morph), but the user hears the edit
 * immediately — same affordance as PT2's `updateCurrentWorkbench`.
 */

import { createSignal } from "solid-js";

import { XmReplayer } from "../core/audio/xmReplayer";
import {
  XM_DEFAULT_BPM,
  XM_DEFAULT_SPEED,
  XM_DEFAULT_TRACKER_NAME,
  XM_VERSION,
  emptyXmNote,
  emptyXmPattern,
} from "../core/xm/format";
import { XM_MAX_ORDERS, type XmSong } from "../core/xm/types";
import { currentEngine, ensureEngine } from "./playback";
import { transport, xm2Song as song } from "./song";
import { currentXmInstrument, currentXmOctave } from "./xmEdit";

/** Seconds of audio to pre-render per preview trigger. Long enough for
 *  a full vol-env decay + fadeout to play out before silence; short
 *  enough that the postMessage payload stays under 1 MB at 48 kHz. */
const PREVIEW_SECONDS = 4;
/** Sample rate the preview renders at. AudioContext's actual rate may
 *  differ — `createBuffer` resamples on playback. 44100 is the typical
 *  XM authoring rate; matches what offline render uses. */
const PREVIEW_SAMPLE_RATE = 44100;
/** Rows in the synthetic preview pattern. The trigger sits on row 0;
 *  the rest are empty so envelopes / fadeout play out across them. */
const PREVIEW_ROWS = 256;

/**
 * Convert a piano-key semitone offset into the XM note number 1..96
 * the preview should trigger. Mirrors `xmPatternEdit.noteForOffset`
 * one-to-one so the audible preview matches the cell the editor
 * writes — if these drift, the user hears one octave off vs. song
 * playback.
 */
export function xmNoteForPreviewOffset(offset: number): number {
  return currentXmOctave() * 12 + offset + 1;
}

/**
 * Identity of the preview currently audible, or null when nothing is
 * playing. `xmLivePreviewSwap` reads this to decide whether a
 * workbench mutation should re-render. Cleared via the engine's
 * `onended` callback when the buffer finishes naturally; held across
 * a swap because the engine suppresses the previous source's onended
 * when it replaces it.
 */
const [activeXmPreview, setActiveXmPreview] = createSignal<{
  instrument1Based: number;
  semitoneOffset: number;
} | null>(null);
export { activeXmPreview };

/** Drop any active-preview record. Tests use this to reset between
 *  cases; production code lets the engine's `onended` callback clear
 *  the signal naturally. */
export function clearActiveXmPreview(): void {
  setActiveXmPreview(null);
}

/**
 * Stop the in-flight preview (if any) and forget it ever existed.
 * Called from source-kind toggles and similar wholesale state
 * transitions where re-rendering the preview against the NEW source
 * would surprise the user with a fresh-sounding playback — the slot's
 * audible content has just been replaced. Cheaper than a "morph" and
 * leaves the user back at "press a piano key to hear the new sound".
 */
export function stopXmPreview(): void {
  setActiveXmPreview(null);
  const eng = currentEngine();
  eng?.stopPreview();
}

/**
 * Build a one-channel XM song that triggers `xmNote` on
 * `instrumentSlot1Based` at row 0. The instrument list is copied by
 * reference from the source song so any later mutation doesn't ripple
 * into in-flight previews.
 */
function buildPreviewSong(
  source: XmSong,
  instrumentSlot1Based: number,
  xmNote: number,
): XmSong {
  const channelCount = 1;
  const pattern = emptyXmPattern(PREVIEW_ROWS, channelCount);
  pattern.rows[0]![0] = {
    ...emptyXmNote(),
    note: xmNote,
    instrument: instrumentSlot1Based,
  };
  return {
    format: "FT2",
    title: "preview",
    trackerName: XM_DEFAULT_TRACKER_NAME,
    version: XM_VERSION,
    channelCount,
    songLength: 1,
    restartPosition: 0,
    orders: new Array(XM_MAX_ORDERS).fill(0),
    patterns: [pattern],
    instruments: source.instruments,
    flags: { linearFreq: source.flags.linearFreq },
    defaultTempo: source.defaultTempo ?? XM_DEFAULT_SPEED,
    defaultBpm: source.defaultBpm ?? XM_DEFAULT_BPM,
  };
}

/**
 * Render the preview song through XmReplayer into stereo Float32
 * buffers at `sampleRate` Hz. Pure synchronous main-thread work —
 * at 48 kHz × 4 s a single render is ~7 ms on a modern laptop,
 * comfortably under one frame even on slower hardware.
 *
 * The render rate must match the AudioContext's sample rate so the
 * worklet plays the buffer back at the same per-frame stride it was
 * generated at — the preview worklet doesn't resample (was free with
 * the previous AudioBufferSourceNode path), so a mismatch shifts the
 * audible pitch by the rate ratio.
 */
function renderPreviewBuffer(
  previewSong: XmSong,
  sampleRate: number,
): { left: Float32Array; right: Float32Array } {
  const replayer = new XmReplayer(previewSong, {
    sampleRate,
    loop: false,
  });
  const frames = PREVIEW_SECONDS * sampleRate;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const CHUNK = 1024;
  let pos = 0;
  while (pos < frames) {
    const want = Math.min(CHUNK, frames - pos);
    replayer.process(left, right, want, pos);
    pos += want;
    if (replayer.isFinished()) break;
  }
  if (pos === frames) return { left, right };
  return { left: left.subarray(0, pos), right: right.subarray(0, pos) };
}

/**
 * Audition the current instrument's first sample at the piano-key
 * pitch. No commit, no cursor advance. Used by piano keys in both the
 * pattern and instrument views (see appKeybindsXm.ts +
 * xmPatternEdit.ts:onXmPianoKey).
 */
export function previewXmNote(semitoneOffset: number): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  // Note 1 = C-0, so `octave * 12 + 1` lands on C of the current
  // octave — matching xmPatternEdit.noteForOffset's formula. The two
  // must stay in lock-step or the preview triggers a different pitch
  // than the pattern editor writes into the cell.
  const xmNote = xmNoteForPreviewOffset(semitoneOffset);
  if (xmNote < 1 || xmNote > 96) return;
  const inst1Based = currentXmInstrument();
  const inst = s.instruments[inst1Based - 1];
  if (!inst) return;
  if (inst.samples.length === 0) return;
  const mapIdx = inst.keyMap[xmNote - 1] ?? 0;
  const sample = inst.samples[mapIdx] ?? inst.samples[0];
  if (!sample || sample.data.length === 0) return;
  setActiveXmPreview({ instrument1Based: inst1Based, semitoneOffset });
  const onEnded = () => {
    const cur = activeXmPreview();
    if (
      cur &&
      cur.instrument1Based === inst1Based &&
      cur.semitoneOffset === semitoneOffset
    ) {
      setActiveXmPreview(null);
    }
  };
  // Render at the engine's sample rate so the worklet's per-frame
  // playback is in tune — the preview worklet doesn't resample. When
  // the engine isn't up yet, render at the default rate and let the
  // ensureEngine().then(...) microtask deliver the buffer.
  const previewSong = buildPreviewSong(s, inst1Based, xmNote);
  // ensureEngine lazily creates the AudioContext on first call (gated
  // behind a user gesture by the browser, which is satisfied by the
  // keydown that brought us here). Without this, the first piano
  // press before any Play action silently no-ops.
  void ensureEngine()
    .then((eng) => {
      if (!eng) return;
      const rate = eng.sampleRate || PREVIEW_SAMPLE_RATE;
      const { left, right } = renderPreviewBuffer(previewSong, rate);
      void eng.playXmPreviewBuffer(left, right, rate, onEnded);
    })
    .catch(() => {
      /* preview is a best-effort side-effect */
    });
}

/**
 * Re-render the in-flight preview against the current song state so a
 * workbench edit (chiptune slider, chain effect param) is audible
 * without the user re-striking the piano key. No-op when no preview
 * is playing. Stop+restart loses phase continuity; the trade-off vs.
 * a worklet-streamed XM voice (which would morph gaplessly like PT2)
 * is the cost of preserving the AudioBufferSourceNode preview path.
 *
 * Called from `updateCurrentXmWorkbench` so every path that commits a
 * workbench mutation — chain ops, source-kind toggle, chiptune param
 * patch, XM transformer setters — feeds through here.
 */
export function xmLivePreviewSwap(): void {
  const active = activeXmPreview();
  if (!active) return;
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const inst1Based = active.instrument1Based;
  const xmNote = xmNoteForPreviewOffset(active.semitoneOffset);
  if (xmNote < 1 || xmNote > 96) return;
  const inst = s.instruments[inst1Based - 1];
  if (!inst || inst.samples.length === 0) return;
  const mapIdx = inst.keyMap[xmNote - 1] ?? 0;
  const sample = inst.samples[mapIdx] ?? inst.samples[0];
  if (!sample || sample.data.length === 0) return;
  // The engine is created lazily, but if a preview is in flight it
  // must already exist. Bail to the no-op path otherwise.
  const eng = currentEngine();
  if (!eng) return;
  const rate = eng.sampleRate || PREVIEW_SAMPLE_RATE;
  const previewSong = buildPreviewSong(s, inst1Based, xmNote);
  const { left, right } = renderPreviewBuffer(previewSong, rate);
  const semitoneOffset = active.semitoneOffset;
  const onEnded = () => {
    const cur = activeXmPreview();
    if (
      cur &&
      cur.instrument1Based === inst1Based &&
      cur.semitoneOffset === semitoneOffset
    ) {
      setActiveXmPreview(null);
    }
  };
  // `restart: false` keeps the worklet's read pointer where it is so
  // the audible voice morphs gaplessly to the new render — no click,
  // no restart-from-zero on every slider tick.
  void eng.playXmPreviewBuffer(left, right, rate, onEnded, /* restart */ false);
}
