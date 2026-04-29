/**
 * Accuracy test bed: render fixtures and compare against pt2-clone reference WAVs.
 *
 * For each `tests/fixtures/<name>.mod` with a sibling `<name>.reference.wav`:
 *   - Parse the .mod
 *   - Run our offline renderer at the reference WAV's sample rate
 *   - Compare channel-for-channel using `compareChannels`
 *   - Fail if RMS difference exceeds the per-fixture tolerance
 *
 * The replayer is currently a stub (silence), so this suite is expected to
 * fail once fixtures are in place. That failure is the contract: it tracks
 * progress as the replayer is implemented.
 *
 * See tests/fixtures/README.md for how to generate reference WAVs.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseModule } from '../src/core/mod/parser';
import { renderToBuffer } from '../src/core/audio/offlineRender';
import { readWav } from './lib/wav';
import { compareChannels } from './lib/compare';

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url).pathname;

interface FixtureCase {
  name: string;
  modPath: string;
  wavPath: string;
}

function discoverFixtures(): FixtureCase[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  const entries = readdirSync(FIXTURES_DIR);
  const cases: FixtureCase[] = [];
  for (const file of entries) {
    if (!file.endsWith('.mod')) continue;
    const name = basename(file, '.mod');
    const wavPath = join(FIXTURES_DIR, `${name}.reference.wav`);
    if (existsSync(wavPath)) {
      cases.push({ name, modPath: join(FIXTURES_DIR, file), wavPath });
    }
  }
  return cases;
}

const fixtures = discoverFixtures();

describe('replayer accuracy vs pt2-clone', () => {
  if (fixtures.length === 0) {
    it.skip('no fixtures present — see tests/fixtures/README.md', () => {});
    return;
  }

  // Tolerances are deliberately tight — loosen per-fixture only with a comment.
  const RMS_TOLERANCE = 0.005;
  const PEAK_TOLERANCE = 0.05;

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

      const result = compareChannels([rendered.left, rendered.right], ref.channels);
      for (const rms of result.rmsDiff) expect(rms).toBeLessThan(RMS_TOLERANCE);
      for (const peak of result.peakDiff) expect(peak).toBeLessThan(PEAK_TOLERANCE);
    });
  }
});
