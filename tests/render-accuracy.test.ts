/**
 * Accuracy test bed: render fixtures and compare against pt2-clone reference WAVs.
 *
 * For each `tests/fixtures/<name>.mod`:
 *   - If `<name>.reference.wav` is missing, render it via vendor/bin/pt2-render
 *     (auto-building the binary if needed)
 *   - Parse the .mod
 *   - Run our offline renderer at the reference WAV's sample rate
 *   - Compare channel-for-channel using `compareChannels`
 *   - Fail if RMS / peak difference exceeds the tolerance
 *
 * Reference WAVs are deterministic and gitignored — every dev rebuilds them
 * locally on first run.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { parseModule } from "../src/core/mod/parser";
import { renderToBuffer } from "../src/core/audio/offlineRender";
import { readWav } from "../src/core/audio/wav";
import { compareChannels } from "./lib/compare";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const RENDER_BIN = join(ROOT_DIR, "vendor/bin/pt2-render");
const BUILD_SH = join(ROOT_DIR, "vendor/build-pt2-clone.sh");

const RMS_TOLERANCE = 0.005;
const PEAK_TOLERANCE = 0.05;

interface FixtureCase {
  name: string;
  modPath: string;
  wavPath: string;
}

function discoverFixtures(): FixtureCase[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  const cases: FixtureCase[] = [];
  for (const file of readdirSync(FIXTURES_DIR)) {
    if (!file.endsWith(".mod")) continue;
    const name = basename(file, ".mod");
    cases.push({
      name,
      modPath: join(FIXTURES_DIR, file),
      wavPath: join(FIXTURES_DIR, `${name}.reference.wav`),
    });
  }
  return cases;
}

function ensureRenderBinary(): void {
  if (existsSync(RENDER_BIN)) return;
  console.log(
    "[accuracy] vendor/bin/pt2-render not built — running build script (one-time, ~1s)",
  );
  execFileSync("bash", [BUILD_SH], { stdio: "inherit" });
  if (!existsSync(RENDER_BIN)) {
    throw new Error(`build script ran but ${RENDER_BIN} still missing`);
  }
}

function ensureReferenceWav(fx: FixtureCase): void {
  if (existsSync(fx.wavPath)) return;
  console.log(`[accuracy] rendering ${basename(fx.wavPath)}`);
  execFileSync(RENDER_BIN, [fx.modPath, fx.wavPath, "--rate=44100"], {
    stdio: "inherit",
  });
}

const fixtures = discoverFixtures();

describe("replayer accuracy vs pt2-clone", () => {
  if (fixtures.length === 0) {
    it.skip("no .mod fixtures in tests/fixtures/", () => {});
    return;
  }

  beforeAll(() => {
    ensureRenderBinary();
    for (const fx of fixtures) ensureReferenceWav(fx);
  });

  for (const fx of fixtures) {
    it(`${fx.name}.mod matches reference`, () => {
      const mod = parseModule(readFileSync(fx.modPath));
      const ref = readWav(readFileSync(fx.wavPath));
      if (ref.channels.length !== 2) {
        throw new Error(`Reference WAV must be stereo: ${fx.wavPath}`);
      }
      const refSeconds = ref.channels[0]!.length / ref.sampleRate;

      const rendered = renderToBuffer(mod, {
        sampleRate: ref.sampleRate,
        maxSeconds: refSeconds,
        stopOnSongEnd: false,
      });

      const result = compareChannels(
        [rendered.left, rendered.right],
        ref.channels,
      );
      for (const rms of result.rmsDiff) expect(rms).toBeLessThan(RMS_TOLERANCE);
      for (const peak of result.peakDiff)
        expect(peak).toBeLessThan(PEAK_TOLERANCE);
    });
  }
});
