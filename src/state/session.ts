import { createSignal } from "solid-js";
import type { ModSong } from "../core/mod/types";
import {
  channelCount as channelCountOf,
  type ProjectFormat,
  type Song,
} from "../core/song";
import { emptySong } from "../core/mod/format";
import { emptyXmInstrument, emptyXmSong } from "../core/xm/format";
import {
  XM_INSTRUMENT_NAME_MAX,
  XM_MAX_INSTRUMENTS,
  type XmInstrument,
  type XmSong,
} from "../core/xm/types";
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
  type SampleWorkbench,
  type XmSampleWorkbench,
} from "../core/audio/sampleWorkbench";
import type { ChiptuneParams } from "../core/audio/chiptune";
import {
  renderToBuffer,
  renderToBufferAsync,
} from "../core/audio/offlineRender";
import { setMp3ExportState } from "./mp3Export";
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
  attachLateWorkbenches,
} from "./song";
import { cursor, setCursor, resetCursor, type Cursor } from "./cursor";
import { resetXmCursor, setXmCursor, xmCursor } from "./cursorXm";
import { clearSelection, clearXmSelection } from "./selection";
import { setSampleSelection } from "./sampleSelection";
import { setXmSampleSelection } from "./xmSampleSelection";
import { clearSelectedEffect } from "./selectedEffect";
import {
  setXmSelectedEffectIndex,
  setXmSelectedEffectParam,
} from "./xmSampleEdit";
import {
  currentXmInstrument,
  currentXmOctave,
  currentXmSampleIndex,
  setCurrentXmInstrument,
  setCurrentXmOctave,
  setCurrentXmSampleIndex,
} from "./xmEdit";
import { reconcileUiToSong } from "./reconcile";
import { getSourceStore } from "./sourceStore";
import { dismissSharedBanner } from "./shareLoad";
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
  withWorkbench,
  type WorkbenchMap,
} from "./sampleWorkbench";
import {
  clearAllXmWorkbenches,
  setXmWorkbench,
  xmWorkbenches,
  xmWorkbenchKey,
  withXmWorkbench,
  type XmWorkbenchMap,
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
  resolvePendingSources,
  type PendingSource,
  type SamplerSourceInputs,
  type XmEditSnapshot,
  type XmSamplerSourceInputs,
  type XmChiptuneSourceInputs,
} from "./persistence";

/** Last error from a file load. Cleared at the start of each load attempt. */
const [error, setError] = createSignal<string | null>(null);
export { error, setError };

/** Display name of the open file, or null on a fresh blank song. */
const [filename, setFilename] = createSignal<string | null>(null);
export { filename, setFilename };

/**
 * The cloud bucket + path the loaded song was last read from or saved
 * to, or `null` for songs that only exist locally (drag-drop, file
 * picker, fresh "New", or "opened from share link" — recipients don't
 * own the source). Drives the "Share this song" menu item: gated to
 * `cloudOrigin() !== null` so users can only share songs that already
 * live in their own cloud bucket.
 *
 * Set explicitly by the cloud-open and cloud-save flows in App.tsx —
 * not by `applyLoadedSession`, which clears it on every load so a
 * local-load can't accidentally inherit the previous song's origin.
 */
export type CloudResource = "projects" | "modules";
export interface CloudOrigin {
  resource: CloudResource;
  name: string;
}
const [cloudOrigin, setCloudOrigin] = createSignal<CloudOrigin | null>(null);
export { cloudOrigin, setCloudOrigin };

export interface LoadedSession {
  song: Song | null;
  filename: string | null;
  infoText?: string;
  view?: View;
  cursor?: Cursor;
  currentSample?: number;
  currentOctave?: number;
  editStep?: number;
  /** FT2 editing state — see `SessionInputs.xmEdit`. */
  xmEdit?: XmEditSnapshot;
  chiptuneSources?: Record<number, ChiptuneParams>;
  samplerSources?: Record<number, SamplerSourceInputs>;
  patternNames?: Record<number, string>;
  mutedChannels?: readonly boolean[];
  soloedChannels?: readonly boolean[];
  /** XM workbenches keyed by `"inst1Based:sampleIdx"`. FT2 projects only. */
  xmSamplerSources?: Record<string, XmSamplerSourceInputs>;
  xmChiptuneSources?: Record<string, XmChiptuneSourceInputs>;
}

