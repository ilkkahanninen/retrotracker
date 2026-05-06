import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { InfoView } from "./components/InfoView";
import { Menu, type MenuItem } from "./components/Menu";
import { PatternGrid } from "./components/PatternGrid";
import { PatternHelp } from "./components/PatternHelp";
import { SampleList } from "./components/SampleList";
import { SampleView, type SampleSelection } from "./components/SampleView";
import { SettingsView } from "./components/SettingsView";
import { bounceSelection } from "./core/audio/bounce";
import type { ChiptuneParams } from "./core/audio/chiptune";
import {
  defaultEffect,
  emptySamplerWorkbench,
  materializeSource,
  runChain,
  runPipeline,
  sourceDisplayName,
  sourceWantsFullLoop,
  workbenchFromChiptune,
  workbenchFromInt8,
  workbenchFromWav,
  workbenchFromWavData,
  workbenchToAlt,
  type EffectKind,
  type EffectNode,
  type MonoMix,
  type ResampleMode,
  type SampleWorkbench,
  type SourceKind,
} from "./core/audio/sampleWorkbench";
import {
  clearRange,
  pasteSlice,
  readSlice,
  type PatternRange,
} from "./core/mod/clipboardOps";
import { visibleRowRangeForOrder } from "./core/mod/flatten";
import { PERIOD_TABLE, emptySong } from "./core/mod/format";
import {
  cleanupOrders,
  clearSample,
  deleteCellPullUp,
  deleteOrder,
  deleteRowPullUp,
  duplicatePatternAtOrder,
  insertCellPushDown,
  insertOrder,
  insertRowPushDown,
  newPatternAtOrder,
  nextPatternAtOrder,
  prevPatternAtOrder,
  replaceSampleData,
  setCell,
  setSample,
  transposeRange,
} from "./core/mod/mutations";
import { parseModule } from "./core/mod/parser";
import { cropSample, cutSample } from "./core/mod/sampleSelection";
import { CHANNELS, ROWS_PER_PATTERN } from "./core/mod/types";
import { writeModule } from "./core/mod/writer";
import { renderToBuffer } from "./core/audio/offlineRender";
import { writeWav } from "./core/audio/wav";
import { songForPlayback } from "./core/audio/loopTruncate";
import { registerAppKeybinds } from "./state/appKeybinds";
import { resetChannelLevels } from "./state/channelLevel";
import {
  isChannelMuted,
  resetChannelMute,
  toggleMute,
  toggleSolo,
} from "./state/channelMute";
import { clipboardSlice, setClipboardSlice } from "./state/clipboard";
import {
  cursor,
  moveDown,
  moveRight,
  requestJumpToTop,
  resetCursor,
  setCursor,
} from "./state/cursor";
import {
  clearFieldPatch,
  currentOctave,
  currentSample,
  decEditStep,
  editStep,
  incEditStep,
  selectSample,
  setCurrentOctave,
  setCurrentSample,
  setEditStep,
} from "./state/edit";
import {
  INFO_LINE_WIDTH,
  INFO_MAX_LINES,
  infoText,
  infoTextFromSampleNames,
  setInfoText,
  wrapInfoText,
} from "./state/info";
import { deriveExportFilename, io } from "./state/io";
import {
  PATTERN_NAME_MAX,
  loadPatternNames,
  patternNames,
  resetPatternNames,
  setPatternName,
} from "./state/patternNames";
import {
  deriveProjectFilename,
  loadSession,
  projectFromBytes,
  projectToBytes,
  saveSession,
  type SamplerSourceInputs,
} from "./state/persistence";
import {
  currentEngine,
  disposeEngine,
  jumpPlaybackToOrder,
  livePreviewSwap,
  stopEngine,
  togglePlayPattern,
  togglePlaySong,
  triggerPreview,
} from "./state/playback";
import * as preview from "./state/preview";
import {
  clearAllWorkbenches,
  getWorkbench,
  setWorkbench,
  withWorkbench,
  withoutWorkbench,
  workbenches,
} from "./state/sampleWorkbench";
import { clearAllStashedLoops, clearStashedLoop } from "./state/loopStash";
import { setSampleSelection } from "./state/sampleSelection";
import {
  clearSelection,
  makeSelection,
  selection,
  selectionAnchor,
  setSelection,
  setSelectionAnchor,
} from "./state/selection";
import { settings } from "./state/settings";
import { installShortcuts } from "./state/shortcuts";
import {
  canRedo,
  canUndo,
  clearHistory,
  commitEdit,
  commitEditWithWorkbenches,
  dirty,
  playMode,
  playPos,
  redo,
  setDirty,
  setPlayMode,
  setPlayPos,
  setSong,
  setTransport,
  song,
  transport,
  undo,
} from "./state/song";
import { applyColorScheme, applyUiScale } from "./state/theme";
import { setView, view } from "./state/view";

/** Hard cap on the `.retro` project file size. The header indicator turns
 *  yellow at the warning threshold and red once the limit is exceeded. */
const PROJECT_SIZE_LIMIT_BYTES = 5 * 1024 * 1024;
const PROJECT_SIZE_WARN_BYTES = 4 * 1024 * 1024;

/** Format a byte count for the header size indicator: KB under 1 MB,
 *  MB with two decimals otherwise. */
function formatProjectSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  return Math.max(0, Math.round(bytes / 1024)) + " KB";
}

