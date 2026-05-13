import {
  workbenchFromWav,
  type SampleWorkbench,
} from "../core/audio/sampleWorkbench";
import { clearSample } from "../core/mod/mutations";
import { emptyXmInstrument } from "../core/xm/format";
import { importWavXmSample } from "../core/xm/sampleImport";
import type { XmInstrument, XmSample } from "../core/xm/types";
import {
  setXmInstrument as setXmInstrumentMutation,
  setXmInstrumentSample as setXmInstrumentSampleMutation,
} from "../core/xm/mutations";
import {
  commitEditWithWorkbenches,
  commitEditXm,
  pt2Song as song,
  xm2Song,
} from "./song";
import { currentSample, selectSample } from "./edit";
import { view } from "./view";
import { withWorkbench } from "./sampleWorkbench";
import { NO_LOOP, nextFreeSlot, writeWorkbenchToSongPure } from "./sampleEdit";
import { setError } from "./session";
import {
  currentXmInstrument,
  selectXmInstrument,
  setCurrentXmSampleIndex,
} from "./xmEdit";
import { setXmSample } from "./xmInstrumentEdit";

/**
 * Multi-WAV drop / picker path — `.mod` / `.xm` / `.retro` go through `loadFile`.
 * All slot writes land in one history entry so undo reverts the batch.
 */
