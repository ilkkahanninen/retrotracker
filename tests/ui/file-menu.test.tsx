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
import { io } from "../../src/state/io";
import { clearSession, projectToBytes } from "../../src/state/persistence";
import { commitEdit } from "../../src/state/song";
import { emptySong } from "../../src/core/mod/format";

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

  it("lists New, Open…, Save…, Export .mod…, Export .wav… in order", () => {
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
    clickItem(container, "File", "New");
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
    clickItem(container, "File", "New");
    expect(confirmSpy).toHaveBeenCalled();
    // User said no → song stays.
    expect(song()!.title).toBe("edited");
  });

  it("proceeds when the user confirms", () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    commitEdit((s) => ({ ...s, title: "edited" }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    clickItem(container, "File", "New");
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
    expect(parsed.v).toBe(1);
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
});

describe("EditMenu: dropdown contents and actions", () => {
  it("lists Undo, Redo, Cut, Copy, Paste, Bounce in order with a separator after Redo", () => {
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
      "Bounce selection to sample",
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

describe("Header: Play song / Play pattern buttons", () => {
  it('the Play song button is labelled "Song" when stopped', () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const btn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Play song"]',
    )!;
    expect(btn.textContent).toBe("Song");
  });

  it("the Play pattern button is rendered alongside Play song", () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const btn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Play pattern"]',
    )!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Pattern");
  });

  it('renders a "Play" label in front of the segmented buttons', () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const label = container.querySelector(".transport .transport__label");
    expect(label?.textContent).toBe("Play");
  });

  it("labels stay the same while playing — the active mode is highlighted instead", () => {
    setSong(emptySong());
    setTransport("playing");
    setPlayMode("song");
    const { container } = render(() => <App />);
    const songBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Play song"]',
    )!;
    const patBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Play pattern"]',
    )!;
    expect(songBtn.textContent).toBe("Song");
    expect(patBtn.textContent).toBe("Pattern");
    expect(songBtn.classList.contains("transport__btn--active")).toBe(true);
    expect(patBtn.classList.contains("transport__btn--active")).toBe(false);
    expect(songBtn.getAttribute("aria-pressed")).toBe("true");
    expect(patBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("highlights Play pattern when the pattern playmode is active", () => {
    setSong(emptySong());
    setTransport("playing");
    setPlayMode("pattern");
    const { container } = render(() => <App />);
    const songBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Play song"]',
    )!;
    const patBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Play pattern"]',
    )!;
    expect(songBtn.classList.contains("transport__btn--active")).toBe(false);
    expect(patBtn.classList.contains("transport__btn--active")).toBe(true);
  });
});
