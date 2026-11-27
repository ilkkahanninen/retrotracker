import { describe, expect, it } from "vitest";

import {
  XmPreviewVoice,
  buildXmPreviewSong,
} from "~/core/audio/xmPreviewVoice";
import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import type { XmInstrument, XmSample } from "~/core/xm/types";

/**
 * The FT2 note audition is a live voice: a replayer on a one-note song,
 * run by the preview worklet for as long as the key is held. It used to
 * be a 4-second pre-rendered buffer, so a held looped note went silent.
 */

const SR = 44100;
const OPTS = { interpolation: "linear", ramping: true } as const;

function sampleOf(
  fill: (i: number) => number,
  length: number,
  looped: boolean,
): XmSample {
  const data = new Int8Array(length);
  for (let i = 0; i < length; i++) data[i] = fill(i);
  return {
    ...emptyXmInstrument().samples[0]!,
    data,
    bits: 8,
    volume: 64,
    loopStart: 0,
    loopLength: looped ? length : 0,
    loopType: looped ? "forward" : "none",
  };
}

const instrumentOf = (...samples: XmSample[]): XmInstrument => ({
  ...emptyXmInstrument(),
  samples,
});

const saw = (i: number) => (i % 64) * 2 - 64;

/** Run the voice for `seconds`, in worklet-sized quanta. Returns the left
 *  channel and the frame at which the voice reported it had ended. */
function run(
  voice: XmPreviewVoice,
  seconds: number,
  at?: { frame: number; act: () => void },
): { left: Float32Array; endedAt: number | null } {
  const total = Math.floor(seconds * SR);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  let endedAt: number | null = null;
  let acted = false;
  for (let pos = 0; pos < total; pos += 128) {
    if (at && !acted && pos >= at.frame) {
      at.act();
      acted = true;
    }
    const frames = Math.min(128, total - pos);
    if (voice.process(left, right, frames, pos) && endedAt === null) {
      endedAt = pos;
    }
  }
  return { left, endedAt };
}

function peak(buf: Float32Array, from: number, to: number): number {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(buf[i]!));
  return p;
}

function start(inst: XmInstrument, sampleIdx?: number): XmPreviewVoice {
  const voice = new XmPreviewVoice(SR);
  voice.start(buildXmPreviewSong(emptyXmSong(), inst, 49, sampleIdx), OPTS);
  return voice;
}

describe("XmPreviewVoice", () => {
  it("a looped sample is still sounding long after 4 seconds", () => {
    const { left, endedAt } = run(
      start(instrumentOf(sampleOf(saw, 64, true))),
      12,
    );
    expect(endedAt).toBeNull();
    // Every second of the twelve is audible, the last included.
    for (let sec = 0; sec < 12; sec++) {
      expect(peak(left, sec * SR, (sec + 1) * SR)).toBeGreaterThan(0.05);
    }
  });

  it("the note is triggered once — the song never comes back round to it", () => {
    // A long one-shot: a retrigger would start it again from the top.
    // 2000 frames at C-4 (8363 Hz) last ~0.24 s; nothing may sound after.
    const { left, endedAt } = run(
      start(instrumentOf(sampleOf(() => 100, 2000, false))),
      12,
    );
    expect(endedAt).not.toBeNull();
    expect(endedAt! / SR).toBeLessThan(0.5);
    expect(peak(left, SR, 12 * SR)).toBe(0);
  });

  it("reports the end of a one-shot once and then stays unloaded", () => {
    const voice = start(instrumentOf(sampleOf(() => 100, 2000, false)));
    expect(voice.active).toBe(true);
    const { endedAt } = run(voice, 1);
    expect(endedAt).not.toBeNull();
    expect(voice.active).toBe(false);
    expect(run(voice, 0.1).endedAt).toBeNull();
  });

  it("a note that can't trigger ends at once instead of hanging", () => {
    const voice = start(instrumentOf(sampleOf(() => 0, 0, false)));
    expect(run(voice, 0.1).endedAt).toBe(0);
  });

  it("swapInstrument morphs the held note without restarting it", () => {
    const loud = instrumentOf(sampleOf(saw, 64, true));
    const silent = instrumentOf(sampleOf(() => 0, 64, true));
    const voice = start(loud);
    const swapAt = SR;
    const { left, endedAt } = run(voice, 3, {
      frame: swapAt,
      act: () => voice.swapInstrument(silent),
    });
    expect(peak(left, 0, swapAt)).toBeGreaterThan(0.05);
    expect(peak(left, swapAt + 4096, 3 * SR)).toBe(0);
    // Still the same held note: silent data, but not ended.
    expect(endedAt).toBeNull();
    expect(voice.active).toBe(true);
  });

  it("stop silences the voice immediately", () => {
    const voice = start(instrumentOf(sampleOf(saw, 64, true)));
    const { left } = run(voice, 1, { frame: 22016, act: () => voice.stop() });
    expect(peak(left, 0, 22016)).toBeGreaterThan(0.05);
    expect(peak(left, 22016, SR)).toBe(0);
    expect(voice.active).toBe(false);
  });

  it("overwrites the output buffers, also when nothing is loaded", () => {
    const voice = new XmPreviewVoice(SR);
    const left = new Float32Array(128).fill(0.5);
    const right = new Float32Array(128).fill(0.5);
    expect(voice.process(left, right, 128)).toBe(false);
    expect(peak(left, 0, 128)).toBe(0);
    expect(peak(right, 0, 128)).toBe(0);
  });
});

describe("buildXmPreviewSong", () => {
  const two = instrumentOf(
    sampleOf(() => 0, 64, true),
    sampleOf(saw, 64, true),
  );

  it("plays the key map's sample by default", () => {
    // Default key map → sample 0, which is silent here.
    const { left } = run(start(two), 0.5);
    expect(peak(left, 0, left.length)).toBe(0);
  });

  it("pinned to a sample, every key plays that one", () => {
    const { left } = run(start(two, 1), 0.5);
    expect(peak(left, 0, left.length)).toBeGreaterThan(0.05);
  });

  it("carries only the auditioned instrument and leaves it untouched", () => {
    const song = buildXmPreviewSong(emptyXmSong(), two, 49, 1);
    expect(song.instruments).toHaveLength(1);
    expect(song.instruments[0]!.samples).toBe(two.samples);
    // The source instrument's own key map is not modified.
    expect(Array.from(new Set(two.keyMap))).toEqual([0]);
    expect(buildXmPreviewSong(emptyXmSong(), two, 49).instruments[0]).toBe(two);
  });
});
