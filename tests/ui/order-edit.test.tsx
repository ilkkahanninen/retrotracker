import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App";
import { setCursor, INITIAL_CURSOR, cursor } from "../../src/state/cursor";
import {
  setSong,
  setTransport,
  setPlayPos,
  playPos,
  clearHistory,
  song,
  transport,
} from "../../src/state/song";
import { setCurrentSample, setCurrentOctave } from "../../src/state/edit";
import { emptyPattern, emptySong } from "../../src/core/mod/format";
import type { Song } from "../../src/core/mod/types";

/** A song with N patterns and orders [0, 1, …, N-1]. */
function songWith(numPatterns: number): Song {
  const s = emptySong();
  s.patterns = Array.from({ length: numPatterns }, emptyPattern);
  s.songLength = numPatterns;
  for (let i = 0; i < numPatterns; i++) s.orders[i] = i;
  return s;
}

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  resetState();
});

describe("order list: click navigation", () => {
  it("clicking a slot moves the cursor onto that order, row 0", async () => {
    setSong(songWith(3));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    const items = container.querySelectorAll<HTMLElement>(".orderlist li");
    expect(items).toHaveLength(3);
    await user.click(items[2]!);
    expect(cursor()).toMatchObject({ order: 2, row: 0 });
  });

  it("the cursor slot carries .orderlist__item--cursor when stopped", async () => {
    setSong(songWith(3));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    const items = container.querySelectorAll<HTMLElement>(".orderlist li");
    await user.click(items[1]!);
    expect(items[1]!.classList.contains("orderlist__item--cursor")).toBe(true);
    expect(items[0]!.classList.contains("orderlist__item--cursor")).toBe(false);
  });

  it("clicking a slot during playback re-routes playback without stopping", async () => {
    // The previous behavior was an early-return: clicking did nothing.
    // Now the order-list click is a mid-playback "jump to pattern X" —
    // playPos snaps synchronously (so the playhead UI moves immediately
    // even before the worklet's first pos event), transport stays
    // "playing", and the edit cursor is left untouched (the worklet
    // drives the playhead while playing).
    setSong(songWith(3));
    const { container } = render(() => <App />);
    setTransport("playing");
    setPlayPos({ order: 0, row: 5 });
    const user = userEvent.setup();
    const items = container.querySelectorAll<HTMLElement>(".orderlist li");
    await user.click(items[2]!);
    expect(playPos()).toEqual({ order: 2, row: 0 });
    expect(transport()).toBe("playing");
    // Cursor is locked while playing.
    expect(cursor().order).toBe(0);
  });
});

describe("order list: Shift+[ / Shift+] step pattern at slot", () => {
  // Position-mapped — drive raw KeyboardEvents so the matcher can see the
  // physical-key code (`BracketLeft` / `BracketRight`) regardless of
  // userEvent's keyboard-syntax escaping rules around brackets.
  function pressBracket(
    side: "left" | "right",
    mods: { meta?: boolean; shift?: boolean } = {},
  ) {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: side === "left" ? "[" : "]",
        code: side === "left" ? "BracketLeft" : "BracketRight",
        metaKey: mods.meta ?? false,
        shiftKey: mods.shift ?? false,
      }),
    );
  }

  it("'Shift+]' increments orders[cursor.order]", () => {
    setSong(songWith(3));
    render(() => <App />);
    expect(song()!.orders[0]).toBe(0);
    pressBracket("right", { shift: true });
    expect(song()!.orders[0]).toBe(1);
  });

  it("'Shift+[' decrements orders[cursor.order] and clamps at 0", () => {
    setSong(songWith(3));
    render(() => <App />);
    setCursor({ order: 2, row: 0, channel: 0, field: "note" }); // slot 2 → pattern 2
    pressBracket("left", { shift: true });
    expect(song()!.orders[2]).toBe(1);
    pressBracket("left", { shift: true });
    expect(song()!.orders[2]).toBe(0);
    pressBracket("left", { shift: true });
    expect(song()!.orders[2]).toBe(0); // clamped
  });

  it("'Shift+]' auto-grows the patterns array when stepping past the last existing one", () => {
    setSong(songWith(2)); // 2 patterns
    render(() => <App />);
    setCursor({ order: 1, row: 0, channel: 0, field: "note" }); // slot 1 → pattern 1
    pressBracket("right", { shift: true });
    expect(song()!.patterns).toHaveLength(3);
    expect(song()!.orders[1]).toBe(2);
  });
});

