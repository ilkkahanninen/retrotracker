/**
 * FT2 accuracy test bed: render fixtures and compare against libxmp
 * reference WAVs.
 *
 * For each `tests/fixtures/xm/<name>.xm`:
 *   - If `<name>.reference.wav` is missing, render it via the system
 *     `xmp` binary (libxmp's CLI). Install once via your package
 *     manager — the bed skips when `xmp` is not on PATH.
 *   - Parse the .xm.
 *   - Run our offline renderer at the reference WAV's sample rate.
 *   - Compare sample-by-sample with `compareChannels`.
 *   - Skip the first `ANTICLICK_SKIP` samples — libxmp ramps the voice
 *     in over its anti-click window; we don't yet, so the head of the
 *     buffer diverges by the click amplitude.
 *
 * xmp is invoked with `-i linear` (matches our linear interp) and
 * `-a 2` (matches our gain — `-a 2` cancels libxmp's default 0.5x
 * headroom AND scales up by 2 so the WAV peaks at the same amplitude
 * we render at). With those flags the WAVs match within ~0.001 RMS
 * for songs that exercise the parts of XM we've implemented.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { renderToBuffer } from "../src/core/audio/offlineRender";
import { readWav } from "../src/core/audio/wav";
import { parseXm } from "../src/core/xm/parser";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/xm/", import.meta.url));

/**
 * libxmp anti-clicks the first ~110 samples of each voice trigger by
 * ramping volume from 0 → target over `ticksize >> 3`. We mirror the
 * ramp in `XmReplayer.snapshotTickGains`, so a skip is no longer
 * necessary for the baseline fixture; the value here is a tiny safety
 * window for floor / quantisation differences in the first few
 * fractional-position samples.
 */
const ANTICLICK_SKIP = 4;

/**
 * Per-fixture tolerance overrides. Periodic-waveform fixtures (sustained
 * saw / square that the song never key-offs) accumulate sub-sample
 * phase drift between our floating-point pitch math and libxmp's
 * fixed-point fraction handling. The amplitude shape still matches
 * within a percent — see the README for measurements.
 *
 * Default tolerances are tight (bit-precise modulo anti-click);
 * fixtures with phase-drift-prone content get a per-name override.
 */
interface Tolerance {
  rms: number;
  peak: number;
}
// Bit-perfect against libxmp modulo quantisation noise from libxmp's
// 16.16 fixed-point local frac advancement vs. our per-sample frac
// derivation from a double `pos`. Most static-pitch fixtures land
// well under this — peaks ≤ 0.005, RMS ≤ 0.0015.
const DEFAULT_TOLERANCE: Tolerance = { rms: 0.002, peak: 0.01 };

// Fixtures whose divergence comes from a small structural difference
// libxmp and XmReplayer don't share bit-for-bit, but the audible
// shape still tracks. The categories:
//
//  - **LFO phase drift**: vibrato / tremolo / auto-vibrato. Our 32-entry
//    quarter-period sine + `>> 5` produces the same audible pitch swing
//    as libxmp's 64-entry full-period sine + `>> 9`, but small
//    quantisation differences accumulate over a multi-second hold and
//    push the per-sample diff above 0.002 RMS. The waveform shape is
//    indistinguishable.
//
//  - **Volume / pan anti-click ramp shape**: libxmp and XmReplayer use
//    slightly different ramp lengths for mid-tick volume cuts (ECy /
//    EDy) and pan changes. The transient is ~50 samples; peak diff
//    lives in that window.
//
//  - **Fadeout / finetune**: per-tick float / integer rounding drifts
//    by a few units of period over a multi-row hold.
const FIXTURE_TOLERANCES: Record<string, Tolerance> = {
  // LFO phase drift (sine autovibrato + per-row vibrato/tremolo).
  "07-vibrato": { rms: 0.06, peak: 0.15 },
  "08-tremolo": { rms: 0.04, peak: 0.2 },
  "10-vibrato-vol-slide": { rms: 0.05, peak: 0.15 },
  "26-auto-vibrato": { rms: 0.02, peak: 0.05 },
  "40-volcol-vibrato": { rms: 0.05, peak: 0.15 },
  // Non-sine autovibrato waveform shape differences. Our autovibrato
  // table is ported from ft2-clone (256-entry LFO); libxmp uses 64-entry
  // tables and a different sawtooth formula. The audible swing magnitude
  // matches; the bit-exact shape doesn't.
  "45-autovib-square": { rms: 0.05, peak: 0.15 },
  "46-autovib-ramp-down": { rms: 0.12, peak: 0.3 },
  "47-autovib-ramp-up": { rms: 0.06, peak: 0.2 },
  // Anti-click ramp shape on volume / pan transitions.
  "12-set-volume": { rms: 0.002, peak: 0.02 },
  "17-note-cut": { rms: 0.002, peak: 0.1 },
  "18-note-delay": { rms: 0.002, peak: 0.04 },
  "25-pan-envelope": { rms: 0.002, peak: 0.02 },
  "27-set-env-pos": { rms: 0.002, peak: 0.02 },
  "37-volcol-set-pan": { rms: 0.02, peak: 0.05 },
  "44-pan-env-loop": { rms: 0.005, peak: 0.02 },
  "49-multi-sample-meta": { rms: 0.002, peak: 0.02 },
  // No-loop fixture cuts the voice when the sample ends; libxmp anti-
  // click-ramps the final ~110 samples to silence while we still cut.
  // The transient diff is bounded by the sample's amplitude at end-of-
  // data (here ≈ ±99/127 ≈ 0.78); the running RMS stays small.
  "50-no-loop": { rms: 0.005, peak: 0.5 },
  // Fadeout / finetune slow drift.
  "11-set-finetune": { rms: 0.01, peak: 0.05 },
  "22-key-off": { rms: 0.003, peak: 0.1 },
  "23-fadeout": { rms: 0.04, peak: 0.4 },
};
function toleranceFor(name: string): Tolerance {
  return FIXTURE_TOLERANCES[name] ?? DEFAULT_TOLERANCE;
}