export async function loadWavsIntoFreeSlots(files: File[]): Promise<void> {
  const s = song();
  if (!s) {
    setError("Open a song before importing WAVs.");
    return;
  }
  const wavFiles = files.filter((f) => /\.wav$/i.test(f.name));
  if (wavFiles.length === 0) {
    setError(
      "Unsupported file. Drop a .mod, .xm, .retro, or one or more .wav.",
    );
    return;
  }

  setError(null);
  const decoded: { wb: SampleWorkbench }[] = [];
  for (const file of wavFiles) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      decoded.push({ wb: workbenchFromWav(bytes, file.name) });
    } catch (err) {
      setError(
        `${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }

  const startSlot = currentSample() - 1;
  const targets: number[] = [];
  let from = startSlot - 1;
  // Sample view → "replace this sample", land on startSlot even when
  // occupied. Pattern view → fan forward across free slots; drops there
  // are typically batch imports the user expects to be appended.
  const overwriteCurrent = view() === "sample";
  if (overwriteCurrent || s.samples[startSlot]?.lengthWords === 0) {
    targets.push(startSlot);
    from = startSlot;
  }
  while (targets.length < decoded.length) {
    const next = nextFreeSlot(s, from);
    if (next === null) break;
    targets.push(next);
    from = next;
  }
  if (targets.length === 0) {
    setError("No free sample slots.");
    return;
  }

  const pairs = decoded.slice(0, targets.length).map((d, i) => ({
    slot: targets[i]!,
    wb: d.wb,
  }));

  commitEditWithWorkbenches((state) => {
    let nextSong = state.song;
    let nextWb = state.workbenches;
    for (let i = 0; i < pairs.length; i++) {
      const { slot, wb } = pairs[i]!;
      // Clear before write so the overwritten slot is treated as fresh —
      // adopt the new WAV's filename and reset volume/finetune. Without
      // this, the new audio would silently inherit the old slot's name.
      if (i === 0 && overwriteCurrent) {
        nextSong = clearSample(nextSong, slot);
      }
      nextSong = writeWorkbenchToSongPure(nextSong, slot, wb, NO_LOOP);
      nextWb = withWorkbench(nextWb, slot, wb);
    }
    return { ...state, song: nextSong, workbenches: nextWb };
  });

  selectSample(pairs[0]!.slot + 1);

  const skipped = decoded.length - pairs.length;
  if (skipped > 0) {
    setError(
      `Out of sample slots — skipped ${skipped} file${skipped === 1 ? "" : "s"}.`,
    );
  }
}

/**
 * Slot-targeted variant: the user dropped WAVs directly onto a slot in the
 * sample list. The first WAV always replaces the target slot's contents
 * (the user explicitly aimed there); any extras fan forward across free
 * slots starting after the target. Non-WAV files are rejected with an
 * error — the slot list isn't a project-load surface.
 */
export async function loadWavsIntoSlot(
  targetSlot: number,
  files: File[],
): Promise<void> {
  const s = song();
  if (!s) {
    setError("Open a song before importing WAVs.");
    return;
  }
  const wavFiles = files.filter((f) => /\.wav$/i.test(f.name));
  if (wavFiles.length === 0) {
    setError("Drop one or more .wav files onto a sample slot.");
    return;
  }

  setError(null);
  const decoded: { wb: SampleWorkbench }[] = [];
  for (const file of wavFiles) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      decoded.push({ wb: workbenchFromWav(bytes, file.name) });
    } catch (err) {
      setError(
        `${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }

  const targets: number[] = [targetSlot];
  let from = targetSlot;
  while (targets.length < decoded.length) {
    const next = nextFreeSlot(s, from);
    if (next === null) break;
    targets.push(next);
    from = next;
  }

  const pairs = decoded.slice(0, targets.length).map((d, i) => ({
    slot: targets[i]!,
    wb: d.wb,
  }));

  commitEditWithWorkbenches((state) => {
    let nextSong = state.song;
    let nextWb = state.workbenches;
    for (let i = 0; i < pairs.length; i++) {
      const { slot, wb } = pairs[i]!;
      // The target slot is always overwritten — clear first so the new
      // WAV's name takes over and volume / finetune reset to defaults
      // (matches the sample-view overwrite path in loadWavsIntoFreeSlots).
      if (i === 0) {
        nextSong = clearSample(nextSong, slot);
      }
      nextSong = writeWorkbenchToSongPure(nextSong, slot, wb, NO_LOOP);
      nextWb = withWorkbench(nextWb, slot, wb);
    }
    return { ...state, song: nextSong, workbenches: nextWb };
  });

  selectSample(pairs[0]!.slot + 1);

  const skipped = decoded.length - pairs.length;
  if (skipped > 0) {
    setError(
      `Out of sample slots — skipped ${skipped} file${skipped === 1 ? "" : "s"}.`,
    );
  }
}

/**
 * FT2 counterpart of `loadWavsIntoSlot`: drop one or more WAVs onto a
 * 1-based instrument slot. The first WAV replaces the target slot; any
 * extras fan forward into the next instrument slots. Each import is a
 * discrete commit so undo steps through them one at a time.
 */
export async function loadWavsIntoXmSlot(
  targetSlot1Based: number,
  files: File[],
): Promise<void> {
  const xm = xm2Song();
  if (!xm) {
    setError("Open an XM song before importing WAVs into instruments.");
    return;
  }
  const wavFiles = files.filter((f) => /\.wav$/i.test(f.name));
  if (wavFiles.length === 0) {
    setError("Drop one or more .wav files onto an instrument slot.");
    return;
  }
  setError(null);

  let slot = targetSlot1Based;
  let imported = 0;
  for (const file of wavFiles) {
    if (slot > 128) {
      const skipped = wavFiles.length - imported;
      setError(
        `Out of instrument slots — skipped ${skipped} file${skipped === 1 ? "" : "s"}.`,
      );
      break;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = importWavXmSample(bytes, file.name);
      setXmSample(slot, result.sample);
      imported++;
      slot++;
    } catch (err) {
      setError(
        `${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }
  if (imported > 0) {
    selectXmInstrument(targetSlot1Based);
  }
}

void currentXmInstrument;

/** Lowest 1-based instrument slot whose contents are an empty instrument
 *  (no samples, or single sample with zero data). Returns null when all
 *  128 slots are populated. */
function firstEmptyXmSlot(): number | null {
  const s = xm2Song();
  if (!s) return null;
  for (let i = 0; i < 128; i++) {
    const inst = s.instruments[i];
    if (!inst) return i + 1;
    if (
      inst.samples.length === 0 ||
      inst.samples.every((sm) => sm.data.length === 0)
    ) {
      return i + 1;
    }
  }
  return null;
}

async function decodeWavFiles(files: File[]): Promise<XmSample[] | null> {
  const wavFiles = files.filter((f) => /\.wav$/i.test(f.name));
  if (wavFiles.length === 0) {
    setError("Drop one or more .wav files.");
    return null;
  }
  const decoded: XmSample[] = [];
  for (const file of wavFiles) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      decoded.push(importWavXmSample(bytes, file.name).sample);
    } catch (err) {
      setError(
        `${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
  return decoded;
}

/**
 * Build a fresh instrument carrying `samples` and write it to
 * `slot1Based`. The instrument's name follows the first sample's name.
 * KeyMap stays all-zeros (all 96 notes route to sample 0) — the user
 * paints the routing in the right-column keymap editor.
 */
function buildXmInstrumentFromSamples(samples: XmSample[]): XmInstrument {
  const base = emptyXmInstrument();
  if (samples.length === 0) return base;
  return {
    ...base,
    name: samples[0]!.name,
    samples,
  };
}

/**
 * Drop handler for the FT2 InstrumentView. Behaviour depends on whether
 * the current slot already holds samples:
 *   - Empty slot: create a new instrument from the dropped WAVs (one
 *     sample per WAV; multi-sample when N > 1).
 *   - Populated slot: append the dropped WAVs as additional samples on
 *     the existing instrument (capped at 16 — extras are dropped with
 *     an error).
 */
export async function dropWavsToXmInstrumentView(files: File[]): Promise<void> {
  const s = xm2Song();
  if (!s) {
    setError("Open an XM song before importing WAVs.");
    return;
  }
  const samples = await decodeWavFiles(files);
  if (!samples) return;
  setError(null);

  const slot1Based = currentXmInstrument();
  const existing = s.instruments[slot1Based - 1];
  const isPopulated =
    !!existing &&
    existing.samples.length > 0 &&
    existing.samples.some((sm) => sm.data.length > 0);

  if (!isPopulated) {
    const next = buildXmInstrumentFromSamples(samples);
    commitEditXm((song) => setXmInstrumentMutation(song, slot1Based - 1, next));
    selectXmInstrument(slot1Based);
    setCurrentXmSampleIndex(0);
    return;
  }

  // Populated slot — append to existing samples. Capped at 16.
  const SAMPLE_CAP = 16;
  let appended = 0;
  let nextIdx = existing.samples.length;
  for (const sample of samples) {
    if (nextIdx >= SAMPLE_CAP) break;
    commitEditXm((song) =>
      setXmInstrumentSampleMutation(song, slot1Based, sample, nextIdx),
    );
    nextIdx++;
    appended++;
  }
  const skipped = samples.length - appended;
  if (skipped > 0) {
    setError(
      `Sample cap reached (${SAMPLE_CAP}) — skipped ${skipped} file${
        skipped === 1 ? "" : "s"
      }.`,
    );
  }
  if (appended > 0) {
    setCurrentXmSampleIndex(existing.samples.length);
  }
}

/**
 * Drop handler for the FT2 pattern view. Finds the first empty
 * instrument slot and builds a new instrument from the dropped WAVs
 * (single sample or multi-sample). No-op when every slot is taken.
 */
export async function dropWavsToXmPatternView(files: File[]): Promise<void> {
  const s = xm2Song();
  if (!s) {
    setError("Open an XM song before importing WAVs.");
    return;
  }
  const samples = await decodeWavFiles(files);
  if (!samples) return;
  setError(null);

  const slot1Based = firstEmptyXmSlot();
  if (slot1Based === null) {
    setError("No free instrument slots — clear one and try again.");
    return;
  }
  const next = buildXmInstrumentFromSamples(samples);
  commitEditXm((song) => setXmInstrumentMutation(song, slot1Based - 1, next));
  selectXmInstrument(slot1Based);
  setCurrentXmSampleIndex(0);
}
