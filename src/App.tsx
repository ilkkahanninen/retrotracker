import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { AboutModal } from "./components/AboutModal";
import { APP_VERSION } from "./version";
import { ModePicker } from "./components/ModePicker";
import { EditStepControl } from "./components/EditStepControl";
import { MetaNumberInput } from "./components/MetaNumberInput";
import { ModeBadge } from "./components/ModeBadge";
import { PatternNameField } from "./components/PatternNameField";
import {
  canInsertOrders,
  deleteOrderTitle,
  duplicatePatternTitle,
  insertOrderTitle,
  orderSlotTitle,
  selectedOrderCount,
} from "./components/orderListShared";
import { isOrderSelected } from "./state/orderSelection";
import { PatternPosReadout } from "./components/PatternPosReadout";
import { SongTitle } from "./components/SongTitle";
import { InfoView } from "./components/InfoView";
import { Menu, type MenuItem } from "./components/Menu";
import {
  fullscreenSupported,
  isFullscreen,
  toggleFullscreen,
} from "./state/fullscreen";
import { Icon } from "./components/Icon";
import {
  AudioWaveform,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  CloudDownload,
  CloudUpload,
  Copy,
  CopyPlus,
  Eraser,
  FileDown,
  FilePlus,
  FileVolume,
  FolderOpen,
  Info,
  Lightbulb,
  ListMusic,
  Maximize,
  Minimize,
  LocateFixed,
  LogIn,
  LogOut,
  Minus,
  Play,
  Plus,
  Redo2,
  Repeat,
  Save,
  Scissors,
  Settings,
  Share2,
  Square,
  Table2,
  Trash,
  Undo2,
  Upload,
  User,
  WandSparkles,
  X,
} from "./components/icons";
import { PatternGridCanvas as PatternGrid } from "./components/PatternGridCanvas";
import { PatternGridXmCanvas as PatternGridXm } from "./components/PatternGridXmCanvas";
import { XmOrderList } from "./components/XmOrderList";
import { PatternHelp } from "./components/PatternHelp";
import { XmPatternHelp } from "./components/XmPatternHelp";
import {
  applyXmChainToSource,
  bounceXmSelectionToInstrument,
  clearCurrentXmInstrument,
  copyXmSampleRange,
  cutXmSampleRange,
  duplicateCurrentXmInstrument,
  effectiveXmSampleRange,
  loadXmWavIntoCurrentSample,
  nextFreeXmInstrumentSlot,
  pasteXmSampleBytes,
} from "./state/xmSampleEdit";
import { InstrumentView } from "./components/InstrumentView";
import { SampleView } from "./components/SampleView";
import { SlotList, type SlotDisplay } from "./components/SlotList";
import { SettingsView } from "./components/SettingsView";
import { bounceSelection } from "./core/audio/bounce";
import type { ChiptuneParams } from "./core/audio/chiptune";
import { emptySong } from "./core/mod/format";
import { writeModule } from "./core/mod/writer";
import { writeXm } from "./core/xm/writer";
import { registerAppKeybinds } from "./state/appKeybinds";
import { registerXmAppKeybinds } from "./state/appKeybindsXm";
import { installEngineSync } from "./state/sync";
import {
  applyCursor,
  applyCursorWithSong,
  backspaceCell,
  backspaceRow,
  clearAtCursor,
  copySelection as copyPatternSelection,
  cutSelection as cutPatternSelection,
  deleteSelection,
  enterHexDigit,
  extendSelection,
  insertEmptyCell,
  insertEmptyRow,
  onPianoKey,
  pasteAtCursor as pastePatternAtCursor,
  previewSampleAtPitch,
  repeatLastEffectFromAbove,
  selectAllSample,
  selectAllStep,
  stepChannelLeft,
  stepChannelRight,
  stepRowDown,
  stepRowPageDown,
  stepRowPageUp,
  stepRowUp,
  toggleChannelMute,
  toggleChannelSolo,
  transposeAtCursor,
} from "./state/patternEdit";
import {
  cleanupOrderList,
  deleteOrderSlot,
  duplicateCurrentPattern,
  insertOrderSlot,
  jumpNextOrder,
  jumpPrevOrder,
  jumpToOrder,
  selectOrdersTo,
  newBlankPatternAtOrder,
  renamePattern,
  stepNextPattern,
  stepPrevPattern,
} from "./state/orderEdit";
import {
  dropWavsToXmPatternView,
  loadWavsIntoFreeSlots,
  loadWavsIntoSlot,
  loadWavsIntoXmSlot,
} from "./state/dropImport";
import {
  addEffect,
  applyChainToSource,
  bounceSelectionToSample,
  clearCurrentSample,
  convertChiptuneToSampler,
  convertSlotToSampler,
  copySampleRange,
  cropCurrentSampleToSelection,
  cutSampleRange,
  addEnvelopePoint,
  duplicateCurrentSample,
  effectiveSampleRange,
  loadWavIntoCurrentSample,
  nudgeEnvelopeSegment,
  pasteSampleFromClipboard,
  patchEnvelopePoint,
  moveEffect,
  nextFreeSlot,
  NO_LOOP,
  patchCurrentSample,
  patchEffect,
  removeEffect,
  removeEnvelopePoint,
  renameSample,
  setDither,
  setEffectBypass,
  setMonoMix,
  setPlayingLengthTicks,
  setResampleMode,
  setSourceKind,
  setTargetNote,
  updateChiptune,
  writeWorkbenchToSongPure,
} from "./state/sampleEdit";
import {
  applyLoadedSession,
  chiptuneSourcesSnapshot,
  cloudOrigin,
  cursorForPersistence,
  xmEditSnapshot,
  hydrateRestoredSources,
  hydratingSources,
  unreadSourcesSnapshot,
  xmChiptuneSourcesSnapshot,
  xmSamplerSourcesSnapshot,
  error,
  exportMp3,
  exportSong,
  exportWav,
  filename,
  loadFile,
  loadServerBytes,
  newProject,
  projectBytes,
  samplerSourcesSnapshot,
  saveProject,
  setCloudOrigin,
  setError,
  setFilename,
} from "./state/session";
import {
  detectAndLoadShareLink,
  dismissSharedBanner,
  dismissShareLoadError,
  sharedBanner,
  shareLoadError,
} from "./state/shareLoad";
import { ShareModal } from "./components/ShareModal";
import { Mp3ExportModal } from "./components/Mp3ExportModal";
import {
  backendAvailable,
  getBytes,
  probeBackend,
  putBytes,
  shareAvailable,
  type BackendResource,
} from "./state/backend";
import {
  authRequired,
  cloudVisibleFor,
  currentUser,
  login as cloudLogin,
  logout as cloudLogout,
  refreshAuth,
} from "./state/auth";
import {
  ServerBrowser,
  type ServerBrowserMode,
} from "./components/ServerBrowser";
import { mutedChannels, soloedChannels } from "./state/channelMute";
import { clipboardSlice, xmClipboardSlice } from "./state/clipboard";
import { sampleClipboard } from "./state/sampleClipboard";
import { xmSampleClipboard } from "./state/xmSampleClipboard";
import { cursor, requestJumpToTop } from "./state/cursor";
import { speedTempoAt } from "./core/mod/flatten";
import {
  currentOctave,
  currentSample,
  editStep,
  selectSample,
} from "./state/edit";
import {
  currentXmInstrument,
  currentXmOctave,
  currentXmSampleIndex,
  selectXmInstrument,
} from "./state/xmEdit";
import { isXmInstrumentEmpty } from "./core/xm/mutations";
import { setXmSampleSelection } from "./state/xmSampleSelection";
import {
  cleanupXmOrderList,
  deleteXmOrderSlot,
  duplicateXmCurrentPattern,
  insertXmOrderSlot,
  newXmBlankPatternAtOrder,
  stepXmNextPattern,
  stepXmPrevPattern,
} from "./state/xmOrderEdit";
import { renameXmInstrument } from "./state/xmInstrumentEdit";
import { xmCursor } from "./state/cursorXm";
import {
  copyXmSelection,
  cutXmSelection,
  pasteXmAtCursor,
  setXmChannelCountAction,
  setXmDefaultBpmAction,
  setXmDefaultSpeedAction,
  setXmRowCountAtCursor,
} from "./state/xmPatternEdit";
import {
  XM_INSTRUMENT_NAME_MAX,
  XM_MAX_BPM,
  XM_MAX_CHANNELS,
  XM_MAX_INSTRUMENTS,
  XM_MAX_PATTERN_ROWS,
  XM_MAX_SPEED,
  XM_MIN_BPM,
  XM_MIN_PATTERN_ROWS,
  XM_MIN_SPEED,
} from "./core/xm/types";
import { SAMPLE_NAME_MAX } from "./core/mod/sampleImport";
import { infoText, setInfoText } from "./state/info";
import { patternNames } from "./state/patternNames";
import {
  loadSession,
  projectToBytes,
  queueSessionSave,
  type SaveOutcome,
} from "./state/persistence";
import { sourceStoreAvailable } from "./state/sourceStore";
import {
  disposeEngine,
  jumpPlaybackToOrder,
  toggleTransport,
} from "./state/playback";
import * as preview from "./state/preview";
import { withWorkbench, workbenches } from "./state/sampleWorkbench";
import { getXmWorkbench, xmWorkbenches } from "./state/xmSampleWorkbench";
import { selection, xmSelection } from "./state/selection";
import {
  settings,
  setLoopPattern,
  toggleFollowPlayback,
  toggleShowPatternHelp,
} from "./state/settings";
import { installShortcuts } from "./state/shortcuts";
import {
  canRedo,
  canUndo,
  commitEdit,
  commitEditWithWorkbenches,
  commitEditXmWithWorkbenches,
  dirty,
  playPos,
  pt2Song,
  redo,
  setDirty,
  setSong,
  setTransport,
  song,
  transport,
  undo,
  xm2Song,
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
  const [dragOver, setDragOver] = createSignal(false);
  const [aboutOpen, setAboutOpen] = createSignal(false);
  const [modePickerOpen, setModePickerOpen] = createSignal(false);
  const [serverBrowser, setServerBrowser] = createSignal<{
    mode: ServerBrowserMode;
    resources: BackendResource[];
    saveTo?: BackendResource;
    title: string;
  } | null>(null);
  const [shareModalOpen, setShareModalOpen] = createSignal(false);
  // Autosave health. `autosaveOutcome` is the last result; the warning
  // banner shows whenever it isn't "ok" and re-appears (after a dismiss)
  // only when the outcome changes, so it informs without nagging on
  // every debounced save.
  const [autosaveOutcome, setAutosaveOutcome] = createSignal<SaveOutcome>("ok");
  const [autosaveWarningDismissed, setAutosaveWarningDismissed] =
    createSignal(false);
  const recordAutosaveOutcome = (outcome: SaveOutcome) => {
    if (outcome !== autosaveOutcome()) setAutosaveWarningDismissed(false);
    setAutosaveOutcome(outcome);
  };

  const USER_MANUAL_URL =
    "https://github.com/ilkkahanninen/retrotracker/blob/main/docs/user-manual.md";

  // Keyed by order index (not pattern index) so a pattern appearing in
  // multiple slots renders only one input at a time — keying by pattern
  // would race two refs' focus calls and the loser's blur would commit
  // an empty value before the user could type. Rename still applies to
  // the underlying pattern, so siblings update on commit.
  const [editingOrderIdx, setEditingOrderIdx] = createSignal<number | null>(
    null,
  );

  const commitPatternRename = (patternIdx: number, raw: string) => {
    setEditingOrderIdx(null);
    renamePattern(patternIdx, raw);
  };

  // Cmd+C / Cmd+X / Cmd+V dispatch by active view: pattern view → the
  // pattern-cell clipboard (state/clipboard.ts), sample view → the
  // sample-byte clipboard (state/sampleClipboard.ts). The two are
  // independent — copying sample bytes never clobbers a pattern slice
  // and vice versa. Other views (info / settings) get a no-op.
  //
  // The pattern branch keeps its transport gate (cut / paste race the
  // worklet mixing the same data; copy is gated alongside for menu /
  // shortcut symmetry). The sample branch doesn't gate — sample edits
  // are allowed mid-playback elsewhere in the app.
  const copyClipboardForActiveView = () => {
    if (view() === "sample") {
      if (xm2Song()) {
        const r = effectiveXmSampleRange();
        if (r) copyXmSampleRange(r.start, r.end);
      } else {
        const r = effectiveSampleRange();
        if (r) copySampleRange(r.start, r.end);
      }
    } else if (view() === "pattern" && transport() !== "playing") {
      if (xm2Song()) copyXmSelection();
      else copyPatternSelection();
    }
  };
  const cutClipboardForActiveView = () => {
    if (view() === "sample") {
      if (xm2Song()) {
        const r = effectiveXmSampleRange();
        if (r) cutXmSampleRange(r.start, r.end);
      } else {
        const r = effectiveSampleRange();
        if (r) cutSampleRange(r.start, r.end);
      }
    } else if (view() === "pattern" && transport() !== "playing") {
      if (xm2Song()) cutXmSelection();
      else cutPatternSelection();
    }
  };
  const pasteClipboardForActiveView = () => {
    if (view() === "sample") {
      if (xm2Song()) pasteXmSampleBytes();
      else pasteSampleFromClipboard();
    } else if (view() === "pattern" && transport() !== "playing") {
      if (xm2Song()) pasteXmAtCursor();
      else pastePatternAtCursor();
    }
  };

  let fileInput: HTMLInputElement | undefined;
  let wavInput: HTMLInputElement | undefined;

  const onPickFile = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void loadFile(file);
    // Clear so re-picking the same file still fires onChange.
    input.value = "";
  };

  /** Header-menu WAV picker for the current sample slot. The Sample view
   *  has its own picker for the in-pane button — keeping a separate input
   *  here means the menu works regardless of which view is active. */
  const onPickWav = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    if (xm2Song()) loadXmWavIntoCurrentSample(buf, file.name);
    else loadWavIntoCurrentSample(buf, file.name);
  };

  const openFilePicker = () => fileInput?.click();

  /**
   * Cloud bytes → editor: GETs the bytes and tunnels them through the
   * regular `loadFile` path so format sniffing + workbench rebuild stay
   * identical to drag-drop / file-picker loads. Works for both `.retro`
   * projects and native `.mod` / `.xm` modules — the user doesn't have
   * to know which bucket a file lives in.
   */
  const openFromCloud = async (
    resource: BackendResource,
    name: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const bytes = await getBytes(resource, name, signal);
    // Dialog dismissed while the bytes were on their way: the user went
    // back to their song, so leave it alone.
    if (signal?.aborted) return;
    const loaded = await loadServerBytes(bytes, name.split("/").pop()!);
    setServerBrowser(null);
    // Rejected file: the previous song is still open, so its cloud origin
    // must stay as it was — otherwise "Share this song…" would share the
    // file that failed to load. The reason is shown in the error banner.
    if (!loaded) return;
    // Track cloud origin for share-enabled buckets only. Samples
    // aren't shareable, so don't pretend the loaded song has a
    // shareable origin even if it came from the samples bucket
    // (which today isn't reachable from "Open from cloud" anyway).
    if (resource === "projects" || resource === "modules") {
      setCloudOrigin({ resource, name });
    } else {
      setCloudOrigin(null);
    }
  };

  /**
   * `.retro` payload → cloud. Reuses `projectBytes` so the snapshot
   * (chiptune sources, workbenches, view, cursor, …) matches the
   * Save-to-computer path byte-for-byte.
   */
  const saveProjectToCloud = async (
    name: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const bytes = projectBytes();
    if (!bytes) return;
    await putBytes("projects", name, bytes, signal);
    // Cancelled as it completed: the dialog is gone and the user was told
    // nothing was saved, so don't mark the song clean.
    if (signal?.aborted) return;
    // The user now owns a cloud copy — enable the "Share" menu item.
    setCloudOrigin({ resource: "projects", name });
    // Saved — same as Save to computer, so File → New doesn't ask to
    // discard changes that were just stored.
    setDirty(false);
    setServerBrowser(null);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    // A single .mod / .xm / .retro replaces the current project — anything
    // else is treated as a batch of WAV imports. PT2 fans WAVs across
    // free sample slots; FT2 bundles them into a fresh multi-sample
    // instrument in the first empty slot.
    const first = files[0]!;
    if (files.length === 1 && /\.(mod|xm|retro)$/i.test(first.name)) {
      void loadFile(first);
      return;
    }
    if (xm2Song()) {
      void dropWavsToXmPatternView(Array.from(files));
      return;
    }
    void loadWavsIntoFreeSlots(Array.from(files));
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const onDragLeave = () => setDragOver(false);

  /** Title edit from the Info view or the pattern strip, routed to the
   *  loaded format's commit path so it is undoable for both PT2 and FT2
   *  songs. Both headers hold 20 chars. */
  const commitSongTitle = (raw: string) => {
    const title = raw.slice(0, 20);
    if (xm2Song()) {
      // Ungated, like the PT path below: the title stays editable while
      // playing with Follow on. `commitEditXm` would drop the edit there.
      commitEditXmWithWorkbenches((state) =>
        state.song.title === title
          ? state
          : { ...state, song: { ...state.song, title } },
      );
      return;
    }
    commitEditWithWorkbenches((state) =>
      state.song.title === title
        ? state
        : { ...state, song: { ...state.song, title } },
    );
  };

  const cleanups: Array<() => void> = [];
  onMount(() => {
    // Optional backend: one-shot probe so the File menu can grow
    // server-side entries when /api/health responds.
    void probeBackend();

    // Catch /share/<token> in the URL and load the linked song. Runs
    // independently of `probeBackend` because the share GET endpoint
    // is anonymous — we don't have to wait for the auth probe before
    // fetching. URL is stripped immediately so reload doesn't refetch.
    // If the editor holds work by the time the bytes arrive — a session
    // restored from autosave just below, or edits made meanwhile — ask
    // before replacing it. A fresh visitor with nothing to lose isn't
    // prompted.
    let restoredFromAutosave = false;
    void detectAndLoadShareLink((sharedName) => {
      if (!restoredFromAutosave && !dirty()) return true;
      return window.confirm(
        `Open the shared song "${sharedName}"?\n\nIt replaces the song currently in the editor, including its autosaved copy. Cancel to keep your song; you can open the link again later.`,
      );
    });

    // After the OIDC callback redirects to "/?auth=ok", refresh the
    // auth signals and strip the query so a page reload doesn't loop.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("auth") === "ok") {
        void refreshAuth();
        params.delete("auth");
        const q = params.toString();
        const newUrl =
          window.location.pathname + (q ? `?${q}` : "") + window.location.hash;
        window.history.replaceState({}, "", newUrl);
      }
    }
    // Sampler workbenches restore only when the previous session fit in
    // localStorage's quota — otherwise saveSession stored the session
    // without source audio (and the autosave banner said so), in which
    // case the slot's int8 still plays from the song bytes but the
    // pipeline UI starts fresh.
    if (!song()) {
      const restored = loadSession();
      if (restored) {
        restoredFromAutosave = true;
        // Same path as every other load, so the restored session gets the
        // same sizing / clamping / reset treatment (mute arrays sized to
        // the song's channel count, XM cursor seeded, selections cleared).
        // A hand-rolled copy of this used to live here and had drifted.
        applyLoadedSession(restored);
        // Restore the cloud origin so "Share this song" stays available
        // after a page reload — `applyLoadedSession` clears it on every
        // load, so it has to be re-set afterwards.
        setCloudOrigin(restored.cloudOrigin);
        // Source audio kept in IndexedDB can't be read synchronously:
        // the song is usable now, the sampler pipelines follow.
        void hydrateRestoredSources(restored.pendingSources);
      } else {
        setSong(emptySong());
        setTransport("ready");
      }
    }
    cleanups.push(installShortcuts());
    installEngineSync();

    // Theme: first run fires synchronously before initial render commits,
    // so the saved scheme paints on the first frame instead of flashing
    // the :root defaults first.
    createEffect(() => applyColorScheme(settings().colorScheme));
    createEffect(() => applyUiScale(settings().uiScale));

    // Autosave is debounced because drag-selection / hex-digit sweeps
    // fire many cursor / song updates in quick succession, and writing
    // through writeModule + base64 + JSON.stringify dozens of times a
    // second is wasted work.
    let saveTimer: number | null = null;
    createEffect(() => {
      const s = song();
      // Read every persisted signal up front so Solid tracks them all.
      const fname = filename();
      const info = infoText();
      const v = view();
      // Tracks cursor() or xmCursor() depending on the song's format.
      const c = cursorForPersistence();
      const samp = currentSample();
      const oct = currentOctave();
      const step = editStep();
      // FT2: current instrument / sample / octave / cursor field. Read
      // here so a change to any of them schedules a save.
      const xmEdit = xmEditSnapshot();
      workbenches();
      const names = patternNames();
      if (!s) return;
      const isPt2 = s.format === "PT2";
      const isXm = s.format === "FT2";
      // Track the XM workbench map so source-kind toggles flush through
      // autosave without waiting for an unrelated signal to change.
      xmWorkbenches();
      // Track cloudOrigin so a setCloudOrigin (cloud open / save) fires
      // an autosave even when no other field changed — without this read
      // the very first save after a fresh boot would land in localStorage
      // without the origin, and a reload would still lose Share.
      const origin = cloudOrigin();
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      // Restored sources still loading: a save now would omit them and
      // then sweep their audio out of the store. The effect re-runs when
      // the flag clears.
      if (hydratingSources()) return;
      const muted = mutedChannels();
      const soloed = soloedChannels();
      saveTimer = window.setTimeout(() => {
        void queueSessionSave(
          {
            song: s,
            filename: fname,
            infoText: info,
            view: v,
            cursor: c,
            currentSample: samp,
            currentOctave: oct,
            editStep: step,
            xmEdit,
            chiptuneSources: isPt2 ? chiptuneSourcesSnapshot() : undefined,
            samplerSources: isPt2 ? samplerSourcesSnapshot() : undefined,
            patternNames: names,
            mutedChannels: muted,
            soloedChannels: soloed,
            xmChiptuneSources: isXm ? xmChiptuneSourcesSnapshot() : undefined,
            xmSamplerSources: isXm ? xmSamplerSourcesSnapshot() : undefined,
            unreadSources: unreadSourcesSnapshot(),
            cloudOrigin: origin,
          },
          recordAutosaveOutcome,
        );
      }, 250);
    });
    cleanups.push(() => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
    });

    const selectAllSampleForActiveSong = () => {
      const s = song();
      if (!s) return;
      if (s.format === "FT2") {
        const inst = s.instruments[currentXmInstrument() - 1];
        const sample = inst?.samples[currentXmSampleIndex()];
        if (!sample || sample.data.length < 2) return;
        // No selecting a chiptune source — the synth re-renders the
        // cycle on every edit, and the waveform doesn't draw one.
        const wb = getXmWorkbench(
          currentXmInstrument(),
          currentXmSampleIndex(),
        );
        if (wb?.source.kind === "chiptune") return;
        setXmSampleSelection({ start: 0, end: sample.data.length });
        return;
      }
      selectAllSample();
    };

    // ⌘O / ⌘S switch to cloud variants when the cloud features are
    // visible (backend up AND signed in if auth is on). Falls back to
    // local pickers in every other case — including auth-required-but-
    // signed-out, since the cloud entries are hidden then anyway.
    const cloudVisible = () => cloudVisibleFor(backendAvailable());
    const openShortcut = () => {
      if (cloudVisible()) {
        setServerBrowser({
          mode: "open",
          resources: ["projects", "modules"],
          title: "Open from cloud",
        });
      } else {
        openFilePicker();
      }
    };
    const saveShortcut = () => {
      if (!song()) return;
      if (cloudVisible()) {
        setServerBrowser({
          mode: "save",
          resources: ["projects"],
          saveTo: "projects",
          title: "Save to cloud",
        });
      } else {
        saveProject();
      }
    };

    for (const c of registerAppKeybinds({
      openFilePicker: openShortcut,
      saveProject: saveShortcut,
      selectAllStep,
      selectAllSample: selectAllSampleForActiveSong,
      copySelection: copyClipboardForActiveView,
      cutSelection: cutClipboardForActiveView,
      pasteAtCursor: pasteClipboardForActiveView,
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
      jumpPrevOrder,
      jumpNextOrder,
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
    // FT2 keybinds — registered alongside the PT2 set, each gated on the
    // active song format. The format is locked for a project's lifetime
    // (modal picker on new, sniff on load), so a single registration covers
    // the whole session.
    for (const c of registerXmAppKeybinds()) cleanups.push(c);
  });
  onCleanup(() => {
    for (const c of cleanups) c();
    preview.stopPreview();
    void disposeEngine();
  });

  // Functions, not arrays — disabled flags need to re-evaluate every
  // time the Menu reads `props.items`. Three cloud states matter:
  //   1. backend down               → no cloud entries at all
  //   2. backend up, no auth        → cloud entries always shown
  //   3. backend up, auth required  → entries only when signed in;
  //      otherwise only a Sign-in entry appears
  // ⌘O / ⌘S hint hops to the cloud entry whenever it's visible.
  const fileMenuItems = (): MenuItem[] => {
    const backend = backendAvailable();
    const needsAuth = authRequired();
    const user = currentUser();
    const cloud = cloudVisibleFor(backend);
    const showSignIn = backend && needsAuth && !user;
    const items: MenuItem[] = [
      { icon: FilePlus, label: "New", onClick: () => setModePickerOpen(true) },
      { separator: true, label: "" },
      {
        icon: FolderOpen,
        label: "Open from computer…",
        hint: cloud ? undefined : "⌘O",
        onClick: openFilePicker,
      },
    ];
    if (cloud) {
      items.push({
        icon: CloudDownload,
        label: "Open from cloud…",
        hint: "⌘O",
        onClick: () =>
          setServerBrowser({
            mode: "open",
            resources: ["projects", "modules"],
            title: "Open from cloud",
          }),
      });
    }
    items.push(
      { separator: true, label: "" },
      {
        icon: Save,
        label: "Save to computer…",
        hint: cloud ? undefined : "⌘S",
        onClick: saveProject,
        disabled: !song(),
      },
    );
    if (cloud) {
      items.push({
        icon: CloudUpload,
        label: "Save to cloud…",
        hint: "⌘S",
        onClick: () =>
          setServerBrowser({
            mode: "save",
            resources: ["projects"],
            saveTo: "projects",
            title: "Save to cloud",
          }),
        disabled: !song(),
      });
    }
    // "Share this song…" appears only when the backend exposes the
    // share feature (DATABASE_URL set on the server). Disabled-with-
    // tooltip beats hidden when the song isn't from the cloud yet —
    // less mysterious for users who expect the item to be there.
    if (cloud && shareAvailable()) {
      const origin = cloudOrigin();
      items.push({
        icon: Share2,
        label: "Share this song…",
        onClick: () => setShareModalOpen(true),
        disabled: !song() || origin === null,
      });
    }
    if (showSignIn) {
      items.push(
        { separator: true, label: "" },
        {
          icon: LogIn,
          label: "Sign in to cloud…",
          onClick: () => cloudLogin(),
        },
      );
    } else if (backend && needsAuth && user) {
      const who = user.name || user.email || "Signed in";
      items.push(
        { separator: true, label: "" },
        {
          icon: User,
          label: `Signed in as ${who}`,
          onClick: () => {},
          disabled: true,
        },
        { icon: LogOut, label: "Sign out", onClick: () => void cloudLogout() },
      );
    }
    items.push(
      { separator: true, label: "" },
      {
        icon: FileDown,
        label: song()?.format === "FT2" ? "Export .xm…" : "Export .mod…",
        onClick: exportSong,
        disabled: !song(),
      },
      {
        icon: FileVolume,
        label: "Export .wav…",
        onClick: exportWav,
        disabled: !song(),
      },
      {
        icon: FileVolume,
        label: "Export .mp3…",
        onClick: () => void exportMp3(),
        disabled: !song(),
      },
      { separator: true, label: "" },
      {
        icon: Info,
        label: "Song info",
        hint: "F4",
        onClick: () => setView("info"),
        disabled: !song(),
      },
    );
    return items;
  };

  const editMenuItems = (): MenuItem[] => {
    const locked = transport() === "playing" && settings().followPlayback;
    const ft2 = !!xm2Song();
    return [
      {
        icon: Undo2,
        label: "Undo",
        hint: "⌘Z",
        onClick: undo,
        disabled: !canUndo() || locked,
      },
      {
        icon: Redo2,
        label: "Redo",
        hint: "⇧⌘Z",
        onClick: redo,
        disabled: !canRedo() || locked,
      },
      { separator: true, label: "" },
      // Disabled checks mirror the shortcut `when` predicates so the
      // menu and keyboard agree on when the action is reachable. The
      // sample-view branch routes through the sample clipboard and is
      // allowed mid-playback (sample edits don't race the worklet);
      // the pattern-view branch keeps its transport gate. The sample
      // copy/cut "has data" check looks at the current slot rather
      // than a selection — the action's range-resolution falls back
      // to the whole sample when nothing is selected.
      {
        icon: Scissors,
        label: "Cut",
        hint: "⌘X",
        onClick: cutClipboardForActiveView,
        disabled:
          view() === "sample"
            ? !song() || !currentSampleHasData()
            : locked || !song(),
      },
      {
        icon: Copy,
        label: "Copy",
        hint: "⌘C",
        onClick: copyClipboardForActiveView,
        disabled:
          view() === "sample" ? !song() || !currentSampleHasData() : !song(),
      },
      {
        icon: ClipboardPaste,
        label: "Paste",
        hint: "⌘V",
        onClick: pasteClipboardForActiveView,
        disabled:
          view() === "sample"
            ? !song() || !(xm2Song() ? xmSampleClipboard() : sampleClipboard())
            : locked ||
              !song() ||
              !(xm2Song() ? xmClipboardSlice() : clipboardSlice()),
      },
      { separator: true, label: "" },
      {
        // FT2 lands the render in a new instrument, PT in a sample slot;
        // each format has its own selection signal and free-slot rule.
        icon: AudioWaveform,
        label: ft2 ? "Bounce to instrument" : "Bounce to sample",
        hint: "⌘E",
        onClick: ft2 ? bounceXmSelectionToInstrument : bounceSelectionToSample,
        disabled: ft2
          ? locked ||
            view() !== "pattern" ||
            !xmSelection() ||
            nextFreeXmInstrumentSlot() === null
          : locked ||
            view() === "sample" ||
            !song() ||
            !selection() ||
            nextFreeSlot(pt2Song(), -1) === null,
      },
      { separator: true, label: "" },
      {
        // No shortcut: F11 belongs to the browser, and its own fullscreen
        // is invisible to the Fullscreen API anyway.
        icon: isFullscreen() ? Minimize : Maximize,
        label: isFullscreen() ? "Exit fullscreen" : "Fullscreen",
        onClick: toggleFullscreen,
        disabled: !fullscreenSupported,
      },
      {
        icon: Settings,
        label: "Settings",
        hint: "F5",
        onClick: () => setView("settings"),
      },
    ];
  };

  const samplesMenuItems = (): MenuItem[] => {
    const xm = xm2Song();
    if (xm) {
      // FT2: the same four actions, acting on the current instrument. The
      // gates mirror the buttons in InstrumentView — these actions are
      // allowed during playback there, so they are here too.
      const inst = xm.instruments[currentXmInstrument() - 1];
      const hasData = !!inst?.samples.some((sm) => sm.data.length > 0);
      return [
        {
          icon: Upload,
          label: "Load WAV…",
          onClick: () => wavInput?.click(),
        },
        {
          icon: CopyPlus,
          label: "Duplicate",
          onClick: duplicateCurrentXmInstrument,
          disabled: !hasData || nextFreeXmInstrumentSlot() === null,
        },
        {
          icon: WandSparkles,
          label: "Apply chain to source",
          onClick: applyXmChainToSource,
        },
        { separator: true, label: "" },
        {
          icon: Trash,
          label: "Clear",
          onClick: clearCurrentXmInstrument,
        },
      ];
    }
    const s = pt2Song();
    const playing = transport() === "playing";
    const hasSong = !!s;
    return [
      {
        icon: Upload,
        label: "Load WAV…",
        onClick: () => wavInput?.click(),
        disabled: !hasSong,
      },
      {
        icon: CopyPlus,
        label: "Duplicate",
        onClick: duplicateCurrentSample,
        disabled:
          !hasSong || nextFreeSlot(s, currentSample() - 1) === null || playing,
      },
      {
        icon: WandSparkles,
        label: "Apply chain to source",
        onClick: applyChainToSource,
        disabled: !hasSong,
      },
      { separator: true, label: "" },
      {
        icon: Trash,
        label: "Clear",
        onClick: clearCurrentSample,
        disabled: !hasSong || playing,
      },
    ];
  };

  const orderMenuItems = (): MenuItem[] => {
    const s = song();
    const playing = transport() === "playing";
    const hasSong = !!s;
    // Every handler has a PT and an FT2 implementation; the menu used to
    // call the PT ones unconditionally, so for an FT2 song every item was
    // enabled and did nothing.
    const xm = s?.format === "FT2";
    const cursorOrder = xm ? xmCursor().order : cursor().order;
    const activeIdx = playing ? playPos().order : cursorOrder;
    const slotPat = s ? (s.orders[activeIdx] ?? 0) : 0;
    const selected = selectedOrderCount();
    return [
      {
        icon: ChevronLeft,
        label: "Previous pattern",
        hint: "⇧[",
        onClick: xm ? stepXmPrevPattern : stepPrevPattern,
        disabled: !hasSong || slotPat <= 0,
      },
      {
        icon: ChevronRight,
        label: "Next pattern",
        hint: "⇧]",
        onClick: xm ? stepXmNextPattern : stepNextPattern,
        disabled: !hasSong,
      },
      { separator: true, label: "" },
      {
        icon: Plus,
        // With several slots selected in the order list these three act
        // on the whole run, and say so.
        label:
          selected > 0 ? `Repeat ${selected} selected slots` : "Insert slot",
        hint: "⌘]",
        onClick: xm ? insertXmOrderSlot : insertOrderSlot,
        disabled:
          !hasSong ||
          (s ? !canInsertOrders(s.songLength, s.orders.length) : true),
      },
      {
        icon: Minus,
        label:
          selected > 0 ? `Delete ${selected} selected slots` : "Delete slot",
        hint: "⌘[",
        onClick: xm ? deleteXmOrderSlot : deleteOrderSlot,
        disabled: !hasSong || (s ? s.songLength <= 1 : true),
      },
      { separator: true, label: "" },
      {
        icon: FilePlus,
        label: "New blank pattern",
        hint: "⌥[",
        onClick: xm ? newXmBlankPatternAtOrder : newBlankPatternAtOrder,
        disabled: !hasSong,
      },
      {
        icon: CopyPlus,
        label:
          selected > 0
            ? `Duplicate patterns of ${selected} selected slots`
            : "Duplicate pattern",
        hint: "⌥]",
        onClick: xm ? duplicateXmCurrentPattern : duplicateCurrentPattern,
        disabled: !hasSong,
      },
      { separator: true, label: "" },
      {
        // Renumbers patterns by appearance and discards unused. Gated on
        // playing because the worklet's snapshot still references the
        // pre-cleanup pattern indices.
        icon: Eraser,
        label: "Clean up",
        onClick: xm ? cleanupXmOrderList : cleanupOrderList,
        disabled: !hasSong || playing,
      },
    ];
  };

  const helpMenuItems = (): MenuItem[] => [
    {
      icon: BookOpen,
      label: "User manual",
      onClick: () =>
        window.open(USER_MANUAL_URL, "_blank", "noopener,noreferrer"),
    },
    {
      icon: Lightbulb,
      label: "Show tips",
      checked: settings().showPatternHelp,
      onClick: toggleShowPatternHelp,
    },
    { separator: true, label: "" },
    { icon: Info, label: "About…", onClick: () => setAboutOpen(true) },
  ];

  const sampleCount = createMemo(() => {
    const s = song();
    if (!s) return 0;
    if (s.format === "FT2") {
      // Instruments with something to play — the ones the list doesn't
      // grey out — not every slot the file declares.
      return s.instruments.filter((inst) => !isXmInstrumentEmpty(inst)).length;
    }
    return s.samples.filter((x) => x.lengthWords > 0).length;
  });

  /** True if the active sample slot has any int8 bytes — used to gate
   *  Copy / Cut in the sample view. The clipboard ops fall back to
   *  "whole sample" when there's no selection, so they only need a
   *  populated slot to be meaningful. */
  const currentSampleHasData = createMemo(() => {
    const s = song();
    if (!s) return false;
    if (s.format === "FT2") {
      const sample =
        s.instruments[currentXmInstrument() - 1]?.samples[
          currentXmSampleIndex()
        ];
      return (sample?.data.length ?? 0) > 0;
    }
    return (s.samples[currentSample() - 1]?.data.byteLength ?? 0) > 0;
  });

  // Speed / tempo in effect at the cursor's (order, row) — fed to the
  // sample-pipeline Length-calculator modal so its inputs auto-fill from
  // wherever the user is currently editing. Inclusive: an Fxx on the
  // cursor row itself is what the user sees, so the calculator should
  // honor it.
  const cursorSpeedTempo = createMemo(() => {
    const s = song();
    if (!s || s.format !== "PT2") return { speed: 6, tempo: 125 };
    const c = cursor();
    return speedTempoAt(s, c.order, c.row, true);
  });

  // Size of the song as its native module file — what Export .mod /
  // Export .xm would write.
  const moduleByteSize = createMemo(() => {
    const s = song();
    if (!s) return 0;
    return (s.format === "PT2" ? writeModule(s) : writeXm(s)).length;
  });
  const moduleExt = () => (song()?.format === "FT2" ? ".xm" : ".mod");

  // Estimated `.retro` size. Tracks only the inputs that affect bytes
  // (song / metadata / chiptune params); cursor moves and view toggles
  // don't recompute. `encodeSongCached` reuses the writeModule output
  // between this memo and the autosave path.
  const projectByteSize = createMemo(() => {
    const s = song();
    if (!s) return 0;
    const isPt2 = s.format === "PT2";
    const isXm = s.format === "FT2";
    return projectToBytes({
      song: s,
      filename: filename(),
      infoText: infoText(),
      view: "pattern",
      cursor: { order: 0, row: 0, channel: 0, field: "note" },
      currentSample: 1,
      currentOctave: 1,
      editStep: 1,
      chiptuneSources: isPt2 ? chiptuneSourcesSnapshot() : undefined,
      samplerSources: isPt2 ? samplerSourcesSnapshot() : undefined,
      patternNames: patternNames(),
      mutedChannels: mutedChannels(),
      soloedChannels: soloedChannels(),
      xmChiptuneSources: isXm ? xmChiptuneSourcesSnapshot() : undefined,
      xmSamplerSources: isXm ? xmSamplerSourcesSnapshot() : undefined,
    }).length;
  });

  // Size level against the browser-storage budget. The header chip only
  // tints; nothing used to SAY anything until an autosave had already
  // failed. Warn once per level change so the user can shrink the
  // project (or save it) while autosave still works.
  //
  // What counts against the budget depends on where sources live. With
  // the source store (IndexedDB) the localStorage payload is the song
  // plus small metadata — sample sources don't count. Without it they
  // are inline, so the whole `.retro`-sized payload has to fit.
  const sessionStorageBytes = createMemo(() => {
    if (!sourceStoreAvailable()) return projectByteSize();
    const s = song();
    if (!s) return 0;
    const isPt2 = s.format === "PT2";
    return projectToBytes({
      song: s,
      filename: filename(),
      infoText: infoText(),
      view: "pattern",
      cursor: { order: 0, row: 0, channel: 0, field: "note" },
      currentSample: 1,
      currentOctave: 1,
      editStep: 1,
      chiptuneSources: isPt2 ? chiptuneSourcesSnapshot() : undefined,
      patternNames: patternNames(),
      xmChiptuneSources: isPt2 ? undefined : xmChiptuneSourcesSnapshot(),
    }).length;
  });
  const projectSizeLevel = createMemo<"ok" | "warn" | "over">(() => {
    const n = sessionStorageBytes();
    if (n > PROJECT_SIZE_LIMIT_BYTES) return "over";
    return n >= PROJECT_SIZE_WARN_BYTES ? "warn" : "ok";
  });
  const [sizeWarningDismissed, setSizeWarningDismissed] = createSignal(false);
  createEffect(() => {
    projectSizeLevel();
    setSizeWarningDismissed(false);
  });
  // Once autosave has actually degraded or failed, its own banner is the
  // accurate one — don't stack a second warning about the same thing.
  const sizeWarningText = () => {
    const size = formatProjectSize(sessionStorageBytes());
    const budget = formatProjectSize(PROJECT_SIZE_LIMIT_BYTES);
    const over = projectSizeLevel() === "over";
    if (sourceStoreAvailable()) {
      // Sources are stored separately; it is the song itself (patterns
      // plus rendered samples) that is filling the budget.
      return over
        ? `The song itself is ${size}, over the ${budget} browser-storage budget, so autosave may fail. Save the project to keep your work; shorter or fewer samples shrink it.`
        : `The song itself is ${size} of the ${budget} browser-storage budget. Past it, autosave fails. Shorter or fewer samples shrink it.`;
    }
    return over
      ? `This project is ${size}, over the ${budget} browser-storage budget. Autosave may stop keeping sample sources and effect chains. Save the project, or shrink it with "Apply chain to source" on cropped samples.`
      : `This project is ${size} of the ${budget} browser-storage budget. Past it, autosave stops keeping sample sources and effect chains. "Apply chain to source" on cropped samples shrinks it.`;
  };
  const showSizeWarning = () =>
    projectSizeLevel() !== "ok" &&
    autosaveOutcome() === "ok" &&
    !sizeWarningDismissed();

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
      <Show when={sharedBanner()}>
        {(b) => (
          <div class="share-banner" role="status">
            <span class="share-banner__text">
              Opened from a share link: <code>{b().filename}</code>. Sign in and
              use <em>Save to cloud…</em> to keep a copy in your own library.
            </span>
            <button
              type="button"
              class="share-banner__dismiss"
              onClick={dismissSharedBanner}
              aria-label="Dismiss"
              title="Dismiss"
            >
              <Icon of={X} />
            </button>
          </div>
        )}
      </Show>
      <Show when={shareLoadError()}>
        {(msg) => (
          <div class="share-banner share-banner--error" role="alert">
            <span class="share-banner__text">{msg()}</span>
            <button
              type="button"
              class="share-banner__dismiss"
              onClick={dismissShareLoadError}
              aria-label="Dismiss"
              title="Dismiss"
            >
              <Icon of={X} />
            </button>
          </div>
        )}
      </Show>
      {/* `error()` used to render only on the empty-state dropzone, so with
          a song open a failed load (or "no free sample slots", a bad WAV,
          …) was completely silent. */}
      <Show when={song() ? error() : null}>
        {(msg) => (
          <div class="share-banner share-banner--error" role="alert">
            <span class="share-banner__text">{msg()}</span>
            <button
              type="button"
              class="share-banner__dismiss"
              onClick={() => setError(null)}
              aria-label="Dismiss"
              title="Dismiss"
            >
              <Icon of={X} />
            </button>
          </div>
        )}
      </Show>
      <Show when={autosaveOutcome() !== "ok" && !autosaveWarningDismissed()}>
        <div class="share-banner share-banner--error" role="alert">
          <span class="share-banner__text">
            {autosaveOutcome() === "degraded"
              ? "This project is too large for browser storage. Autosave now keeps the song and rendered samples only — sample sources and effect chains will be gone after a reload. Use Save to keep everything."
              : "Autosave isn't working: the browser couldn't store this project (storage full or blocked), so a reload would bring back an older version. Use Save to keep your work."}
          </span>
          <button
            type="button"
            class="share-banner__dismiss"
            onClick={() => setAutosaveWarningDismissed(true)}
            aria-label="Dismiss"
            title="Dismiss"
          >
            <Icon of={X} />
          </button>
        </div>
      </Show>
      <Show when={song() && showSizeWarning()}>
        <div class="share-banner share-banner--warn" role="status">
          <span class="share-banner__text">{sizeWarningText()}</span>
          <button
            type="button"
            class="share-banner__dismiss"
            onClick={() => setSizeWarningDismissed(true)}
            aria-label="Dismiss"
            title="Dismiss"
          >
            <Icon of={X} />
          </button>
        </div>
      </Show>
      <header class="app__header">
        <div class="app__header-left">
          <h1>
            RetroTracker <span class="app__version">{APP_VERSION}</span>
          </h1>
          {/* Hidden — clicked by File→Open and Cmd+O. */}
          <input
            type="file"
            accept=".retro,.mod,.xm"
            onChange={onPickFile}
            hidden
            ref={fileInput}
          />
          {/* Hidden — clicked by Samples → Load WAV. */}
          <input
            type="file"
            accept=".wav"
            onChange={onPickWav}
            hidden
            ref={wavInput}
          />
          <Menu label="File" items={fileMenuItems()} />
          <Menu label="Edit" items={editMenuItems()} />
          <Menu
            label={xm2Song() ? "Instruments" : "Samples"}
            items={samplesMenuItems()}
          />
          <Menu label="Order" items={orderMenuItems()} />
          <Menu label="Help" items={helpMenuItems()} />
        </div>
        <div class="app__header-center">
          <div class="viewtabs" role="tablist" aria-label="View">
            <button
              type="button"
              role="tab"
              classList={{ "viewtab--active": view() === "pattern" }}
              aria-selected={view() === "pattern"}
              onClick={() => setView("pattern")}
              title="Pattern view (F2)"
            >
              <Icon of={Table2} />
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
              <Icon of={AudioWaveform} />
              Sample
            </button>
          </div>
          <div class="transport" role="group" aria-label="Transport">
            <button
              type="button"
              class="transport__btn transport__btn--play"
              classList={{
                "transport__btn--active": transport() === "playing",
              }}
              onClick={() => void toggleTransport()}
              disabled={!song()}
              title={
                transport() === "playing"
                  ? "Stop (Space)"
                  : settings().loopPattern
                    ? "Play pattern (Space)"
                    : "Play song (Space)"
              }
              aria-label={transport() === "playing" ? "Stop" : "Play"}
              aria-pressed={transport() === "playing"}
            >
              <Show
                when={transport() === "playing"}
                fallback={<Icon of={Play} />}
              >
                <Icon of={Square} />
              </Show>
            </button>
            <div
              class="transport__group"
              role="group"
              aria-label="Playback mode"
            >
              <button
                type="button"
                class="transport__btn"
                classList={{
                  "transport__btn--active": !settings().loopPattern,
                }}
                onClick={() => setLoopPattern(false)}
                title="Play the whole song"
                aria-pressed={!settings().loopPattern}
              >
                <Icon of={ListMusic} />
                Song
              </button>
              <button
                type="button"
                class="transport__btn"
                classList={{
                  "transport__btn--active": settings().loopPattern,
                }}
                onClick={() => setLoopPattern(true)}
                title="Loop the cursor's pattern"
                aria-pressed={settings().loopPattern}
              >
                <Icon of={Repeat} />
                Pattern
              </button>
            </div>
            <button
              type="button"
              class="transport__btn transport__btn--pill"
              classList={{
                "transport__btn--active": settings().followPlayback,
              }}
              onClick={() => toggleFollowPlayback()}
              title={
                settings().followPlayback
                  ? "View follows the playhead — click to track the cursor instead"
                  : "View tracks the cursor — click to follow the playhead"
              }
              aria-pressed={settings().followPlayback}
            >
              <Icon of={LocateFixed} />
              Follow
            </button>
          </div>
        </div>
        <Show when={song()}>
          {/* Combined size pill: .mod / .xm payload + estimated .retro project
              size / limit. Shares one chip to free header space; warn/err
              classes tint it yellow / red as the .retro estimate climbs. */}
          <span
            class="filesize"
            classList={{
              "filesize--warn": projectSizeLevel() === "warn",
              "filesize--err": projectSizeLevel() === "over",
            }}
            title={
              sourceStoreAvailable()
                ? `${moduleExt()} file size · estimated .retro project size. Autosave keeps sample sources in separate browser storage; the song itself is ${formatProjectSize(sessionStorageBytes())} of its ${formatProjectSize(PROJECT_SIZE_LIMIT_BYTES)} budget.`
                : `${moduleExt()} file size · estimated .retro project size — browser-storage budget ${formatProjectSize(PROJECT_SIZE_LIMIT_BYTES)}. Past it, autosave stops keeping sample sources and effect chains; saving to a file or the cloud is unaffected.`
            }
          >
            <span class="filesize__seg">
              {moduleExt()} {formatProjectSize(moduleByteSize())}
            </span>
            <span class="filesize__sep">·</span>
            <span class="filesize__seg">
              .retro {formatProjectSize(projectByteSize())}
              {/* The "/ budget" only means something when the whole
                  project has to fit in localStorage. */}
              <Show when={!sourceStoreAvailable()}>
                {" "}
                / {formatProjectSize(PROJECT_SIZE_LIMIT_BYTES)}
              </Show>
            </span>
          </span>
        </Show>
      </header>

      <aside class="app__samples">
        <h2>{xm2Song() ? "Instruments" : "Samples"}</h2>
        <Show
          when={xm2Song()}
          fallback={
            <SlotList
              slots={() => {
                const s = pt2Song();
                if (!s) return null;
                return s.samples.map((sample) => ({
                  name: sample.name,
                  isEmpty: sample.lengthWords === 0,
                }));
              }}
              currentSlot={currentSample}
              onSelect={selectSample}
              onRename={renameSample}
              onDropFiles={(slot1Based, files) => {
                void loadWavsIntoSlot(slot1Based - 1, files);
              }}
              nameMaxLength={SAMPLE_NAME_MAX}
              itemLabel="sample"
            />
          }
        >
          {(xm) => (
            <SlotList
              slots={() => {
                const insts = xm().instruments;
                const arr: SlotDisplay[] = new Array(XM_MAX_INSTRUMENTS);
                for (let i = 0; i < XM_MAX_INSTRUMENTS; i++) {
                  const inst = insts[i];
                  // Greyed-out when there is nothing to play — the same
                  // test imports use to find a free slot.
                  const isEmpty = isXmInstrumentEmpty(inst);
                  arr[i] = {
                    name: inst?.name ?? "",
                    isEmpty,
                  };
                }
                return arr;
              }}
              currentSlot={currentXmInstrument}
              onSelect={selectXmInstrument}
              onRename={renameXmInstrument}
              onDropFiles={(slot1Based, files) => {
                void loadWavsIntoXmSlot(slot1Based, files);
              }}
              nameMaxLength={XM_INSTRUMENT_NAME_MAX}
              itemLabel="instrument"
            />
          )}
        </Show>
      </aside>

      <main class="app__main">
        <Show when={xm2Song()}>
          {(xm) => (
            <>
              <div
                class="patternpane"
                classList={{ "view-hidden": view() !== "pattern" }}
              >
                <div class="patternpane__meta">
                  <SongTitle title={xm().title} onCommit={commitSongTitle} />
                  <ModeBadge format="FT2" />
                  <span class="patternpane__sep">·</span>
                  <span>{filename()}</span>
                  <span class="patternpane__sep">·</span>
                  <MetaNumberInput
                    label="Channels"
                    ariaLabel="Channel count"
                    title="Song-wide channel count"
                    min={2}
                    max={XM_MAX_CHANNELS}
                    disabled={transport() === "playing"}
                    value={xm().channelCount}
                    onCommit={setXmChannelCountAction}
                  />
                  <span class="patternpane__sep">·</span>
                  <span>{sampleCount()} instruments</span>
                  <span class="patternpane__sep">·</span>
                  <MetaNumberInput
                    label="Rows"
                    ariaLabel="Pattern row count"
                    title={`Row count of pattern at order ${xmCursor().order}`}
                    min={XM_MIN_PATTERN_ROWS}
                    max={XM_MAX_PATTERN_ROWS}
                    disabled={transport() === "playing"}
                    value={(() => {
                      const s = xm();
                      const idx = s.orders[xmCursor().order];
                      return idx !== undefined
                        ? (s.patterns[idx]?.rowCount ?? 0)
                        : 0;
                    })()}
                    onCommit={setXmRowCountAtCursor}
                  />
                  <span class="patternpane__sep">·</span>
                  <MetaNumberInput
                    label="Speed"
                    ariaLabel="Initial speed"
                    title="Initial speed in ticks per row"
                    min={XM_MIN_SPEED}
                    max={XM_MAX_SPEED}
                    disabled={transport() === "playing"}
                    value={xm().defaultTempo}
                    onCommit={setXmDefaultSpeedAction}
                  />
                  <span class="patternpane__sep">·</span>
                  <MetaNumberInput
                    label="Tempo"
                    ariaLabel="Initial tempo"
                    title="Initial tempo in BPM"
                    min={XM_MIN_BPM}
                    max={XM_MAX_BPM}
                    disabled={transport() === "playing"}
                    value={xm().defaultBpm}
                    onCommit={setXmDefaultBpmAction}
                  />
                  <span class="patternpane__sep">·</span>
                  <PatternPosReadout song={xm()} />
                  <span class="patternpane__sep">·</span>
                  <span>oct {currentXmOctave()}</span>
                  <span class="patternpane__sep">·</span>
                  <span>
                    ins{" "}
                    {currentXmInstrument()
                      .toString(16)
                      .toUpperCase()
                      .padStart(2, "0")}
                  </span>
                  <span class="patternpane__sep">·</span>
                  <EditStepControl />
                </div>
                <PatternGridXm
                  song={xm()}
                  pos={playPos()}
                  active={transport() === "playing"}
                />
                <Show when={settings().showPatternHelp}>
                  <XmPatternHelp song={xm()} cursor={xmCursor()} />
                </Show>
              </div>
              <div
                class="sampleview-wrapper"
                classList={{ "view-hidden": view() !== "sample" }}
              >
                <InstrumentView song={xm()} />
              </div>
            </>
          )}
        </Show>
        <Show
          when={pt2Song()}
          fallback={
            <Show when={!song()}>
              <div class="dropzone">
                <p>
                  Drop a <code>.mod</code> or <code>.xm</code> file anywhere, or
                  use <em>Load .mod…</em>
                </p>
                <Show when={error()}>
                  <p class="error">{error()}</p>
                </Show>
              </div>
            </Show>
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
                  <SongTitle title={s().title} onCommit={commitSongTitle} />
                  <ModeBadge format={s().format} />
                  <span class="patternpane__sep">·</span>
                  <span>{filename()}</span>
                  <span class="patternpane__sep">·</span>
                  <span>{sampleCount()} samples</span>
                  <span class="patternpane__sep">·</span>
                  <PatternPosReadout song={s()} />
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
                  <EditStepControl />
                </div>
                <PatternGrid
                  song={s()}
                  pos={playPos()}
                  active={transport() === "playing"}
                  onCellClick={applyCursor}
                />
                <Show when={settings().showPatternHelp}>
                  <PatternHelp song={s()} cursor={cursor()} />
                </Show>
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
                  onCutSelection={cutSampleRange}
                  onCopySelection={copySampleRange}
                  onPasteSampleClipboard={pasteSampleFromClipboard}
                  sampleClipboardHasData={!!sampleClipboard()}
                  onAddEffect={addEffect}
                  onRemoveEffect={removeEffect}
                  onMoveEffect={moveEffect}
                  onPatchEffect={patchEffect}
                  onSetEffectBypass={setEffectBypass}
                  onApplyChain={applyChainToSource}
                  onSetMonoMix={setMonoMix}
                  onSetTargetNote={setTargetNote}
                  onSetResampleMode={setResampleMode}
                  onSetDither={setDither}
                  onSetPlayingLengthTicks={setPlayingLengthTicks}
                  cursorSpeed={cursorSpeedTempo().speed}
                  cursorTempo={cursorSpeedTempo().tempo}
                  onSetSourceKind={setSourceKind}
                  onUpdateChiptune={updateChiptune}
                  onConvertChiptuneToSampler={convertChiptuneToSampler}
                  onConvertToSampler={convertSlotToSampler}
                  onAddEnvelopePoint={addEnvelopePoint}
                  onRemoveEnvelopePoint={removeEnvelopePoint}
                  onPatchEnvelopePoint={patchEnvelopePoint}
                  onNudgeEnvelopeSegment={nudgeEnvelopeSegment}
                />
              </div>
            </>
          )}
        </Show>
        {/* Info and Settings are format-agnostic, so they live outside the
            PT2 / FT2 branches above. They used to sit inside the PT2 one,
            which left both views blank for FT2 songs. */}
        <Show when={song()}>
          {(s) => (
            <>
              <div
                class="infoview-wrapper"
                classList={{ "view-hidden": view() !== "info" }}
              >
                <InfoView
                  song={s()}
                  filename={filename()}
                  infoText={infoText()}
                  onTitleChange={commitSongTitle}
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
          <Show when={xm2Song()}>{(xm) => <XmOrderList song={xm()} />}</Show>
          <Show
            when={pt2Song()}
            fallback={
              <Show when={!xm2Song()}>
                <p class="placeholder">—</p>
              </Show>
            }
          >
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
              // With several slots selected, Insert needs room for a
              // copy of the whole run.
              const canIns = () =>
                canInsertOrders(s().songLength, s().orders.length);
              const canDel = () => s().songLength > 1;
              const canBlank = () => true;
              return (
                <>
                  <div class="ordertools">
                    <button
                      type="button"
                      onClick={stepPrevPattern}
                      disabled={!canPrev()}
                      title="Previous pattern at slot (⇧[)"
                      aria-label="Previous pattern at slot"
                    >
                      <Icon of={ChevronLeft} />
                    </button>
                    <button
                      type="button"
                      onClick={stepNextPattern}
                      disabled={!canNext()}
                      title="Next pattern at slot (⇧])"
                      aria-label="Next pattern at slot"
                    >
                      <Icon of={ChevronRight} />
                    </button>
                    <button
                      type="button"
                      onClick={insertOrderSlot}
                      disabled={!canIns()}
                      title={insertOrderTitle(
                        s().songLength,
                        s().orders.length,
                      )}
                      aria-label="Insert slot"
                    >
                      <Icon of={Plus} />
                    </button>
                    <button
                      type="button"
                      onClick={deleteOrderSlot}
                      disabled={!canDel()}
                      title={deleteOrderTitle()}
                      aria-label="Delete slot"
                    >
                      <Icon of={Minus} />
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
                      title={duplicatePatternTitle()}
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
                            "orderlist__item--selected": isOrderSelected(i),
                          }}
                          onClick={(e) => {
                            if (editingOrderIdx() === i) return;
                            // Shift-click selects a run of slots for
                            // Insert / Dup / Delete to act on.
                            if (e.shiftKey) selectOrdersTo(i);
                            else jumpToOrder(i);
                          }}
                          onDblClick={(e) => {
                            e.stopPropagation();
                            setEditingOrderIdx(i);
                          }}
                          title={orderSlotTitle(i)}
                        >
                          <span class="num">
                            {i.toString(16).toUpperCase().padStart(2, "0")}
                          </span>
                          <span class="pat">
                            {p.toString(16).toUpperCase().padStart(2, "0")}
                          </span>
                          <PatternNameField
                            name={patternNames()[p] ?? ""}
                            editing={editingOrderIdx() === i}
                            onCommit={(raw) => commitPatternRename(p, raw)}
                            onCancel={() => setEditingOrderIdx(null)}
                          />
                        </li>
                      ))}
                  </ol>
                </>
              );
            }}
          </Show>
        </aside>
      </Show>
      <Show when={aboutOpen()}>
        <AboutModal onClose={() => setAboutOpen(false)} />
      </Show>
      <Show when={modePickerOpen()}>
        <ModePicker
          onPick={(format) => {
            setModePickerOpen(false);
            newProject(format);
          }}
          onCancel={() => setModePickerOpen(false)}
        />
      </Show>
      <Show when={serverBrowser()}>
        {(sb) => (
          <ServerBrowser
            mode={sb().mode}
            resources={sb().resources}
            saveTo={sb().saveTo}
            title={sb().title}
            initialName={
              sb().mode === "save"
                ? (filename()?.replace(/\.(mod|xm|retro)$/i, ".retro") ??
                  `${song()?.title || "untitled"}.retro`)
                : ""
            }
            onPick={(name, resource, signal) => {
              if (sb().mode === "open") {
                return openFromCloud(resource, name, signal);
              }
              return saveProjectToCloud(name, signal);
            }}
            onClose={() => setServerBrowser(null)}
          />
        )}
      </Show>
      <Show when={shareModalOpen()}>
        <ShareModal
          origin={cloudOrigin()}
          onClose={() => setShareModalOpen(false)}
        />
      </Show>
      <Mp3ExportModal />
    </div>
  );
};
