/**
 * FT2-mode note preview. Builds a one-note preview song for the current
 * instrument and hands it to the engine's XM preview worklet, which runs
 * an `XmReplayer` on it for as long as the key is held — so the full XM
 * voice model (volume + panning envelopes, autovibrato, fadeout,
 * ping-pong loop, finetune, 16-bit samples, relative-note offset) sounds
 * as it does in the song, and a looped sample sustains indefinitely.
 *
 * Live editing while a preview is in flight is handled by
 * `xmLivePreviewSwap` below: any workbench mutation (chiptune slider,
 * chain effect param) swaps the instrument under the sounding voice,
 * which keeps its position — the same gapless morph as PT2's
 * `updateCurrentWorkbench`.
 */

import { createSignal } from "solid-js";

import {
  buildXmPreviewSong,
  previewInstrument,
} from "../core/audio/xmPreviewVoice";
import type { XmInstrument, XmSample } from "../core/xm/types";
import { hzForNote } from "../core/audio/xmFreqTable";
import {
  currentEngine,
  ensureEngine,
  previewStopCount,
  stopEnginePreview,
} from "./playback";
import { xm2Song as song } from "./song";
import { settings } from "./settings";
import { currentXmInstrument, currentXmOctave } from "./xmEdit";

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
 * workbench mutation should reach the sounding voice. Cleared via the
 * engine's `onEnded` callback when the note runs out by itself; a swap
 * leaves it in place — it is the same note continuing.
 */
const [activeXmPreview, setActiveXmPreview] = createSignal<{
  instrument1Based: number;
  semitoneOffset: number;
  /** Set when the preview was pinned to one sample (the instrument
   *  editor auditions the sample being edited). */
  sampleIdx?: number;
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
  stopEnginePreview();
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

export interface XmPreviewOptions {
  /**
   * Audition this sample whatever the key map says. The instrument
   * editor passes the sample being edited: with the default key map
   * every key plays sample 0, so editing sample 2 would otherwise be
   * inaudible from the keyboard.
   */
  sampleIdx?: number;
}

/** The sample a preview of `xmNote` on `inst` will sound, and its index. */
function previewTarget(
  inst: XmInstrument,
  xmNote: number,
  sampleIdx: number | undefined,
): { sample: XmSample; index: number } | null {
  if (sampleIdx !== undefined) {
    // Pinned: an empty edited sample is silence, not a fallback to
    // another sample — that would misreport what is being edited.
    const sample = inst.samples[sampleIdx];
    return sample && sample.data.length > 0
      ? { sample, index: sampleIdx }
      : null;
  }
  const mapIdx = inst.keyMap[xmNote - 1] ?? 0;
  const index = inst.samples[mapIdx] ? mapIdx : 0;
  const sample = inst.samples[index];
  return sample && sample.data.length > 0 ? { sample, index } : null;
}

/**
 * Audition the current instrument at the piano-key pitch. No commit, no
 * cursor advance. Used by piano keys in both the pattern and instrument
 * views (see appKeybindsXm.ts + xmPatternEdit.ts:onXmPianoKey). Plays on
 * its own node, so it works over a playing song like PT's preview does.
 */
export function previewXmNote(
  semitoneOffset: number,
  opts: XmPreviewOptions = {},
): void {
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
  const target = previewTarget(inst, xmNote, opts.sampleIdx);
  if (!target) return;
  const { sampleIdx } = opts;
  setActiveXmPreview(
    sampleIdx === undefined
      ? { instrument1Based: inst1Based, semitoneOffset }
      : { instrument1Based: inst1Based, semitoneOffset, sampleIdx },
  );
  startXmPreviewTracking(
    inst1Based,
    target.index,
    target.sample,
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
  const previewSong = buildXmPreviewSong(s, inst, xmNote, sampleIdx);
  // Audition through the same mixer settings as song playback, so a note
  // previewed from the keyboard sounds like it will in the song.
  const mixer = {
    interpolation: settings().ft2Interpolation,
    ramping: settings().ft2Ramping,
  };
  // ensureEngine lazily creates the AudioContext on first call (gated
  // behind a user gesture by the browser, which is satisfied by the
  // keydown that brought us here). Without this, the first piano
  // press before any Play action silently no-ops.
  const stops = previewStopCount();
  void ensureEngine()
    .then((eng) => {
      if (!eng) return;
      // Key released before the engine existed — see `triggerPreview`.
      if (stops !== previewStopCount()) return;
      void eng.startXmPreview(previewSong, mixer, onEnded);
    })
    .catch(() => {
      /* preview is a best-effort side-effect */
    });
}

/**
 * Push the current instrument to the in-flight preview so a workbench
 * edit (chiptune slider, chain effect param) is audible without the
 * user re-striking the piano key. The worklet swaps the instrument under
 * the sounding voice, which keeps its position — a gapless morph, like
 * PT2's. No-op when no preview is playing.
 *
 * Called from `updateCurrentXmWorkbench` so every path that commits a
 * workbench mutation — chain ops, source-kind toggle, chiptune param
 * patch, XM transformer setters — feeds through here.
 */
export function xmLivePreviewSwap(): void {
  const active = activeXmPreview();
  if (!active) return;
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
  const xmNote = xmNoteForPreviewOffset(active.semitoneOffset);
  if (xmNote < 1 || xmNote > 96) return;
  const inst = s.instruments[active.instrument1Based - 1];
  if (!inst) return;
  const target = previewTarget(inst, xmNote, active.sampleIdx);
  if (!target) return;
  // Refresh tracking against the (possibly mutated) sample so the playhead
  // honours new loop bounds and length without restarting from zero.
  updateXmPreviewTracking(target.sample);
  eng.swapXmPreviewInstrument(previewInstrument(inst, active.sampleIdx));
}
