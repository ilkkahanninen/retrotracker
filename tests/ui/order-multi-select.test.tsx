import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

import { App } from "../../src/App";
import { emptyPattern, emptySong } from "../../src/core/mod/format";
import { MAX_ORDERS, type ModSong } from "../../src/core/mod/types";
import { emptyXmPattern, emptyXmSong } from "../../src/core/xm/format";
import type { XmSong } from "../../src/core/xm/types";
import { INITIAL_CURSOR, cursor, setCursor } from "../../src/state/cursor";
import { resetXmCursor, xmCursor } from "../../src/state/cursorXm";
import {
  clearOrderSelection,
  orderSelection,
  orderSelectionRange,
} from "../../src/state/orderSelection";
import { setFollowPlayback } from "../../src/state/settings";
import {
  canUndo,
  clearHistory,
  playPos,
  setPlayPos,
  setSong,
  setTransport,
  song,
  undo,
} from "../../src/state/song";

/**
 * Order-list multi-selection: shift-click selects a run of positions, and
 * the toolbar's Insert / Dup / Delete then act on the whole run —
 * repeat it, give it its own pattern copies, remove it. Both formats.
 */

function ptSong(n: number): ModSong {
  const s = emptySong();
  s.patterns = Array.from({ length: n }, emptyPattern);
  s.songLength = n;
  for (let i = 0; i < n; i++) s.orders[i] = i;
  return s;
}

function xmSong(n: number): XmSong {
  const s = emptyXmSong();
  return {
    ...s,
    patterns: Array.from({ length: n }, () =>
      emptyXmPattern(64, s.channelCount),
    ),
    songLength: n,
    orders: Object.assign(
      s.orders.slice(),
      Array.from({ length: n }, (_, i) => i),
    ),
  };
}

function reset(): void {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  setFollowPlayback(true);
  setCursor({ ...INITIAL_CURSOR });
  resetXmCursor();
  clearOrderSelection();
  clearHistory();
}
beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

const live = () => song()!.orders.slice(0, song()!.songLength);
const rows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".orderlist li"));
const selectedRows = (container: HTMLElement) =>
  rows(container)
    .map((li, i) =>
      li.classList.contains("orderlist__item--selected") ? i : -1,
    )
    .filter((i) => i >= 0);
const tool = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLButtonElement>(
    `.ordertools button[aria-label="${label}"]`,
  )!;
const shiftClick = (el: HTMLElement) => fireEvent.click(el, { shiftKey: true });
/** Cmd/Ctrl + a bracket key, as the order shortcuts expect it. */
const pressMod = (key: string, code: string) =>
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key, code, metaKey: true, bubbles: true }),
  );

/** The same behaviour is expected from both order lists. */
const formats = [
  { name: "PT", make: ptSong, cursorOrder: () => cursor().order },
  { name: "FT2", make: xmSong, cursorOrder: () => xmCursor().order },
] as const;

