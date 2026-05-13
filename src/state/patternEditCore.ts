import type { PatternSelection } from "./selection";
import { makeSelection } from "./selection";
import type { PatternRange } from "../core/clipboardOps";

export interface CursorShape {
  order: number;
  row: number;
  channel: number;
  field: string;
}

export interface CellWithEffect {
  effect: number;
  effectParam: number;
}

export interface SelectionAnchor {
  order: number;
  row: number;
  channel: number;
}

export interface PatternEditAdapter<
  S,
  C extends CursorShape,
  Cell extends CellWithEffect,
> {
  song: () => S | null;
  cursor: () => C;
  setCursorRaw: (c: C) => void;
  selection: () => PatternSelection | null;
  setSelection: (r: PatternSelection | null) => void;
  selectionAnchor: () => SelectionAnchor | null;
  setSelectionAnchor: (a: SelectionAnchor | null) => void;
  clearSelection: () => void;
  setPlayPos: (p: { order: number; row: number }) => void;
  isPlaying: () => boolean;
  commitSong: (transform: (s: S) => S) => void;
  channelCount: (s: S) => number;
  visibleRowsOfOrder: (s: S, order: number) => { first: number; last: number };
  editStep: () => number;
  moveDown: (c: C, s: S) => C;
  stepDownAfterInsert: (c: C, s: S) => C;
  getCellAt: (
    s: S,
    order: number,
    row: number,
    channel: number,
  ) => Cell | undefined;
  setCell: (
    s: S,
    order: number,
    row: number,
    channel: number,
    patch: Partial<Cell>,
  ) => S;
  clearFieldPatch: (cell: Cell, field: C["field"]) => Partial<Cell>;
  getClipboard: () => { rows: Cell[][] } | null;
  setClipboard: (v: { rows: Cell[][] } | null) => void;
  clipboardOps: {
    clearRange: (s: S, r: PatternRange) => S;
    readSlice: (s: S, r: PatternRange) => Cell[][] | null;
    pasteSlice: (
      s: S,
      rows: Cell[][],
      order: number,
      row: number,
      channel: number,
    ) => S;
    transposeRange: (s: S, r: PatternRange, delta: number) => S;
    deleteCellPullUp: (s: S, order: number, row: number, channel: number) => S;
    deleteRowPullUp: (s: S, order: number, row: number) => S;
    insertCellPushDown: (
      s: S,
      order: number,
      row: number,
      channel: number,
    ) => S;
    insertRowPushDown: (s: S, order: number, row: number) => S;
  };
}

export function createPatternEdit<
  S,
  C extends CursorShape,
  Cell extends CellWithEffect,
