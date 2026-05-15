import { createSignal } from "solid-js";
import type { ModSong } from "../core/mod/types";
import {
  channelCount as channelCountOf,
  type ProjectFormat,
  type Song,
} from "../core/song";
import { emptySong } from "../core/mod/format";
import { emptyXmSong } from "../core/xm/format";
import { parseModule } from "../core/mod/parser";
import { writeModule } from "../core/mod/writer";
import { parseXm } from "../core/xm/parser";
import { writeXm } from "../core/xm/writer";
import { isXmFile } from "../core/xm/sniff";
import {
  workbenchFromChiptune,
  workbenchFromWavData,
  xmWorkbenchFromChiptune,
  xmWorkbenchFromWav,
} from "../core/audio/sampleWorkbench";
import type { ChiptuneParams } from "../core/audio/chiptune";
import { renderToBuffer } from "../core/audio/offlineRender";
import { writeWav } from "../core/audio/wav";
import { songForPlayback } from "../core/audio/loopTruncate";
import {
  song,
  setSong,
  setTransport,
  setPlayMode,
  setPlayPos,
  setDirty,
  dirty,
  clearHistory,
} from "./song";
import { cursor, setCursor, resetCursor, type Cursor } from "./cursor";
import { resetXmCursor, setXmCursor } from "./cursorXm";
import { setView, view, type View } from "./view";
import {
  setInfoText,
  infoText,
  infoTextFromSampleNames,
  wrapInfoText,
  INFO_LINE_WIDTH,
  INFO_MAX_LINES,
} from "./info";
import {
  setCurrentSample,
  setCurrentOctave,
  setEditStep,
  currentSample,
  currentOctave,
  editStep,
} from "./edit";
import {
  resetChannelMute,
  setChannelMuteState,
  mutedChannels,
  soloedChannels,
} from "./channelMute";
import { resetChannelLevels } from "./channelLevel";
import {
  resetPatternNames,
  loadPatternNames,
  patternNames,
} from "./patternNames";
import {
  workbenches,
  setWorkbench,
  clearAllWorkbenches,
} from "./sampleWorkbench";
import {
  clearAllXmWorkbenches,
  setXmWorkbench,
  xmWorkbenches,
  xmWorkbenchKey,
} from "./xmSampleWorkbench";
import { clearAllStashedLoops } from "./loopStash";
import { clearAllImportedStashes } from "./importedStash";
import { stopEngine } from "./playback";
import { settings } from "./settings";
import { deriveExportFilename, io } from "./io";
import {
  projectFromBytes,
  projectToBytes,
  deriveProjectFilename,
  type SamplerSourceInputs,
  type XmSamplerSourceInputs,
  type XmChiptuneSourceInputs,
} from "./persistence";

/** Last error from a file load. Cleared at the start of each load attempt. */
const [error, setError] = createSignal<string | null>(null);
export { error, setError };

/** Display name of the open file, or null on a fresh blank song. */
const [filename, setFilename] = createSignal<string | null>(null);
export { filename, setFilename };

export interface LoadedSession {
  song: Song | null;
  filename: string | null;
  infoText?: string;
  view?: View;
  cursor?: Cursor;
  currentSample?: number;
  currentOctave?: number;
  editStep?: number;
  chiptuneSources?: Record<number, ChiptuneParams>;
  samplerSources?: Record<number, SamplerSourceInputs>;
  patternNames?: Record<number, string>;
  mutedChannels?: readonly boolean[];
  soloedChannels?: readonly boolean[];
  /** XM workbenches keyed by `"inst1Based:sampleIdx"`. FT2 projects only. */
  xmSamplerSources?: Record<string, XmSamplerSourceInputs>;
  xmChiptuneSources?: Record<string, XmChiptuneSourceInputs>;
}

