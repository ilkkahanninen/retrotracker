import {
  workbenchFromWav,
  type SampleWorkbench,
} from "../core/audio/sampleWorkbench";
import { clearSample } from "../core/mod/mutations";
import { readWav } from "../core/audio/wav";
import { emptyXmInstrument } from "../core/xm/format";
import {
  buildXmWavImport,
  deriveXmSampleName,
  type XmWavImport,
} from "../core/xm/sampleImport";
import { XM_MAX_INSTRUMENTS, type XmInstrument } from "../core/xm/types";
import {
  isXmInstrumentEmpty,
  nextFreeXmInstrumentIndex,
  setXmInstrument as setXmInstrumentMutation,
} from "../core/xm/mutations";
import {
  commitEditWithWorkbenches,
  pt2Song as song,
  xm2Song,
  type XmEditState,
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
import { commitXmSlotShape } from "./xmInstrumentEdit";
import { withXmWavImport } from "./xmSampleEdit";
import {
  withXmWorkbench,
  withoutXmInstrumentWorkbenches,
} from "./xmSampleWorkbench";

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
 * 1-based instrument slot. The first WAV replaces the target slot with a
 * fresh instrument named after the file; any extras land in the next
 * FREE slots after it, so a multi-file drop never overwrites populated
 * instruments. The whole batch is one undo entry, as PT's is.
 */
export async function loadWavsIntoXmSlot(
  targetSlot1Based: number,
  files: File[],
): Promise<void> {
  if (!xm2Song()) {
    setError("Open an XM song before importing WAVs into instruments.");
    return;
  }
  const imports = await decodeXmWavFiles(
    files,
    "Drop one or more .wav files onto an instrument slot.",
  );
  if (!imports) return;
  setError(null);

  let placed = 0;
  const committed = commitXmSlotShape((state) => {
    // Targets are worked out against the song as it is NOW — decoding
    // awaited, so anything read before it may be stale.
    let next = state;
    let slot: number | null = targetSlot1Based - 1;
    placed = 0;
    for (const imp of imports) {
      if (slot === null || slot >= XM_MAX_INSTRUMENTS) break;
      next = withXmInstrumentFromImports(next, slot + 1, [imp]);
      placed++;
      slot = nextFreeXmInstrumentIndex(next.song, slot + 1);
    }
    return next;
  });
  if (!committed) {
    reportXmImportRejected();
    return;
  }
  selectXmInstrument(targetSlot1Based);
  setCurrentXmSampleIndex(0);
  const skipped = imports.length - placed;
  if (skipped > 0) {
    setError(
      `Out of instrument slots — skipped ${skipped} file${skipped === 1 ? "" : "s"}.`,
    );
  }
}

void currentXmInstrument;

/** Decode dropped WAVs into ready-to-commit imports. Reports the problem
 *  and returns null when there are no WAVs or one fails to decode — a
 *  half-imported batch would be worse than none. */
async function decodeXmWavFiles(
  files: File[],
  emptyMessage = "Drop one or more .wav files.",
): Promise<XmWavImport[] | null> {
  const wavFiles = files.filter((f) => /\.wav$/i.test(f.name));
  if (wavFiles.length === 0) {
    setError(emptyMessage);
    return null;
  }
  const decoded: XmWavImport[] = [];
  for (const file of wavFiles) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Read the frequency mode after the await: it belongs to whatever
      // song is loaded when the import lands.
      const linear = xm2Song()?.flags.linearFreq ?? true;
      decoded.push(
        buildXmWavImport(readWav(bytes), deriveXmSampleName(file.name), linear),
      );
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
 * Write a whole new instrument built from `imports` (one sample each)
 * into `slot1Based`, with each sample's workbench. The instrument takes
 * the first file's name. KeyMap stays all-zeros (all 96 notes route to
 * sample 0) — the user paints the routing in the keymap editor.
 *
 * Every workbench the slot had goes first: an "empty" slot can still own
 * some (a lazily created empty-source one, or a chiptune whose render
 * was cleared), and left in place they would re-render over the freshly
 * imported samples.
 */
function withXmInstrumentFromImports(
  state: XmEditState,
  slot1Based: number,
  imports: XmWavImport[],
): XmEditState {
  const instrument: XmInstrument = {
    ...emptyXmInstrument(),
    name: imports[0]?.sample.name ?? "",
    samples: imports.map((imp) => imp.sample),
  };
  let wbs = withoutXmInstrumentWorkbenches(state.xmWorkbenches, slot1Based);
  imports.forEach((imp, idx) => {
    wbs = withXmWorkbench(wbs, slot1Based, idx, imp.wb);
  });
  return {
    song: setXmInstrumentMutation(state.song, slot1Based - 1, instrument),
    xmWorkbenches: wbs,
  };
}

/** Tell the user a dropped WAV went nowhere (the commit was rejected —
 *  an out-of-range slot or a cap, since imports aren't gated on
 *  playback). */
function reportXmImportRejected(): void {
  setError("Couldn't import the dropped samples.");
}

/** Most samples one FT2 instrument holds. */
const XM_SAMPLE_CAP = 16;

/**
 * Drop handler for the FT2 InstrumentView. Behaviour depends on whether
 * the current slot already holds samples:
 *   - Empty slot: create a new instrument from the dropped WAVs (one
 *     sample per WAV; multi-sample when N > 1).
 *   - Populated slot: append the dropped WAVs as additional samples on
 *     the existing instrument (capped at 16 — extras are dropped with
 *     an error). Replacing the sample being edited is Load WAV's job.
 * Either way the batch is one undo entry.
 */
export async function dropWavsToXmInstrumentView(files: File[]): Promise<void> {
  if (!xm2Song()) {
    setError("Open an XM song before importing WAVs.");
    return;
  }
  const imports = await decodeXmWavFiles(files);
  if (!imports) return;
  setError(null);

  const slot1Based = currentXmInstrument();
  // After the await: the instrument as it is now.
  const existing = xm2Song()?.instruments[slot1Based - 1];

  if (isXmInstrumentEmpty(existing)) {
    const batch = imports.slice(0, XM_SAMPLE_CAP);
    const committed = commitXmSlotShape((state) =>
      withXmInstrumentFromImports(state, slot1Based, batch),
    );
    if (!committed) {
      reportXmImportRejected();
      return;
    }
    selectXmInstrument(slot1Based);
    setCurrentXmSampleIndex(0);
    reportXmSampleCap(imports.length - batch.length);
    return;
  }

  // Populated slot — append to existing samples.
  const firstNew = existing!.samples.length;
  const batch = imports.slice(0, Math.max(0, XM_SAMPLE_CAP - firstNew));
  if (batch.length > 0) {
    const committed = commitXmSlotShape((state) =>
      batch.reduce(
        (next, imp, i) => withXmWavImport(next, slot1Based, firstNew + i, imp),
        state,
      ),
    );
    if (!committed) {
      reportXmImportRejected();
      return;
    }
    setCurrentXmSampleIndex(firstNew);
  }
  reportXmSampleCap(imports.length - batch.length);
}

function reportXmSampleCap(skipped: number): void {
  if (skipped <= 0) return;
  setError(
    `Sample cap reached (${XM_SAMPLE_CAP}) — skipped ${skipped} file${
      skipped === 1 ? "" : "s"
    }.`,
  );
}

/**
 * Drop handler for the FT2 pattern view. Finds the first empty
 * instrument slot and builds a new instrument from the dropped WAVs
 * (single sample or multi-sample). No-op when every slot is taken.
 */
export async function dropWavsToXmPatternView(files: File[]): Promise<void> {
  if (!xm2Song()) {
    setError("Open an XM song before importing WAVs.");
    return;
  }
  const imports = await decodeXmWavFiles(files);
  if (!imports) return;
  setError(null);

  const batch = imports.slice(0, XM_SAMPLE_CAP);
  let slot1Based: number | null = null;
  const committed = commitXmSlotShape((state) => {
    const free = nextFreeXmInstrumentIndex(state.song);
    slot1Based = free === null ? null : free + 1;
    return slot1Based === null
      ? state
      : withXmInstrumentFromImports(state, slot1Based, batch);
  });
  if (slot1Based === null) {
    setError("No free instrument slots — clear one and try again.");
    return;
  }
  if (!committed) {
    reportXmImportRejected();
    return;
  }
  selectXmInstrument(slot1Based);
  setCurrentXmSampleIndex(0);
  reportXmSampleCap(imports.length - batch.length);
}
