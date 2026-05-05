/**
 * CLI: render a .mod to a .wav offline using our replayer.
 *
 * Usage:
 *   npm run render -- input.mod output.wav [--seconds=N] [--rate=44100]
 *
 * Useful for ear-checking the replayer alongside pt2-clone output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { argv } from "node:process";
import { parseModule } from "../../src/core/mod/parser";
import { renderToBuffer } from "../../src/core/audio/offlineRender";
import { writeWav } from "../../src/core/audio/wav";

function parseArg(name: string, fallback: number): number {
  const flag = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(flag));
  return hit ? Number(hit.slice(flag.length)) : fallback;
}

function main(): void {
  const positional = argv.slice(2).filter((a) => !a.startsWith("--"));
  const [input, output] = positional;
  if (!input || !output) {
    console.error(
      "Usage: npm run render -- input.mod output.wav [--seconds=N] [--rate=44100]",
    );
    process.exit(1);
  }
  const seconds = parseArg("seconds", 60);
  const rate = parseArg("rate", 44100);

  const mod = parseModule(readFileSync(input));
  const audio = renderToBuffer(mod, { sampleRate: rate, maxSeconds: seconds });
  const wav = writeWav({
    sampleRate: rate,
    channels: [audio.left, audio.right],
  });
  writeFileSync(output, wav);
  console.log(`wrote ${output} (${audio.left.length} frames @ ${rate} Hz)`);
}

main();
