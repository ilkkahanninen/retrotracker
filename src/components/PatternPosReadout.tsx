import type { Component } from "solid-js";

import { playPos } from "../state/song";

interface Props {
  /** Either format's song — only the order list is read. */
  song: { songLength: number; orders: number[] };
}

const hex2 = (n: number): string =>
  n.toString(16).toUpperCase().padStart(2, "0");

/**
 * "order XX/YY · pat XX · row XX" for the pattern meta strip: where the
 * playhead (or, when stopped, the cursor) is. Shared by the PT and FT2
 * strips.
 */
export const PatternPosReadout: Component<Props> = (props) => (
  <>
    <span>
      order {hex2(playPos().order)}/{hex2(props.song.songLength - 1)}
    </span>
    <span class="patternpane__sep">·</span>
    <span>pat {hex2(props.song.orders[playPos().order] ?? 0)}</span>
    <span class="patternpane__sep">·</span>
    <span>row {hex2(playPos().row)}</span>
  </>
);
