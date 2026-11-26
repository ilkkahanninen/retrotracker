/**
 * Regression: every pane stays mounted and only flips a `view-hidden`
 * class, so keyboard shortcuts that weren't gated on the active view kept
 * editing the hidden pattern grid from sample / info / settings view. The
 * dispatcher also ran behind open modals, and text-editing chords
 * (⌘X / ⌘V / ⌘Z / ⌘A) inside a text field acted on the song instead of
 * the text.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App";
import { cursor, INITIAL_CURSOR, setCursor } from "../../src/state/cursor";
import { setXmCursor, xmCursor } from "../../src/state/cursorXm";
import {
  clearHistory,
  commitEdit,
  pt2Song,
  setPlayPos,
  setSong,
  setTransport,
  song,
  transport,
  xm2Song,
} from "../../src/state/song";
import { setCurrentOctave, setCurrentSample } from "../../src/state/edit";
import { setFollowPlayback } from "../../src/state/settings";
import { setView, type View } from "../../src/state/view";
import { clearSelection } from "../../src/state/selection";
import { emptySong, PERIOD_TABLE } from "../../src/core/mod/format";
import { setCell, replaceSampleData } from "../../src/core/mod/mutations";
import { emptyXmSong } from "../../src/core/xm/format";
import { clearAllWorkbenches } from "../../src/state/sampleWorkbench";

const C2 = PERIOD_TABLE[0]![12]!;

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  clearAllWorkbenches();
  clearSelection();
  setCursor({ ...INITIAL_CURSOR });
  setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
  setCurrentOctave(2);
  setCurrentSample(1);
  setFollowPlayback(true);
  setView("pattern");
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  document.querySelectorAll("[data-test-modal]").forEach((el) => el.remove());
  resetState();
});

/** PT song with a note on rows 0..3 of channel 0 and sample 1 populated. */
function seedPtSong() {
  let s = emptySong();
  for (let row = 0; row < 4; row++) {
    s = setCell(s, 0, row, 0, { period: C2, sample: 1 });
  }
  s = replaceSampleData(s, 0, new Int8Array(64).fill(40), {
    name: "kick",
    volume: 64,
  });
  setSong(s);
  setTransport("ready");
}

const ptCell = (row: number) => pt2Song()!.patterns[0]!.rows[row]![0]!;

describe.each<View>(["sample", "info", "settings"])(
  "PT pattern keys in %s view",
  (v) => {
    it("do not edit or move through the hidden pattern", async () => {
      seedPtSong();
      setCursor({ order: 0, row: 2, channel: 0, field: "note" });
      setView(v);
      render(() => <App />);
      const before = song();
      const user = userEvent.setup();

      await user.keyboard("{Backspace}{Enter}.{Delete}");
      await user.keyboard("{ArrowDown}{ArrowRight}{Tab}{PageDown}");
      await user.keyboard("{Shift>}{Backspace}{Enter}{/Shift}");

      expect(song()).toBe(before);
      expect(cursor()).toEqual({ order: 0, row: 2, channel: 0, field: "note" });
    });

    it("do not change the order list", () => {
      seedPtSong();
      setView(v);
      render(() => <App />);
      const before = song();
      for (const code of ["BracketRight", "BracketLeft"]) {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: code === "BracketRight" ? "]" : "[",
            code,
            metaKey: true,
          }),
        );
      }
      expect(song()).toBe(before);
    });
  },
);

describe.each<View>(["info", "settings"])("PT note entry in %s view", (v) => {
  it("piano and hex keys write nothing", async () => {
    seedPtSong();
    setCursor({ order: 0, row: 10, channel: 1, field: "note" });
    setView(v);
    render(() => <App />);
    const before = song();
    const user = userEvent.setup();
    await user.keyboard("asd");
    setCursor({ order: 0, row: 10, channel: 1, field: "effectHi" });
    await user.keyboard("1f");
    expect(song()).toBe(before);
  });
});

describe("PT pattern keys in pattern view", () => {
  it("still work (sanity check for the gates)", async () => {
    seedPtSong();
    setCursor({ order: 0, row: 2, channel: 0, field: "note" });
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard(".");
    expect(ptCell(2).period).toBe(0);
    const row = cursor().row;
    await user.keyboard("{ArrowDown}");
    expect(cursor().row).toBe(row + 1);
  });
});

