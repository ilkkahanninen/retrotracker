/**
 * FT2 instrument-level edit actions. Phase 3-5 only carries the rename
 * action that the instrument list pane needs; envelope / autovibrato /
 * fadeout / sample-import setters land in Phase 4 alongside the FT2
 * sample editor.
 */

import { renameXmInstrument as renameXmInstrumentMutation } from "../core/xm/mutations";
import { commitEditXm } from "./song";

/** 1-based slot index — the instrument list's inline rename can target any slot. */
export function renameXmInstrument(slot1Based: number, name: string): void {
  commitEditXm((s) => renameXmInstrumentMutation(s, slot1Based, name));
}