export function applyLoadedSession(loaded: LoadedSession): void {
  if (!loaded.song) return;
  // Halt the worklet AND flip transport BEFORE setSong: the live-edit
  // createEffect reads `transport()` and would otherwise dispatch wasted
  // setSampleData / replaceSong messages to the stopped worklet for
  // every diff between the old and new song.
  stopEngine();
  setTransport("ready");
  setPlayMode(null);
  // Mute/solo / VU / pattern names are tied to the previous song's
  // channels and pattern indices; carrying them over surprises the user.
  // Size the dynamic-length signals to match the new song's channel count
  // so PT (4) and FT2 (2..32) projects each get correctly-shaped arrays.
  const ch = channelCountOf(loaded.song);
  resetChannelMute(ch);
  resetChannelLevels(ch);
  resetPatternNames();
  if (loaded.patternNames) loadPatternNames(loaded.patternNames);
  if (loaded.mutedChannels || loaded.soloedChannels) {
    setChannelMuteState(loaded.mutedChannels, loaded.soloedChannels, ch);
  }
  setSong(loaded.song);
  setFilename(loaded.filename);
  setInfoText(loaded.infoText ?? "");
  if (loaded.view) setView(loaded.view);
  if (loaded.cursor) {
    setCursor(loaded.cursor);
    setPlayPos({ order: loaded.cursor.order, row: loaded.cursor.row });
    // FT2 also needs its own cursor seeded — the persisted Cursor's
    // (order, row) carry over but the field/channel land back at the
    // start because PT and FT field types don't share names.
    if (loaded.song.format === "FT2") {
      setXmCursor({
        order: loaded.cursor.order,
        row: loaded.cursor.row,
        channel: 0,
        field: "note",
      });
    }
  } else {
    resetCursor();
    resetXmCursor();
    setPlayPos({ order: 0, row: 0 });
  }
  if (typeof loaded.currentSample === "number")
    setCurrentSample(loaded.currentSample);
  if (typeof loaded.currentOctave === "number")
    setCurrentOctave(loaded.currentOctave);
  if (typeof loaded.editStep === "number") setEditStep(loaded.editStep);
  clearHistory();
  clearAllWorkbenches();
  clearAllXmWorkbenches();
  clearAllStashedLoops();
  clearAllImportedStashes();
  if (loaded.chiptuneSources) {
    for (const [slotStr, params] of Object.entries(loaded.chiptuneSources)) {
      const slot = parseInt(slotStr, 10);
      if (!Number.isFinite(slot)) continue;
      setWorkbench(slot, workbenchFromChiptune(params));
    }
  }
  if (loaded.samplerSources) {
    for (const [slotStr, src] of Object.entries(loaded.samplerSources)) {
      const slot = parseInt(slotStr, 10);
      if (!Number.isFinite(slot)) continue;
      setWorkbench(slot, {
        ...workbenchFromWavData(src.wav, src.sourceName),
        chain: src.chain,
        pt: src.pt,
      });
    }
  }
  if (loaded.xmSamplerSources) {
    for (const [key, src] of Object.entries(loaded.xmSamplerSources)) {
      const [inst, idx] = parseXmKey(key);
      if (inst === null) continue;
      setXmWorkbench(inst, idx, {
        ...xmWorkbenchFromWav(src.wav, src.sourceName),
        chain: src.chain,
        xm: src.xm,
      });
    }
  }
  if (loaded.xmChiptuneSources) {
    for (const [key, src] of Object.entries(loaded.xmChiptuneSources)) {
      const [inst, idx] = parseXmKey(key);
      if (inst === null) continue;
      setXmWorkbench(inst, idx, {
        ...xmWorkbenchFromChiptune(src.params),
        chain: src.chain,
        xm: src.xm,
      });
    }
  }
  setDirty(false);
}

/** Parse `"inst:sampleIdx"` back to a tuple; returns `[null, 0]` on
 *  malformed input. Mirrors persistence.ts's `isXmWorkbenchKey` guard. */
function parseXmKey(k: string): [number | null, number] {
  const parts = k.split(":");
  if (parts.length !== 2) return [null, 0];
  const inst = parseInt(parts[0]!, 10);
  const idx = parseInt(parts[1]!, 10);
  if (!Number.isFinite(inst) || !Number.isFinite(idx)) return [null, 0];
  return [inst, idx];
}

/**
 * Sniffs the file: `.retro` → project, "Extended Module: " magic → XM (FT2),
 * anything else → strict M.K. `.mod`.
 *
 * Phase 2: XM files now parse end-to-end into an `XmSong`, but
 * `applyLoadedSession`'s editor-runtime gate still rejects FT2 (the editor
 * itself is Phase 3 work). The parse result flows in so callers see
 * "FT2 mode not yet supported" with a successful parse behind it, not a
 * bare error from the magic sniff.
 */