/**
 * Bumped by every load. Asynchronous follow-ups to a load (fetching the
 * restored session's source audio) capture it and stand down if another
 * song has been loaded in the meantime.
 */
let loadEpoch = 0;

/**
 * True while a restored session's sampler sources are still being read
 * from the source store. Autosave waits for it: a save written in that
 * window would not reference the sources yet, and its garbage sweep
 * would then delete their audio.
 */
const [hydratingSources, setHydratingSources] = createSignal(false);
export { hydratingSources };

/**
 * Fetch the source audio a restored session referenced by id and attach
 * it to the matching slots as sampler workbenches — the asynchronous
 * second half of a boot restore. The song itself (and each slot's
 * rendered sample) is already in place from `applyLoadedSession`, so the
 * editor is usable immediately; the pipeline UI for these slots appears
 * when this resolves.
 *
 * A slot that already has a workbench by then (the user acted first) is
 * left alone. This is not an edit — no undo entry, no dirty flag — but
 * the workbenches are also added to the snapshots already in the undo
 * history (`attachLateWorkbenches`), so undoing an edit made while the
 * audio was still loading doesn't drop them again.
 */
export async function hydrateRestoredSources(
  pending: readonly PendingSource[],
): Promise<void> {
  const store = getSourceStore();
  if (!store || pending.length === 0) return;
  const epoch = loadEpoch;
  // Remember what each slot holds right now (we run synchronously after
  // `applyLoadedSession`). The user can edit while the audio is read; a
  // source is only attached to a state whose slot still has this exact
  // sample data — a removed, cleared, replaced or shifted sample must not
  // inherit it.
  const loadedSong = song();
  if (!loadedSong) return;
  const expected = new Map<string, SlotData>();
  for (const p of pending) {
    const key = pendingKey(p);
    const data = slotData(loadedSong, key);
    if (data) expected.set(key, data);
  }
  awaitingSources = expected;
  setHydratingSources(true);
  try {
    const { samplerSources, xmSamplerSources, unread } =
      await resolvePendingSources(pending, store);
    if (epoch !== loadEpoch) return;
    unreadSources = unread
      .map((p) => ({ pending: p, data: expected.get(pendingKey(p)) }))
      .filter((u): u is UnreadSource => u.data !== undefined);
    const s = song();
    // Built once, so the live maps and every history snapshot share the
    // same workbench objects.
    const restoredPt: Array<[number, SampleWorkbench]> = [];
    const restoredXm: Array<[number, number, XmSampleWorkbench]> = [];
    if (s?.format === "PT2") {
      for (const [slotStr, src] of Object.entries(samplerSources)) {
        restoredPt.push([
          parseInt(slotStr, 10),
          {
            ...workbenchFromWavData(src.wav, src.sourceName),
            chain: src.chain,
            pt: src.pt,
          },
        ]);
      }
    } else if (s?.format === "FT2") {
      for (const [key, src] of Object.entries(xmSamplerSources)) {
        const [inst, idx] = parseXmKey(key);
        if (inst === null) continue;
        restoredXm.push([
          inst,
          idx,
          {
            ...xmWorkbenchFromWav(src.wav, src.sourceName),
            chain: src.chain,
            xm: src.xm,
          },
        ]);
      }
    }
    // Memoised per (input map, set of additions): snapshots that share a
    // map and get the same additions keep sharing one map.
    const memo = <M extends object>() => {
      const cache = new Map<M, Map<string, M>>();
      return (map: M, sig: string, build: () => M): M => {
        let bySig = cache.get(map);
        if (!bySig) cache.set(map, (bySig = new Map()));
        let out = bySig.get(sig);
        if (!out) bySig.set(sig, (out = build()));
        return out;
      };
    };
    const ptMemo = memo<WorkbenchMap>();
    const xmMemo = memo<XmWorkbenchMap>();
    attachLateWorkbenches(
      (map, entrySong) => {
        const add = restoredPt.filter(([slot]) => {
          const key = String(slot);
          return (
            !map.has(slot) &&
            expected.has(key) &&
            slotData(entrySong, key) === expected.get(key)
          );
        });
        if (add.length === 0) return map;
        return ptMemo(map, add.map(([slot]) => slot).join(","), () => {
          let out = map;
          for (const [slot, wb] of add) out = withWorkbench(out, slot, wb);
          return out;
        });
      },
      (map, entrySong) => {
        const add = restoredXm.filter(([inst, idx]) => {
          const key = xmWorkbenchKey(inst, idx);
          return (
            !map.has(key) &&
            expected.has(key) &&
            slotData(entrySong, key) === expected.get(key)
          );
        });
        if (add.length === 0) return map;
        return xmMemo(
          map,
          add.map(([inst, idx]) => xmWorkbenchKey(inst, idx)).join(","),
          () => {
            let out = map;
            for (const [inst, idx, wb] of add) {
              out = withXmWorkbench(out, inst, idx, wb);
            }
            return out;
          },
        );
      },
    );
  } catch {
    // The store failed mid-read. The slots keep playing from the song
    // bytes; they just come back without their workbenches.
  } finally {
    if (epoch === loadEpoch) awaitingSources = null;
    setHydratingSources(false);
  }
}

