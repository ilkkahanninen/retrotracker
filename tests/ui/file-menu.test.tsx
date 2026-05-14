import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App";
import { setCursor, INITIAL_CURSOR, cursor } from "../../src/state/cursor";
import {
  setSong,
  setTransport,
  setPlayMode,
  setPlayPos,
  clearHistory,
  song,
  dirty,
  setDirty,
} from "../../src/state/song";
import {
  setCurrentSample,
  setCurrentOctave,
  setEditStep,
  currentSample,
  editStep,
} from "../../src/state/edit";
import { setView, view } from "../../src/state/view";
import { setClipboardSlice } from "../../src/state/clipboard";
import { setSelection } from "../../src/state/selection";
import {
  mutedChannels,
  resetChannelMute,
  setChannelMuteState,
  soloedChannels,
  toggleMute,
} from "../../src/state/channelMute";
import { io } from "../../src/state/io";
import {
  clearSession,
  projectToBytes,
  saveSession,
} from "../../src/state/persistence";
import { commitEdit } from "../../src/state/song";
import { emptySong } from "../../src/core/mod/format";
import { setLoopPattern, setFollowPlayback } from "../../src/state/settings";

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  setPlayMode(null);
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setEditStep(1);
  setDirty(false);
  setView("pattern");
  setSelection(null);
  resetChannelMute();
  clearSession();
}

const realDownload = io.download;
beforeEach(() => {
  resetState();
  io.download = vi.fn();
});
afterEach(() => {
  cleanup();
  io.download = realDownload;
  resetState();
  vi.restoreAllMocks();
});

/** Find the trigger of one of the header dropdown menus by its label. */
function menuTrigger(
  container: HTMLElement,
  label: "File" | "Edit",
): HTMLButtonElement {
  for (const btn of container.querySelectorAll<HTMLButtonElement>(
    ".menu__button",
  )) {
    if (btn.textContent?.startsWith(label)) return btn;
  }
  throw new Error(`${label} menu button not found`);
}

/** Open one of the header dropdowns and click an item by its visible label. */
function clickItem(
  container: HTMLElement,
  menu: "File" | "Edit",
  label: string,
): void {
  fireEvent.click(menuTrigger(container, menu));
  for (const item of container.querySelectorAll<HTMLElement>(".menu__item")) {
    if (item.textContent?.includes(label)) {
      fireEvent.click(item);
      return;
    }
  }
  throw new Error(`No ${menu}-menu item labelled "${label}"`);
}

/**
 * Click File → New, then pick "ProTracker" in the mode-picker modal that
 * opens. Phase 1 wires File → New to the modal instead of jumping straight
 * to a fresh song.
 */
function clickNewPt2(container: HTMLElement): void {
  clickItem(container, "File", "New");
  const choices = container.querySelectorAll<HTMLButtonElement>(
    ".mode-picker__choice",
  );
  for (const btn of choices) {
    if (btn.textContent?.includes("ProTracker")) {
      fireEvent.click(btn);
      return;
    }
  }
  throw new Error("ModePicker did not render the ProTracker choice");
}

describe("FileMenu: dropdown behaviour", () => {
  it("opens on click and closes when an item fires", () => {
    const { container } = render(() => <App />);
    const trigger = menuTrigger(container, "File");
    expect(container.querySelector(".menu__list")).toBeNull();
    fireEvent.click(trigger);
    expect(container.querySelector(".menu__list")).not.toBeNull();
    // Click the New item — menu should close after the action.
    const newItem = Array.from(
      container.querySelectorAll<HTMLElement>(".menu__item"),
    ).find((i) => i.textContent?.includes("New"))!;
    fireEvent.click(newItem);
    expect(container.querySelector(".menu__list")).toBeNull();
  });

  it("lists New, Open…, Save…, Export .mod…, Export .wav…, Song info in order", () => {
    const { container } = render(() => <App />);
    fireEvent.click(menuTrigger(container, "File"));
    const labels = Array.from(
      container.querySelectorAll<HTMLElement>(".menu__item .menu__label"),
    ).map((el) => el.textContent);
    expect(labels).toEqual([
      "New",
      "Open…",
      "Save…",
      "Export .mod…",
      "Export .wav…",
      "Song info",
    ]);
  });
});