describe("XM pattern keys outside pattern view", () => {
  function seedXm() {
    const s = emptyXmSong();
    const pat = s.patterns[s.orders[0]!]!;
    for (let row = 0; row < 4; row++) {
      pat.rows[row]![0] = { ...pat.rows[row]![0]!, note: 49, instrument: 1 };
    }
    setSong(s);
    setTransport("ready");
  }

  it.each<View>(["sample", "info", "settings"])(
    "%s view: no hidden edits, cursor stays put",
    async (v) => {
      seedXm();
      setXmCursor({ order: 0, row: 2, channel: 0, field: "note" });
      setView(v);
      render(() => <App />);
      const before = xm2Song();
      const user = userEvent.setup();
      await user.keyboard("{Backspace}{Enter}.{Delete}{ArrowDown}{Tab}");
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "[",
          code: "BracketLeft",
          metaKey: true,
        }),
      );
      expect(xm2Song()).toBe(before);
      expect(xmCursor()).toEqual({
        order: 0,
        row: 2,
        channel: 0,
        field: "note",
      });
    },
  );
});

describe("shortcuts behind a modal", () => {
  /** Stand-in for any of the app's dialogs — they all render with
   *  `aria-modal="true"`, which is what the dispatcher keys off. */
  function openFakeModal() {
    const el = document.createElement("div");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("data-test-modal", "");
    el.tabIndex = -1;
    document.body.appendChild(el);
    el.focus();
  }

  it("typing does not reach the pattern or the transport", async () => {
    seedPtSong();
    setCursor({ order: 0, row: 10, channel: 1, field: "note" });
    render(() => <App />);
    openFakeModal();
    const before = song();
    const user = userEvent.setup();
    await user.keyboard("song{Enter}{Backspace} ");
    expect(song()).toBe(before);
    expect(cursor().row).toBe(10);
    expect(transport()).toBe("ready");
  });

  it("does not swallow Enter on the dialog's focused button", () => {
    seedPtSong();
    render(() => <App />);
    openFakeModal();
    const ev = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      cancelable: true,
    });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("the real New-project dialog blocks pattern edits too", async () => {
    seedPtSong();
    setCursor({ order: 0, row: 10, channel: 1, field: "note" });
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    const fileMenu = [
      ...container.querySelectorAll<HTMLButtonElement>(".menu__button"),
    ].find((b) => b.textContent?.startsWith("File"))!;
    fireEvent.click(fileMenu);
    const newItem = [
      ...container.querySelectorAll<HTMLElement>(".menu__item"),
    ].find((i) => i.textContent?.includes("New"))!;
    fireEvent.click(newItem);
    expect(document.querySelector('[aria-modal="true"]')).not.toBeNull();
    const before = song();
    await user.keyboard("asd");
    expect(song()).toBe(before);
  });
});

describe("text-editing chords inside a text field", () => {
  function focusSampleName(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(
      '.samplemeta input[type="text"]',
    )!;
    input.focus();
    return input;
  }
  const chord = (key: string, extra: KeyboardEventInit = {}) => {
    const ev = new KeyboardEvent("keydown", {
      key,
      code: `Key${key.toUpperCase()}`,
      metaKey: true,
      cancelable: true,
      ...extra,
    });
    window.dispatchEvent(ev);
    return ev;
  };

  it("⌘X in the sample-name input does not cut the sample", () => {
    seedPtSong();
    setView("sample");
    const { container } = render(() => <App />);
    focusSampleName(container);
    const ev = chord("x");
    expect(pt2Song()!.samples[0]!.data.length).toBe(64);
    // Left for the browser, so the text cut still happens.
    expect(ev.defaultPrevented).toBe(false);
  });

  it("⌘C / ⌘V / ⌘A in a text field are left to the browser", () => {
    seedPtSong();
    setView("sample");
    const { container } = render(() => <App />);
    focusSampleName(container);
    const before = song();
    for (const k of ["c", "v", "a"]) {
      expect(chord(k).defaultPrevented).toBe(false);
    }
    expect(song()).toBe(before);
  });

  it("⌘Z / ⌘⇧Z / ⌘Y in a text field do not undo or redo song edits", () => {
    seedPtSong();
    setView("sample");
    const { container } = render(() => <App />);
    commitEdit((s) => setCell(s, 0, 20, 0, { period: C2, sample: 1 }));
    const edited = song();
    focusSampleName(container);
    chord("z");
    expect(song()).toBe(edited);
    chord("z", { shiftKey: true });
    chord("y");
    expect(song()).toBe(edited);
  });

  it("the same chords still act on the song when no text field has focus", () => {
    seedPtSong();
    setView("sample");
    render(() => <App />);
    commitEdit((s) => setCell(s, 0, 20, 0, { period: C2, sample: 1 }));
    const edited = song();
    (document.activeElement as HTMLElement | null)?.blur();
    chord("z");
    expect(song()).not.toBe(edited);
    chord("x");
    expect(pt2Song()!.samples[0]!.data.length).toBe(0);
  });
});