type SlotData = Int8Array | Int16Array;
type UnreadSource = { pending: PendingSource; data: SlotData };

const pendingKey = (p: PendingSource): string =>
  p.kind === "pt" ? String(p.slot) : p.key;

/** Sample data held by the slot a pending source belongs to: a PT slot
 *  index (`"3"`) or an XM `"inst:sampleIdx"` key. */
function slotData(s: Song, key: string): SlotData | undefined {
  if (s.format === "PT2") {
    return key.includes(":") ? undefined : s.samples[parseInt(key, 10)]?.data;
  }
  const [inst, idx] = parseXmKey(key);
  if (inst === null) return undefined;
  return s.instruments[inst - 1]?.samples[idx]?.data;
}

/**
 * Slots whose source audio is still being read, with the sample data
 * they held at load. Null when no hydration is in flight.
 */
let awaitingSources: Map<string, SlotData> | null = null;

/**
 * True while the restored source for this slot (PT slot index or XM
 * `"inst:sampleIdx"` key) is still being read. Editors must not wrap the
 * slot's rendered bytes in a fresh workbench meanwhile: it would shadow
 * the real source, whose audio the next autosave would then sweep.
 */
export function sourcePending(key: string | number): boolean {
  if (!awaitingSources) return false;
  const k = String(key);
  const data = awaitingSources.get(k);
  const s = song();
  return data !== undefined && !!s && slotData(s, k) === data;
}

/**
 * Sources whose audio could not be read this session (see
 * `resolvePendingSources`). Reset on every load.
 */
let unreadSources: UnreadSource[] = [];

/**
 * The unread sources that still belong to the song as it is now — the
 * slot holds the same sample data and has no workbench of its own. Passed
 * to autosave so their audio stays referenced.
 */
export function unreadSourcesSnapshot(): PendingSource[] {
  const s = song();
  if (!s) return [];
  return unreadSources
    .filter(({ pending: p, data }) => {
      const key = pendingKey(p);
      if (slotData(s, key) !== data) return false;
      return p.kind === "pt"
        ? !workbenches().has(p.slot)
        : ![...xmWorkbenches().keys()].some((k) => k === p.key);
    })
    .map((u) => u.pending);
}