describe("File menu: New", () => {
  it("replaces the song with a blank one and clears dirty", () => {
    const s = emptySong();
    s.title = "Stale";
    setSong(s);
    setDirty(false);
    const { container } = render(() => <App />);
    clickNewPt2(container);
    expect(song()!.title).toBe("");
    expect(dirty()).toBe(false);
  });

  it("prompts via window.confirm when the project is dirty", () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    // Simulate an edit so dirty=true.
    commitEdit((s) => ({ ...s, title: "edited" }));
    expect(dirty()).toBe(true);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    clickNewPt2(container);
    expect(confirmSpy).toHaveBeenCalled();
    // User said no → song stays.
    expect(song()!.title).toBe("edited");
  });

  it("proceeds when the user confirms", () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    commitEdit((s) => ({ ...s, title: "edited" }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    clickNewPt2(container);
    expect(song()!.title).toBe("");
    expect(dirty()).toBe(false);
  });
});

describe("File menu: Save… (.retro)", () => {
  it("downloads a .retro JSON with the application/json mime", () => {
    const s = emptySong();
    s.title = "Demo";
    setSong(s);
    setCursor({ order: 0, row: 5, channel: 2, field: "effectHi" });
    setCurrentSample(7);
    setEditStep(3);
    setView("sample");
    const { container } = render(() => <App />);
    clickItem(container, "File", "Save…");
    expect(io.download).toHaveBeenCalledTimes(1);
    const [name, bytes, mime] = (io.download as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(name).toBe("Demo.retro");
    expect(mime).toBe("application/json");
    // Validate the JSON shape.
    const text = new TextDecoder("utf-8").decode(bytes as Uint8Array);
    const parsed = JSON.parse(text);
    expect(parsed.v).toBe(9);
    expect(parsed.cursor).toEqual({
      order: 0,
      row: 5,
      channel: 2,
      field: "effectHi",
    });
    expect(parsed.currentSample).toBe(7);
    expect(parsed.editStep).toBe(3);
    expect(parsed.view).toBe("sample");
  });

  it("Save clears dirty", () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    commitEdit((s) => ({ ...s, title: "x" }));
    expect(dirty()).toBe(true);
    clickItem(container, "File", "Save…");
    expect(dirty()).toBe(false);
  });
});

describe("Open: file-input sniff routes by extension", () => {
  it("a .retro upload restores cursor / view / current sample / edit step", async () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const user = userEvent.setup();

    // Build a project payload to upload.
    const s = emptySong();
    s.title = "Loaded";
    const projectBytes = projectToBytes({
      song: s,
      filename: "Loaded.retro",
      view: "sample",
      cursor: { order: 0, row: 11, channel: 1, field: "sampleLo" },
      currentSample: 9,
      currentOctave: 3,
      editStep: 4,
    });
    // Copy into a fresh ArrayBuffer so the BlobPart type narrows cleanly
    // (TS's File ctor doesn't accept ArrayBufferLike).
    const buf = new ArrayBuffer(projectBytes.byteLength);
    new Uint8Array(buf).set(projectBytes);
    const file = new File([buf], "Loaded.retro", { type: "application/json" });

    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept*=".retro"]',
    )!;
    await user.upload(input, file);

    // Wait a microtask for the async loadFile to resolve.
    await new Promise((r) => setTimeout(r, 0));

    expect(song()!.title).toBe("Loaded");
    expect(view()).toBe("sample");
    expect(cursor()).toEqual({
      order: 0,
      row: 11,
      channel: 1,
      field: "sampleLo",
    });
    expect(currentSample()).toBe(9);
    expect(editStep()).toBe(4);
  });

  it("autosave round-trip restores per-channel mute / solo on App mount", async () => {
    // Bug repro: pre-fix, refreshing the browser dropped mute/solo
    // even though they were written to localStorage. The onMount path
    // restored everything else from `loadSession()` but skipped the
    // mute fields, so `setChannelMuteState` never fired.
    saveSession({
      song: emptySong(),
      filename: "saved.mod",
      view: "pattern",
      cursor: { ...INITIAL_CURSOR },
      currentSample: 1,
      currentOctave: 2,
      editStep: 1,
      mutedChannels: [false, false, true, false],
      soloedChannels: [true, false, false, false],
    });
    // App's onMount runs loadSession when no song is set; resetState
    // already cleared `song`, so a fresh render exercises that path.
    render(() => <App />);
    expect(mutedChannels()).toEqual([false, false, true, false]);
    expect(soloedChannels()).toEqual([true, false, false, false]);
  });

  it("a .retro upload restores per-channel mute / solo state", async () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const user = userEvent.setup();

    // Build a project payload with channel 1 muted and channel 0 solo'd.
    const s = emptySong();
    s.title = "Mixed";
    const projectBytes = projectToBytes({
      song: s,
      filename: "Mixed.retro",
      view: "pattern",
      cursor: { ...INITIAL_CURSOR },
      currentSample: 1,
      currentOctave: 2,
      editStep: 1,
      mutedChannels: [false, true, false, false],
      soloedChannels: [true, false, false, false],
    });
    const buf = new ArrayBuffer(projectBytes.byteLength);
    new Uint8Array(buf).set(projectBytes);
    const file = new File([buf], "Mixed.retro", { type: "application/json" });

    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept*=".retro"]',
    )!;
    await user.upload(input, file);
    await new Promise((r) => setTimeout(r, 0));

    expect(mutedChannels()).toEqual([false, true, false, false]);
    expect(soloedChannels()).toEqual([true, false, false, false]);
  });

  it("Save .retro round-trip preserves mute / solo across reload", async () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    // Toggle channel 2 mute, then drive the Save .retro menu item so we
    // exercise the full saveProject path.
    toggleMute(2);
    expect(mutedChannels()[2]).toBe(true);

    fireEvent.click(menuTrigger(container, "File"));
    const items = Array.from(
      container.querySelectorAll<HTMLElement>(".menu__item"),
    );
    const saveItem = items.find((it) =>
      // The Save… item has label "Save…"; match by prefix (not a Save As
      // distinguisher in this menu yet).
      it.textContent?.startsWith("Save"),
    )!;
    fireEvent.click(saveItem);
    const [, bytes] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;

    // The downloaded bytes are what would land on disk. Re-decode via
    // projectFromBytes — equivalent to opening them via the file picker.
    setChannelMuteState([false, false, false, false], null);
    expect(mutedChannels()[2]).toBe(false);

    const { projectFromBytes } = await import("../../src/state/persistence");
    const restored = projectFromBytes(bytes as Uint8Array);
    expect(restored).not.toBeNull();
    expect(restored!.mutedChannels).toEqual([false, false, true, false]);
  });
});

