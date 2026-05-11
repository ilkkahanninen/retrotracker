import { createSignal } from "solid-js";
import type { XmNote } from "../core/xm/types";

/**
 * In-memory FT2 pattern clipboard — sibling to `state/clipboard.ts` (PT).
 * The two run independently: a PT copy doesn't pollute the FT2
 * clipboard, and vice versa. Each format's clipboard is empty when no
 * project of that format has copied anything yet, so the user can
 * theoretically have one cell on each clipboard at the same time, but
 * since format is locked per session in practice only one is ever live.
 */
export interface XmClipboardSlice {
  rows: XmNote[][];
}

export const [xmClipboardSlice, setXmClipboardSlice] =
  createSignal<XmClipboardSlice | null>(null);