export function applyLoadedSession(loaded: LoadedSession): void {
  if (!loaded.song) return;
  loadEpoch++;
  awaitingSources = null;
  unreadSources = [];
  // Every load — local, cloud, or share — starts with a clean origin.
  // Cloud paths re-set it explicitly after this call; local paths
  // (file picker / drag-drop / share-link recipient) leave it null.
  setCloudOrigin(null);
  // The "opened from a share link" banner describes the previous song.
  // (The share loader raises it again AFTER this call for its own load.)
  dismissSharedBanner();
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
  // Selections and "which thing is selected" markers index into the OLD
  // song. Left alone they survive into the new one — the first Backspace /
  // Delete / cut then hits the old range, a waveform selection gets
  // adopted as a loop, and the instrument cursor sits on a slot the user
  // never picked in this project.
  clearSelection();
  clearXmSelection();
  setSampleSelection(null);
  setXmSampleSelection(null);
  clearSelectedEffect();
  setXmSelectedEffectIndex(null);
  setXmSelectedEffectParam(null);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
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
        channel: loaded.cursor.channel,
        field: "note",
      });
    }
  } else {
    resetCursor();
    resetXmCursor();
    setPlayPos({ order: 0, row: 0 });
  }
  // FT2: put the editor back where it was. After `setSong` and the
  // cursor seed above, and in this order — picking the instrument resets
  // the sample index, so the index goes last, clamped to the samples
  // the instrument really has.
  if (loaded.xmEdit && loaded.song.format === "FT2") {
    const edit = loaded.xmEdit;
    setXmCursor({ ...xmCursor(), field: edit.field });
    setCurrentXmOctave(edit.octave);
    setCurrentXmInstrument(edit.instrument);
    const samples =
      loaded.song.instruments[edit.instrument - 1]?.samples.length ?? 0;
    setCurrentXmSampleIndex(
      Math.max(0, Math.min(samples - 1, edit.sampleIndex)),
    );
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
  // A persisted cursor / mute snapshot is only validated against the
  // format's limits, not this song's actual order count, row counts and
  // channel count — clamp against the real thing.
  reconcileUiToSong();
  setDirty(false);
}

/**
 * The cursor to persist for the loaded song. The on-disk shape is the PT
 * `Cursor`; FT2 projects edit through `xmCursor`, so its position is
 * mapped onto that shape instead of saving the dormant PT cursor. The
 * field can't be (PT and FT2 field names don't line up) — it travels in
 * `xmEditSnapshot` instead.
 */
export function cursorForPersistence(): Cursor {
  if (song()?.format !== "FT2") return cursor();
  const c = xmCursor();
  return { order: c.order, row: c.row, channel: c.channel, field: "note" };
}

/** FT2 editing state to persist alongside the song, or undefined for a
 *  PT project. Reads the signals, so calling it inside an effect makes
 *  the effect follow them. */
export function xmEditSnapshot(): XmEditSnapshot | undefined {
  if (song()?.format !== "FT2") return undefined;
  return {
    instrument: currentXmInstrument(),
    sampleIndex: currentXmSampleIndex(),
    octave: currentXmOctave(),
    field: xmCursor().field,
  };
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
 * anything else → strict M.K. `.mod`. Resolves `true` when the file was
 * loaded, `false` when it was rejected (the reason is in `error()`).
 *
 * Phase 2: XM files now parse end-to-end into an `XmSong`, but
 * `applyLoadedSession`'s editor-runtime gate still rejects FT2 (the editor
 * itself is Phase 3 work). The parse result flows in so callers see
 * "FT2 mode not yet supported" with a successful parse behind it, not a
 * bare error from the magic sniff.
 */
