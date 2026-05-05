import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parseModule } from "../src/core/mod/parser";

const FIXTURES_DIR = new URL("./fixtures/", import.meta.url).pathname;

const expected = [
  "00-baseline",
  "01-resampling",
  "02-amiga-filter",
  "03-vibrato-waveforms",
  "04-tremolo-waveforms",
  "05-glissando",
  "06-panning",
  "07-invert-loop",
  "08-arpeggio",
  "09-slide-up",
  "10-slide-down",
  "11-tone-porta-vol-slide",
  "12-vibrato-vol-slide",
  "13-sample-offset",
  "14-volume-slide",
  "15-position-jump",
  "16-set-volume",
  "17-pattern-break",
  "18-set-speed",
  "19-fine-slide-up",
  "20-fine-slide-down",
  "21-set-finetune",
  "22-pattern-loop",
  "23-retrigger",
  "24-fine-vol-up",
  "25-fine-vol-down",
  "26-note-cut",
  "27-note-delay",
  "28-pattern-delay",
];

describe("generated fixtures", () => {
  it("all expected fixtures are present on disk", () => {
    const present = readdirSync(FIXTURES_DIR)
      .filter((f) => f.endsWith(".mod"))
      .map((f) => basename(f, ".mod"))
      .sort();
    expect(present).toEqual(expected);
  });

  for (const name of expected) {
    it(`${name}.mod parses as a valid M.K. module`, () => {
      const path = join(FIXTURES_DIR, `${name}.mod`);
      expect(existsSync(path)).toBe(true);
      const mod = parseModule(readFileSync(path));
      expect(mod.signature).toBe("M.K.");
      expect(mod.samples).toHaveLength(31);
      expect(mod.orders).toHaveLength(128);
      expect(mod.songLength).toBeGreaterThan(0);
      expect(mod.patterns.length).toBeGreaterThan(0);
    });
  }
});
