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
import { InfoView } from "./components/InfoView";
import { Menu, type MenuItem } from "./components/Menu";
import { PatternGrid } from "./components/PatternGrid";
import { PatternHelp } from "./components/PatternHelp";
import { SampleList } from "./components/SampleList";
import { SampleView } from "./components/SampleView";
import { SettingsView } from "./components/SettingsView";
import { bounceSelection } from "./core/audio/bounce";
import type { ChiptuneParams } from "./core/audio/chiptune";
import {
  workbenchFromChiptune,
  workbenchFromWavData,
} from "./core/audio/sampleWorkbench";
import { emptySong } from "./core/mod/format";
import { writeModule } from "./core/mod/writer";
import { registerAppKeybinds } from "./state/appKeybinds";
import { installEngineSync } from "./state/sync";
import {
  applyCursor,
  applyCursorWithSong,
  backspaceCell,
  backspaceRow,
  clearAtCursor,
  copySelection,
  cutSelection,
  deleteSelection,
  enterHexDigit,
  extendSelection,
  insertEmptyCell,
  insertEmptyRow,
  onPianoKey,
  pasteAtCursor,
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
  newBlankPatternAtOrder,
  stepNextPattern,
  stepPrevPattern,
} from "./state/orderEdit";
import { loadWavsIntoFreeSlots } from "./state/dropImport";
import {
  addEffect,
  applyChainToSource,
  bounceSelectionToSample,
  clearCurrentSample,
  convertChiptuneToSampler,
  convertSlotToSampler,
  cropCurrentSampleToSelection,
  cutCurrentSampleSelection,
  duplicateCurrentSample,
  loadWavIntoCurrentSample,
  moveEffect,
  nextFreeSlot,
  NO_LOOP,
  patchCurrentSample,
  patchEffect,
  removeEffect,
  renameSample,
  setDither,
  setMonoMix,
  setResampleMode,
  setSourceKind,
  setTargetNote,
  updateChiptune,
  writeWorkbenchToSongPure,
} from "./state/sampleEdit";
import {
  chiptuneSourcesSnapshot,
  error,
  exportMod,
  exportWav,
  filename,
  loadFile,
  newProject,
  samplerSourcesSnapshot,
  saveProject,
  setError,
  setFilename,
} from "./state/session";
import {
  mutedChannels,
  setChannelMuteState,
  soloedChannels,
} from "./state/channelMute";
import { clipboardSlice } from "./state/clipboard";
import { cursor, requestJumpToTop, setCursor } from "./state/cursor";
import {
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
import { infoText, setInfoText } from "./state/info";
import {
  PATTERN_NAME_MAX,
  loadPatternNames,
  patternNames,
  setPatternName,
} from "./state/patternNames";
import { loadSession, projectToBytes, saveSession } from "./state/persistence";
import {
  disposeEngine,
  jumpPlaybackToOrder,
  togglePlayPattern,
  togglePlaySong,
} from "./state/playback";
import * as preview from "./state/preview";
import {
  setWorkbench,
  withWorkbench,
  workbenches,
} from "./state/sampleWorkbench";
import { selection } from "./state/selection";
import { settings, toggleShowPatternHelp } from "./state/settings";
import { installShortcuts } from "./state/shortcuts";
import {
  canRedo,
  canUndo,
  commitEdit,
  commitEditWithWorkbenches,
  playMode,
  playPos,
  redo,
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
  const [dragOver, setDragOver] = createSignal(false);
  const [editingTitle, setEditingTitle] = createSignal(false);
  const [aboutOpen, setAboutOpen] = createSignal(false);

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
    setPatternName(patternIdx, raw);
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

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const onDragLeave = () => setDragOver(false);

  // Owns `editingTitle`, so it stays here rather than in state/sampleEdit.
  // PT title field is 20 chars; matches the Info view's input.
  const commitTitleEdit = (raw: string) => {
    setEditingTitle(false);
    const title = raw.slice(0, 20);
    commitEditWithWorkbenches((state) =>
      state.song.title === title
        ? state
        : { ...state, song: { ...state.song, title } },
    );
  };

  const cleanups: Array<() => void> = [];
  onMount(() => {
    // Sampler workbenches restore only when the previous session fit in
    // localStorage's quota — saveSession silently drops the write when
    // it doesn't, in which case the slot's int8 still plays from the
    // song bytes but the pipeline UI starts fresh.
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
        setChannelMuteState(restored.mutedChannels, restored.soloedChannels);
        setTransport("ready");
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
      const c = cursor();
      const samp = currentSample();
      const oct = currentOctave();
      const step = editStep();
      workbenches();
      const names = patternNames();
      if (!s) return;
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      const muted = mutedChannels();
      const soloed = soloedChannels();
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
          mutedChannels: muted,
          soloedChannels: soloed,
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
  });
  onCleanup(() => {
    for (const c of cleanups) c();
    preview.stopPreview();
    void disposeEngine();
  });

  // Functions, not arrays — disabled flags need to re-evaluate every
  // time the Menu reads `props.items`.
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
      // Disabled checks mirror the shortcut `when` predicates so the
      // menu and keyboard agree on when the action is reachable.
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

  const helpMenuItems = (): MenuItem[] => [
    {
      label: "User manual",
      onClick: () =>
        window.open(USER_MANUAL_URL, "_blank", "noopener,noreferrer"),
    },
    {
      label: "Show tips",
      checked: settings().showPatternHelp,
      onClick: toggleShowPatternHelp,
    },
    { separator: true, label: "" },
    { label: "About RetroTracker…", onClick: () => setAboutOpen(true) },
  ];

  const sampleCount = createMemo(() => {
    const s = song();
    if (!s) return 0;
    return s.samples.filter((x) => x.lengthWords > 0).length;
  });

  const modByteSize = createMemo(() => {
    const s = song();
    if (!s) return 0;
    return writeModule(s).length;
  });

  // Estimated `.retro` size. Tracks only the inputs that affect bytes
  // (song / metadata / chiptune params); cursor moves and view toggles
  // don't recompute. `encodeSongCached` reuses the writeModule output
  // between this memo and the autosave path.
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
      mutedChannels: mutedChannels(),
      soloedChannels: soloedChannels(),
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
          {/* Hidden — clicked by File→Open and Cmd+O. */}
          <input
            type="file"
            accept=".retro,.mod"
            onChange={onPickFile}
            hidden
            ref={fileInput}
          />
          <Menu label="File" items={fileMenuItems()} />
          <Menu label="Edit" items={editMenuItems()} />
          <Menu label="Help" items={helpMenuItems()} />
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
                        onDblClick={() => setEditingTitle(true)}
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
                    commitEditWithWorkbenches((state) =>
                      state.song.title === title
                        ? state
                        : { ...state, song: { ...state.song, title } },
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
                      title="Previous pattern at slot (⇧[)"
                      aria-label="Previous pattern at slot"
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      onClick={stepNextPattern}
                      disabled={!canNext()}
                      title="Next pattern at slot (⇧])"
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
      <Show when={aboutOpen()}>
        <AboutModal onClose={() => setAboutOpen(false)} />
      </Show>
    </div>
  );
};