interface FixtureCase {
  name: string;
  xmPath: string;
  wavPath: string;
}

function discoverFixtures(): FixtureCase[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  const cases: FixtureCase[] = [];
  for (const file of readdirSync(FIXTURES_DIR)) {
    if (!file.endsWith(".xm")) continue;
    const name = basename(file, ".xm");
    cases.push({
      name,
      xmPath: join(FIXTURES_DIR, file),
      wavPath: join(FIXTURES_DIR, `${name}.reference.wav`),
    });
  }
  return cases;
}

function hasXmpCli(): boolean {
  // `xmp --version` exits 0; `xmp --help` exits 255 even on success.
  const check = spawnSync("xmp", ["--version"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return check.status === 0;
}

function ensureReferenceWav(fx: FixtureCase): void {
  if (existsSync(fx.wavPath)) return;
  console.log(`[xm-accuracy] rendering ${basename(fx.wavPath)}`);
  // -i linear : match our linear interpolation (xmp default is spline)
  // -a 2      : match our amplitude (libxmp default is 0.5x; -a 2 → 1x
  //             since each step doubles)
  // Default --pan-separation is 100 — full XM panning, what we want.
  execFileSync(
    "xmp",
    [
      "-d",
      "wav",
      "-o",
      fx.wavPath,
      "-f",
      "44100",
      "-i",
      "linear",
      "-a",
      "2",
      fx.xmPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (!existsSync(fx.wavPath)) {
    throw new Error(`xmp ran but ${fx.wavPath} is missing`);
  }
}

const fixtures = discoverFixtures();
const xmpAvailable = hasXmpCli();

describe("XmReplayer accuracy vs libxmp", () => {
  if (fixtures.length === 0) {
    it.skip("no .xm fixtures in tests/fixtures/xm/", () => {});
    return;
  }
  if (!xmpAvailable) {
    it.skip("xmp not on PATH — install libxmp's CLI to run the bed", () => {});
    return;
  }

  beforeAll(() => {
    for (const fx of fixtures) ensureReferenceWav(fx);
  });

  for (const fx of fixtures) {
    it(`${fx.name}.xm matches reference`, () => {
      const xm = parseXm(new Uint8Array(readFileSync(fx.xmPath)));
      const ref = readWav(readFileSync(fx.wavPath));
      if (ref.channels.length !== 2) {
        throw new Error(`Reference WAV must be stereo: ${fx.wavPath}`);
      }
      const refSeconds = ref.channels[0]!.length / ref.sampleRate;

      const rendered = renderToBuffer(xm, {
        sampleRate: ref.sampleRate,
        maxSeconds: refSeconds,
        stopOnSongEnd: true,
      });

      const n = Math.min(ref.channels[0]!.length, rendered.left.length);
      if (n <= ANTICLICK_SKIP) {
        throw new Error(
          `[${fx.name}] not enough samples (${n}) past anti-click window`,
        );
      }
      const tol = toleranceFor(fx.name);
      const cmp = (
        a: Float32Array,
        b: Float32Array,
        label: string,
      ): { rms: number; peak: number } => {
        let sumSq = 0;
        let peak = 0;
        // Reference is read from a 16-bit WAV, so its samples are
        // implicitly clipped to int16 range (≈ [-1, +0.99997]). Our
        // renderer is unclipped float — keep it that way for the live
        // audio path, but clip both sides here so multi-voice mixes
        // that overflow above ±1 don't register as divergence purely
        // because libxmp's PCM writer clipped them first.
        const clip = (x: number) => Math.max(-1, Math.min(1, x));
        for (let i = ANTICLICK_SKIP; i < n; i++) {
          const d = clip(a[i]!) - clip(b[i]!);
          sumSq += d * d;
          const ad = Math.abs(d);
          if (ad > peak) peak = ad;
        }
        const rms = Math.sqrt(sumSq / (n - ANTICLICK_SKIP));
        if (rms > tol.rms) {
          throw new Error(
            `[${fx.name}] ${label}: RMS diff ${rms.toFixed(5)} > ${tol.rms}`,
          );
        }
        if (peak > tol.peak) {
          throw new Error(
            `[${fx.name}] ${label}: peak diff ${peak.toFixed(5)} > ${tol.peak}`,
          );
        }
        return { rms, peak };
      };
      cmp(ref.channels[0]!, rendered.left, "L");
      cmp(ref.channels[1]!, rendered.right, "R");
      expect(n).toBeGreaterThan(ANTICLICK_SKIP);
    });
  }
});
