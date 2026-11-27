import { describe, expect, it } from "vitest";

import { XmReplayer } from "~/core/audio/xmReplayer";
import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import type { XmInstrument, XmSample, XmSong } from "~/core/xm/types";

/**
 * Mid-playback `replaceInstrument` is the worklet's hot-swap path for
 * FT2 sample-pipeline edits — the counterpart of
 * `Pt2Replayer.replaceSampleSlot`. It must change what a sounding voice
 * emits without restarting the song.
 */

const SR = 44100;
const TOTAL = SR / 2;
const SWAP_AT = 5000;

function loopedSample(fill: (i: number) => number, length = 256): XmSample {
  const data = new Int8Array(length);
  for (let i = 0; i < length; i++) data[i] = fill(i);
  return {
    name: "s",
    data,
    bits: 8,
    loopStart: 0,
    loopLength: length,
    loopType: "forward",
    volume: 64,
    finetune: 0,
    panning: 128,
    relativeNote: 0,
  };
}

function instrumentOf(sample: XmSample): XmInstrument {
  return { ...emptyXmInstrument(), samples: [sample] };
}

/** One looping saw on instrument 1, held from row 0 at a slow speed so
 *  the note is still sounding well past the swap point. */
function buildSong(): XmSong {
  let s = emptyXmSong();
  s = setXmInstrument(s, 0, instrumentOf(loopedSample((i) => i - 128)));
  s = setXmInstrument(s, 1, instrumentOf(loopedSample((i) => i - 128)));
  s = setXmCell(s, 0, 0, 0, { note: 49, instrument: 1 });
  return { ...s, defaultTempo: 31 };
}

function peak(buf: Float32Array, from: number, to: number): number {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(buf[i]!));
  return p;
}

/** Render TOTAL frames, running `swap` once SWAP_AT frames are out. */
function render(swap?: (r: XmReplayer) => void): Float32Array {
  const r = new XmReplayer(buildSong(), { sampleRate: SR, loop: false });
  const L = new Float32Array(TOTAL);
  const R = new Float32Array(TOTAL);
  r.process(L, R, SWAP_AT);
  swap?.(r);
  r.process(L, R, TOTAL - SWAP_AT, SWAP_AT);
  return L;
}

describe("XmReplayer.replaceInstrument", () => {
  const silent = instrumentOf(loopedSample(() => 0));

  it("re-points a sounding voice at the new sample data", () => {
    const baseline = render();
    const swapped = render((r) => r.replaceInstrument(0, silent));
    // Nothing before the swap moves.
    expect(Array.from(swapped.subarray(0, SWAP_AT))).toEqual(
      Array.from(baseline.subarray(0, SWAP_AT)),
    );
    // The note is still held in the baseline, and silent after the swap
    // (past the mixer's short gain ramp).
    const settle = SWAP_AT + 2048;
    expect(peak(baseline, settle, TOTAL)).toBeGreaterThan(0.05);
    expect(peak(swapped, settle, TOTAL)).toBe(0);
  });

  it("leaves voices playing other instruments alone", () => {
    const baseline = render();
    const swapped = render((r) => r.replaceInstrument(1, silent));
    expect(Array.from(swapped)).toEqual(Array.from(baseline));
  });

  it("keeps the old data when the replacement has no such sample", () => {
    const baseline = render();
    const empty: XmInstrument = { ...emptyXmInstrument(), samples: [] };
    const swapped = render((r) => r.replaceInstrument(0, empty));
    expect(Array.from(swapped)).toEqual(Array.from(baseline));
  });

  it("survives a replacement shorter than the voice's read position", () => {
    const short = instrumentOf(loopedSample((i) => (i % 2 ? 64 : -64), 4));
    const swapped = render((r) => r.replaceInstrument(0, short));
    expect(swapped.every((v) => Number.isFinite(v))).toBe(true);
    expect(peak(swapped, SWAP_AT + 2048, TOTAL)).toBeGreaterThan(0.05);
  });

  it("ignores an index outside the instrument list", () => {
    const baseline = render();
    const swapped = render((r) => {
      r.replaceInstrument(-1, silent);
      r.replaceInstrument(64, silent);
    });
    expect(Array.from(swapped)).toEqual(Array.from(baseline));
  });

  it("is what the next note trigger reads", () => {
    // Channel 2 triggers instrument 2 on row 1; silence it before playing.
    const withSecondNote = setXmCell(buildSong(), 0, 1, 1, {
      note: 49,
      instrument: 2,
    });
    const renderSong = (song: XmSong, prepare?: (r: XmReplayer) => void) => {
      const r = new XmReplayer(
        { ...song, defaultTempo: 6 },
        { sampleRate: SR, loop: false },
      );
      prepare?.(r);
      const L = new Float32Array(TOTAL);
      r.process(L, new Float32Array(TOTAL), TOTAL);
      return L;
    };
    const oneNote = renderSong(buildSong());
    const twoNotes = renderSong(withSecondNote);
    const silenced = renderSong(withSecondNote, (r) =>
      r.replaceInstrument(1, silent),
    );
    expect(Array.from(twoNotes)).not.toEqual(Array.from(oneNote));
    expect(Array.from(silenced)).toEqual(Array.from(oneNote));
  });
});
