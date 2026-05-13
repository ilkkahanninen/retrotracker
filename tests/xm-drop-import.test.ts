import { beforeEach, describe, expect, it } from "vitest";

import { writeWav, type WavData } from "../src/core/audio/wav";
import { emptyXmInstrument, emptyXmSong } from "../src/core/xm/format";
import {
  clearHistory,
  setSong,
  setTransport,
  xm2Song,
} from "../src/state/song";
import {
  currentXmInstrument,
  currentXmSampleIndex,
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "../src/state/xmEdit";
import {
  dropWavsToXmInstrumentView,
  dropWavsToXmPatternView,
} from "../src/state/dropImport";

/** Build a one-second mono 16-bit WAV with a single non-silent frame so
 *  the importer sees real data. The actual contents don't matter for
 *  these tests — we just verify the drop pipeline creates samples. */
function makeWavFile(name: string, frames = 64): File {
  const channel = new Float32Array(frames);
  for (let i = 0; i < frames; i++) channel[i] = (i / frames) * 0.5;
  const wav: WavData = { sampleRate: 44100, channels: [channel] };
  const bytes = writeWav(wav);
  // BlobPart expects an ArrayBuffer-backed view; cast through unknown
  // to satisfy the SharedArrayBuffer-aware Uint8Array typing.
  return new File([bytes as unknown as BlobPart], name, {
    type: "audio/wav",
  });
}

function seedEmptySong(): void {
  setSong(emptyXmSong());
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
  clearHistory();
}

function seedPopulatedSlot1(): void {
  const s = emptyXmSong();
  const inst = emptyXmInstrument();
  inst.name = "preexisting";
  inst.samples[0]!.name = "existing-sample";
  inst.samples[0]!.data = new Int8Array([1, 2, 3, 4]);
  s.instruments = [inst];
  setSong(s);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
  clearHistory();
}

beforeEach(() => {
  setSong(null);
  clearHistory();
});

describe("dropWavsToXmInstrumentView", () => {
  it("single WAV onto an empty slot creates a new instrument with one sample", async () => {
    seedEmptySong();
    await dropWavsToXmInstrumentView([makeWavFile("kick.wav")]);
    const inst = xm2Song()!.instruments[0]!;
    expect(inst.samples.length).toBe(1);
    expect(inst.samples[0]!.name).toBe("kick");
    expect(inst.samples[0]!.data.length).toBeGreaterThan(0);
    // Instrument name follows the dropped file.
    expect(inst.name).toBe("kick");
    // Active sample lands on index 0.
    expect(currentXmSampleIndex()).toBe(0);
  });

  it("multi-WAV drop onto an empty slot creates a multi-sample instrument", async () => {
    seedEmptySong();
    await dropWavsToXmInstrumentView([
      makeWavFile("a.wav"),
      makeWavFile("b.wav"),
      makeWavFile("c.wav"),
    ]);
    const inst = xm2Song()!.instruments[0]!;
    expect(inst.samples.length).toBe(3);
    expect(inst.samples.map((s) => s.name)).toEqual(["a", "b", "c"]);
    // KeyMap stays all-zeros so all notes play sample 0 — the user
    // paints custom routing in the keymap editor.
    expect(Array.from(inst.keyMap).every((v) => v === 0)).toBe(true);
  });

  it("dropping WAVs onto a populated slot appends samples to the existing instrument", async () => {
    seedPopulatedSlot1();
    await dropWavsToXmInstrumentView([
      makeWavFile("extra-a.wav"),
      makeWavFile("extra-b.wav"),
    ]);
    const inst = xm2Song()!.instruments[0]!;
    expect(inst.samples.length).toBe(3);
    // First sample is the preexisting one.
    expect(inst.samples[0]!.name).toBe("existing-sample");
    expect(Array.from(inst.samples[0]!.data)).toEqual([1, 2, 3, 4]);
    // Appended samples carry the dropped WAV names.
    expect(inst.samples[1]!.name).toBe("extra-a");
    expect(inst.samples[2]!.name).toBe("extra-b");
    // Active sample switches to the first appended sample.
    expect(currentXmSampleIndex()).toBe(1);
  });

  it("dropping more than 16 WAVs onto a populated slot stops at the cap", async () => {
    seedPopulatedSlot1();
    const files: File[] = [];
    // 16 more would push us to 17 — past the 16-sample cap.
    for (let i = 0; i < 16; i++) files.push(makeWavFile(`s${i}.wav`));
    await dropWavsToXmInstrumentView(files);
    const inst = xm2Song()!.instruments[0]!;
    expect(inst.samples.length).toBe(16);
  });
});

describe("dropWavsToXmPatternView", () => {
  it("creates a new instrument at the first empty slot", async () => {
    seedPopulatedSlot1();
    expect(currentXmInstrument()).toBe(1);
    await dropWavsToXmPatternView([
      makeWavFile("new-a.wav"),
      makeWavFile("new-b.wav"),
    ]);
    const s = xm2Song()!;
    // Slot 1 is populated → new instrument should land at slot 2.
    expect(s.instruments[1]!.samples.length).toBe(2);
    expect(s.instruments[1]!.samples.map((sm) => sm.name)).toEqual([
      "new-a",
      "new-b",
    ]);
    // Active instrument switches to the new slot.
    expect(currentXmInstrument()).toBe(2);
  });

  it("single WAV creates a new single-sample instrument", async () => {
    seedEmptySong();
    await dropWavsToXmPatternView([makeWavFile("solo.wav")]);
    const inst = xm2Song()!.instruments[0]!;
    expect(inst.samples.length).toBe(1);
    expect(inst.samples[0]!.name).toBe("solo");
  });
});
