import {
  workbenchFromWav,
  type SampleWorkbench,
} from "../core/audio/sampleWorkbench";
import { clearSample } from "../core/mod/mutations";
import { commitEditWithWorkbenches, song } from "./song";
import { currentSample, selectSample } from "./edit";
import { view } from "./view";
import { withWorkbench } from "./sampleWorkbench";
import { NO_LOOP, nextFreeSlot, writeWorkbenchToSongPure } from "./sampleEdit";
import { setError } from "./session";

/**
 * Multi-WAV drop / picker path — `.mod` / `.retro` go through `loadFile`.
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
    setError("Unsupported file. Drop a .mod, .retro, or one or more .wav.");
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