export async function loadFile(file: File): Promise<void> {
  setError(null);
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (/\.retro$/i.test(file.name)) {
      const loaded = projectFromBytes(buf);
      if (!loaded) throw new Error("Invalid .retro project");
      applyLoadedSession(loaded);
    } else if (isXmFile(buf)) {
      const xm = parseXm(buf);
      applyLoadedSession({
        song: xm,
        filename: file.name,
        infoText: infoTextFromSampleNames(
          xm.instruments.map((inst) => inst.name),
        ),
      });
    } else {
      const mod = parseModule(buf.buffer);
      applyLoadedSession({
        song: mod,
        filename: file.name,
        infoText: infoTextFromSampleNames(mod.samples.map((sm) => sm.name)),
      });
    }
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    setTransport("idle");
  }
}

/**
 * Stamp the info-text lines into the sample-name slots. No-op on empty
 * text: we don't want exporting to silently rewrite sample names the
 * user never edited. Per-line truncation matches the .mod sample-name
 * field width (22 chars) so writeModule's writeAscii doesn't drop the tail.
 */
export function withInfoTextAsSampleNames(s: ModSong, text: string): ModSong {
  if (text.length === 0) return s;
  const lines = wrapInfoText(text, INFO_LINE_WIDTH, INFO_MAX_LINES);
  const samples = s.samples.map((sample, i) => ({
    ...sample,
    name: lines[i] ?? "",
  }));
  return { ...s, samples };
}

export function chiptuneSourcesSnapshot(): Record<number, ChiptuneParams> {
  const out: Record<number, ChiptuneParams> = {};
  for (const [slot, wb] of workbenches()) {
    if (wb.source.kind === "chiptune") out[slot] = wb.source.params;
  }
  return out;
}

/**
 * Capture each XM workbench currently in chiptune mode. Keys mirror the
 * in-memory `xmWorkbenchKey` string so a save→load round-trip lands
 * each workbench back on the same `(instrument, sampleIdx)` pair.
 */
export function xmChiptuneSourcesSnapshot(): Record<
  string,
  XmChiptuneSourceInputs
> {
  const out: Record<string, XmChiptuneSourceInputs> = {};
  for (const [key, wb] of xmWorkbenches()) {
    if (wb.source.kind !== "chiptune") continue;
    out[key] = { params: wb.source.params, chain: wb.chain, xm: wb.xm };
  }
  return out;
}

/**
 * Capture each XM workbench in sampler mode whose source carries audio
 * (an empty-sampler placeholder is skipped — the reload path lazy-
 * creates one from the sample bytes anyway). A workbench with no audio
 * but a configured chain is still emitted so the user's chain work
 * isn't silently dropped on save.
 */
export function xmSamplerSourcesSnapshot(): Record<
  string,
  XmSamplerSourceInputs
> {
  const out: Record<string, XmSamplerSourceInputs> = {};
  for (const [key, wb] of xmWorkbenches()) {
    if (wb.source.kind !== "sampler") continue;
    const hasAudio = wb.source.wav.channels.some((ch) => ch.length > 0);
    const hasChain = wb.chain.length > 0;
    if (!hasAudio && !hasChain) continue;
    out[key] = {
      sourceName: wb.source.sourceName,
      wav: wb.source.wav,
      chain: wb.chain,
      xm: wb.xm,
    };
  }
  return out;
}

void xmWorkbenchKey;

/**
 * Empty workbenches (placeholder created by toggling Sampler → Chiptune
 * on a fresh slot) are skipped: no audio to store, and the toggle
 * recreates them on demand. A workbench with no audio but a configured
 * chain is still emitted so the user's chain work isn't silently
 * dropped on save.
 */
export function samplerSourcesSnapshot(): Record<number, SamplerSourceInputs> {
  const out: Record<number, SamplerSourceInputs> = {};
  for (const [slot, wb] of workbenches()) {
    if (wb.source.kind !== "sampler") continue;
    const hasAudio = wb.source.wav.channels.some((ch) => ch.length > 0);
    const hasChain = wb.chain.length > 0;
    if (!hasAudio && !hasChain) continue;
    out[slot] = {
      sourceName: wb.source.sourceName,
      wav: wb.source.wav,
      chain: wb.chain,
      pt: wb.pt,
    };
  }
  return out;
}

