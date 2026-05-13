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
import { XM_MAX_ORDERS, type XmSample, type XmSong } from "../core/xm/types";
import { hzForNote } from "../core/audio/xmFreqTable";
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
  stopXmPreviewTracking();
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
  stopXmPreviewTracking();
  const eng = currentEngine();
  eng?.stopPreview();
}

// ─── Playhead tracking ───────────────────────────────────────────────────
//
// Why: same shape as PT2's preview.ts — performance.now() + source rate
// drives a RAF loop that updates `xmPreviewFrame`. Decoupled from the
// engine on purpose: querying the worklet's read pointer would tie the
// renderer to engine internals for what is, fundamentally, a UI cue.

interface XmPreviewTracking {
  instrument1Based: number;
  sampleIdx: number;
  startedAt: number;
  /** Source-sample frames per second (note rate after relativeNote +
   *  finetune). Constant for the lifetime of a single trigger. */
  sourceHz: number;
  dataLen: number;
  loopStart: number;
  loopLen: number;
  loopType: XmSample["loopType"];
  raf: number | null;
}

let tracking: XmPreviewTracking | null = null;

const [xmPreviewFrame, setXmPreviewFrame] = createSignal<{
  instrument1Based: number;
  sampleIdx: number;
  frame: number;
} | null>(null);

export { xmPreviewFrame };

function computeFrame(t: XmPreviewTracking, playedFrames: number): number {
  const len = t.dataLen;
  if (len <= 0) return 0;
  const hasLoop = t.loopType !== "none" && t.loopLen > 0;
  if (!hasLoop) {
    return Math.min(len - 1, Math.max(0, Math.floor(playedFrames)));
  }
  if (playedFrames < t.loopStart + t.loopLen) {
    return Math.min(len - 1, Math.max(0, Math.floor(playedFrames)));
  }
  const beyond = playedFrames - t.loopStart;
  if (t.loopType === "forward") {
    const frame = t.loopStart + Math.floor(beyond % t.loopLen);
    return Math.min(len - 1, Math.max(0, frame));
  }
  // ping-pong: 2 × loopLen period — forward half then backward half.
  const period = 2 * t.loopLen;
  const phase = beyond % period;
  const frame =
    phase < t.loopLen
      ? t.loopStart + Math.floor(phase)
      : t.loopStart + Math.floor(period - phase);
  return Math.min(len - 1, Math.max(0, frame));
}

function startXmPreviewTracking(
  instrument1Based: number,
  sampleIdx: number,
  sample: XmSample,
  xmNote: number,
  linearFreq: boolean,
): void {
  stopXmPreviewTracking();
  if (sample.data.length === 0) return;
  // Why: node-env tests (state tests outside tests/ui/**) don't define
  // requestAnimationFrame — tracking is a pure UI cue, so no-op there.
  if (typeof requestAnimationFrame !== "function") return;
  const effectiveNote = Math.max(1, Math.min(96, xmNote + sample.relativeNote));
  const sourceHz = hzForNote(effectiveNote, sample.finetune, linearFreq);
  if (!isFinite(sourceHz) || sourceHz <= 0) return;
  tracking = {
    instrument1Based,
    sampleIdx,
    startedAt: performance.now(),
    sourceHz,
    dataLen: sample.data.length,
    loopStart: sample.loopStart,
    loopLen: sample.loopLength,
    loopType: sample.loopType,
    raf: null,
  };
  const tick = () => {
    const t = tracking;
    if (!t) return;
    const elapsedSec = (performance.now() - t.startedAt) / 1000;
    const playedFrames = elapsedSec * t.sourceHz;
    const hasLoop = t.loopType !== "none" && t.loopLen > 0;
    if (!hasLoop && playedFrames >= t.dataLen) {
      stopXmPreviewTracking();
      return;
    }
    setXmPreviewFrame({
      instrument1Based: t.instrument1Based,
      sampleIdx: t.sampleIdx,
      frame: computeFrame(t, playedFrames),
    });
    t.raf = requestAnimationFrame(tick);
  };
  tracking.raf = requestAnimationFrame(tick);
}

function stopXmPreviewTracking(): void {
  if (!tracking) return;
  if (tracking.raf !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(tracking.raf);
  }
  tracking = null;
  setXmPreviewFrame(null);
}

// Why: live-swap path replaces the audible buffer without restarting —
// keep startedAt put so the visual playhead stays continuous, but refresh
// the data/loop fields in case the user's edit changed them.
function updateXmPreviewTracking(sample: XmSample): void {
  if (!tracking) return;
  tracking.dataLen = sample.data.length;
  tracking.loopStart = sample.loopStart;
  tracking.loopLen = sample.loopLength;
  tracking.loopType = sample.loopType;
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
  startXmPreviewTracking(
    inst1Based,
    mapIdx,
    sample,
    xmNote,
    s.flags.linearFreq,
  );
  const onEnded = () => {
    const cur = activeXmPreview();
    if (
      cur &&
      cur.instrument1Based === inst1Based &&
      cur.semitoneOffset === semitoneOffset
    ) {
      setActiveXmPreview(null);
      stopXmPreviewTracking();
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
  // The engine is created lazily, but if a preview is in flight it
  // must already exist. Bail to the no-op path otherwise.
  const eng = currentEngine();
  if (!eng) return;
  // Double-check that the engine is still tracking a live preview —
  // `activeXmPreview` is a UI-level signal; if a key-up cleared the
  // engine's onEnded callback but a stale `activeXmPreview` somehow
  // survived (race between handlers, re-render, etc.), the engine's
  // gate is the authoritative truth. Without this, a slider drag
  // immediately after key-up could play unrequested audio.
  if (!eng.isXmPreviewActive()) {
    setActiveXmPreview(null);
    return;
  }
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
  const rate = eng.sampleRate || PREVIEW_SAMPLE_RATE;
  const previewSong = buildPreviewSong(s, inst1Based, xmNote);
  const { left, right } = renderPreviewBuffer(previewSong, rate);
  // Refresh tracking against the (possibly mutated) sample so the playhead
  // honours new loop bounds and length without restarting from zero.
  updateXmPreviewTracking(sample);
  const semitoneOffset = active.semitoneOffset;
  const onEnded = () => {
    const cur = activeXmPreview();
    if (
      cur &&
      cur.instrument1Based === inst1Based &&
      cur.semitoneOffset === semitoneOffset
    ) {
      setActiveXmPreview(null);
      stopXmPreviewTracking();
    }
  };
  // `restart: false` keeps the worklet's read pointer where it is so
  // the audible voice morphs gaplessly to the new render — no click,
  // no restart-from-zero on every slider tick.
  void eng.playXmPreviewBuffer(left, right, rate, onEnded, /* restart */ false);
}
