import { render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it } from "vitest";

import { PatternGridXm } from "~/components/PatternGridXm";
import { emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmPatternRowCount } from "~/core/xm/mutations";
import { resetXmCursor, setXmCursor } from "~/state/cursorXm";

beforeEach(() => {
  resetXmCursor();
});

describe("PatternGridXm rendering", () => {
  it("mounts using the PT grid's .patgrid skeleton", () => {
    const song = emptyXmSong();
    const { container } = render(() => (
      <PatternGridXm song={song} pos={{ order: 0, row: 0 }} active={false} />
    ));
    // Look & feel parity with PT mode: same outer class, same row layout.
    expect(container.querySelector(".patgrid")).not.toBeNull();
    expect(container.querySelector(".patgrid__header")).not.toBeNull();
    expect(container.querySelector(".patgrid__rows")).not.toBeNull();
  });

  it("placeholder height tracks flat row count × ROW_HEIGHT", () => {
    // jsdom reports clientHeight=0, so the visible slice is just the
    // virtualization buffer. The spacer's height proves the scrollbar
    // represents the full song.
    const song = emptyXmSong();
    const { container } = render(() => (
      <PatternGridXm song={song} pos={{ order: 0, row: 0 }} active={false} />
    ));
    const spacer = container.querySelector<HTMLElement>(
      ".patgrid__rows-spacer",
    )!;
    // 64 rows × 19px = 1216px (one pattern, one order entry).
    expect(spacer.style.height).toBe("1216px");
  });

  it("virtualization mounts a buffer of rows, not all of them", () => {
    const song = emptyXmSong();
    const { container } = render(() => (
      <PatternGridXm song={song} pos={{ order: 0, row: 0 }} active={false} />
    ));
    const rows = container.querySelectorAll(".patgrid__row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(64);
  });

  it("renders one .patgrid__cell per channel", () => {
    const song = emptyXmSong();
    const { container } = render(() => (
      <PatternGridXm song={song} pos={{ order: 0, row: 0 }} active={false} />
    ));
    // Header + first body row each have channelCount cells. Walk the body.
    const firstBodyRow = container.querySelector(
      ".patgrid__rows .patgrid__row",
    )!;
    const cells = firstBodyRow.querySelectorAll(".patgrid__cell");
    expect(cells.length).toBe(song.channelCount);
  });

  it("each cell carries note / inst / vol / effect sub-spans", () => {
    const song = emptyXmSong();
    const { container } = render(() => (
      <PatternGridXm song={song} pos={{ order: 0, row: 0 }} active={false} />
    ));
    const firstBodyCell = container.querySelector(
      ".patgrid__rows .patgrid__row .patgrid__cell",
    )!;
    expect(firstBodyCell.querySelector(".patgrid__note")).not.toBeNull();
    expect(firstBodyCell.querySelector(".patgrid__samp")).not.toBeNull();
    expect(firstBodyCell.querySelector(".patgrid__vol")).not.toBeNull();
    expect(firstBodyCell.querySelector(".patgrid__eff")).not.toBeNull();
  });

  it("renders the note name for a populated cell on row 5", () => {
    let song = emptyXmSong();
    song = setXmCell(song, 0, 5, 0, { note: 49 });
    setXmCursor({ order: 0, row: 5, channel: 0, field: "note" });
    const { container } = render(() => (
      <PatternGridXm song={song} pos={{ order: 0, row: 0 }} active={false} />
    ));
    // Cursor row's first cell has the populated note.
    const cursorRow = container.querySelector(".patgrid__row--cursor")!;
    const note = cursorRow.querySelector(".patgrid__note")!;
    expect(note.textContent).toBe("C-4");
  });

  it("variable rowCount adjusts the spacer height", () => {
    let song = emptyXmSong();
    song = setXmPatternRowCount(song, 0, 32);
    const { container } = render(() => (
      <PatternGridXm song={song} pos={{ order: 0, row: 0 }} active={false} />
    ));
    const spacer = container.querySelector<HTMLElement>(
      ".patgrid__rows-spacer",
    )!;
    // 32 rows × 19px = 608px.
    expect(spacer.style.height).toBe("608px");
  });

  it("renders all up-to-32 channels in the header", () => {
    const song = { ...emptyXmSong(), channelCount: 16 };
    song.patterns = [
      {
        rows: Array.from({ length: 64 }, () =>
          Array.from({ length: 16 }, () => ({
            note: 0,
            instrument: 0,
            volumeColumn: 0,
            effect: 0,
            effectParam: 0,
          })),
        ),
        rowCount: 64,
      },
    ];
    const { container } = render(() => (
      <PatternGridXm song={song} pos={{ order: 0, row: 0 }} active={false} />
    ));
    expect(container.querySelectorAll(".patgrid__chhead").length).toBe(16);
  });

  it("draws the pattern boundary above the first row of a new order", () => {
    // Two-order song with a small first pattern so the boundary at flat
    // index 4 falls inside the virtualization buffer (jsdom reports
    // clientHeight=0, so only the buffer's worth of rows mounts).
    let song = emptyXmSong();
    song = setXmPatternRowCount(song, 0, 4);
    song = { ...song, songLength: 2, orders: [...song.orders] };
    song.orders[1] = 0;
    const { container } = render(() => (
      <PatternGridXm song={song} pos={{ order: 0, row: 0 }} active={false} />
    ));
    expect(container.querySelector(".patgrid__row--boundary")).not.toBeNull();
  });
});
