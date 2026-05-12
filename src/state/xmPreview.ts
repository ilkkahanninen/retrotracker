/**
 * FT2-mode note preview. Runs `XmReplayer` on the main thread with a
 * synthetic single-channel song that triggers the current instrument
 * at the requested note. The rendered PCM goes to the engine's
 * AudioBufferSourceNode path so the full XM voice model — volume +
 * panning envelopes, autovibrato, fadeout, ping-pong loop, finetune,
 * 16-bit samples, relative-note offset — all sound correct in the
 * audition.
 *
 * Trade-off vs. live-morphing PT2 preview: the audio is fixed at
 * trigger time. Slider edits on the instrument while a preview key is
 * held won't re-render — the user re-strikes the key to hear the new
 * settings. Acceptable for an audition workflow.
 */

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
import { ensureEngine } from "./playback";
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
 * buffers. Pure synchronous main-thread work — at 44.1 kHz × 4 s a
 * single render is ~6 ms on a modern laptop, comfortably under one
 * frame even on slower hardware.
 */
function renderPreviewBuffer(previewSong: XmSong): {
  left: Float32Array;
  right: Float32Array;
} {
  const replayer = new XmReplayer(previewSong, {
    sampleRate: PREVIEW_SAMPLE_RATE,
    loop: false,
  });
  const frames = PREVIEW_SECONDS * PREVIEW_SAMPLE_RATE;
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
  const xmNote = (currentXmOctave() - 1) * 12 + semitoneOffset + 1;
  if (xmNote < 1 || xmNote > 96) return;
  const inst = s.instruments[currentXmInstrument() - 1];
  if (!inst) return;
  if (inst.samples.length === 0) return;
  const mapIdx = inst.keyMap[xmNote - 1] ?? 0;
  const sample = inst.samples[mapIdx] ?? inst.samples[0];
  if (!sample || sample.data.length === 0) return;
  // Render synchronously so the audio is ready by the time the engine
  // promise resolves; the lazy AudioContext creation can take a frame
  // on first use after a user gesture, but the render itself doesn't
  // need to wait for it.
  const previewSong = buildPreviewSong(s, currentXmInstrument(), xmNote);
  const { left, right } = renderPreviewBuffer(previewSong);
  // ensureEngine lazily creates the AudioContext on first call (gated
  // behind a user gesture by the browser, which is satisfied by the
  // keydown that brought us here). Without this, the first piano
  // press before any Play action silently no-ops.
  void ensureEngine()
    .then((eng) => {
      if (eng) void eng.playXmPreviewBuffer(left, right, PREVIEW_SAMPLE_RATE);
    })
    .catch(() => {
      /* preview is a best-effort side-effect */
    });
}