describe("EditMenu: dropdown contents and actions", () => {
  it("lists Undo, Redo, Cut, Copy, Paste, Bounce, Settings in order with a separator after Redo", () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    fireEvent.click(menuTrigger(container, "Edit"));
    const labels = Array.from(
      container.querySelectorAll<HTMLElement>(".menu__list .menu__label"),
    ).map((el) => el.textContent);
    expect(labels).toEqual([
      "Undo",
      "Redo",
      "Cut",
      "Copy",
      "Paste",
      "Bounce to sample",
      "Settings",
    ]);
    // Separator is the third <li> in the list (after Undo and Redo).
    const items = container.querySelectorAll<HTMLElement>(".menu__list > li");
    expect(items[2]!.classList.contains("menu__separator")).toBe(true);
  });

  it("Undo and Redo are disabled at boot (empty history) but enabled after an edit", () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    fireEvent.click(menuTrigger(container, "Edit"));
    const undoItem = Array.from(
      container.querySelectorAll<HTMLElement>(".menu__item"),
    ).find((i) => i.textContent?.startsWith("Undo"))!;
    expect(undoItem.getAttribute("aria-disabled")).toBe("true");
    // Make an edit so canUndo() flips.
    commitEdit((s) => ({ ...s, title: "edited" }));
    // Re-open to refresh the rendered disabled state. (The menu list
    // tears down + remounts on each open.)
    fireEvent.click(menuTrigger(container, "Edit")); // close
    fireEvent.click(menuTrigger(container, "Edit")); // re-open
    const undoAfter = Array.from(
      container.querySelectorAll<HTMLElement>(".menu__item"),
    ).find((i) => i.textContent?.startsWith("Undo"))!;
    expect(undoAfter.getAttribute("aria-disabled")).toBe("false");
  });

  it("clicking Undo reverts the most recent edit", () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    commitEdit((s) => ({ ...s, title: "edited" }));
    expect(song()!.title).toBe("edited");
    clickItem(container, "Edit", "Undo");
    expect(song()!.title).toBe("");
  });

  it("Paste is disabled when the clipboard is empty", () => {
    setSong(emptySong());
    setClipboardSlice(null);
    const { container } = render(() => <App />);
    fireEvent.click(menuTrigger(container, "Edit"));
    const pasteItem = Array.from(
      container.querySelectorAll<HTMLElement>(".menu__item"),
    ).find((i) => i.textContent?.startsWith("Paste"))!;
    expect(pasteItem.getAttribute("aria-disabled")).toBe("true");
  });

  it("Bounce selection is disabled without a selection, enabled once one exists", () => {
    setSong(emptySong());
    setClipboardSlice(null);
    const { container } = render(() => <App />);
    fireEvent.click(menuTrigger(container, "Edit"));
    let bounce = Array.from(
      container.querySelectorAll<HTMLElement>(".menu__item"),
    ).find((i) => i.textContent?.startsWith("Bounce"))!;
    expect(bounce.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(menuTrigger(container, "Edit")); // close

    // Drop a selection and reopen the menu.
    setSelection({
      order: 0,
      startRow: 0,
      endRow: 4,
      startChannel: 0,
      endChannel: 1,
    });
    fireEvent.click(menuTrigger(container, "Edit"));
    bounce = Array.from(
      container.querySelectorAll<HTMLElement>(".menu__item"),
    ).find((i) => i.textContent?.startsWith("Bounce"))!;
    expect(bounce.getAttribute("aria-disabled")).toBe("false");
  });

  it("Cut / Copy / Paste are all disabled in the sample view", () => {
    setSong(emptySong());
    setView("sample");
    setClipboardSlice({
      rows: [[{ period: 0, sample: 0, effect: 0, effectParam: 0 }]],
    });
    const { container } = render(() => <App />);
    fireEvent.click(menuTrigger(container, "Edit"));
    for (const label of ["Cut", "Copy", "Paste"]) {
      const item = Array.from(
        container.querySelectorAll<HTMLElement>(".menu__item"),
      ).find((i) => i.textContent?.startsWith(label))!;
      expect(item.getAttribute("aria-disabled")).toBe("true");
    }
  });
});