describe("order list: insert / delete slot", () => {
  function pressBracket(
    side: "left" | "right",
    mods: { meta?: boolean; shift?: boolean } = {},
  ) {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: side === "left" ? "[" : "]",
        code: side === "left" ? "BracketLeft" : "BracketRight",
        metaKey: mods.meta ?? false,
        shiftKey: mods.shift ?? false,
      }),
    );
  }

  it("Cmd+] inserts a new slot at the cursor and bumps songLength", () => {
    setSong(songWith(2));
    render(() => <App />);
    expect(song()!.songLength).toBe(2);
    pressBracket("right", { meta: true });
    expect(song()!.songLength).toBe(3);
    expect(song()!.orders[0]).toBe(0); // duplicated from the previous slot 0
    expect(song()!.orders[1]).toBe(0);
    expect(song()!.orders[2]).toBe(1); // old slot 1 pushed right
  });

  it("Cmd+[ deletes the slot under the cursor and shrinks songLength", () => {
    setSong(songWith(3));
    render(() => <App />);
    setCursor({ order: 1, row: 0, channel: 0, field: "note" });
    pressBracket("left", { meta: true });
    expect(song()!.songLength).toBe(2);
    expect(song()!.orders[1]).toBe(2); // the previous slot 2 pulled left
  });

  it("Cmd+[ clamps the cursor when deleting the last slot", () => {
    setSong(songWith(2));
    render(() => <App />);
    setCursor({ order: 1, row: 0, channel: 0, field: "note" });
    pressBracket("left", { meta: true });
    expect(song()!.songLength).toBe(1);
    expect(cursor().order).toBe(0);
  });

  it("Cmd+[ no-ops when the song already has only one slot", () => {
    setSong(songWith(1));
    render(() => <App />);
    pressBracket("left", { meta: true });
    expect(song()!.songLength).toBe(1);
  });
});

describe("order list: new blank pattern at slot", () => {
  it("Option+[ appends a new pattern and points the slot at it", () => {
    setSong(songWith(2));
    render(() => <App />);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "[",
        code: "BracketLeft",
        altKey: true,
      }),
    );
    expect(song()!.patterns).toHaveLength(3);
    expect(song()!.orders[0]).toBe(2);
  });
});

describe("order list: duplicate pattern at slot", () => {
  it("Option+] copies the current pattern and points the slot at the copy", () => {
    const s = songWith(2);
    s.patterns[0]!.rows[3]![1] = {
      period: 428,
      sample: 5,
      effect: 0xc,
      effectParam: 0x40,
    };
    setSong(s);
    render(() => <App />);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "]",
        code: "BracketRight",
        altKey: true,
      }),
    );
    expect(song()!.patterns).toHaveLength(3);
    expect(song()!.orders[0]).toBe(2);
    const copied = song()!.patterns[2]!.rows[3]![1]!;
    expect(copied.period).toBe(428);
    expect(copied.sample).toBe(5);
    expect(copied.effect).toBe(0xc);
    expect(copied.effectParam).toBe(0x40);
  });
});

describe("order editing is allowed during playback", () => {
  // Order edits are now allowed mid-playback — the worklet keeps its
  // own song snapshot, so a slot bump while playing updates the editor
  // state without desyncing what's currently audible. The new orders
  // apply on the next play / restart.
  it("'Shift+]' bumps the slot pattern while transport is playing", () => {
    setSong(songWith(3));
    render(() => <App />);
    setTransport("playing");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "]",
        code: "BracketRight",
        shiftKey: true,
      }),
    );
    expect(song()!.orders[0]).toBe(1);
  });

  it("Cmd+] inserts a slot during playback (songLength grows)", () => {
    setSong(songWith(2));
    render(() => <App />);
    setTransport("playing");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "]",
        code: "BracketRight",
        metaKey: true,
      }),
    );
    expect(song()!.songLength).toBe(3);
  });

  it("'Shift+]' bumps the slot the playhead is currently on, not the locked cursor", () => {
    // Cursor at slot 0 (its pre-play position), playhead at slot 2. The
    // active pattern in the order list is whatever the song is audibly
    // cycling through right now — playhead — so `Shift+]` must bump
    // orders[2], not orders[0]. Without this, mid-playback order edits
    // would always touch wherever the user last navigated before
    // pressing play (often the start of the song).
    setSong(songWith(3));
    render(() => <App />);
    setCursor({ order: 0, row: 0, channel: 0, field: "note" });
    setTransport("playing");
    setPlayPos({ order: 2, row: 0 });
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "]",
        code: "BracketRight",
        shiftKey: true,
      }),
    );
    expect(song()!.orders[0]).toBe(0); // untouched
    expect(song()!.orders[2]).toBe(3); // playhead's slot bumped from 2 → 3
  });

  it("'Previous pattern' toolbar button mirrors the playhead's slot during playback", () => {
    // Cursor's slot pattern is 0 (would normally disable Prev), but the
    // playhead is on slot 1 (pattern 1, > 0). The button must enable
    // because clicking it acts on the playhead, not the cursor.
    setSong(songWith(3));
    const { container } = render(() => <App />);
    setCursor({ order: 0, row: 0, channel: 0, field: "note" });
    setTransport("playing");
    setPlayPos({ order: 1, row: 0 });
    expect(tool(container, "Previous pattern at slot").disabled).toBe(false);
  });
});

