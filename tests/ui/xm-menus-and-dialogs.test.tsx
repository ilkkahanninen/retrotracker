/**
 * Regressions for:
 *  - the cloud browser being dismissable / re-clickable while a request is
 *    in flight (the pending open then replaced the song after the user had
 *    gone back to editing; a double-click fired three loads);
 *  - a share link opened on boot replacing the autosaved session unasked;
 *  - the Order menu and Edit → Paste being wired to the PT handlers only;
 *  - the XM selected-effect marker surviving an instrument switch;
 *  - the XM mixer settings never reaching the engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

import { App } from "../../src/App";
import { ServerBrowser } from "../../src/components/ServerBrowser";
import { emptySong } from "../../src/core/mod/format";
import { writeModule } from "../../src/core/mod/writer";
import { emptyXmSong } from "../../src/core/xm/format";
import { setXmCell } from "../../src/core/xm/mutations";
import { resetXmCursor, setXmCursor } from "../../src/state/cursorXm";
import { clearSession, saveSession } from "../../src/state/persistence";
import { disposeEngine, ensureEngine } from "../../src/state/playback";
import { clearXmSelection, setXmSelection } from "../../src/state/selection";
import { setCloudOrigin, setError } from "../../src/state/session";
import { setSettings } from "../../src/state/settings";
import {
  dismissShareLoadError,
  dismissSharedBanner,
  sharedBanner,
} from "../../src/state/shareLoad";
import {
  clearHistory,
  setDirty,
  setSong,
  setTransport,
  song,
  undo,
  xm2Song,
} from "../../src/state/song";
import { setView } from "../../src/state/view";
import {
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "../../src/state/xmEdit";
import { copyXmSelection } from "../../src/state/xmPatternEdit";
import {
  setXmSelectedEffectIndex,
  setXmSelectedEffectParam,
  xmSelectedEffectIndex,
  xmSelectedEffectParam,
} from "../../src/state/xmSampleEdit";
import { setXmClipboardSlice } from "../../src/state/clipboard";
import {
  installRecordingEngine,
  type RecordingEngine,
} from "../lib/recording-engine";

function reset() {
  setSong(null);
  setTransport("idle");
  clearHistory();
  setError(null);
  setCloudOrigin(null);
  setDirty(false);
  setView("pattern");
  resetXmCursor();
  clearXmSelection();
  setXmClipboardSlice(null);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setXmSelectedEffectIndex(null);
  setXmSelectedEffectParam(null);
  dismissSharedBanner();
  dismissShareLoadError();
  setSettings({ ft2Interpolation: "linear", ft2Ramping: true });
  clearSession();
}
beforeEach(reset);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  reset();
});

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function menuItem(container: HTMLElement, menu: string, label: string) {
  const trigger = [
    ...container.querySelectorAll<HTMLButtonElement>(".menu__button"),
  ].find((b) => b.textContent?.startsWith(menu))!;
  fireEvent.click(trigger);
  return [...container.querySelectorAll<HTMLElement>(".menu__item")].find((i) =>
    i.textContent?.includes(label),
  )!;
}
const isDisabled = (el: HTMLElement) =>
  el.getAttribute("aria-disabled") === "true";

describe("ServerBrowser while a request is in flight", () => {
  function mount() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const resource = String(input).includes("modules")
          ? "modules"
          : "projects";
        return json({
          resource,
          extensions: [],
          entries:
            resource === "projects"
              ? [{ name: "tune.retro", size: 10, mtime: 1 }]
              : [],
        });
      }),
    );
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const onPick = vi.fn(() => pending);
    const onClose = vi.fn();
    const result = render(() => (
      <ServerBrowser
        mode="open"
        resources={["projects", "modules"]}
        title="Open from cloud"
        initialName=""
        onPick={onPick}
        onClose={onClose}
      />
    ));
    return { ...result, onPick, onClose, release };
  }

  it("a second click does not load again, and dismissing cancels the request", async () => {
    const { container, onPick, onClose } = mount();
    await waitFor(() =>
      expect(container.querySelector(".server-browser__row")).not.toBeNull(),
    );
    const row = container.querySelector<HTMLElement>(".server-browser__row")!;

    // A real double-click: click, click, dblclick.
    fireEvent.click(row);
    fireEvent.click(row);
    fireEvent.dblClick(row);
    expect(onPick).toHaveBeenCalledTimes(1);

    // A stalled request must not trap the user behind the modal: Escape
    // closes it and aborts the request so its result is never applied.
    const signal = (onPick.mock.calls[0] as unknown[])[2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
  });

  it("can be dismissed when idle", async () => {
    const { container, onClose } = mount();
    await waitFor(() =>
      expect(container.querySelector(".server-browser__row")).not.toBeNull(),
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("share link on boot", () => {
  const TOKEN = "abcdefghijklmnopqrstuv";
  let originalPath: string;

  beforeEach(() => {
    originalPath = window.location.pathname;
    window.history.replaceState(null, "", `/share/${TOKEN}`);
    const shared = writeModule({ ...emptySong(), title: "shared song" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/api/shares/${TOKEN}`)) {
          return new Response(shared as unknown as BodyInit, {
            status: 200,
            headers: {
              "Content-Disposition": 'attachment; filename="shared.mod"',
            },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );
  });
  afterEach(() => window.history.replaceState(null, "", originalPath));

  function autosave(title: string) {
    saveSession({
      song: { ...emptySong(), title },
      filename: "mine.mod",
      view: "pattern",
      cursor: { order: 0, row: 0, channel: 0, field: "note" },
      currentSample: 1,
      currentOctave: 2,
      editStep: 1,
    });
  }

  it("asks before replacing a restored session, and keeps it on Cancel", async () => {
    autosave("my work");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(() => <App />);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await tick();
    expect(confirm.mock.calls[0]![0]).toContain("shared.mod");
    expect(song()!.title).toBe("my work");
    expect(sharedBanner()).toBeNull();
  });

  it("loads the shared song on OK", async () => {
    autosave("my work");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(() => <App />);
    await waitFor(() => expect(song()!.title).toBe("shared song"));
    await waitFor(() =>
      expect(sharedBanner()).toEqual({ filename: "shared.mod" }),
    );
  });

  it("does not prompt a visitor with no session", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(() => <App />);
    await waitFor(() => expect(song()?.title).toBe("shared song"));
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("menus with an FT2 song", () => {
  function seed() {
    let s = emptyXmSong();
    s = setXmCell(s, 0, 0, 0, { note: 49, instrument: 1 });
    setSong(s);
    setTransport("ready");
  }

  it("Order → Insert slot / Delete slot act on the FT2 song", () => {
    seed();
    const { container } = render(() => <App />);
    expect(xm2Song()!.songLength).toBe(1);
    fireEvent.click(menuItem(container, "Order", "Insert slot"));
    expect(xm2Song()!.songLength).toBe(2);
    fireEvent.click(menuItem(container, "Order", "Delete slot"));
    expect(xm2Song()!.songLength).toBe(1);
  });

  it("Order → New blank pattern adds a pattern", () => {
    seed();
    const { container } = render(() => <App />);
    const before = xm2Song()!.patterns.length;
    fireEvent.click(menuItem(container, "Order", "New blank pattern"));
    expect(xm2Song()!.patterns.length).toBe(before + 1);
  });

  it("Order → Clean up renumbers by first use, drops unused patterns, and undoes", () => {
    seed();
    const { container } = render(() => <App />);
    // Patterns 0 (has the seeded note), 1 and 2; order list plays 2 then 0.
    fireEvent.click(menuItem(container, "Order", "New blank pattern"));
    fireEvent.click(menuItem(container, "Order", "Insert slot"));
    fireEvent.click(menuItem(container, "Order", "New blank pattern"));
    fireEvent.click(menuItem(container, "Order", "Previous pattern"));
    const before = xm2Song()!;
    expect(before.patterns.length).toBe(3);
    const played = before.orders.slice(0, before.songLength);
    const expectPatterns = [...new Set(played)].map((p) => before.patterns[p]);

    fireEvent.click(menuItem(container, "Order", "Clean up"));
    const after = xm2Song()!;
    expect(after.patterns).toEqual(expectPatterns);
    expect(after.patterns.length).toBeLessThan(3);
    // Same music: every slot still points at the same pattern object.
    for (let i = 0; i < after.songLength; i++) {
      expect(after.patterns[after.orders[i]!]).toBe(
        before.patterns[before.orders[i]!],
      );
    }
    expect(after.orders[0]).toBe(0);

    undo();
    expect(xm2Song()!.patterns.length).toBe(3);
  });

  it("Order → Clean up is disabled while playing", () => {
    seed();
    setTransport("playing");
    const { container } = render(() => <App />);
    expect(isDisabled(menuItem(container, "Order", "Clean up"))).toBe(true);
  });

  it("Edit → Paste enables after an FT2 copy and pastes", () => {
    seed();
    const { container } = render(() => <App />);
    expect(isDisabled(menuItem(container, "Edit", "Paste"))).toBe(true);
    // Clicking the trigger again closes the menu.
    fireEvent.click(
      [...container.querySelectorAll<HTMLButtonElement>(".menu__button")].find(
        (b) => b.textContent?.startsWith("Edit"),
      )!,
    );

    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    copyXmSelection();
    setXmCursor({ order: 0, row: 8, channel: 0, field: "note" });
    const paste = menuItem(container, "Edit", "Paste");
    expect(isDisabled(paste)).toBe(false);
    fireEvent.click(paste);
    const s = xm2Song()!;
    expect(s.patterns[s.orders[0]!]!.rows[8]![0]!.note).toBe(49);
  });

  it("Edit → Bounce to instrument needs a selection, then fills the next free instrument", () => {
    seed();
    clearXmSelection();
    const { container } = render(() => <App />);
    expect(
      isDisabled(menuItem(container, "Edit", "Bounce to instrument")),
    ).toBe(true);
    fireEvent.click(
      [...container.querySelectorAll<HTMLButtonElement>(".menu__button")].find(
        (b) => b.textContent?.startsWith("Edit"),
      )!,
    );

    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 3,
      startChannel: 0,
      endChannel: 0,
    });
    const bounce = menuItem(container, "Edit", "Bounce to instrument");
    expect(isDisabled(bounce)).toBe(false);
    fireEvent.click(bounce);
    const inst = xm2Song()!.instruments[0]!;
    expect(inst.name.startsWith("Bnc")).toBe(true);
    expect(inst.samples[0]!.data.length).toBeGreaterThan(0);
  });

  it("Edit → Bounce to instrument is disabled while playing", () => {
    seed();
    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 3,
      startChannel: 0,
      endChannel: 0,
    });
    setTransport("playing");
    const { container } = render(() => <App />);
    expect(
      isDisabled(menuItem(container, "Edit", "Bounce to instrument")),
    ).toBe(true);
  });
});

describe("XM selected effect", () => {
  it("is cleared when the instrument or sample changes", () => {
    setSong(emptyXmSong());
    setView("sample");
    render(() => <App />);
    setXmSelectedEffectIndex(0);
    setXmSelectedEffectParam("volume");

    setCurrentXmInstrument(2);
    expect(xmSelectedEffectIndex()).toBeNull();
    expect(xmSelectedEffectParam()).toBeNull();

    setXmSelectedEffectIndex(1);
    setCurrentXmSampleIndex(1);
    expect(xmSelectedEffectIndex()).toBeNull();
  });
});

describe("XM mixer settings reach the engine", () => {
  let fake: RecordingEngine;
  beforeEach(() => {
    fake = installRecordingEngine();
  });
  afterEach(async () => {
    await disposeEngine();
  });

  it("forwards the stored settings on engine creation and on change", async () => {
    setSettings({ ft2Interpolation: "cubic", ft2Ramping: false });
    setSong(emptyXmSong());
    render(() => <App />);
    await ensureEngine();
    await waitFor(() =>
      expect(fake.callsTo("setXmMixer").at(-1)?.args).toEqual(["cubic", false]),
    );
    setSettings({ ft2Interpolation: "sinc8" });
    await waitFor(() =>
      expect(fake.callsTo("setXmMixer").at(-1)?.args).toEqual(["sinc8", false]),
    );
    setSettings({ ft2Ramping: true });
    await waitFor(() =>
      expect(fake.callsTo("setXmMixer").at(-1)?.args).toEqual(["sinc8", true]),
    );
  });
});