export function exportMod(): void {
  const s = song();
  if (!s || s.format !== "PT2") return;
  const stamped = withInfoTextAsSampleNames(s, infoText());
  const bytes = writeModule(stamped);
  io.download(deriveExportFilename(filename(), s.title), bytes, "audio/x-mod");
}

/**
 * FT2 counterpart of `exportMod`. Writes the loaded `XmSong` out as
 * `.xm` bytes. The downloaded filename uses the loaded `.xm` name when
 * available, otherwise falls back to the song title (sanitised) — same
 * policy as `deriveExportFilename` for `.mod`.
 */
export function exportXm(): void {
  const s = song();
  if (!s || s.format !== "FT2") return;
  const bytes = writeXm(s);
  io.download(
    deriveExportFilename(filename(), s.title, "xm"),
    bytes,
    "audio/x-xm",
  );
}

/** Format-aware export entry — picks the right writer for the loaded song. */
export function exportSong(): void {
  const s = song();
  if (!s) return;
  if (s.format === "PT2") exportMod();
  else exportXm();
}

/**
 * Pipes through `songForPlayback` (loop-truncate) so the export matches
 * what the editor previews. Synchronous on the main thread — worth
 * worker-offloading the day someone hits the freeze threshold on a long
 * song. `maxSeconds = 30 min` is a safety net; `stopOnSongEnd` is the
 * normal exit for any PT module that loops cleanly.
 */
export function exportWav(): void {
  const s = song();
  if (!s) return;
  // PT2-specific tweaks (sample-name stamping from info text, A500/A1200
  // filter, stereo separation) only apply to PT2 songs. For FT2 we feed
  // the song straight through `renderToBuffer`, which dispatches to the
  // XM replayer via `makeReplayer`.
  const playbackSong =
    s.format === "PT2"
      ? songForPlayback(withInfoTextAsSampleNames(s, infoText()))
      : s;
  const sampleRate = 44100;
  const audio = renderToBuffer(playbackSong, {
    sampleRate,
    maxSeconds: 30 * 60,
    stopOnSongEnd: true,
    amigaModel: settings().paulaModel,
    stereoSeparation: settings().stereoSeparation,
  });
  const bytes = writeWav({
    sampleRate: audio.sampleRate,
    channels: [audio.left, audio.right],
  });
  io.download(
    deriveExportFilename(filename(), s.title, "wav"),
    bytes,
    "audio/wav",
  );
}

/**
 * `.retro` is the lossless round-trip format. Save .mod loses the cursor
 * position, current sample, edit step, mute state, and pattern names.
 */
export function saveProject(): void {
  const s = song();
  if (!s) return;
  // PT2 carries `chiptuneSources` / `samplerSources` / `patternNames`;
  // FT2 carries the per-(instrument, sampleIdx) XM workbench maps. The
  // payload itself is format-agnostic — fields not relevant to the
  // active format stay undefined.
  const isPt2 = s.format === "PT2";
  const isXm = s.format === "FT2";
  const bytes = projectToBytes({
    song: s,
    filename: filename(),
    infoText: infoText(),
    view: view(),
    cursor: cursor(),
    currentSample: currentSample(),
    currentOctave: currentOctave(),
    editStep: editStep(),
    chiptuneSources: isPt2 ? chiptuneSourcesSnapshot() : undefined,
    samplerSources: isPt2 ? samplerSourcesSnapshot() : undefined,
    patternNames: isPt2 ? patternNames() : undefined,
    mutedChannels: mutedChannels(),
    soloedChannels: soloedChannels(),
    xmSamplerSources: isXm ? xmSamplerSourcesSnapshot() : undefined,
    xmChiptuneSources: isXm ? xmChiptuneSourcesSnapshot() : undefined,
  });
  io.download(
    deriveProjectFilename(filename(), s.title),
    bytes,
    "application/json",
  );
  setDirty(false);
}

export function newProject(format: ProjectFormat = "PT2"): void {
  // jsdom stubs `window.confirm` to true so tests don't hang on the prompt.
  if (dirty()) {
    const ok =
      typeof window !== "undefined" && window.confirm
        ? window.confirm("Discard unsaved changes?")
        : true;
    if (!ok) return;
  }
  const fresh = format === "FT2" ? emptyXmSong() : emptySong();
  applyLoadedSession({ song: fresh, filename: null });
}