export async function loadFile(file: File): Promise<boolean> {
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
    return true;
  } catch (e) {
    // Parsing happens before `applyLoadedSession`, so a rejected file has
    // not touched the editor: the open song (and its playback) carries on.
    // Flipping transport to "idle" here used to desync the UI from a
    // still-running worklet — only do it when there is no song at all.
    // Resolves `false` so callers don't treat the failure as a load
    // (share banner, cloud origin).
    const msg = e instanceof Error ? e.message : String(e);
    setError(`Could not open ${file.name}: ${msg}`);
    if (!song()) setTransport("idle");
    return false;
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

/**
 * FT2 counterpart of `withInfoTextAsSampleNames`: stamp the info-text
 * lines into the instrument names, the slot an `.xm` has for a message
 * (and where loading one reads the info text back from). Same rule as
 * PT — a no-op on empty text; otherwise every instrument's name becomes
 * its line, or blank past the end of the text. Instruments are appended
 * when the text has more lines than the song has instruments, up to the
 * format's 128.
 */
export function withInfoTextAsInstrumentNames(s: XmSong, text: string): XmSong {
  if (text.length === 0) return s;
  const lines = wrapInfoText(text, XM_INSTRUMENT_NAME_MAX, XM_MAX_INSTRUMENTS);
  const count = Math.max(s.instruments.length, lines.length);
  const instruments: XmInstrument[] = [];
  for (let i = 0; i < count; i++) {
    instruments.push({
      ...(s.instruments[i] ?? emptyXmInstrument()),
      name: lines[i] ?? "",
    });
  }
  return { ...s, instruments };
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
  const bytes = writeXm(withInfoTextAsInstrumentNames(s, infoText()));
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
    xmInterpolation: settings().ft2Interpolation,
    xmRamping: settings().ft2Ramping,
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
 * MP3 counterpart of `exportWav`. Same render pipeline, but encodes to MP3
 * via a dynamically-imported helper so the encoder (~85 KB minified) ships
 * in a separate Vite chunk that only downloads when the user actually
 * exports. Async because the encoder yields to the UI thread periodically;
 * the menu item is fire-and-forget — `void exportMp3()` at the call site.
 */
export async function exportMp3(): Promise<void> {
  const s = song();
  if (!s) return;
  const playbackSong =
    s.format === "PT2"
      ? songForPlayback(withInfoTextAsSampleNames(s, infoText()))
      : s;
  const sampleRate = 44100;
  setMp3ExportState({ phase: "rendering", frac: NaN });
  // Yield once so the modal has a chance to mount before render kicks off.
  await new Promise<void>((r) => setTimeout(r, 0));
  try {
    const audio = await renderToBufferAsync(playbackSong, {
      sampleRate,
      maxSeconds: 30 * 60,
      stopOnSongEnd: true,
      amigaModel: settings().paulaModel,
      stereoSeparation: settings().stereoSeparation,
      xmInterpolation: settings().ft2Interpolation,
      xmRamping: settings().ft2Ramping,
    });
    setMp3ExportState({ phase: "encoding", frac: 0 });
    const { encodeMp3 } = await import("~/core/audio/mp3Encode");
    const bytes = await encodeMp3(audio, {
      onProgress: (frac) => setMp3ExportState({ phase: "encoding", frac }),
    });
    io.download(
      deriveExportFilename(filename(), s.title, "mp3"),
      bytes,
      "audio/mpeg",
    );
  } finally {
    setMp3ExportState(null);
  }
}

/**
 * `.retro` is the lossless round-trip format. Save .mod loses the cursor
 * position, current sample, edit step, mute state, and pattern names.
 */
/**
 * Build the `.retro` payload for the currently loaded song. Factored so
 * both the download path (`saveProject`) and the server-save path can
 * reuse the same snapshot logic.
 */
export function projectBytes(): Uint8Array | null {
  const s = song();
  if (!s) return null;
  const isPt2 = s.format === "PT2";
  const isXm = s.format === "FT2";
  return projectToBytes({
    song: s,
    filename: filename(),
    infoText: infoText(),
    view: view(),
    cursor: cursorForPersistence(),
    currentSample: currentSample(),
    currentOctave: currentOctave(),
    editStep: editStep(),
    xmEdit: xmEditSnapshot(),
    chiptuneSources: isPt2 ? chiptuneSourcesSnapshot() : undefined,
    samplerSources: isPt2 ? samplerSourcesSnapshot() : undefined,
    patternNames: patternNames(),
    mutedChannels: mutedChannels(),
    soloedChannels: soloedChannels(),
    xmSamplerSources: isXm ? xmSamplerSourcesSnapshot() : undefined,
    xmChiptuneSources: isXm ? xmChiptuneSourcesSnapshot() : undefined,
  });
}

export function saveProject(): void {
  const s = song();
  if (!s) return;
  const bytes = projectBytes();
  if (!bytes) return;
  io.download(
    deriveProjectFilename(filename(), s.title),
    bytes,
    "application/json",
  );
  setDirty(false);
}

/**
 * Native-binary bytes for the loaded song. PT2 → `.mod`, FT2 → `.xm`.
 * Returns `null` when no song is loaded.
 */
export function moduleBytes(): Uint8Array | null {
  const s = song();
  if (!s) return null;
  if (s.format === "PT2") {
    return writeModule(withInfoTextAsSampleNames(s, infoText()));
  }
  return writeXm(withInfoTextAsInstrumentNames(s, infoText()));
}

/**
 * Load bytes that came from the server into the editor by tunneling
 * them through the same `loadFile` path the file picker / drag-drop
 * use — the format sniff and `applyLoadedSession` plumbing is reused
 * for free. The `name` drives the extension-based format pick.
 */
export async function loadServerBytes(
  bytes: Uint8Array,
  name: string,
): Promise<boolean> {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return loadFile(new File([ab], name));
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
