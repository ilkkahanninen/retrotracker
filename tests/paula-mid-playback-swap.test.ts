import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { parseModule } from "../src/core/mod/parser";
import { Replayer } from "../src/core/audio/replayer";

/**
 * Mid-playback Amiga-model swap should immediately retune the filters.
 * We render the same fixture three ways:
 *   1. A1200 throughout
 *   2. A500 throughout
 *   3. A1200 for the first chunk, then setAmigaModel('A500') and continue
 * The tail of (3) (after a brief filter-state settling window) should be
 * far closer to the corresponding tail of (2) than to (1) — proving the
 * swap actually took effect mid-stream.
 */
describe("Paula mid-playback model swap", () => {
  it("output tail after swap matches the target model, not the original", () => {
    const bytes = readFileSync(
      new URL("./fixtures/00-baseline.mod", import.meta.url),
    );
    const song = parseModule(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );

    const SR = 44100;
    const TOTAL = SR * 2; // 2s
    const SWAP_AT = SR / 4; // 250ms — past initial DMA priming

    function render(
      initial: "A1200" | "A500",
      swapTo: "A1200" | "A500" | null,
    ): Float32Array {
      const r = new Replayer(song, {
        sampleRate: SR,
        loop: false,
        amigaModel: initial,
      });
      const L = new Float32Array(TOTAL);
      const R = new Float32Array(TOTAL);
      if (swapTo === null) {
        r.process(L, R, TOTAL);
      } else {
        r.process(L, R, SWAP_AT);
        r.setAmigaModel(swapTo);
        const tmpL = L.subarray(SWAP_AT);
        const tmpR = R.subarray(SWAP_AT);
        const restL = new Float32Array(tmpL.length);
        const restR = new Float32Array(tmpR.length);
        r.process(restL, restR, TOTAL - SWAP_AT);
        L.set(restL, SWAP_AT);
        R.set(restR, SWAP_AT);
      }
      return L;
    }

    const a1200 = render("A1200", null);
    const a500 = render("A500", null);
    const swapped = render("A1200", "A500");

    // Compare tails (skip a 50ms settling window past the swap point so
    // the filter's RC history converges between the two streams).
    const tailStart = SWAP_AT + Math.floor(SR * 0.05);
    let rmsToA500 = 0;
    let rmsToA1200 = 0;
    let n = 0;
    for (let i = tailStart; i < TOTAL; i++) {
      const a = swapped[i]!;
      const dA500 = a - a500[i]!;
      const dA1200 = a - a1200[i]!;
      rmsToA500 += dA500 * dA500;
      rmsToA1200 += dA1200 * dA1200;
      n++;
    }
    rmsToA500 = Math.sqrt(rmsToA500 / n);
    rmsToA1200 = Math.sqrt(rmsToA1200 / n);
    console.log(
      `swapped→A500 RMS=${rmsToA500.toFixed(5)}  swapped→A1200 RMS=${rmsToA1200.toFixed(5)}`,
    );
    expect(rmsToA500).toBeLessThan(rmsToA1200 * 0.2);
  });
});