describe("Header: Play/Stop, Song↔Pattern toggle, Follow toggle", () => {
  // The two toggles live in `settings` (localStorage write-through). Reset
  // them between cases so jsdom's persistent storage doesn't leak.
  beforeEach(() => {
    setLoopPattern(false);
    setFollowPlayback(true);
  });

  it("shows the play glyph on the play/stop button when stopped", () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const btn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Play"]',
    )!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("▶");
    expect(btn.classList.contains("transport__btn--active")).toBe(false);
  });

  it("flips to the stop glyph and goes active while playing", () => {
    setSong(emptySong());
    setTransport("playing");
    const { container } = render(() => <App />);
    const btn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop"]',
    )!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("■");
    expect(btn.classList.contains("transport__btn--active")).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders Song and Pattern as a segmented toggle, Song active by default", () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const group = container.querySelector(
      '.transport [aria-label="Playback mode"]',
    )!;
    expect(group).not.toBeNull();
    const buttons = group.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons.length).toBe(2);
    expect(buttons[0]!.textContent).toBe("Song");
    expect(buttons[1]!.textContent).toBe("Pattern");
    expect(buttons[0]!.classList.contains("transport__btn--active")).toBe(true);
    expect(buttons[1]!.classList.contains("transport__btn--active")).toBe(
      false,
    );
  });

  it("clicking the Pattern toggle flips loopPattern and the active highlight", async () => {
    setSong(emptySong());
    const user = userEvent.setup();
    const { container } = render(() => <App />);
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      '.transport [aria-label="Playback mode"] button',
    );
    await user.click(buttons[1]!);
    expect(buttons[0]!.classList.contains("transport__btn--active")).toBe(
      false,
    );
    expect(buttons[1]!.classList.contains("transport__btn--active")).toBe(true);
  });

  it("renders the Follow toggle, active by default", () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      ".transport > button",
    );
    // play/stop is first; follow is last among direct button children.
    const follow = buttons[buttons.length - 1]!;
    expect(follow.textContent).toBe("Follow");
    expect(follow.classList.contains("transport__btn--active")).toBe(true);
    expect(follow.getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking the Follow toggle deactivates it", async () => {
    setSong(emptySong());
    const user = userEvent.setup();
    const { container } = render(() => <App />);
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      ".transport > button",
    );
    const follow = buttons[buttons.length - 1]!;
    await user.click(follow);
    expect(follow.classList.contains("transport__btn--active")).toBe(false);
    expect(follow.getAttribute("aria-pressed")).toBe("false");
  });
});