>(adapter: PatternEditAdapter<S, C, Cell>) {
  function applyCursor(next: C): void {
    if (adapter.isPlaying()) return;
    adapter.setCursorRaw(next);
    adapter.setPlayPos({ order: next.order, row: next.row });
    adapter.clearSelection();
  }

  function extendSelection(next: C): void {
    if (adapter.isPlaying()) return;
    const before = adapter.cursor();
    let anchor = adapter.selectionAnchor();
    if (!anchor) {
      anchor = {
        order: before.order,
        row: before.row,
        channel: before.channel,
      };
      adapter.setSelectionAnchor(anchor);
    }
    adapter.setCursorRaw(next);
    adapter.setPlayPos({ order: next.order, row: next.row });
    if (next.order !== anchor.order) {
      const reAnchor = {
        order: next.order,
        row: next.row,
        channel: next.channel,
      };
      adapter.setSelectionAnchor(reAnchor);
      adapter.setSelection(null);
      return;
    }
    adapter.setSelection(
      makeSelection(
        anchor.order,
        anchor.row,
        anchor.channel,
        next.row,
        next.channel,
      ),
    );
  }

  function applyCursorWithSong(fn: (c: C, s: S) => C): void {
    if (adapter.isPlaying()) return;
    const s = adapter.song();
    if (!s) return;
    applyCursor(fn(adapter.cursor(), s));
  }

  function advanceByEditStep(): void {
    const s = adapter.song();
    if (!s) return;
    const step = adapter.editStep();
    if (step <= 0) return;
    let next = adapter.cursor();
    for (let i = 0; i < step; i++) next = adapter.moveDown(next, s);
    applyCursor(next);
  }

  function visibleRowsOfCursor(): { first: number; last: number } {
    const s = adapter.song();
    if (!s) return { first: 0, last: 0 };
    return adapter.visibleRowsOfOrder(s, adapter.cursor().order);
  }

  const stepChannelLeft = (c: C): C => ({
    ...c,
    channel: Math.max(0, c.channel - 1),
  });

  const stepChannelRight = (c: C): C => {
    const s = adapter.song();
    if (!s) return c;
    return {
      ...c,
      channel: Math.min(adapter.channelCount(s) - 1, c.channel + 1),
    };
  };

  const stepRowUp = (c: C): C => ({
    ...c,
    row: Math.max(visibleRowsOfCursor().first, c.row - 1),
  });
  const stepRowDown = (c: C): C => ({
    ...c,
    row: Math.min(visibleRowsOfCursor().last, c.row + 1),
  });
  const stepRowPageUp = (c: C, n: number): C => ({
    ...c,
    row: Math.max(visibleRowsOfCursor().first, c.row - Math.max(1, n)),
  });
  const stepRowPageDown = (c: C, n: number): C => ({
    ...c,
    row: Math.min(visibleRowsOfCursor().last, c.row + Math.max(1, n)),
  });

  function clearAtCursor(): void {
    if (adapter.isPlaying()) return;
    const s = adapter.song();
    if (!s) return;
    const c = adapter.cursor();
    const cell = adapter.getCellAt(s, c.order, c.row, c.channel);
    if (!cell) return;
    const patch = adapter.clearFieldPatch(cell, c.field);
    adapter.commitSong((song) =>
      adapter.setCell(song, c.order, c.row, c.channel, patch),
    );
    advanceByEditStep();
  }

  function repeatLastEffectFromAbove(): void {
    if (adapter.isPlaying()) return;
    const s = adapter.song();
    if (!s) return;
    const c = adapter.cursor();
    let copy: { effect: number; effectParam: number } | null = null;
    for (let r = c.row - 1; r >= 0; r--) {
      const cell = adapter.getCellAt(s, c.order, r, c.channel);
      if (!cell) continue;
      if (cell.effect !== 0 || cell.effectParam !== 0) {
        copy = { effect: cell.effect, effectParam: cell.effectParam };
        break;
      }
    }
    if (!copy) return;
    const patch = copy as Partial<Cell>;
    adapter.commitSong((song) =>
      adapter.setCell(song, c.order, c.row, c.channel, patch),
    );
    advanceByEditStep();
  }

  function selectAllStep(): void {
    if (adapter.isPlaying()) return;
    const s = adapter.song();
    if (!s) return;
    const c = adapter.cursor();
    const sel = adapter.selection();
    const { first, last } = adapter.visibleRowsOfOrder(s, c.order);
    const cc = adapter.channelCount(s);
    const isWholePattern =
      !!sel &&
      sel.order === c.order &&
      sel.startRow === first &&
      sel.endRow === last &&
      sel.startChannel === 0 &&
      sel.endChannel === cc - 1;
    if (isWholePattern) return;
    const isWholeChannel =
      !!sel &&
      sel.order === c.order &&
      sel.startRow === first &&
      sel.endRow === last &&
      sel.startChannel === c.channel &&
      sel.endChannel === c.channel;
    if (isWholeChannel) {
      adapter.setSelection(makeSelection(c.order, first, 0, last, cc - 1));
      return;
    }
    adapter.setSelection(
      makeSelection(c.order, first, c.channel, last, c.channel),
    );
  }

  function rangeForClipboard(): PatternRange | null {
    if (!adapter.song()) return null;
    const sel = adapter.selection();
    if (sel)
      return {
        order: sel.order,
        startRow: sel.startRow,
        endRow: sel.endRow,
        startChannel: sel.startChannel,
        endChannel: sel.endChannel,
      };
    const c = adapter.cursor();
    return {
      order: c.order,
      startRow: c.row,
      endRow: c.row,
      startChannel: c.channel,
      endChannel: c.channel,
    };
  }

  function copySelection(): void {
    const range = rangeForClipboard();
    if (!range) return;
    const s = adapter.song();
    if (!s) return;
    const slice = adapter.clipboardOps.readSlice(s, range);
    if (!slice) return;
    adapter.setClipboard({ rows: slice });
  }

  function cutSelection(): void {
    const range = rangeForClipboard();
    if (!range) return;
    const s = adapter.song();
    if (!s) return;
    const slice = adapter.clipboardOps.readSlice(s, range);
    if (!slice) return;
    adapter.setClipboard({ rows: slice });
    adapter.commitSong((song) => adapter.clipboardOps.clearRange(song, range));
    adapter.setSelection(null);
  }

  function pasteAtCursor(): void {
    if (adapter.isPlaying()) return;
    const slice = adapter.getClipboard();
    if (!slice || slice.rows.length === 0) return;
    const c = adapter.cursor();
    adapter.commitSong((song) =>
      adapter.clipboardOps.pasteSlice(
        song,
        slice.rows,
        c.order,
        c.row,
        c.channel,
      ),
    );
    applyCursor(stepRowPageDown(c, slice.rows.length));
  }

  function transposeAtCursor(deltaSemitones: number): void {
    if (adapter.isPlaying()) return;
    const s = adapter.song();
    if (!s) return;
    const sel = adapter.selection();
    const range: PatternRange = sel
      ? {
          order: sel.order,
          startRow: sel.startRow,
          endRow: sel.endRow,
          startChannel: sel.startChannel,
          endChannel: sel.endChannel,
        }
      : (() => {
          const c = adapter.cursor();
          return {
            order: c.order,
            startRow: c.row,
            endRow: c.row,
            startChannel: c.channel,
            endChannel: c.channel,
          };
        })();
    adapter.commitSong((song) =>
      adapter.clipboardOps.transposeRange(song, range, deltaSemitones),
    );
  }

  function backspaceCell(): void {
    if (adapter.isPlaying()) return;
    const s = adapter.song();
    if (!s) return;
    const sel = adapter.selection();
    if (sel) {
      adapter.commitSong((song) => adapter.clipboardOps.clearRange(song, sel));
      return;
    }
    const c = adapter.cursor();
    if (c.row <= 0) return;
    adapter.commitSong((song) =>
      adapter.clipboardOps.deleteCellPullUp(
        song,
        c.order,
        c.row - 1,
        c.channel,
      ),
    );
    // Why: explicit row-1 step (not moveUp) — pull-up may shift a Dxx into
    // the cursor's row, hiding it; moveUp would land above the closest visible.
    applyCursor({ ...c, row: c.row - 1 });
  }

  function backspaceRow(): void {
    if (adapter.isPlaying()) return;
    const s = adapter.song();
    if (!s) return;
    const sel = adapter.selection();
    if (sel) {
      adapter.commitSong((song) =>
        adapter.clipboardOps.clearRange(song, {
          order: sel.order,
          startRow: sel.startRow,
          endRow: sel.endRow,
          startChannel: 0,
          endChannel: adapter.channelCount(song) - 1,
        }),
      );
      return;
    }
    const c = adapter.cursor();
    if (c.row <= 0) return;
    adapter.commitSong((song) =>
      adapter.clipboardOps.deleteRowPullUp(song, c.order, c.row - 1),
    );
    applyCursor({ ...c, row: c.row - 1 });
  }

  function deleteSelection(): void {
    if (adapter.isPlaying()) return;
    const sel = adapter.selection();
    if (!sel) return;
    adapter.commitSong((song) => adapter.clipboardOps.clearRange(song, sel));
  }

  function insertEmptyCell(): void {
    if (adapter.isPlaying()) return;
    const s = adapter.song();
    if (!s) return;
    const c = adapter.cursor();
    adapter.commitSong((song) =>
      adapter.clipboardOps.insertCellPushDown(song, c.order, c.row, c.channel),
    );
    applyCursor(adapter.stepDownAfterInsert(c, s));
  }

  function insertEmptyRow(): void {
    if (adapter.isPlaying()) return;
    const s = adapter.song();
    if (!s) return;
    const c = adapter.cursor();
    adapter.commitSong((song) =>
      adapter.clipboardOps.insertRowPushDown(song, c.order, c.row),
    );
    applyCursor(adapter.stepDownAfterInsert(c, s));
  }

  return {
    applyCursor,
    extendSelection,
    applyCursorWithSong,
    advanceByEditStep,
    stepChannelLeft,
    stepChannelRight,
    stepRowUp,
    stepRowDown,
    stepRowPageUp,
    stepRowPageDown,
    clearAtCursor,
    repeatLastEffectFromAbove,
    selectAllStep,
    copySelection,
    cutSelection,
    pasteAtCursor,
    transposeAtCursor,
    backspaceCell,
    backspaceRow,
    deleteSelection,
    insertEmptyCell,
    insertEmptyRow,
  };
}
