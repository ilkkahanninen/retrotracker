import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { parseModule } from "../src/core/mod/parser";
import { Replayer } from "../src/core/audio/replayer";

/**
 * Mid-playback `replaceSampleSlot` should change what the worklet emits
 * within ~one loop period — without restarting the song. We render the
 * baseline fixture two ways (silenced from the start vs. silenced after
 * the swap point) and verify:
 *   1. The output BEFORE the swap is identical between the two renders
 *      (the swap doesn't time-travel).
 *   2. The output AFTER the swap point converges to silence in the
 *      swap-mid-playback render — proving the new sample bytes reached
 *      Paula's voice latches and the next loop wrap picked them up.
 */
describe("Replayer.replaceSampleSlot", () => {
  it("hot-swapping a sample slot changes audible output without resetting playback", () => {
    const bytes = readFileSync(
      new URL("./fixtures/00-baseline.mod", import.meta.url),
    );
    const song = parseModule(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );

    const SR = 44100;
    const TOTAL = SR; // 1s
    const SWAP_AT = SR / 4; // 250ms

    // Baseline: render the whole song untouched.
    const baseline = (() => {
      const r = new Replayer(song, { sampleRate: SR, loop: false });
      const L = new Float32Array(TOTAL);
      const R = new Float32Array(TOTAL);
      r.process(L, R, TOTAL);
      return L;
    })();

    // Swap mid-stream: at SWAP_AT, replace every populated sample slot
    // with a silent copy (data zeroed). Voices should converge to
    // silence as their next loop wrap pulls the silent buffer in.
    const swapped = (() => {
      const r = new Replayer(song, { sampleRate: SR, loop: false });
      const L = new Float32Array(TOTAL);
      const R = new Float32Array(TOTAL);
      r.process(L, R, SWAP_AT);
      for (let i = 0; i < song.samples.length; i++) {
        const s = song.samples[i]!;
        if (s.data.byteLength === 0) continue;
        const silent = new Int8Array(s.data.length); // zeroed
        r.replaceSampleSlot(i, { ...s, data: silent });
      }
      const tailL = L.subarray(SWAP_AT);
      const tailR = R.subarray(SWAP_AT);
      const restL = new Float32Array(tailL.length);
      const restR = new Float32Array(tailR.length);
      r.process(restL, restR, TOTAL - SWAP_AT);
      L.set(restL, SWAP_AT);
      R.set(restR, SWAP_AT);
      return L;
    })();

    // Pre-swap output is identical: the swap didn't perturb earlier samples.
    for (let i = 0; i < SWAP_AT; i++) {
      expect(swapped[i]).toBe(baseline[i]);
    }

    // Post-swap tail converges to ~silence. Skip a 100ms settling
    // window past SWAP_AT for any in-flight loop wraps to complete and
    // for filter RC history to drain. After that, RMS should be tiny.
    const tailStart = SWAP_AT + Math.floor(SR * 0.1);
    let sumSq = 0;
    let n = 0;
    for (let i = tailStart; i < TOTAL; i++) {
      sumSq += swapped[i]! * swapped[i]!;
      n++;
    }
    const swappedRms = Math.sqrt(sumSq / n);

    // Same window in the baseline — must be loud, otherwise the test
    // proves nothing.
    sumSq = 0;
    for (let i = tailStart; i < TOTAL; i++) {
      sumSq += baseline[i]! * baseline[i]!;
    }
    const baselineRms = Math.sqrt(sumSq / n);

    expect(baselineRms).toBeGreaterThan(0.01); // sanity
    expect(swappedRms).toBeLessThan(baselineRms * 0.05);
  });
});