export const App: Component = () => {
  const [error, setError] = createSignal<string | null>(null);
  const [filename, setFilename] = createSignal<string | null>(null);
  const [dragOver, setDragOver] = createSignal(false);
  /**
   * True while the user is double-click-editing the song title in the
   * pattern metapane. Local UI state — same shape as SampleList's inline
   * rename, just a single-target version since there's only one title.
   */
  const [editingTitle, setEditingTitle] = createSignal(false);

  /**
   * Order-list row currently being inline-renamed, or null when none. Keyed
   * by order index (not pattern index) so a pattern that appears multiple
   * times in the order list only renders one input at a time — keying by
   * pattern would race two refs' focus calls and the loser's blur would
   * commit an empty value before the user could type. Rename still
   * applies to the underlying pattern, so siblings update on commit.
   */
  const [editingOrderIdx, setEditingOrderIdx] = createSignal<number | null>(
    null,
  );

  const commitPatternRename = (patternIdx: number, raw: string) => {
    setEditingOrderIdx(null);
    setPatternName(patternIdx, raw);
  };

  /**
   * Apply a fully-parsed session (from `.retro`, from localStorage, or from
   * a freshly-parsed .mod with no UI overrides) to every relevant signal.
   * Used by Open and the autosave-restore path so they go through one place.
   */
  const applyLoadedSession = (loaded: {
    song: ReturnType<typeof song>;
    filename: string | null;
    infoText?: string;
    view?: ReturnType<typeof view>;
    cursor?: ReturnType<typeof cursor>;
    currentSample?: number;
    currentOctave?: number;
    editStep?: number;
    /** Per-slot chiptune source params restored from the project. */
    chiptuneSources?: Record<number, ChiptuneParams>;
    /** Per-slot sampler source WAVs restored from the project. */
    samplerSources?: Record<number, SamplerSourceInputs>;
    /** Project-only pattern names (pattern index → name). */
    patternNames?: Record<number, string>;
  }) => {
    if (!loaded.song) return;
    // Halt any in-flight playback before swapping the song — otherwise the
    // worklet keeps mixing the old song under the new UI state.
    stopEngine();
    setPlayMode(null);
    // Mute/solo are session-only and tied to the previous song's channels;
    // carrying them over surprises the user ("why is channel 3 silent?").
    resetChannelMute();
    // Drop stale VU bars from the previous song's last playing quantum;
    // the worklet won't emit a fresh `level` event until playback resumes.
    resetChannelLevels();
    // Pattern names are project-only and tied to the previous song's
    // pattern indices — clear before restoring this load's set.
    resetPatternNames();
    if (loaded.patternNames) loadPatternNames(loaded.patternNames);
    setSong(loaded.song);
    setFilename(loaded.filename);
    setInfoText(loaded.infoText ?? "");
    if (loaded.view) setView(loaded.view);
    if (loaded.cursor) {
      setCursor(loaded.cursor);
      setPlayPos({ order: loaded.cursor.order, row: loaded.cursor.row });
    } else {
      resetCursor();
      setPlayPos({ order: 0, row: 0 });
    }
    if (typeof loaded.currentSample === "number")
      setCurrentSample(loaded.currentSample);
    if (typeof loaded.currentOctave === "number")
      setCurrentOctave(loaded.currentOctave);
    if (typeof loaded.editStep === "number") setEditStep(loaded.editStep);
    clearHistory();
    // Both chiptune and sampler workbenches survive a session boundary now:
    // chiptune via tiny `ChiptuneParams` JSON (synth is deterministic), sampler
    // via 16-bit WAV bytes embedded in the project. Only the source half is
    // restored — chain + PT params reset to defaults — but the int8 in the
    // song bytes is the canonical playback data, so audio is unchanged either
    // way; the user just gets a fresh chain UI.
    clearAllWorkbenches();
    clearAllStashedLoops();
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
    setTransport("ready");
    setDirty(false);
  };

  /**
   * Open a file the user picked / dropped. Sniffs the extension: `.retro`
   * round-trips through the project format, anything else is parsed as
   * a `.mod`. Errors land in the `error` signal which the dropzone shows.
   */
  const loadFile = async (file: File) => {
    setError(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      if (/\.retro$/i.test(file.name)) {
        const loaded = projectFromBytes(buf);
        if (!loaded) throw new Error("Invalid .retro project");
        applyLoadedSession(loaded);
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
  };

  let fileInput: HTMLInputElement | undefined;

  const onPickFile = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void loadFile(file);
    // Clear so re-picking the same file still fires onChange.
    input.value = "";
  };

  const openFilePicker = () => fileInput?.click();

  /**
   * Serialise the current Song to a `.mod` file and trigger a browser
   * download. No-op when no song is loaded, but otherwise works at any
   * transport state — saving mid-playback is harmless since `writeModule`
   * is read-only.
   */
  const exportMod = () => {
    const s = song();
    if (!s) return;
    const stamped = withInfoTextAsSampleNames(s, infoText());
    const bytes = writeModule(stamped);
    io.download(
      deriveExportFilename(filename(), s.title),
      bytes,
      "audio/x-mod",
    );
  };

  /**
   * Render the current song to a 16-bit stereo .wav at 44.1 kHz and trigger
   * a download. Pipes through `songForPlayback` (loop-truncate fix-up) so
   * the export sounds the way the editor's preview does, and forwards the
   * user's Paula model + stereo-separation settings into the offline
   * renderer so the WAV matches what they hear live.
   *
   * Synchronous: a 5-minute song renders in ~1–2 s on a modern laptop,
   * which is acceptable for a button click. Worker-offloading is the next
   * step if anyone hits the freeze threshold on a long song. The hard cap
   * `maxSeconds = 30 min` is a safety net — `stopOnSongEnd: true` (the
   * default) cuts at the song's loop point, which fires for any PT module
   * that loops cleanly.
   */
  const exportWav = () => {
    const s = song();
    if (!s) return;
    const stamped = withInfoTextAsSampleNames(s, infoText());
    const playbackSong = songForPlayback(stamped);
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
  };

  /**
   * Stamp `text` into the sample-name slots of `song`, one line per slot.
   * Pure: returns the same Song reference when `text` is empty (we don't
   * want exporting to silently rewrite samples a user didn't ask to
   * touch). Per-line truncation to 22 chars matches the .mod sample-name
   * field width — writeModule's writeAscii would otherwise drop the tail.
   */
  function withInfoTextAsSampleNames(
    s: ReturnType<typeof song>,
    text: string,
  ): NonNullable<ReturnType<typeof song>> {
    if (!s) throw new Error("withInfoTextAsSampleNames: no song");
    if (text.length === 0) return s;
    const lines = wrapInfoText(text, INFO_LINE_WIDTH, INFO_MAX_LINES);
    const samples = s.samples.map((sample, i) => ({
      ...sample,
      name: lines[i] ?? "",
    }));
    return { ...s, samples };
  }

  /**
   * Build the slot→params map of chiptune workbenches for persistence.
   */
  const chiptuneSourcesSnapshot = (): Record<number, ChiptuneParams> => {
    const out: Record<number, ChiptuneParams> = {};
    for (const [slot, wb] of workbenches()) {
      if (wb.source.kind === "chiptune") out[slot] = wb.source.params;
    }
    return out;
  };

  /**
   * Build the slot→source map of sampler workbenches for persistence —
   * source WAV plus the chain and PT params so the pipeline restores
   * exactly as the user left it. Empty workbenches (placeholder created by
   * toggling Sampler → Chiptune on a fresh slot) are skipped: there's no
   * audio to store and the toggle recreates them on demand.
   */
  const samplerSourcesSnapshot = (): Record<number, SamplerSourceInputs> => {
    const out: Record<number, SamplerSourceInputs> = {};
    for (const [slot, wb] of workbenches()) {
      if (wb.source.kind !== "sampler") continue;
      const hasAudio = wb.source.wav.channels.some((ch) => ch.length > 0);
      if (!hasAudio) continue;
      out[slot] = {
        sourceName: wb.source.sourceName,
        wav: wb.source.wav,
        chain: wb.chain,
        pt: wb.pt,
      };
    }
    return out;
  };

  /**
   * Serialise the current Song + UI state to a `.retro` project file. This
   * is the format that round-trips losslessly — Save .mod loses the cursor
   * position, current sample, edit step, etc.
   */
  const saveProject = () => {
    const s = song();
    if (!s) return;
    const bytes = projectToBytes({
      song: s,
      filename: filename(),
      infoText: infoText(),
      view: view(),
      cursor: cursor(),
      currentSample: currentSample(),
      currentOctave: currentOctave(),
      editStep: editStep(),
      chiptuneSources: chiptuneSourcesSnapshot(),
      samplerSources: samplerSourcesSnapshot(),
      patternNames: patternNames(),
    });
    io.download(
      deriveProjectFilename(filename(), s.title),
      bytes,
      "application/json",
    );
    setDirty(false);
  };

  /**
   * Reset to a blank "M.K." song. Confirms with the user first if the
   * current project has unsaved changes — the prompt uses the browser's
   * native `confirm`, which jsdom stubs to true (so tests don't hang).
   */
  const newProject = () => {
    if (dirty()) {
      const ok =
        typeof window !== "undefined" && window.confirm
          ? window.confirm("Discard unsaved changes?")
          : true;
      if (!ok) return;
    }
    applyLoadedSession({ song: emptySong(), filename: null });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    // A single .mod / .retro replaces the current project — anything else is
    // treated as a batch of WAV imports and fanned out across free slots.
    const first = files[0]!;
    if (files.length === 1 && /\.(mod|retro)$/i.test(first.name)) {
      void loadFile(first);
      return;
    }
    void loadWavsIntoFreeSlots(Array.from(files));
  };

  /**
   * Decode each dropped WAV and assign them to consecutive free sample slots,
   * starting at the current selection (using it first if empty, otherwise
   * walking forward via `nextFreeSlot`). All slot writes land in a single
   * history entry so undo reverts the whole batch.
   */
  const loadWavsIntoFreeSlots = async (files: File[]) => {
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
    // Sample view: the user is actively editing this slot — dropping a WAV
    // here means "replace this sample", so we land on `startSlot` even when
    // it already holds data. Pattern view keeps the existing behaviour
    // (start at the current slot only when it's empty, then fan forward),
    // since drops there are typically batch imports the user expects to
    // see appended without clobbering anything.
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
        // Sample-view overwrite of an occupied slot (i === 0 + overwriteCurrent):
        // clear the slot first so `writeWorkbenchToSongPure` treats this as a
        // fresh write — the new WAV's filename becomes the sample name and
        // volume/finetune reset to defaults. Without this, dropping a new
        // WAV onto a named slot would silently leave the old name attached
        // to brand-new audio.
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
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const onDragLeave = () => setDragOver(false);

  /**
   * Move the cursor to `next`. Disabled during playback (the cursor is also
   * hidden), and while stopped the playhead tracks the cursor so the next
   * Shift+Space (Play from cursor) starts where the user is editing.
   *
   * Plain-cursor moves drop the active range selection AND its anchor —
   * once the user starts navigating with arrows / clicks, the highlighted
   * rectangle is stale and would otherwise just confuse the eye. The
   * shift-arrow / drag handlers go through `extendSelection` instead,
   * which keeps the anchor and updates the selection rectangle as a unit.
   */
  const applyCursor = (next: ReturnType<typeof cursor>) => {
    if (transport() === "playing") return;
    setCursor(next);
    setPlayPos({ order: next.order, row: next.row });
    clearSelection();
  };

  /**
   * Move the cursor to `next` AND extend the selection from its anchor.
   * Used by shift-arrow nav and (indirectly, via PatternGrid) by mouse
   * drag. The first call after a plain navigation re-anchors at the
   * cursor's PRE-MOVE position so the originating cell is included.
   *
   * Selection is single-pattern: if `next.order` differs from the anchor's
   * order, we drop the existing selection and re-anchor at `next`. That
   * keeps the rectangle well-defined without trying to span orders.
   */
  const extendSelection = (next: ReturnType<typeof cursor>) => {
    if (transport() === "playing") return;
    const before = cursor();
    let anchor = selectionAnchor();
    if (!anchor) {
      anchor = {
        order: before.order,
        row: before.row,
        channel: before.channel,
      };
      setSelectionAnchor(anchor);
    }
    setCursor(next);
    setPlayPos({ order: next.order, row: next.row });
    if (next.order !== anchor.order) {
      const reAnchor = {
        order: next.order,
        row: next.row,
        channel: next.channel,
      };
      setSelectionAnchor(reAnchor);
      setSelection(null);
      return;
    }
    setSelection(
      makeSelection(
        anchor.order,
        anchor.row,
        anchor.channel,
        next.row,
        next.channel,
      ),
    );
  };

  /** Same as applyCursor but for movement functions that need the Song. */
  const applyCursorWithSong = (
    fn: (
      c: ReturnType<typeof cursor>,
      s: NonNullable<ReturnType<typeof song>>,
    ) => ReturnType<typeof cursor>,
  ) => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    applyCursor(fn(cursor(), s));
  };

  // ─── Shift+arrow range extension ────────────────────────────────────────
  // Shift+left/right hops a WHOLE channel at a time (skipping the per-cell
  // sub-fields the user has to traverse during plain editing) — when the
  // user is sweeping out a selection rectangle the sub-field doesn't
  // matter, so jumping directly to the neighbouring channel matches the
  // user's mental model. Shift+up/down/page step rows. All of these stay
  // within the cursor's current pattern; the selection rectangle is
  // single-pattern by design (see PatternSelection in state/selection.ts).
  const stepChannelLeft = (c: ReturnType<typeof cursor>) => ({
    ...c,
    channel: Math.max(0, c.channel - 1),
  });
  const stepChannelRight = (c: ReturnType<typeof cursor>) => ({
    ...c,
    channel: Math.min(CHANNELS - 1, c.channel + 1),
  });
  // Clamp row movement to the visible-row range of the cursor's order so
  // shift+arrow / shift+page can't extend a selection into Dxx-truncated
  // territory (or above an inbound Dxx-target row, in the symmetric case).
  // Falls back to the full 0..63 range when no song is loaded yet.
  const visibleRows = (order: number): { first: number; last: number } => {
    const s = song();
    return s
      ? (visibleRowRangeForOrder(s, order) ?? {
          first: 0,
          last: ROWS_PER_PATTERN - 1,
        })
      : { first: 0, last: ROWS_PER_PATTERN - 1 };
  };
  const stepRowUp = (c: ReturnType<typeof cursor>) => ({
    ...c,
    row: Math.max(visibleRows(c.order).first, c.row - 1),
  });
  const stepRowDown = (c: ReturnType<typeof cursor>) => ({
    ...c,
    row: Math.min(visibleRows(c.order).last, c.row + 1),
  });
  const stepRowPageUp = (c: ReturnType<typeof cursor>, n: number) => ({
    ...c,
    row: Math.max(visibleRows(c.order).first, c.row - Math.max(1, n)),
  });
  const stepRowPageDown = (c: ReturnType<typeof cursor>, n: number) => ({
    ...c,
    row: Math.min(visibleRows(c.order).last, c.row + Math.max(1, n)),
  });

  /**
   * Write a note at the cursor and audition it. No-op if the cursor isn't on
   * the note field, the song isn't loaded, the resulting note is out of
   * ProTracker's 3-octave range, or playback is active (note entry is a
   * stopped-mode action).
   */
  const enterNote = (semitoneOffset: number) => {
    if (transport() === "playing") return;
    const c = cursor();
    if (c.field !== "note") return;
    const s = song();
    if (!s) return;
    const noteIdx = (currentOctave() - 1) * 12 + semitoneOffset;
    if (noteIdx < 0 || noteIdx >= 36) return;
    const period = PERIOD_TABLE[0]![noteIdx]!;
    const sampleNum = currentSample();

    commitEdit((song) =>
      setCell(song, c.order, c.row, c.channel, {
        period,
        sample: sampleNum,
      }),
    );
    advanceByEditStep();

    const sample = s.samples[sampleNum - 1];
    if (sample) triggerPreview(sampleNum - 1, sample, period);
  };

  /**
   * Audition the current sample at the keyboard-mapped pitch — used in the
   * sample view to preview without touching the song. No commit, no cursor
   * advance, no period write. Out-of-range notes (offsets that fall outside
   * PT's 3-octave table) silently no-op.
   */
  const previewSampleAtPitch = (semitoneOffset: number) => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const noteIdx = (currentOctave() - 1) * 12 + semitoneOffset;
    if (noteIdx < 0 || noteIdx >= 36) return;
    const period = PERIOD_TABLE[0]![noteIdx]!;
    const sample = s.samples[currentSample() - 1];
    if (sample) triggerPreview(currentSample() - 1, sample, period);
  };

  /**
   * Single piano-key handler that does the right thing per view: write+audition
   * a cell in pattern view, audition-only in sample view. The shortcut's
   * `when` predicate keeps it gated to the appropriate cursor state in pattern
   * view, but in sample view the cursor field doesn't matter — the user just
   * wants to hear notes.
   */
  const onPianoKey = (semitoneOffset: number) => {
    if (view() === "sample") previewSampleAtPitch(semitoneOffset);
    else enterNote(semitoneOffset);
  };

  /**
   * Write one hex nibble (0..F) into the field under the cursor and step
   * the cursor on. Sample numbers are clamped to ProTracker's 1..31 range
   * (5-bit field) — typing a digit that overflows just lands the cell at
   * the cap. Effect command + param have no overflow constraint (cmd is
   * one nibble, param two nibbles — all hex-aligned).
   *
   * Auto-advance is "right within the row, then down on the last sub-field":
   *   sampleHi → sampleLo → (down)
   *   effectCmd → effectHi → effectLo → (down, then jump back to effectCmd)
   * For effects we additionally rewind the field to `effectCmd` after the
   * line break so the user can keep punching three-digit effects without
   * pulling the cursor back left after each one. Matches the multi-digit
   * rhythm in PT/FT2.
   */
  const enterHexDigit = (digit: number) => {
    if (transport() === "playing") return;
    const c = cursor();
    const s = song();
    if (!s) return;
    const pat = s.patterns[s.orders[c.order] ?? -1];
    const note = pat?.rows[c.row]?.[c.channel];
    if (!note) return;

    let patch: Partial<typeof note> | null = null;
    switch (c.field) {
      case "sampleHi": {
        const raw = ((digit & 0x0f) << 4) | (note.sample & 0x0f);
        patch = { sample: Math.min(31, raw) };
        break;
      }
      case "sampleLo": {
        const raw = (note.sample & 0xf0) | (digit & 0x0f);
        patch = { sample: Math.min(31, raw) };
        break;
      }
      case "effectCmd":
        patch = { effect: digit & 0x0f };
        break;
      case "effectHi":
        patch = {
          effectParam: ((digit & 0x0f) << 4) | (note.effectParam & 0x0f),
        };
        break;
      case "effectLo":
        patch = { effectParam: (note.effectParam & 0xf0) | (digit & 0x0f) };
        break;
      default:
        return;
    }

    commitEdit((song) => setCell(song, c.order, c.row, c.channel, patch));
    const stepsRight =
      c.field === "sampleHi" ||
      c.field === "effectCmd" ||
      c.field === "effectHi";
    if (stepsRight) {
      applyCursor(moveRight(cursor()));
    } else {
      // Last sub-field of a column → advance by the edit step. At step 0
      // the cursor stays put so the user can keep stamping the same cell.
      advanceByEditStep();
      // After completing a 3-nibble effect, rewind the column to effectCmd
      // on the new row so a follow-up effect can be typed without manually
      // moving the cursor back left. Skip the rewind at edit step 0 — there
      // we WANT the cursor to stay on effectLo for chord-style overwrites.
      if (c.field === "effectLo" && editStep() > 0) {
        applyCursor({ ...cursor(), field: "effectCmd" });
      }
    }
  };

  /**
   * Clear the field under the cursor (note → period, sample → sample number,
   * effect cmd/hi/lo → corresponding effect bytes) and step the cursor down
   * one row. No-op while playing or with no song loaded.
   */
  const clearAtCursor = () => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const c = cursor();
    const pat = s.patterns[s.orders[c.order] ?? -1];
    const note = pat?.rows[c.row]?.[c.channel];
    if (!note) return;
    const patch = clearFieldPatch(note, c.field);
    commitEdit((song) => setCell(song, c.order, c.row, c.channel, patch));
    advanceByEditStep();
  };

  /**
   * Copy the most recent non-empty effect on the cursor's channel from any
   * row above the cursor (within the current pattern) into the cursor's
   * cell, then advance. No-op when the cursor is on row 0 or no prior cell
   * on this channel carries an effect — that's a deliberate choice so the
   * key doesn't quietly write zeros and skip a row, which would make
   * accidental presses destructive.
   */
  const repeatLastEffectFromAbove = () => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const c = cursor();
    const pat = s.patterns[s.orders[c.order] ?? -1];
    if (!pat) return;
    let copy: { effect: number; effectParam: number } | null = null;
    for (let r = c.row - 1; r >= 0; r--) {
      const cell = pat.rows[r]?.[c.channel];
      if (!cell) continue;
      if (cell.effect !== 0 || cell.effectParam !== 0) {
        copy = { effect: cell.effect, effectParam: cell.effectParam };
        break;
      }
    }
    if (!copy) return;
    const patch = copy;
    commitEdit((song) => setCell(song, c.order, c.row, c.channel, patch));
    advanceByEditStep();
  };

  /**
   * Step the cursor one row down on the post-edit song. Used by structural
   * actions (Backspace pull-up, Enter push-down) where we always want to
   * track the inserted/deleted row by exactly one — edit step doesn't apply.
   */
  const advanceCursor = () => {
    const s = song();
    if (!s) return;
    applyCursor(moveDown(cursor(), s));
  };

  /**
   * FT2-style row jump after a content entry: advance by `editStep()` rows.
   * 0 leaves the cursor put (useful for stamping chords or overwriting the
   * same cell). Used by note entry, hex entry (when stepping to the next
   * row), clear, and the "repeat last effect" key — anywhere the user has
   * just *added* something to the cell, as opposed to restructuring rows.
   */
  const advanceByEditStep = () => {
    const s = song();
    if (!s) return;
    const step = editStep();
    if (step <= 0) return;
    let next = cursor();
    for (let i = 0; i < step; i++) next = moveDown(next, s);
    applyCursor(next);
  };

  // ─── Range selection / clipboard ────────────────────────────────────────

  /**
   * Cmd+A cycles through three "select all" levels:
   *   1. (no selection or smaller)  → entire current channel
   *   2. (channel-wide selection)   → entire pattern (all rows × 4 ch)
   *   3. (already pattern-wide)     → no further expansion
   *
   * The cycle key is the *exact* selection rectangle — if the user has
   * an arbitrary drag-selection active, Cmd+A jumps straight to step 1.
   *
   * The row range is clamped to the cursor order's visible band so a
   * Dxx-truncated pattern doesn't get a selection that bleeds into the
   * hidden tail (or above an inbound Dxx-target row).
   */
  const selectAllStep = () => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const c = cursor();
    const sel = selection();
    const { first, last } = visibleRows(c.order);
    const isWholePattern =
      !!sel &&
      sel.order === c.order &&
      sel.startRow === first &&
      sel.endRow === last &&
      sel.startChannel === 0 &&
      sel.endChannel === CHANNELS - 1;
    if (isWholePattern) return; // step 3+ — already maximal, no-op
    const isWholeChannel =
      !!sel &&
      sel.order === c.order &&
      sel.startRow === first &&
      sel.endRow === last &&
      sel.startChannel === c.channel &&
      sel.endChannel === c.channel;
    if (isWholeChannel) {
      // Step 2: expand to the whole pattern.
      setSelection(makeSelection(c.order, first, 0, last, CHANNELS - 1));
      return;
    }
    // Step 1 (default): select the whole current channel.
    setSelection(makeSelection(c.order, first, c.channel, last, c.channel));
  };

  /**
   * Sample-view counterpart of `selectAllStep`: span the entire int8 of the
   * current sample. No-op when the slot has no data — the button is also
   * disabled in that state, but the keyboard shortcut is unconditional so
   * we guard here too. Not gated on `transport === 'playing'` because the
   * waveform selection is purely a UI affordance — it doesn't mutate the
   * song, so the worklet sync invariant doesn't apply.
   */
  const selectAllSample = () => {
    const slot = currentSample() - 1;
    // Chiptune sources don't expose selection (no Crop/Cut/range-aware
    // effects in chiptune mode, and the synth re-renders on every param
    // edit). Mirroring the SampleView gate keeps Cmd+A inert there.
    if (getWorkbench(slot)?.source.kind === "chiptune") return;
    const s = song();
    const len = s?.samples[slot]?.data.length ?? 0;
    if (len < 2) return;
    setSampleSelection({ start: 0, end: len });
  };

  /**
   * Build a `PatternRange` from the current selection if any, otherwise from
   * the cursor's single cell. Returns null when no song is loaded — every
   * caller bails on null without erroring so this is a safe pre-check.
   */
  const rangeForClipboard = (): PatternRange | null => {
    if (!song()) return null;
    const sel = selection();
    if (sel)
      return {
        order: sel.order,
        startRow: sel.startRow,
        endRow: sel.endRow,
        startChannel: sel.startChannel,
        endChannel: sel.endChannel,
      };
    const c = cursor();
    return {
      order: c.order,
      startRow: c.row,
      endRow: c.row,
      startChannel: c.channel,
      endChannel: c.channel,
    };
  };

  /**
   * Cmd+C: read the selection (or the cursor's cell when nothing's
   * selected) into the in-memory clipboard. The slice is a deep copy so
   * later edits to the song don't mutate what's on the clipboard.
   */
  const copySelection = () => {
    const range = rangeForClipboard();
    if (!range) return;
    const s = song();
    if (!s) return;
    const slice = readSlice(s, range);
    if (!slice) return;
    setClipboardSlice({ rows: slice });
  };

  /**
   * Cmd+X: copy then clear. The clear goes through `commitEdit` so undo
   * restores the cells. After cutting we clear the selection too — the
   * highlighted cells are now empty, and a stale selection rectangle
   * just confuses the eye.
   */
  const cutSelection = () => {
    const range = rangeForClipboard();
    if (!range) return;
    const s = song();
    if (!s) return;
    const slice = readSlice(s, range);
    if (!slice) return;
    setClipboardSlice({ rows: slice });
    commitEdit((song) => clearRange(song, range));
    setSelection(null);
  };

  /**
   * Cmd+V: stamp the clipboard at the cursor, then drop the cursor onto
   * the row right after the pasted block (channel unchanged) so repeated
   * pastes stack downward without manual stepping. Cells past pattern
   * bounds are silently clipped by `pasteSlice`; the cursor advance is
   * clamped to the last row in the same way.
   */
  const pasteAtCursor = () => {
    if (transport() === "playing") return;
    const slice = clipboardSlice();
    if (!slice || slice.rows.length === 0) return;
    const c = cursor();
    commitEdit((song) =>
      pasteSlice(song, slice.rows, c.order, c.row, c.channel),
    );
    applyCursor(stepRowPageDown(c, slice.rows.length));
  };

  /**
   * Transpose the cell under the cursor — or every cell inside the active
   * selection — by `deltaSemitones`. Empty cells (no period stored) are
   * left alone; non-empty cells re-snap to PT's finetune-0 grid via
   * `transposeRange`. No-op while playing or with no song loaded.
   *
   * Scope rules mirror copy/paste: a selection wins, otherwise the cursor
   * cell is the implicit one-cell range. Selection is preserved across
   * the operation so the user can chord ⇧− ⇧− ⇧− to walk a phrase down.
   */
  const transposeAtCursor = (deltaSemitones: number) => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const sel = selection();
    const range =
      sel ??
      (() => {
        const c = cursor();
        return {
          order: c.order,
          startRow: c.row,
          endRow: c.row,
          startChannel: c.channel,
          endChannel: c.channel,
        };
      })();
    commitEdit((song) => transposeRange(song, range, deltaSemitones));
  };

  /**
   * Backspace: with an active range selection, zero every cell inside it and
   * leave the cursor + selection alone — the user expects a destructive key
   * over a highlighted block to wipe the block, not nudge the cursor. With
   * no selection, delete the cell directly above the cursor on this channel
   * and pull the rest of the channel up by one; cursor moves up one row to
   * land on the now-shifted content, mirroring text-editor backspace.
   * Affects only the current pattern in both modes.
   */
  const backspaceCell = () => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const sel = selection();
    if (sel) {
      commitEdit((song) => clearRange(song, sel));
      return;
    }
    const c = cursor();
    if (c.row <= 0) return;
    commitEdit((song) => deleteCellPullUp(song, c.order, c.row - 1, c.channel));
    // Step explicitly to row-1 rather than via moveUp: the pull-up may have
    // shifted a Dxx into the cursor's row, hiding it. moveUp from a hidden
    // row would snap-then-step (via moveByRows' recovery) to *one above* the
    // closest visible — but backspace's contract is "the cell I deleted
    // moved up; follow it", which means landing exactly on row-1.
    applyCursor({ ...c, row: c.row - 1 });
  };

  /**
   * Delete: when a range selection is active, zero every cell inside it.
   * Cursor and selection both stay put so follow-up edits can target the
   * same block. No-op without a selection — Backspace owns the
   * single-cell clear; Delete is selection-only.
   */
  const deleteSelection = () => {
    if (transport() === "playing") return;
    const sel = selection();
    if (!sel) return;
    commitEdit((song) => clearRange(song, sel));
  };

  /**
   * Shift+Backspace: like Backspace but applied across every channel.
   * With a selection, clear all channels for the selected row range (the
   * horizontal extent is widened to the whole pattern), cursor + selection
   * stay put. With no selection, delete the row directly above the cursor
   * across all channels and pull every row below up by one; cursor moves
   * up to land on the now-shifted content.
   */
  const backspaceRow = () => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const sel = selection();
    if (sel) {
      commitEdit((song) =>
        clearRange(song, {
          order: sel.order,
          startRow: sel.startRow,
          endRow: sel.endRow,
          startChannel: 0,
          endChannel: CHANNELS - 1,
        }),
      );
      return;
    }
    const c = cursor();
    if (c.row <= 0) return;
    commitEdit((song) => deleteRowPullUp(song, c.order, c.row - 1));
    // See `backspaceCell` for why we step explicitly to c.row - 1 instead of
    // routing through moveUp — same Dxx-pull-up corner case applies here.
    applyCursor({ ...c, row: c.row - 1 });
  };

  /**
   * Return: insert an empty cell at the cursor on this channel and push the
   * rest of the channel down by one (last cell falls off). Cursor advances
   * one row so the user can keep building. Affects only the current pattern.
   */
  const insertEmptyCell = () => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const c = cursor();
    commitEdit((song) => insertCellPushDown(song, c.order, c.row, c.channel));
    advanceCursor();
  };

  /**
   * Shift+Return: like Return but applied across every channel. Insert an
   * empty row at the cursor and push every row at or below down by one
   * (the last row of the pattern falls off). Cursor advances one row so
   * subsequent presses keep extending the gap downward.
   */
  const insertEmptyRow = () => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const c = cursor();
    commitEdit((song) => insertRowPushDown(song, c.order, c.row));
    advanceCursor();
  };

  /**
   * Mute / solo a channel by 0-based index. Both work during playback —
   * the gate is applied per-tick by the replayer, so the user can A/B
   * channels in real time. Out-of-range indices are no-ops.
   */
  const toggleChannelMute = (channel: number) => {
    toggleMute(channel);
  };
  const toggleChannelSolo = (channel: number) => {
    toggleSolo(channel);
  };

  // ─── Order-list editing ──────────────────────────────────────────────────

  /**
   * Move the edit cursor to a specific order slot, row 0. Drives the user-
   * triggered "jump" path (clicking an order-list slot) — bumps the
   * pattern grid's jump request so the cursor is snapped to the top of
   * the viewport instead of letting the gentle margin-scroller leave it
   * stuck at the bottom of the previous view.
   *
   * During playback the cursor is locked (the worklet drives the
   * playhead), so we re-route to the engine instead: the replayer
   * restarts at this order's row 0 and keeps playing in the same
   * playMode (song / pattern-loop). The user clicks an order list slot
   * to re-route the song without stopping first.
   */
  const jumpToOrder = (order: number) => {
    const s = song();
    if (!s) return;
    const clamped = Math.max(0, Math.min(s.songLength - 1, order));
    if (transport() === "playing") {
      void jumpPlaybackToOrder(clamped);
      return;
    }
    applyCursor({ ...cursor(), order: clamped, row: 0 });
    requestJumpToTop();
  };

  // Order-list edits are allowed mid-playback. The worklet keeps its own
  // song snapshot, so the changes show up audibly on the next play /
  // restart — just like sample-meta edits. Routed through
  // `commitEditWithWorkbenches` (instead of `commitEdit`) because that's
  // the commit primitive whose policy is "carry workbenches+patternNames
  // through unchanged AND don't gate on transport". The transforms only
  // touch `song`, so `workbenches` and `patternNames` pass through.

  // The "current position" for an order-list command follows the
  // playhead while playing and the edit cursor when stopped. Without
  // this, pressing `]` mid-playback would bump whichever slot the user
  // last navigated to before play (often slot 0), not the slot the song
  // is audibly cycling through right now.
  const activeOrder = () =>
    transport() === "playing" ? playPos().order : cursor().order;

  const stepNextPattern = () => {
    const o = activeOrder();
    commitEditWithWorkbenches((state) => {
      const next = nextPatternAtOrder(state.song, o);
      return next === state.song ? state : { ...state, song: next };
    });
  };

  const stepPrevPattern = () => {
    const o = activeOrder();
    commitEditWithWorkbenches((state) => {
      const next = prevPatternAtOrder(state.song, o);
      return next === state.song ? state : { ...state, song: next };
    });
  };

  const insertOrderSlot = () => {
    const before = song();
    if (!before) return;
    const o = activeOrder();
    commitEditWithWorkbenches((state) => {
      const next = insertOrder(state.song, o);
      return next === state.song ? state : { ...state, song: next };
    });
    const after = song();
    if (!after) return;
    // Skip the cursor advance when `insertOrder` was a no-op (already at
    // MAX_ORDERS — songLength didn't grow). Otherwise advance by one so the
    // cursor lands on the newly-created slot. `insertOrder` duplicates the
    // pattern at the active position (so [A, B, C] with the active slot
    // on B becomes [A, B, B, C]); the duplicate sits at o + 1, and
    // putting the cursor there is what the user expects so they can
    // immediately step that slot to a different pattern via `<` / `>`.
    // `applyCursor` itself is a no-op during playback, so this naturally
    // skips the cursor move while playing — the cursor stays put on the
    // pre-insert slot index, which matches the playhead-locked policy.
    if (after.songLength === before.songLength) return;
    applyCursor({ ...cursor(), order: o + 1, row: 0 });
    requestJumpToTop();
  };

  /** Delete the slot at the active position; clamp the cursor if it fell off the end. */
  const deleteOrderSlot = () => {
    const o = activeOrder();
    commitEditWithWorkbenches((state) => {
      const next = deleteOrder(state.song, o);
      return next === state.song ? state : { ...state, song: next };
    });
    const after = song();
    if (after && cursor().order >= after.songLength) {
      applyCursor({ ...cursor(), order: after.songLength - 1, row: 0 });
    }
  };

  const newBlankPatternAtOrder = () => {
    const o = activeOrder();
    commitEditWithWorkbenches((state) => {
      const next = newPatternAtOrder(state.song, o);
      return next === state.song ? state : { ...state, song: next };
    });
  };

  /** Append a copy of the active position's pattern and point the slot at the copy. */
  const duplicateCurrentPattern = () => {
    const o = activeOrder();
    commitEditWithWorkbenches((state) => {
      const next = duplicatePatternAtOrder(state.song, o);
      return next === state.song ? state : { ...state, song: next };
    });
  };

  /**
   * Tidy the order list: renumber patterns in order of first appearance and
   * drop unused ones. The song change and the pattern-name re-keying go
   * through one bundled commit so undo restores both atomically — without
   * that, undo would leave names mapped to the cleaned-up indices while the
   * song reverts to the pre-cleanup pattern numbering.
   *
   * The cursor's `order` stays valid because songLength doesn't change and
   * the pattern *content* at each order slot is unchanged — only the
   * pattern's numerical index moved.
   */
  const cleanupOrderList = () => {
    if (transport() === "playing") return;
    commitEditWithWorkbenches((state) => {
      const result = cleanupOrders(state.song);
      if (result.song === state.song) return state;
      const oldNames = state.patternNames;
      const newNames: Record<number, string> = {};
      for (const key of Object.keys(oldNames)) {
        const oldIdx = Number(key);
        const newIdx = result.remap[oldIdx];
        if (newIdx !== undefined) newNames[newIdx] = oldNames[oldIdx]!;
      }
      return { ...state, song: result.song, patternNames: newNames };
    });
  };

  // ─── Sample editing ──────────────────────────────────────────────────────

  /**
   * Patch metadata fields on the currently-selected sample. Routes through
   * `commitEditWithWorkbenches` (not `commitEdit`) so the edit is allowed
   * mid-playback — the user can shape loop bounds, volume, finetune, name
   * while a song plays. The worklet keeps its own song snapshot, so the
   * audio doesn't change live; the new values apply on the next play /
   * restart.
   */
  const patchCurrentSample = (patch: Parameters<typeof setSample>[2]) => {
    const slot = currentSample() - 1;
    // Loop-aware chain effects (currently just `crossfade`) bake the loop
    // boundary into the int8 at pipeline time. A bare loop-field edit only
    // mutates metadata, so the audio would stay glued to the previous loop
    // position until something else (effect edit, target-note swap, source
    // change) re-ran the pipeline. Re-run it here in the same commit so
    // undo reverts both halves atomically.
    const touchesLoop = "loopStartWords" in patch || "loopLengthWords" in patch;
    const wb = touchesLoop ? getWorkbench(slot) : undefined;
    const needsRerun = !!wb && wb.chain.some((e) => e.kind === "crossfade");
    commitEditWithWorkbenches((state) => {
      const next = setSample(state.song, slot, patch);
      if (next === state.song) return state;
      const finalSong =
        needsRerun && wb ? writeWorkbenchToSongPure(next, slot, wb) : next;
      return { ...state, song: finalSong };
    });
  };

  /**
   * Rename a sample slot by 1-based index. Used by the sample list's
   * double-click-to-edit affordance — independent of which slot is the
   * current selection so the user can rename any slot they double-click.
   * Allowed mid-playback (sample-side edit policy).
   */
  const renameSample = (slot1Based: number, name: string) => {
    commitEditWithWorkbenches((state) => {
      const next = setSample(state.song, slot1Based - 1, { name });
      return next === state.song ? state : { ...state, song: next };
    });
  };

  /**
   * Commit a new song title from the metapane's inline editor. Truncated
   * to PT's 20-char limit (matches the Info view's input). Skipped during
   * playback to keep the worklet's snapshot consistent with the UI; the
   * Info view's input is similarly gated.
   */
  const commitTitleEdit = (raw: string) => {
    setEditingTitle(false);
    if (transport() === "playing") return;
    const title = raw.slice(0, 20);
    commitEdit((song) => (song.title === title ? song : { ...song, title }));
  };

  /**
   * Reset the currently-selected sample to empty (also drops its workbench).
   * The song clear and the workbench drop are bundled into a single history
   * entry so undo restores both — the chain UI was previously left dangling
   * after a Clear-then-undo.
   */
  const clearCurrentSample = () => {
    const slot = currentSample() - 1;
    // Drop the loop-stash too: the audio it described is gone, so a future
    // re-enable on this slot should fall through to "loop the whole sample"
    // for whatever new audio lands here. Not part of the history snapshot
    // because the stash is session-only — undo restores the song + workbench
    // map, and a stale stash can't make that desync (worst case the user
    // re-enables loop on the restored sample and gets the whole-sample
    // default, which is the same outcome as if they'd never stashed).
    clearStashedLoop(slot);
    commitEditWithWorkbenches((state) => ({
      ...state,
      song: clearSample(state.song, slot),
      workbenches: withoutWorkbench(state.workbenches, slot),
    }));
  };

  /**
   * Find the lowest empty sample slot strictly after `from`, or null if none.
   * "Empty" matches `clearSample`'s definition: lengthWords === 0. We scan
   * the slots PT actually addresses (0..30); slot index here is 0-based,
   * the UI labels them 1..31.
   */
  const nextFreeSlot = (
    s: ReturnType<typeof song>,
    from: number,
  ): number | null => {
    if (!s) return null;
    for (let i = from + 1; i < s.samples.length; i++) {
      if (s.samples[i]!.lengthWords === 0) return i;
    }
    return null;
  };

  /**
   * Copy the current sample (data + meta) to the next empty slot, taking
   * the workbench along so the duplicate keeps its source kind, chain and
   * pt — including the alt half. Both halves move in one history entry so
   * undo reverts to a single state. Selection follows the new slot, so the
   * user is immediately editing the copy.
   *
   * No-op when the current slot is empty (nothing to duplicate) or every
   * subsequent slot is occupied.
   */
  const duplicateCurrentSample = () => {
    const s = song();
    if (!s) return;
    const slot = currentSample() - 1;
    const sample = s.samples[slot];
    if (!sample || sample.lengthWords === 0) return;
    const target = nextFreeSlot(s, slot);
    if (target === null) return;

    commitEditWithWorkbenches((state) => {
      const samples = [...state.song.samples];
      // Shallow-copy the Sample record; `data` is an Int8Array we share by
      // reference — the song treats it as immutable, so a referential copy
      // is safe and avoids the cost of cloning multi-KB buffers.
      samples[target] = { ...samples[slot]! };
      const newSong = { ...state.song, samples };
      const wb = state.workbenches.get(slot);
      const newWorkbenches = wb
        ? // Workbenches are deep-immutable; shallow-clone the top level so
          // future edits on slot N don't mutate the duplicate at slot M
          // through a shared chain reference.
          withWorkbench(state.workbenches, target, {
            source: wb.source,
            chain: [...wb.chain],
            pt: { ...wb.pt },
            alt: wb.alt
              ? {
                  source: wb.alt.source,
                  chain: [...wb.alt.chain],
                  pt: { ...wb.alt.pt },
                  loop: wb.alt.loop ? { ...wb.alt.loop } : null,
                }
              : null,
          })
        : state.workbenches;
      return { ...state, song: newSong, workbenches: newWorkbenches };
    });
    setCurrentSample(target + 1);
  };

  /**
   * Map a byte-range selection (over the int8 output the user sees) into the
   * frame-range that a NEW effect appended to the chain would receive as
   * input. The new effect operates on the OUTPUT of the existing chain
   * (post-effects, pre-transformer), not on the source — so we run the chain
   * once to get its current length and proportionally scale the int8 byte
   * positions into that frame space.
   *
   * Returns null when the chain output is empty or the selection collapses
   * after rounding.
   */
  const selectionToChainFrames = (
    wb: SampleWorkbench,
    startByte: number,
    endByte: number,
    int8Len: number,
  ): { startFrame: number; endFrame: number } | null => {
    const chainOut = runChain(materializeSource(wb.source), wb.chain);
    const chainLen = chainOut.channels[0]?.length ?? 0;
    if (chainLen === 0 || int8Len === 0) return null;
    const startFrame = Math.max(
      0,
      Math.min(chainLen, Math.round((startByte * chainLen) / int8Len)),
    );
    const endFrame = Math.max(
      startFrame,
      Math.min(chainLen, Math.round((endByte * chainLen) / int8Len)),
    );
    if (endFrame - startFrame < 1) return null;
    return { startFrame, endFrame };
  };

  /**
   * Crop / cut the current sample to the selection. When a workbench exists
   * we APPEND the edit as a Crop or Cut effect on the chain — non-destructive,
   * the user can drop the effect from the pipeline editor to undo. When no
   * workbench is present (samples loaded from a `.mod` have no source to
   * preserve), we fall back to direct int8 mutation via cropSample/cutSample.
   */
  const applySelectionEdit = (
    kind: "crop" | "cut",
    startByte: number,
    endByte: number,
  ) => {
    const slot = currentSample() - 1;
    const s = song()?.samples[slot];
    if (!s) return;
    const wb = getWorkbench(slot);
    if (wb) {
      const frames = selectionToChainFrames(
        wb,
        startByte,
        endByte,
        s.data.byteLength,
      );
      if (!frames) return;
      const effect: EffectNode = { kind, params: frames };
      updateCurrentWorkbench({ ...wb, chain: [...wb.chain, effect] });
      return;
    }
    // No workbench — destructive int8 mutation, with translated loop. We
    // intentionally drop nothing here (there's no workbench to drop).
    const transform = kind === "crop" ? cropSample : cutSample;
    const result = transform(s, startByte, endByte);
    if (!result) return;
    commitEdit((song) =>
      replaceSampleData(song, slot, result.data, {
        name: s.name,
        volume: s.volume,
        finetune: s.finetune,
        loopStartWords: result.loopStartWords,
        loopLengthWords: result.loopLengthWords,
      }),
    );
  };

  const cropCurrentSampleToSelection = (start: number, end: number) =>
    applySelectionEdit("crop", start, end);
  const cutCurrentSampleSelection = (start: number, end: number) =>
    applySelectionEdit("cut", start, end);

  /**
   * Apply a workbench's pipeline and produce a new Song with the resulting
   * int8 written into `slot`. Pure — used inside `commitEditWithWorkbenches`
   * so the song update and the workbench-map update share one history entry.
   *
   * First write into a fresh slot adopts the source name and full volume.
   * Re-runs (pipeline edits on an already-populated slot) leave the user's
   * name / volume / finetune / loop alone — otherwise dragging a gain slider
   * would silently clobber any volume the user dialed in by hand, and any
   * loop they configured on the waveform. `replaceSampleData` clamps the
   * loop to the new length so a length-changing effect (crop) can't leave
   * the loop pointing past the data.
   *
   * Exception: chiptune sources always force a full-sample loop on every
   * write. The synth's output is a single cycle that's only musically useful
   * when looped, the UI hides the Loop toggle so the user can't intervene,
   * and changing `cycleFrames` would otherwise leave a stale loop length
   * pointing into nothing.
   *
   * `loopOverride` lets the caller pin the slot's loop fields explicitly —
   * highest priority, beats both the chiptune full-loop rule and the
   * preserve-old fallback. Used by source-kind swaps and fresh-WAV loads
   * so a sampler doesn't inherit the chiptune loop the slot held a moment
   * earlier.
   */
  const writeWorkbenchToSongPure = (
    song: import("./core/mod/types").Song,
    slot: number,
    wb: SampleWorkbench,
    loopOverride?: { loopStartWords: number; loopLengthWords: number },
  ): import("./core/mod/types").Song => {
    const old = song.samples[slot];
    // Build a chain run-context that carries the slot's current loop into
    // chain-input frame space, so loop-aware effects (crossfade) can act
    // on it without each effect needing its own copy of the loop fields.
    // Mapping: int8 byte position → source-frame position via the ratio
    // sourceFrames / int8Length. Holds when no length-changing chain
    // effects (crop / cut) precede the loop-aware effect.
    const ctx = (() => {
      if (!old || old.loopLengthWords <= 1 || old.data.length <= 0) return null;
      const sourceFrames =
        materializeSource(wb.source).channels[0]?.length ?? 0;
      if (sourceFrames <= 0) return null;
      const ratio = sourceFrames / old.data.length;
      const loopStartByte = old.loopStartWords * 2;
      const loopEndByte = (old.loopStartWords + old.loopLengthWords) * 2;
      return {
        loopStartFrame: loopStartByte * ratio,
        loopEndFrame: loopEndByte * ratio,
      };
    })();
    const data = runPipeline(wb, ctx);
    const isFirstWrite = !old || old.lengthWords === 0;
    const fullLoop =
      sourceWantsFullLoop(wb.source) && data.length >= 2
        ? { loopStartWords: 0, loopLengthWords: data.length >> 1 }
        : null;
    // Explicit override wins; otherwise chiptune's full-loop wins; otherwise
    // we fall through to first-write defaults (no loop) or preserve / scale old.
    const loopFields = loopOverride ?? fullLoop;
    // When the data length changed under us (target-note resample, resample-
    // mode toggle, dither flip, any chain edit) and the slot HAD a real loop,
    // scale the loop window's byte endpoints by the new/old length ratio so
    // the user keeps the same proportional loop region. Without this, switch-
    // ing target note slid the loop relative to the audio underneath.
    // Skipped when an explicit `loopOverride` (or chiptune full-loop) wins
    // anyway, when the slot has no loop, or when length is unchanged.
    const scaledLoop = (() => {
      if (loopFields) return null;
      if (!old || old.loopLengthWords <= 1) return null;
      if (old.data.length <= 0 || data.length === old.data.length) return null;
      const ratio = data.length / old.data.length;
      const oldEndBytes = (old.loopStartWords + old.loopLengthWords) * 2;
      const newStartBytes = Math.round(old.loopStartWords * 2 * ratio);
      const newEndBytes = Math.round(oldEndBytes * ratio);
      const newLenBytes = Math.max(4, newEndBytes - newStartBytes);
      // Word-align: PT loop fields count 16-bit words. `>> 1` floors to keep
      // the loop strictly inside the resampled data; `replaceSampleData`
      // also clamps, but landing in bounds first preserves loop *intent*.
      return {
        loopStartWords: Math.max(0, newStartBytes >> 1),
        loopLengthWords: Math.max(2, newLenBytes >> 1),
      };
    })();
    const meta: Parameters<typeof replaceSampleData>[3] = isFirstWrite
      ? {
          volume: 64,
          finetune: 0,
          name: sourceDisplayName(wb.source).slice(0, 22),
          ...(loopFields ?? {}),
        }
      : {
          volume: old.volume,
          finetune: old.finetune,
          name: old.name,
          ...(loopFields ??
            scaledLoop ?? {
              loopStartWords: old.loopStartWords,
              loopLengthWords: old.loopLengthWords,
            }),
        };
    return replaceSampleData(song, slot, data, meta);
  };

  /**
   * Decode a WAV into a workbench for the current slot and run the (initially
   * empty) pipeline. The workbench survives until the user clears the slot
   * or loads a different `.mod`; further pipeline edits go through the
   * addEffect / removeEffect / patchEffect handlers below.
   *
   * Bundles workbench creation + pipeline write into a single history entry
   * so undoing reverts both halves at once.
   */
  /**
   * "Bounce selection" — render the current pattern selection through a
   * CleanMixer (no Paula) and land the result in the next free sample slot
   * as a Sampler workbench. Selection survives unchanged so the user can
   * follow up with a Cut / Delete to clear the bounced rows.
   *
   * No-op when:
   *   - no song / no selection
   *   - no free slot remains
   *
   * Allowed mid-playback (sample-side edit policy). The offline render
   * runs synchronously on the main thread and briefly competes with the
   * audio thread for CPU, but the live worklet has its own song snapshot
   * so playback continuity is unaffected.
   */
  const bounceSelectionToSample = () => {
    const s = song();
    const sel = selection();
    if (!s || !sel) return;
    const slot = nextFreeSlot(s, -1);
    if (slot === null) {
      setError("No free sample slots — clear one and try again.");
      return;
    }
    const result = bounceSelection(s, sel);
    if (!result) return;
    const patNum = s.orders[sel.order] ?? 0;
    // Short, grep-able name within PT's 22-char limit. Pattern + row range.
    const sourceName = `Bnc P${patNum.toString(16).toUpperCase()} R${sel.startRow
      .toString(16)
      .toUpperCase()
      .padStart(
        2,
        "0",
      )}-${sel.endRow.toString(16).toUpperCase().padStart(2, "0")}`;
    const wb = workbenchFromWavData(result.wav, sourceName);
    setError(null);
    commitEditWithWorkbenches((state) => ({
      ...state,
      song: writeWorkbenchToSongPure(state.song, slot, wb, NO_LOOP),
      workbenches: withWorkbench(state.workbenches, slot, wb),
    }));
    // Hop the sample-slot selection to the new bounce so the user sees what
    // they got. Keep the pattern-view cursor and selection where they were.
    selectSample(slot + 1);
  };

  const loadWavIntoCurrentSample = (bytes: Uint8Array, filename: string) => {
    let wb: SampleWorkbench;
    try {
      wb = workbenchFromWav(bytes, filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setError(null);
    const slot = currentSample() - 1;
    // Preserve any active chiptune as the alt stash so the user can toggle
    // back to it without losing their synth params. If the slot already had
    // a sampler, keep its alt (the chiptune side, if any) so it survives the
    // overwrite — otherwise toggling kinds after re-loading a WAV would
    // forget the chiptune the user previously had.
    const existing = getWorkbench(slot);
    if (existing) {
      if (existing.source.kind === "chiptune") {
        wb = { ...wb, alt: workbenchToAlt(existing) };
      } else if (existing.alt) {
        wb = { ...wb, alt: existing.alt };
      }
    }
    const wbToCommit = wb;
    // A fresh sampler starts with no loop — passing the explicit override
    // also clears any chiptune-era full-loop the slot might still hold from
    // a previous source-kind toggle.
    commitEditWithWorkbenches((state) => ({
      ...state,
      song: writeWorkbenchToSongPure(state.song, slot, wbToCommit, NO_LOOP),
      workbenches: withWorkbench(state.workbenches, slot, wbToCommit),
    }));
  };

  /**
   * Replace the workbench at the current slot and re-run the pipeline. Both
   * halves (the workbench map and the int8 in the song) move together inside
   * one history entry — undo reverts the chain UI alongside the waveform.
   *
   * `loopOverride` is forwarded to `writeWorkbenchToSongPure` — pass it on
   * source-kind transitions where the slot's old loop fields shouldn't
   * survive (e.g. switching back to sampler after chiptune full-looped it).
   */
  const updateCurrentWorkbench = (
    next: SampleWorkbench,
    loopOverride?: { loopStartWords: number; loopLengthWords: number },
  ) => {
    const slot = currentSample() - 1;
    commitEditWithWorkbenches((state) => ({
      ...state,
      song: writeWorkbenchToSongPure(state.song, slot, next, loopOverride),
      workbenches: withWorkbench(state.workbenches, slot, next),
    }));
    // If a piano-key audition is in flight on this slot, hand the freshly
    // re-rendered int8 to the preview voice so the user hears the edit
    // immediately. Covers every workbench-driven edit — chiptune param
    // sliders, sampler chain effects, PT mono-mix / target-note swaps —
    // without each handler having to remember to call `livePreviewSwap`.
    const ap = preview.activePreview();
    if (ap && ap.slot === slot) {
      const updatedSample = song()?.samples[slot];
      if (updatedSample) livePreviewSwap(slot, updatedSample, ap.period);
    }
  };

  /** PT no-loop sentinel: loopLengthWords === 1 (a single word, two bytes). */
  const NO_LOOP = { loopStartWords: 0, loopLengthWords: 1 };

  /**
   * Append an effect to the chain. For range-aware kinds (reverse / fadeIn /
   * fadeOut / crop / cut) we use the user's current waveform selection if
   * present — mapping the int8-byte selection back to chain-output frame
   * indices, since the new effect's input is the chain's current output. With
   * no selection, `defaultEffect` picks a sensible default range over that
   * same chain output (whole sample for reverse, head 1024 for fadeIn, etc).
   * gain / normalize ignore selection — they don't take a range.
   */
  const addEffect = (kind: EffectKind, selection: SampleSelection | null) => {
    const slot = currentSample() - 1;
    const wb = getWorkbench(slot);
    if (!wb) return;
    const s = song()?.samples[slot];
    if (!s) return;

    const chainOut = runChain(materializeSource(wb.source), wb.chain);
    let node: EffectNode;
    const isRangeAware =
      kind === "reverse" ||
      kind === "fadeIn" ||
      kind === "fadeOut" ||
      kind === "crop" ||
      kind === "cut";
    if (isRangeAware && selection && s.data.byteLength > 0) {
      const chainLen = chainOut.channels[0]?.length ?? 0;
      const int8Len = s.data.byteLength;
      const startFrame = Math.max(
        0,
        Math.min(chainLen, Math.round((selection.start * chainLen) / int8Len)),
      );
      const endFrame = Math.max(
        startFrame,
        Math.min(chainLen, Math.round((selection.end * chainLen) / int8Len)),
      );
      if (endFrame - startFrame < 1) return;
      node = { kind, params: { startFrame, endFrame } } as EffectNode;
    } else {
      node = defaultEffect(kind, chainOut);
    }
    updateCurrentWorkbench({ ...wb, chain: [...wb.chain, node] });
  };

  const removeEffect = (index: number) => {
    const wb = getWorkbench(currentSample() - 1);
    if (!wb) return;
    if (index < 0 || index >= wb.chain.length) return;
    updateCurrentWorkbench({
      ...wb,
      chain: wb.chain.filter((_, i) => i !== index),
    });
  };

  const moveEffect = (index: number, delta: -1 | 1) => {
    const wb = getWorkbench(currentSample() - 1);
    if (!wb) return;
    const target = index + delta;
    if (target < 0 || target >= wb.chain.length) return;
    const chain = [...wb.chain];
    [chain[index], chain[target]] = [chain[target]!, chain[index]!];
    updateCurrentWorkbench({ ...wb, chain });
  };

  /** Replace one node's params (or whole node, for variants without params). */
  const patchEffect = (index: number, next: EffectNode) => {
    const wb = getWorkbench(currentSample() - 1);
    if (!wb) return;
    if (index < 0 || index >= wb.chain.length) return;
    const chain = wb.chain.map((n, i) => (i === index ? next : n));
    updateCurrentWorkbench({ ...wb, chain });
  };

  /**
   * Burn the current workbench's effect chain into its sampler source: runs
   * the chain end-to-end and replaces the source WAV with the result, then
   * clears the chain. PT params are kept, so the slot's int8 — and thus
   * playback — is unchanged. The motivation is project-file size: an early
   * Crop in the chain still keeps the original full-length source around in
   * the workbench (so the user can edit the crop later); applying collapses
   * the source to just the bytes the chain actually used, which is the
   * difference between a 20 MB and a 200 KB `.retro` after a heavy crop.
   *
   * No-op for chiptune (its source regenerates from params on every render —
   * "applying" would have nothing meaningful to keep) and for an empty chain
   * (nothing to burn).
   */
  const applyChainToSource = () => {
    const slot = currentSample() - 1;
    const wb = getWorkbench(slot);
    if (!wb) return;
    if (wb.source.kind !== "sampler") return;
    if (wb.chain.length === 0) return;

    let burned = runChain(
      materializeSource(wb.source),
      wb.chain,
      runContextForSlot(slot, wb),
    );

    // Auto-truncate at loop end. The bytes past `loopEnd` are never heard
    // (live worklet already plays through `songForPlayback` which truncates
    // for the same reason), so dropping them from the source on Apply
    // shrinks the .retro project without changing anything the user hears.
    // Skipped when the slot has no real loop or when the loop already
    // covers the whole sample.
    const sample = song()?.samples[slot];
    if (sample && sample.loopLengthWords > 1 && sample.data.length > 0) {
      const sourceFrames = burned.channels[0]?.length ?? 0;
      if (sourceFrames > 0) {
        // Map slot int8-byte loopEnd into burned-WAV frame space — same
        // ratio writeWorkbenchToSongPure uses for its run-context.
        const ratio = sourceFrames / sample.data.length;
        const loopEndByte =
          (sample.loopStartWords + sample.loopLengthWords) * 2;
        const loopEndFrame = Math.min(
          sourceFrames,
          Math.floor(loopEndByte * ratio),
        );
        if (loopEndFrame > 0 && loopEndFrame < sourceFrames) {
          burned = {
            sampleRate: burned.sampleRate,
            channels: burned.channels.map((ch) => ch.slice(0, loopEndFrame)),
          };
        }
      }
    }

    updateCurrentWorkbench({
      ...wb,
      source: {
        kind: "sampler",
        wav: burned,
        sourceName: wb.source.sourceName,
      },
      chain: [],
    });
  };

  /**
   * Build the same chain run-context `writeWorkbenchToSongPure` uses, so
   * the burn-time `runChain` sees the loop info that loop-aware chain
   * effects (crossfade) need. Returns `null` when the slot has no real
   * loop or no int8 yet.
   */
  const runContextForSlot = (
    slot: number,
    wb: SampleWorkbench,
  ): { loopStartFrame: number; loopEndFrame: number } | null => {
    const sample = song()?.samples[slot];
    if (!sample || sample.loopLengthWords <= 1 || sample.data.length <= 0)
      return null;
    const sourceFrames = materializeSource(wb.source).channels[0]?.length ?? 0;
    if (sourceFrames <= 0) return null;
    const ratio = sourceFrames / sample.data.length;
    const loopStartByte = sample.loopStartWords * 2;
    const loopEndByte = (sample.loopStartWords + sample.loopLengthWords) * 2;
    return {
      loopStartFrame: loopStartByte * ratio,
      loopEndFrame: loopEndByte * ratio,
    };
  };

  const setMonoMix = (monoMix: MonoMix) => {
    const wb = getWorkbench(currentSample() - 1);
    if (!wb) return;
    updateCurrentWorkbench({ ...wb, pt: { ...wb.pt, monoMix } });
  };

  const setTargetNote = (targetNote: number | null) => {
    const wb = getWorkbench(currentSample() - 1);
    if (!wb) return;
    updateCurrentWorkbench({ ...wb, pt: { ...wb.pt, targetNote } });
  };

  const setResampleMode = (resampleMode: ResampleMode) => {
    const wb = getWorkbench(currentSample() - 1);
    if (!wb) return;
    updateCurrentWorkbench({ ...wb, pt: { ...wb.pt, resampleMode } });
  };

  const setDither = (dither: boolean) => {
    const wb = getWorkbench(currentSample() - 1);
    if (!wb) return;
    updateCurrentWorkbench({ ...wb, pt: { ...wb.pt, dither } });
  };

  /**
   * Switch the current slot's source kind (Sampler ↔ Chiptune). The switch
   * is non-destructive: the active half is stashed in `wb.alt` and the
   * target half is restored from `wb.alt` if it was previously stashed
   * there. So the user can flip back and forth without losing the WAV they
   * loaded or the synth params they dialed in.
   *
   * When no alt of the target kind exists:
   *   - target = chiptune: create a fresh chiptune workbench (default params).
   *   - target = sampler:  no-op — Sampler has no useful "fresh" state
   *     without a WAV, so the user must click Load WAV to enter sampler mode.
   */
  const setSourceKind = (kind: SourceKind) => {
    if (transport() === "playing") return;
    const slot = currentSample() - 1;
    const wb = getWorkbench(slot);

    // No workbench yet — only chiptune is creatable from nothing.
    if (!wb) {
      if (kind === "chiptune") updateCurrentWorkbench(workbenchFromChiptune());
      return;
    }
    if (wb.source.kind === kind) return;

    // Snapshot the slot's current loop into the alt — without it, a sampler
    // with a loop would lose the loop on Sampler→Chiptune→Sampler round-trip
    // (chiptune's full-loop overwrites the slot's fields, and the
    // sampler-restore path below forces NO_LOOP when no snapshot exists).
    const sample = song()?.samples[slot];
    const currentLoop = sample
      ? {
          loopStartWords: sample.loopStartWords,
          loopLengthWords: sample.loopLengthWords,
        }
      : null;
    const stash = workbenchToAlt(wb, currentLoop);

    // Restore from alt when it matches the requested kind. For sampler
    // restore use the alt's captured loop (preserves the user's sampler
    // loop across kind toggles), falling back to NO_LOOP if no snapshot
    // exists. For chiptune restore, pass undefined so the
    // `sourceWantsFullLoop` rule recomputes the full-loop against the
    // current render size — a stale captured loop would be wrong if the
    // user changed osc params (and thus cycle length) before toggling.
    if (wb.alt && wb.alt.source.kind === kind) {
      const restoreLoop =
        kind === "sampler" ? (wb.alt.loop ?? NO_LOOP) : undefined;
      updateCurrentWorkbench(
        {
          source: wb.alt.source,
          chain: wb.alt.chain,
          pt: wb.alt.pt,
          alt: stash,
        },
        restoreLoop,
      );
      return;
    }

    if (kind === "chiptune") {
      // First-time entry into chiptune for this slot — fresh defaults,
      // current sampler half goes to alt for restore-on-toggle-back.
      updateCurrentWorkbench({ ...workbenchFromChiptune(), alt: stash });
      return;
    }

    // kind === 'sampler' with no alt-sampler on file. Drop into the
    // "empty sampler" view — same UX as a fresh slot, with the Load WAV
    // button waiting. The current chiptune half is stashed as alt so
    // toggling back restores it untouched.
    updateCurrentWorkbench({ ...emptySamplerWorkbench(), alt: stash }, NO_LOOP);
  };

  /**
   * Patch the chiptune source params on the current slot. No-op if the slot
   * isn't a chiptune workbench. The single-history-entry commit + live
   * preview swap both happen inside `updateCurrentWorkbench`.
   */
  const updateChiptune = (patch: Partial<ChiptuneParams>) => {
    const slot = currentSample() - 1;
    const wb = getWorkbench(slot);
    if (!wb || wb.source.kind !== "chiptune") return;
    const params: ChiptuneParams = { ...wb.source.params, ...patch };
    updateCurrentWorkbench({
      ...wb,
      source: { kind: "chiptune", params },
    });
  };

  /**
   * Render the current chiptune to a WavData and replace the slot's
   * workbench with a sampler whose source IS that wave — opens the slot
   * up to the sampler effect chain (filter / fade / crop / …) while
   * keeping the synthesised sound exactly as it was. Distinct from the
   * Chiptune↔Sampler kind toggle: that one swaps in a fresh / stashed
   * sampler half, this one freezes the synth output as the new source.
   *
   * Chiptune params get stashed in `alt` so the user can flip back via
   * the source-kind toggle without losing their work. PT stays at
   * `targetNote: null` so the sampler plays the wave at its native rate
   * (matching how chiptune played it); the slot's existing full-loop
   * carries over so the sampled cycle still loops by default.
   */
  /**
   * Wrap an existing int8 sample as a fresh sampler workbench. Used after
   * a `.mod` load when the user wants to access the chain UI on a sample
   * that came from the file rather than a `Load WAV…` import. Pure
   * workbench-state — the slot's int8 isn't rewritten, so the bytes stay
   * exactly as the .mod stored them until the user actually edits the chain.
   */
  const convertSlotToSampler = () => {
    const slot = currentSample() - 1;
    if (getWorkbench(slot)) return;
    const sample = song()?.samples[slot];
    if (!sample || sample.lengthWords <= 0 || sample.data.byteLength <= 0)
      return;
    const sourceName = (sample.name.trim() || `Sample ${slot + 1}`).slice(
      0,
      22,
    );
    setWorkbench(slot, workbenchFromInt8(sample.data, sourceName));
  };

  const convertChiptuneToSampler = () => {
    if (transport() === "playing") return;
    const slot = currentSample() - 1;
    const wb = getWorkbench(slot);
    if (!wb || wb.source.kind !== "chiptune") return;
    const wav = materializeSource(wb.source);
    const sample = song()?.samples[slot];
    const currentLoop = sample
      ? {
          loopStartWords: sample.loopStartWords,
          loopLengthWords: sample.loopLengthWords,
        }
      : null;
    updateCurrentWorkbench({
      source: { kind: "sampler", wav, sourceName: "Chiptune render" },
      chain: [],
      pt: { monoMix: "average", targetNote: null },
      alt: workbenchToAlt(wb, currentLoop),
    });
  };

  const cleanups: Array<() => void> = [];
  onMount(() => {
    // Restore the previous session from localStorage if one exists; otherwise
    // boot with a blank "M.K." song so the user can start editing immediately
    // without having to load a file first. The engine is created lazily on
    // the first Play, so we don't touch AudioContext on mount.
    //
    // Both chiptune and sampler workbenches restore from autosave (the latter
    // only when the previous session fit in localStorage's quota — saveSession
    // silently drops the write when it doesn't, in which case the slot's int8
    // still plays from the song bytes but the pipeline UI starts fresh).
    if (!song()) {
      const restored = loadSession();
      if (restored) {
        setSong(restored.song);
        setFilename(restored.filename);
        setInfoText(restored.infoText);
        setView(restored.view);
        setCursor(restored.cursor);
        setPlayPos({ order: restored.cursor.order, row: restored.cursor.row });
        setCurrentSample(restored.currentSample);
        setCurrentOctave(restored.currentOctave);
        setEditStep(restored.editStep);
        for (const [slotStr, params] of Object.entries(
          restored.chiptuneSources,
        )) {
          const slot = parseInt(slotStr, 10);
          if (Number.isFinite(slot))
            setWorkbench(slot, workbenchFromChiptune(params));
        }
        for (const [slotStr, src] of Object.entries(restored.samplerSources)) {
          const slot = parseInt(slotStr, 10);
          if (!Number.isFinite(slot)) continue;
          setWorkbench(slot, {
            ...workbenchFromWavData(src.wav, src.sourceName),
            chain: src.chain,
            pt: src.pt,
          });
        }
        loadPatternNames(restored.patternNames);
        setTransport("ready");
      } else {
        setSong(emptySong());
        setTransport("ready");
      }
    }
    cleanups.push(installShortcuts());

    // Push per-channel mute/solo changes to the audio engine. We don't
    // auto-create the engine here — if it doesn't exist yet, the next
    // ensureEngine() will sync the current state on creation.
    createEffect(() => {
      const eng = currentEngine();
      for (let ch = 0; ch < CHANNELS; ch++) {
        const muted = isChannelMuted(ch);
        if (eng) eng.setChannelMuted(ch, muted);
      }
    });

    // Push Paula filter model changes to both worklets. Read the signal
    // first, unconditionally — `eng?.setPaulaModel(settings()…)` would
    // short-circuit when the engine is still null (the lazy-creation
    // path on first launch), and Solid would record zero dependencies
    // on that first run, killing the effect for the whole session. With
    // the read up front, the effect always tracks `settings`, and once
    // the engine appears (via ensureEngine), every subsequent toggle
    // forwards through.
    createEffect(() => {
      const model = settings().paulaModel;
      const eng = currentEngine();
      eng?.setPaulaModel(model);
    });

    // Stereo separation — same read-first pattern so the Solid effect
    // stays subscribed even when the engine is still null on first run.
    createEffect(() => {
      const sep = settings().stereoSeparation;
      const eng = currentEngine();
      eng?.setStereoSeparation(sep);
    });

    // Push live edits to the worklet so the user hears them immediately
    // instead of having to stop+play. Two channels:
    //   - Per-slot sample data → `engine.setSampleData(i, sample)`. Also
    //     re-latches any active Paula voice playing that slot, so a
    //     chiptune slider morph snaps into the new waveform within one
    //     loop period.
    //   - Order-list / pattern-array shape (`orders`, `songLength`,
    //     `patterns`) → `engine.replaceSong(song)`. The Replayer reads
    //     `orders[orderIndex]` fresh on every row, so the next row
    //     processed picks up a stepped slot's new pattern.
    // Both diff by reference — the editor's mutation paths always
    // produce fresh objects when something changes, so `!==` is the
    // right gate. No-ops when transport isn't playing: the next play
    // call's `engine.load(song)` picks everything up in one shot.
    let prevSamples: import("./core/mod/types").Sample[] | null = null;
    let prevOrders: import("./core/mod/types").Song["orders"] | null = null;
    let prevPatterns: import("./core/mod/types").Song["patterns"] | null = null;
    let prevSongLength: number | null = null;
    createEffect(() => {
      const s = song();
      const playing = transport() === "playing";
      if (!s) {
        prevSamples = null;
        prevOrders = null;
        prevPatterns = null;
        prevSongLength = null;
        return;
      }
      const eng = playing ? currentEngine() : null;
      if (eng && prevSamples) {
        for (let i = 0; i < s.samples.length; i++) {
          const cur = s.samples[i]!;
          const prev = prevSamples[i];
          if (cur !== prev) eng.setSampleData(i, cur);
        }
      }
      if (
        eng &&
        (s.orders !== prevOrders ||
          s.patterns !== prevPatterns ||
          s.songLength !== prevSongLength) &&
        prevOrders !== null
      ) {
        eng.replaceSong(s);
      }
      prevSamples = s.samples;
      prevOrders = s.orders;
      prevPatterns = s.patterns;
      prevSongLength = s.songLength;
    });

    // Theme application. The first run fires synchronously before the
    // initial render is committed, so the saved scheme paints on the
    // first frame instead of flashing the :root defaults first.
    createEffect(() => applyColorScheme(settings().colorScheme));
    createEffect(() => applyUiScale(settings().uiScale));

    // Autosave to localStorage whenever the persisted signals change.
    // Debounced because some interactions (drag-selection, hex digit
    // entry sweeping a column) fire many cursor / song updates in quick
    // succession, and writing the song through writeModule + base64 +
    // JSON.stringify dozens of times a second is wasted work.
    let saveTimer: number | null = null;
    createEffect(() => {
      const s = song();
      // Track the rest of the persisted signals so the effect re-runs.
      const fname = filename();
      const info = infoText();
      const v = view();
      const c = cursor();
      const samp = currentSample();
      const oct = currentOctave();
      const step = editStep();
      // Subscribe to the workbenches map so chiptune-source edits also
      // trigger an autosave. The snapshot is taken inside the timeout to
      // pick up any rapid follow-up edits before we serialise.
      workbenches();
      // Subscribe to pattern names so renames also re-fire the autosave.
      const names = patternNames();
      if (!s) return;
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveSession({
          song: s,
          filename: fname,
          infoText: info,
          view: v,
          cursor: c,
          currentSample: samp,
          currentOctave: oct,
          editStep: step,
          chiptuneSources: chiptuneSourcesSnapshot(),
          samplerSources: samplerSourcesSnapshot(),
          patternNames: names,
        });
      }, 250);
    });
    cleanups.push(() => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
    });

    for (const c of registerAppKeybinds({
      openFilePicker,
      saveProject,
      selectAllStep,
      selectAllSample,
      copySelection,
      cutSelection,
      pasteAtCursor,
      bounceSelectionToSample,
      applyCursor,
      applyCursorWithSong,
      extendSelection,
      stepChannelLeft,
      stepChannelRight,
      stepRowUp,
      stepRowDown,
      stepRowPageUp,
      stepRowPageDown,
      onPianoKey,
      previewPianoKey: previewSampleAtPitch,
      enterHexDigit,
      transposeAtCursor,
      repeatLastEffectFromAbove,
      stepPrevPattern,
      stepNextPattern,
      insertOrderSlot,
      deleteOrderSlot,
      newBlankPatternAtOrder,
      duplicateCurrentPattern,
      clearAtCursor,
      backspaceCell,
      backspaceRow,
      deleteSelection,
      insertEmptyCell,
      insertEmptyRow,
      toggleChannelMute,
      toggleChannelSolo,
    }))
      cleanups.push(c);
  });
  onCleanup(() => {
    for (const c of cleanups) c();
    preview.stopPreview();
    void disposeEngine();
  });

  // Menu items for the header dropdowns. Functions so the disabled flags
  // re-evaluate reactively each time the Menu reads `props.items`.
  const fileMenuItems = (): MenuItem[] => [
    { label: "New", onClick: newProject },
    { label: "Open…", hint: "⌘O", onClick: openFilePicker },
    { separator: true, label: "" },
    { label: "Save…", hint: "⌘S", onClick: saveProject, disabled: !song() },
    { label: "Export .mod…", onClick: exportMod, disabled: !song() },
    { label: "Export .wav…", onClick: exportWav, disabled: !song() },
  ];

  const editMenuItems = (): MenuItem[] => {
    const playing = transport() === "playing";
    return [
      {
        label: "Undo",
        hint: "⌘Z",
        onClick: undo,
        disabled: !canUndo() || playing,
      },
      {
        label: "Redo",
        hint: "⇧⌘Z",
        onClick: redo,
        disabled: !canRedo() || playing,
      },
      { separator: true, label: "" },
      // Copy / Cut / Paste live here for discoverability — same handlers
      // the Cmd+C / X / V shortcuts call. Disabled checks mirror the
      // shortcut `when` predicates so the menu and keyboard agree on
      // when the action is reachable.
      {
        label: "Cut",
        hint: "⌘X",
        onClick: cutSelection,
        disabled: playing || view() === "sample" || !song(),
      },
      {
        label: "Copy",
        hint: "⌘C",
        onClick: copySelection,
        disabled: view() === "sample" || !song(),
      },
      {
        label: "Paste",
        hint: "⌘V",
        onClick: pasteAtCursor,
        disabled:
          playing || view() === "sample" || !song() || !clipboardSlice(),
      },
      { separator: true, label: "" },
      {
        label: "Bounce selection to sample",
        hint: "⌘E",
        onClick: bounceSelectionToSample,
        disabled:
          playing ||
          view() === "sample" ||
          !song() ||
          !selection() ||
          nextFreeSlot(song(), -1) === null,
      },
    ];
  };

  const sampleCount = createMemo(() => {
    const s = song();
    if (!s) return 0;
    return s.samples.filter((x) => x.lengthWords > 0).length;
  });

  // Raw .mod byte size — what "Save .mod" would write. Recomputed only
  // when the song reference changes (which happens on every commitEdit).
  const modByteSize = createMemo(() => {
    const s = song();
    if (!s) return 0;
    return writeModule(s).length;
  });

  // Estimated `.retro` file size for the project-size indicator. Tracks
  // only the inputs that meaningfully affect bytes (song / metadata /
  // chiptune params); cursor moves and view toggles don't recompute, and
  // `encodeSongCached` reuses the writeModule output between this memo
  // and the autosave path.
  const projectByteSize = createMemo(() => {
    const s = song();
    if (!s) return 0;
    return projectToBytes({
      song: s,
      filename: filename(),
      infoText: infoText(),
      view: "pattern",
      cursor: { order: 0, row: 0, channel: 0, field: "note" },
      currentSample: 1,
      currentOctave: 1,
      editStep: 1,
      chiptuneSources: chiptuneSourcesSnapshot(),
      samplerSources: samplerSourcesSnapshot(),
      patternNames: patternNames(),
    }).length;
  });

  return (
    <div
      class="app"
      classList={{
        "app--drag": dragOver(),
        "app--view-pattern": view() === "pattern",
        "app--view-sample": view() === "sample",
        "app--view-info": view() === "info",
        "app--view-settings": view() === "settings",
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header class="app__header">
        <div class="app__header-left">
          <h1>RetroTracker</h1>
          {/* Hidden file input — both the File menu's "Open…" item and the
              Cmd+O shortcut click it. accept covers both formats; the
              actual sniff happens in loadFile via the filename suffix. */}
          <input
            type="file"
            accept=".retro,.mod"
            onChange={onPickFile}
            hidden
            ref={fileInput}
          />
          <Menu label="File" items={fileMenuItems()} />
          <Menu label="Edit" items={editMenuItems()} />
          <Show when={song()}>
            <span class="filesize" title=".mod file size">
              .mod {formatProjectSize(modByteSize())}
            </span>
            <span
              class="filesize"
              classList={{
                "filesize--warn":
                  projectByteSize() >= PROJECT_SIZE_WARN_BYTES &&
                  projectByteSize() <= PROJECT_SIZE_LIMIT_BYTES,
                "filesize--err": projectByteSize() > PROJECT_SIZE_LIMIT_BYTES,
              }}
              title={`Estimated .retro project file size — limit ${formatProjectSize(PROJECT_SIZE_LIMIT_BYTES)}`}
            >
              .retro {formatProjectSize(projectByteSize())} /{" "}
              {formatProjectSize(PROJECT_SIZE_LIMIT_BYTES)}
            </span>
          </Show>
        </div>
        <div class="viewtabs" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            classList={{ "viewtab--active": view() === "pattern" }}
            aria-selected={view() === "pattern"}
            onClick={() => setView("pattern")}
            title="Pattern view (F2)"
          >
            Pattern
          </button>
          <button
            type="button"
            role="tab"
            classList={{ "viewtab--active": view() === "sample" }}
            aria-selected={view() === "sample"}
            onClick={() => setView("sample")}
            title="Sample view (F3)"
          >
            Sample
          </button>
          <button
            type="button"
            role="tab"
            classList={{ "viewtab--active": view() === "info" }}
            aria-selected={view() === "info"}
            onClick={() => setView("info")}
            title="Info view (F4)"
          >
            Info
          </button>
          <button
            type="button"
            role="tab"
            classList={{ "viewtab--active": view() === "settings" }}
            aria-selected={view() === "settings"}
            onClick={() => setView("settings")}
            title="Settings view (F5)"
          >
            Settings
          </button>
        </div>
        <div class="transport" role="group" aria-label="Transport">
          <span class="transport__label">Play</span>
          <div class="transport__group">
            <button
              type="button"
              class="transport__btn"
              classList={{
                "transport__btn--active":
                  transport() === "playing" && playMode() === "song",
              }}
              onClick={() => void togglePlaySong()}
              disabled={!song()}
              title="Play song / Stop (Space)"
              aria-label="Play song"
              aria-pressed={transport() === "playing" && playMode() === "song"}
            >
              Song
            </button>
            <button
              type="button"
              class="transport__btn"
              classList={{
                "transport__btn--active":
                  transport() === "playing" && playMode() === "pattern",
              }}
              onClick={() => void togglePlayPattern()}
              disabled={!song()}
              title="Play pattern (Option+Space)"
              aria-label="Play pattern"
              aria-pressed={
                transport() === "playing" && playMode() === "pattern"
              }
            >
              Pattern
            </button>
          </div>
        </div>
      </header>

      <aside class="app__samples">
        <h2>Samples</h2>
        <SampleList
          song={song()}
          onSelect={selectSample}
          onRename={renameSample}
        />
      </aside>

      <main class="app__main">
        <Show
          when={song()}
          fallback={
            <div class="dropzone">
              <p>
                Drop a <code>.mod</code> file anywhere, or use{" "}
                <em>Load .mod…</em>
              </p>
              <Show when={error()}>
                <p class="error">{error()}</p>
              </Show>
            </div>
          }
        >
          {(s) => (
            // Both panes stay mounted; only their visibility flips with the
            // view signal. Toggling unmount/mount used to rebuild ~2400
            // PatternGrid spans (and their listeners) on every switch,
            // which the user felt as a noticeable lag — keeping the trees
            // alive turns the toggle into a single CSS class swap.
            <>
              <div
                class="patternpane"
                classList={{ "view-hidden": view() !== "pattern" }}
              >
                <div class="patternpane__meta">
                  <Show
                    when={editingTitle()}
                    fallback={
                      <span
                        class="patternpane__title"
                        title="Double-click to rename song"
                        onDblClick={() => {
                          if (transport() !== "playing") setEditingTitle(true);
                        }}
                      >
                        {s().title || <em>(untitled)</em>}
                      </span>
                    }
                  >
                    <input
                      class="patternpane__title-input"
                      type="text"
                      maxLength={20}
                      value={s().title}
                      ref={(el) =>
                        queueMicrotask(() => {
                          el.focus();
                          el.select();
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitTitleEdit(e.currentTarget.value);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingTitle(false);
                        }
                      }}
                      onBlur={(e) => {
                        if (editingTitle())
                          commitTitleEdit(e.currentTarget.value);
                      }}
                    />
                  </Show>
                  <span class="patternpane__sep">·</span>
                  <span>{filename()}</span>
                  <span class="patternpane__sep">·</span>
                  <span>{sampleCount()} samples</span>
                  <span class="patternpane__sep">·</span>
                  <span>
                    order{" "}
                    {playPos()
                      .order.toString(16)
                      .toUpperCase()
                      .padStart(2, "0")}
                    /
                    {(s().songLength - 1)
                      .toString(16)
                      .toUpperCase()
                      .padStart(2, "0")}
                  </span>
                  <span class="patternpane__sep">·</span>
                  <span>
                    pat{" "}
                    {(s().orders[playPos().order] ?? 0)
                      .toString(16)
                      .toUpperCase()
                      .padStart(2, "0")}
                  </span>
                  <span class="patternpane__sep">·</span>
                  <span>
                    row{" "}
                    {playPos().row.toString(16).toUpperCase().padStart(2, "0")}
                  </span>
                  <span class="patternpane__sep">·</span>
                  <span>oct {currentOctave()}</span>
                  <span class="patternpane__sep">·</span>
                  <span>
                    smp{" "}
                    {currentSample()
                      .toString(16)
                      .toUpperCase()
                      .padStart(2, "0")}
                  </span>
                  <span class="patternpane__sep">·</span>
                  <span class="patternpane__editstep">
                    step
                    <button
                      type="button"
                      class="patternpane__editstep-btn"
                      onClick={decEditStep}
                      disabled={transport() === "playing"}
                      title="Decrease edit step ([)"
                      aria-label="Decrease edit step"
                    >
                      −
                    </button>
                    <span
                      class="patternpane__editstep-value"
                      aria-label="Edit step"
                    >
                      {editStep()}
                    </span>
                    <button
                      type="button"
                      class="patternpane__editstep-btn"
                      onClick={incEditStep}
                      disabled={transport() === "playing"}
                      title="Increase edit step (])"
                      aria-label="Increase edit step"
                    >
                      +
                    </button>
                  </span>
                </div>
                <PatternGrid
                  song={s()}
                  pos={playPos()}
                  active={transport() === "playing"}
                  onCellClick={applyCursor}
                />
                <PatternHelp song={s()} cursor={cursor()} />
              </div>
              <div
                class="sampleview-wrapper"
                classList={{ "view-hidden": view() !== "sample" }}
              >
                <SampleView
                  song={s()}
                  onLoadWav={loadWavIntoCurrentSample}
                  onClear={clearCurrentSample}
                  onDuplicate={duplicateCurrentSample}
                  canDuplicate={nextFreeSlot(s(), currentSample() - 1) !== null}
                  onPatch={patchCurrentSample}
                  onCropToSelection={cropCurrentSampleToSelection}
                  onDeleteSelection={cutCurrentSampleSelection}
                  onAddEffect={addEffect}
                  onRemoveEffect={removeEffect}
                  onMoveEffect={moveEffect}
                  onPatchEffect={patchEffect}
                  onApplyChain={applyChainToSource}
                  onSetMonoMix={setMonoMix}
                  onSetTargetNote={setTargetNote}
                  onSetResampleMode={setResampleMode}
                  onSetDither={setDither}
                  onSetSourceKind={setSourceKind}
                  onUpdateChiptune={updateChiptune}
                  onConvertChiptuneToSampler={convertChiptuneToSampler}
                  onConvertToSampler={convertSlotToSampler}
                />
              </div>
              <div
                class="infoview-wrapper"
                classList={{ "view-hidden": view() !== "info" }}
              >
                <InfoView
                  song={s()}
                  filename={filename()}
                  infoText={infoText()}
                  onTitleChange={(title) =>
                    commitEdit((song) =>
                      song.title === title ? song : { ...song, title },
                    )
                  }
                  onFilenameChange={(name) => setFilename(name || null)}
                  onInfoTextChange={setInfoText}
                />
              </div>
              <div
                class="settingsview-wrapper"
                classList={{ "view-hidden": view() !== "settings" }}
              >
                <SettingsView />
              </div>
            </>
          )}
        </Show>
      </main>

      <Show when={view() === "pattern"}>
        <aside class="app__order">
          <h2>Order</h2>
          <Show when={song()} fallback={<p class="placeholder">—</p>}>
            {(s) => {
              // Disable a button when the corresponding action would no-op
              // so the UI doesn't lie about what's possible. Order edits
              // are allowed mid-playback (mirrors the keyboard handlers);
              // the `playing` gate is reserved for Clean up, which would
              // renumber patterns the worklet's own song snapshot still
              // references. The Prev/Next predicates read the slot pattern
              // at the *active* position — playhead while playing, cursor
              // when stopped — so they reflect what `<` / `>` actually act
              // on right now.
              const playing = () => transport() === "playing";
              const activeIdx = () =>
                playing() ? playPos().order : cursor().order;
              const slotPat = () => s().orders[activeIdx()] ?? 0;
              const canPrev = () => slotPat() > 0;
              const canNext = () => true;
              const canIns = () => s().songLength < s().orders.length;
              const canDel = () => s().songLength > 1;
              const canBlank = () => true;
              return (
                <>
                  <div class="ordertools">
                    <button
                      type="button"
                      onClick={stepPrevPattern}
                      disabled={!canPrev()}
                      title="Previous pattern at slot ([)"
                      aria-label="Previous pattern at slot"
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      onClick={stepNextPattern}
                      disabled={!canNext()}
                      title="Next pattern at slot (])"
                      aria-label="Next pattern at slot"
                    >
                      ›
                    </button>
                    <button
                      type="button"
                      onClick={insertOrderSlot}
                      disabled={!canIns()}
                      title="Insert slot at cursor (⌘])"
                      aria-label="Insert slot"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={deleteOrderSlot}
                      disabled={!canDel()}
                      title="Delete slot at cursor (⌘[)"
                      aria-label="Delete slot"
                    >
                      −
                    </button>
                    <button
                      type="button"
                      onClick={newBlankPatternAtOrder}
                      disabled={!canBlank()}
                      title="New blank pattern at slot (⌥[)"
                      aria-label="New blank pattern"
                    >
                      New
                    </button>
                    <button
                      type="button"
                      onClick={duplicateCurrentPattern}
                      disabled={!canBlank()}
                      title="Duplicate pattern at slot (⌥])"
                      aria-label="Duplicate pattern"
                    >
                      Dup
                    </button>
                  </div>
                  <ol class="orderlist">
                    {s()
                      .orders.slice(0, s().songLength)
                      .map((p, i) => (
                        <li
                          classList={{
                            "orderlist__item--active": i === playPos().order,
                            "orderlist__item--cursor":
                              transport() !== "playing" && i === cursor().order,
                          }}
                          onClick={() => {
                            if (editingOrderIdx() === i) return;
                            jumpToOrder(i);
                          }}
                          onDblClick={(e) => {
                            e.stopPropagation();
                            setEditingOrderIdx(i);
                          }}
                          title={`Jump to order ${i.toString(16).toUpperCase().padStart(2, "0")} — double-click to rename pattern`}
                        >
                          <span class="num">
                            {i.toString(16).toUpperCase().padStart(2, "0")}
                          </span>
                          <span class="pat">
                            {p.toString(16).toUpperCase().padStart(2, "0")}
                          </span>
                          <Show
                            when={editingOrderIdx() === i}
                            fallback={
                              <span class="orderlist__name">
                                {patternNames()[p] ?? ""}
                              </span>
                            }
                          >
                            <input
                              class="orderlist__name-input"
                              type="text"
                              maxLength={PATTERN_NAME_MAX}
                              value={patternNames()[p] ?? ""}
                              ref={(el) =>
                                queueMicrotask(() => {
                                  el.focus();
                                  el.select();
                                })
                              }
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitPatternRename(p, e.currentTarget.value);
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  setEditingOrderIdx(null);
                                }
                              }}
                              onBlur={(e) => {
                                if (editingOrderIdx() === i)
                                  commitPatternRename(p, e.currentTarget.value);
                              }}
                            />
                          </Show>
                        </li>
                      ))}
                  </ol>
                  <div class="orderfooter">
                    <button
                      type="button"
                      onClick={cleanupOrderList}
                      disabled={playing()}
                      title="Renumber patterns in order of appearance and discard unused ones"
                    >
                      Clean up
                    </button>
                  </div>
                </>
              );
            }}
          </Show>
        </aside>
      </Show>
    </div>
  );
};
