import { CHANNELS, ROWS_PER_PATTERN } from "../core/mod/types";
import { channelCount, rowsOfPattern } from "../core/song";
import { channelLevels, resetChannelLevels } from "./channelLevel";
import {
  mutedChannels,
  setChannelMuteState,
  soloedChannels,
} from "./channelMute";
import { cursor, setCursor } from "./cursor";
import { setXmCursor, xmCursor } from "./cursorXm";
import {
  clearSelection,
  clearXmSelection,
  selection,
  xmSelection,
  type PatternSelection,
} from "./selection";
import { playPos, setPlayPos, song, transport } from "./song";

const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

/**
 * Bring the UI state that INDEXES into the song back in range after the
 * song's shape changed underneath it.
 *
 * The song is replaced wholesale by undo / redo, file load, and the XM
 * row-count / channel-count actions, but the cursor, play position,
 * pattern selection and per-channel mute arrays live in their own signals
 * and used to be fixed up ad hoc by whichever forward action remembered
 * to. Anything that missed (undo of an order insert, undo of a row-count
 * change, a channel-count shrink with a solo'd channel, a page reload of
 * an 8-channel XM) left a phantom cursor that swallowed keystrokes, a
 * selection pointing at cells that no longer exist, or mute flags for
 * channels that can't be reached any more.
 *
 * Idempotent and cheap — signals are only written when a value actually
 * has to change, so calling it after every history step costs nothing in
 * the common case. Nothing here touches the song itself.
 */
export function reconcileUiToSong(): void {
  const s = song();
  if (!s) return;
  const lastOrder = Math.max(0, s.songLength - 1);
  const channels = channelCount(s);
  const rowsAt = (order: number): number =>
    s.format === "FT2"
      ? Math.max(1, rowsOfPattern(s, s.orders[order] ?? 0))
      : ROWS_PER_PATTERN;

  if (s.format === "FT2") {
    const c = xmCursor();
    const order = clamp(c.order, 0, lastOrder);
    const row = clamp(c.row, 0, rowsAt(order) - 1);
    const channel = clamp(c.channel, 0, channels - 1);
    if (order !== c.order || row !== c.row || channel !== c.channel) {
      setXmCursor({ ...c, order, row, channel });
    }
    const sel = xmSelection();
    if (sel && !selectionFits(sel, lastOrder, rowsAt, channels)) {
      clearXmSelection();
    }
  } else {
    const c = cursor();
    const order = clamp(c.order, 0, lastOrder);
    const row = clamp(c.row, 0, ROWS_PER_PATTERN - 1);
    const channel = clamp(c.channel, 0, CHANNELS - 1);
    if (order !== c.order || row !== c.row || channel !== c.channel) {
      setCursor({ ...c, order, row, channel });
    }
    const sel = selection();
    if (sel && !selectionFits(sel, lastOrder, rowsAt, channels)) {
      clearSelection();
    }
  }

  // While playing, the worklet owns playPos (it reports against its own
  // snapshot); only pull it back in range when stopped.
  if (transport() !== "playing") {
    const p = playPos();
    const order = clamp(p.order, 0, lastOrder);
    const row = clamp(p.row, 0, rowsAt(order) - 1);
    if (order !== p.order || row !== p.row) setPlayPos({ order, row });
  }

  // Mute / solo: keep the flags of channels that still exist, drop the
  // rest, and give new channels a real (false) entry so they can be
  // toggled. A solo on a removed channel would otherwise silence every
  // remaining one with no button left to clear it.
  if (
    mutedChannels().length !== channels ||
    soloedChannels().length !== channels
  ) {
    setChannelMuteState(mutedChannels(), soloedChannels(), channels);
  }
  if (channelLevels().length !== channels) resetChannelLevels(channels);
}

function selectionFits(
  sel: PatternSelection,
  lastOrder: number,
  rowsAt: (order: number) => number,
  channels: number,
): boolean {
  return (
    sel.order >= 0 &&
    sel.order <= lastOrder &&
    sel.startRow >= 0 &&
    sel.endRow < rowsAt(sel.order) &&
    sel.startChannel >= 0 &&
    sel.endChannel < channels
  );
}