for (const fmt of formats) {
  describe(`${fmt.name} order list: selecting a run`, () => {
    it("shift-click selects from the active position to the clicked one", () => {
      setSong(fmt.make(5));
      const { container } = render(() => <App />);
      fireEvent.click(rows(container)[1]!);
      shiftClick(rows(container)[3]!);
      expect(orderSelectionRange()).toEqual({ start: 1, end: 3 });
      expect(selectedRows(container)).toEqual([1, 2, 3]);
      // The cursor stays where it was — selecting is not navigating.
      expect(fmt.cursorOrder()).toBe(1);
    });

    it("a second shift-click moves the far end and keeps the anchor", () => {
      setSong(fmt.make(5));
      const { container } = render(() => <App />);
      fireEvent.click(rows(container)[2]!);
      shiftClick(rows(container)[4]!);
      shiftClick(rows(container)[0]!);
      expect(orderSelectionRange()).toEqual({ start: 0, end: 2 });
    });

    it("a plain click clears the selection and jumps", () => {
      setSong(fmt.make(5));
      const { container } = render(() => <App />);
      shiftClick(rows(container)[2]!);
      fireEvent.click(rows(container)[4]!);
      expect(orderSelection()).toBeNull();
      expect(selectedRows(container)).toEqual([]);
      expect(fmt.cursorOrder()).toBe(4);
    });

    it("Escape clears the selection", async () => {
      setSong(fmt.make(5));
      const { container } = render(() => <App />);
      shiftClick(rows(container)[2]!);
      const user = userEvent.setup();
      await user.keyboard("{Escape}");
      expect(orderSelection()).toBeNull();
    });

    it("shift-clicking the active position alone selects nothing to act on", () => {
      setSong(fmt.make(3));
      const { container } = render(() => <App />);
      shiftClick(rows(container)[0]!);
      expect(orderSelectionRange()).toBeNull();
      expect(selectedRows(container)).toEqual([]);
    });
  });

  describe(`${fmt.name} order list: acting on a selected run`, () => {
    function selectOneToTwo(container: HTMLElement): void {
      fireEvent.click(rows(container)[1]!);
      shiftClick(rows(container)[2]!);
    }

    it("Insert repeats the run after itself and selects the copy", () => {
      setSong(fmt.make(4));
      const { container } = render(() => <App />);
      selectOneToTwo(container);
      fireEvent.click(tool(container, "Insert slot"));
      expect(live()).toEqual([0, 1, 2, 1, 2, 3]);
      expect(orderSelectionRange()).toEqual({ start: 3, end: 4 });
      expect(selectedRows(container)).toEqual([3, 4]);
      expect(fmt.cursorOrder()).toBe(3);
    });

    it("Insert then Dup makes the repeat its own patterns", () => {
      setSong(fmt.make(4));
      const { container } = render(() => <App />);
      selectOneToTwo(container);
      fireEvent.click(tool(container, "Insert slot"));
      fireEvent.click(tool(container, "Duplicate pattern"));
      expect(live()).toEqual([0, 1, 2, 4, 5, 3]);
      expect(song()!.patterns).toHaveLength(6);
      // Still selected, on the same positions.
      expect(orderSelectionRange()).toEqual({ start: 3, end: 4 });
    });

    it("Delete removes the run and clears the selection", () => {
      setSong(fmt.make(5));
      const { container } = render(() => <App />);
      selectOneToTwo(container);
      fireEvent.click(tool(container, "Delete slot"));
      expect(live()).toEqual([0, 3, 4]);
      expect(orderSelection()).toBeNull();
      expect(fmt.cursorOrder()).toBe(1);
    });

    it("each action is one undo step, and undo drops the selection", () => {
      setSong(fmt.make(4));
      const { container } = render(() => <App />);
      selectOneToTwo(container);
      fireEvent.click(tool(container, "Insert slot"));
      undo();
      expect(live()).toEqual([0, 1, 2, 3]);
      expect(canUndo()).toBe(false);
      expect(orderSelection()).toBeNull();
    });

    it("the keyboard shortcuts follow the selection too", () => {
      setSong(fmt.make(4));
      const { container } = render(() => <App />);
      selectOneToTwo(container);
      pressMod("]", "BracketRight"); // insert → repeat the run
      expect(live()).toEqual([0, 1, 2, 1, 2, 3]);
      pressMod("[", "BracketLeft"); // delete → remove the selected copy
      expect(live()).toEqual([0, 1, 2, 3]);
    });

    it("works while the song plays, without moving the playhead", () => {
      setSong(fmt.make(4));
      const { container } = render(() => <App />);
      setTransport("playing");
      setPlayPos({ order: 0, row: 8 });
      shiftClick(rows(container)[2]!); // anchors at the playhead: 0..2
      expect(orderSelectionRange()).toEqual({ start: 0, end: 2 });
      expect(playPos()).toEqual({ order: 0, row: 8 });
      fireEvent.click(tool(container, "Insert slot"));
      expect(live()).toEqual([0, 1, 2, 0, 1, 2, 3]);
      expect(playPos().order).toBe(0);
    });

    it("without a selection the buttons act on one position, as before", () => {
      setSong(fmt.make(3));
      const { container } = render(() => <App />);
      fireEvent.click(rows(container)[1]!);
      fireEvent.click(tool(container, "Insert slot"));
      expect(live()).toEqual([0, 1, 1, 2]);
      fireEvent.click(tool(container, "Delete slot"));
      expect(live()).toEqual([0, 1, 2]);
    });

    it("the toolbar says what it will do with the selection", () => {
      setSong(fmt.make(4));
      const { container } = render(() => <App />);
      expect(tool(container, "Insert slot").title).toBe(
        "Insert slot at cursor (⌘])",
      );
      selectOneToTwo(container);
      expect(tool(container, "Insert slot").title).toContain(
        "Repeat the 2 selected slots",
      );
      expect(tool(container, "Delete slot").title).toContain(
        "Delete the 2 selected slots",
      );
      expect(tool(container, "Duplicate pattern").title).toContain(
        "2 selected slots their own copies",
      );
    });
  });
}

describe("order list: a run that would not fit", () => {
  it("Insert is disabled, says why, and does nothing", () => {
    const s = ptSong(1);
    s.songLength = MAX_ORDERS - 1;
    setSong(s);
    const { container } = render(() => <App />);
    fireEvent.click(rows(container)[0]!);
    shiftClick(rows(container)[1]!);
    const insert = tool(container, "Insert slot");
    expect(insert.disabled).toBe(true);
    expect(insert.title).toContain("No room to repeat 2 slots");
    // One more single slot would still fit once the selection is gone.
    fireEvent.click(rows(container)[0]!);
    expect(tool(container, "Insert slot").disabled).toBe(false);
  });
});