describe("order list: [ / ] jump to prev/next order", () => {
  // Bare `[` / `]` move the active position prev/next in the order
  // list. When stopped, the cursor moves; when playing, the audio
  // engine retargets to that order at row 0 and playPos snaps in
  // sync (the same path as clicking an order list slot).
  function pressBracket(
    side: "left" | "right",
    mods: { shift?: boolean } = {},
  ) {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: side === "left" ? "[" : "]",
        code: side === "left" ? "BracketLeft" : "BracketRight",
        shiftKey: mods.shift ?? false,
      }),
    );
  }

  it("']' moves the cursor to the next order when stopped", () => {
    setSong(songWith(3));
    render(() => <App />);
    expect(cursor().order).toBe(0);
    pressBracket("right");
    expect(cursor().order).toBe(1);
    pressBracket("right");
    expect(cursor().order).toBe(2);
  });

  it("']' clamps at the last order", () => {
    setSong(songWith(3));
    render(() => <App />);
    setCursor({ order: 2, row: 0, channel: 0, field: "note" });
    pressBracket("right");
    expect(cursor().order).toBe(2);
    expect(song()!.songLength).toBe(3); // didn't grow either
  });

  it("'[' moves the cursor to the previous order, clamping at 0", () => {
    setSong(songWith(3));
    render(() => <App />);
    setCursor({ order: 2, row: 0, channel: 0, field: "note" });
    pressBracket("left");
    expect(cursor().order).toBe(1);
    pressBracket("left");
    expect(cursor().order).toBe(0);
    pressBracket("left");
    expect(cursor().order).toBe(0);
  });

  it("']' retargets playback to the next order during playback", () => {
    setSong(songWith(3));
    render(() => <App />);
    setTransport("playing");
    setPlayPos({ order: 0, row: 5 });
    pressBracket("right");
    // Same path as clicking an order list slot mid-playback: playPos
    // snaps to (target, 0) synchronously and transport stays "playing".
    expect(playPos()).toEqual({ order: 1, row: 0 });
    expect(transport()).toBe("playing");
  });
});

/**
 * Toolbar parity: the buttons in `.ordertools` should drive the same
 * mutations the keyboard does. We don't re-test every edge case (the
 * mutations are unit-tested separately) — just the click → state path
 * for each action and the disabled-state contract.
 */
function tool(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(
    `.ordertools button[aria-label="${label}"]`,
  );
  if (!btn) throw new Error(`tool button "${label}" not found`);
  return btn;
}

describe("order toolbar buttons", () => {
  it("Next button increments the slot pattern", async () => {
    setSong(songWith(3));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    expect(song()!.orders[0]).toBe(0);
    await user.click(tool(container, "Next pattern at slot"));
    expect(song()!.orders[0]).toBe(1);
  });

  it("Previous button decrements and is disabled at pattern 0", async () => {
    setSong(songWith(3));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    // Slot 0 → pattern 0 → button disabled.
    expect(tool(container, "Previous pattern at slot").disabled).toBe(true);
    setCursor({ order: 2, row: 0, channel: 0, field: "note" });
    expect(tool(container, "Previous pattern at slot").disabled).toBe(false);
    await user.click(tool(container, "Previous pattern at slot"));
    expect(song()!.orders[2]).toBe(1);
  });

  it("Insert button grows songLength", async () => {
    setSong(songWith(2));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(tool(container, "Insert slot"));
    expect(song()!.songLength).toBe(3);
  });

  it("Insert advances the cursor onto the newly-created slot", async () => {
    setSong(songWith(3));
    setCursor({ order: 1, row: 0, channel: 0, field: "note" });
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(tool(container, "Insert slot"));
    // [0,1,2] with cursor on 1 → [0,1,1,2]; the new (duplicate) slot is at
    // index 2 and the cursor advances there.
    expect(cursor().order).toBe(2);
    expect(song()!.orders.slice(0, 4)).toEqual([0, 1, 1, 2]);
  });

  it("Insert via Cmd+] at MAX_ORDERS leaves the cursor put (no-op insertOrder)", () => {
    // The toolbar button gates on `songLength < 128` so it disables itself,
    // but the Cmd+] shortcut only checks transport — without our songLength
    // before/after diff the handler would still bump the cursor on a no-op
    // insert, walking it past content. Drive the keyboard path (via a raw
    // KeyboardEvent — `userEvent.keyboard` has heavy realtime delays we
    // don't need here) so we hit exactly that branch.
    const s = emptySong();
    s.songLength = 128;
    for (let i = 0; i < 128; i++) s.orders[i] = 0;
    setSong(s);
    setCursor({ order: 5, row: 0, channel: 0, field: "note" });
    render(() => <App />);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "]",
        code: "BracketRight",
        metaKey: true,
      }),
    );
    expect(cursor().order).toBe(5);
    expect(song()!.songLength).toBe(128);
  });

  it("Delete button shrinks songLength and disables at length 1", async () => {
    setSong(songWith(2));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(tool(container, "Delete slot"));
    expect(song()!.songLength).toBe(1);
    expect(tool(container, "Delete slot").disabled).toBe(true);
  });

  it("New blank button appends a pattern and points the slot at it", async () => {
    setSong(songWith(2));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(tool(container, "New blank pattern"));
    expect(song()!.patterns).toHaveLength(3);
    expect(song()!.orders[0]).toBe(2);
  });

  it("Duplicate button copies the current pattern and points the slot at the copy", async () => {
    const s = songWith(2);
    s.patterns[0]!.rows[7]![2] = {
      period: 320,
      sample: 3,
      effect: 0,
      effectParam: 0,
    };
    setSong(s);
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(tool(container, "Duplicate pattern"));
    expect(song()!.patterns).toHaveLength(3);
    expect(song()!.orders[0]).toBe(2);
    expect(song()!.patterns[2]!.rows[7]![2]!.period).toBe(320);
    expect(song()!.patterns[2]!.rows[7]![2]!.sample).toBe(3);
  });

  it("toolbar buttons stay live during playback (Clean up is the only exception)", () => {
    // Pattern stepping / insert / delete / new / duplicate are allowed
    // mid-playback. They only need their non-transport pre-conditions to
    // still hold (e.g. Previous needs slotPat > 0). Clean up is gated
    // separately because it renumbers patterns and would desync the
    // worklet's song snapshot — covered in the Clean up describe. Set
    // playPos to a slot whose pattern > 0 so Prev's pre-condition
    // holds — the toolbar reads the playhead's slot during playback.
    setSong(songWith(3));
    const { container } = render(() => <App />);
    setTransport("playing");
    setPlayPos({ order: 1, row: 0 }); // slotPat = 1, Prev enabled
    for (const label of [
      "Previous pattern at slot",
      "Next pattern at slot",
      "Insert slot",
      "Delete slot",
      "New blank pattern",
      "Duplicate pattern",
    ]) {
      expect(tool(container, label).disabled).toBe(false);
    }
  });
});

describe("Clean up button", () => {
  function cleanupBtn(container: HTMLElement): HTMLButtonElement {
    const btn = container.querySelector<HTMLButtonElement>(
      ".orderfooter button",
    );
    if (!btn) throw new Error("Clean up button not found");
    return btn;
  }

  it("renumbers patterns in order of appearance and discards unused ones", async () => {
    // README example: orders [4,5,0,0,1] over six patterns → [0,1,2,2,3].
    const s = emptySong();
    s.patterns = Array.from({ length: 6 }, emptyPattern);
    s.songLength = 5;
    s.orders[0] = 4;
    s.orders[1] = 5;
    s.orders[2] = 0;
    s.orders[3] = 0;
    s.orders[4] = 1;
    // Stamp something distinctive into pattern 4 so we can verify it survives.
    s.patterns[4]!.rows[0]![0] = {
      period: 428,
      sample: 1,
      effect: 0,
      effectParam: 0,
    };
    setSong(s);
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(cleanupBtn(container));
    expect(song()!.orders.slice(0, 5)).toEqual([0, 1, 2, 2, 3]);
    expect(song()!.patterns).toHaveLength(4);
    // Pattern that used to be index 4 now lives at index 0.
    expect(song()!.patterns[0]!.rows[0]![0]!.period).toBe(428);
  });

  it("is disabled while transport is playing", () => {
    setSong(songWith(3));
    const { container } = render(() => <App />);
    setTransport("playing");
    expect(cleanupBtn(container).disabled).toBe(true);
  });
});
