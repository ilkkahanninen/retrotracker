import type { XmSampleWorkbench } from "../core/audio/sampleWorkbench";
import { createWorkbenchStore } from "./workbenchStore";

// Why: composite key because XM samples live nested inside instruments.
export type XmWorkbenchKey = `${number}:${number}`;
export type XmWorkbenchMap = Map<XmWorkbenchKey, XmSampleWorkbench>;

export function xmWorkbenchKey(
  instSlot1Based: number,
  sampleIdx: number,
): XmWorkbenchKey {
  return `${instSlot1Based}:${sampleIdx}`;
}

const store = createWorkbenchStore<XmWorkbenchKey, XmSampleWorkbench>();

export const xmWorkbenches = store.signal;
export const setXmWorkbenchesRaw = store.setRaw;

export function getXmWorkbench(
  instSlot1Based: number,
  sampleIdx: number,
): XmSampleWorkbench | undefined {
  return store.get(xmWorkbenchKey(instSlot1Based, sampleIdx));
}

export function setXmWorkbench(
  instSlot1Based: number,
  sampleIdx: number,
  wb: XmSampleWorkbench,
): void {
  store.set(xmWorkbenchKey(instSlot1Based, sampleIdx), wb);
}

export function clearXmWorkbench(
  instSlot1Based: number,
  sampleIdx: number,
): void {
  store.clear(xmWorkbenchKey(instSlot1Based, sampleIdx));
}

export function clearAllXmWorkbenches(): void {
  store.clearAll();
}

export function withXmWorkbench(
  map: XmWorkbenchMap,
  instSlot1Based: number,
  sampleIdx: number,
  wb: XmSampleWorkbench,
): XmWorkbenchMap {
  return store.withSet(map, xmWorkbenchKey(instSlot1Based, sampleIdx), wb);
}

export function withoutXmWorkbench(
  map: XmWorkbenchMap,
  instSlot1Based: number,
  sampleIdx: number,
): XmWorkbenchMap {
  return store.withClear(map, xmWorkbenchKey(instSlot1Based, sampleIdx));
}

// ─── Slot-shape helpers ────────────────────────────────────────────────────
//
// A workbench is only valid for the exact sample bytes it rendered. Any op
// that replaces, removes, or copies a sample WITHOUT going through the
// pipeline must fix the map in the same commit — otherwise the next chain
// edit re-runs the stale workbench and overwrites the new audio with the
// old source. These are pure (fresh map out, input untouched) so they
// compose inside `commitEditXmWithWorkbenches` and undo atomically.

function parseKey(key: XmWorkbenchKey): [number, number] {
  const [inst, idx] = key.split(":");
  return [Number(inst), Number(idx)];
}

/** Drop every workbench belonging to instrument `instSlot1Based`. */
export function withoutXmInstrumentWorkbenches(
  map: XmWorkbenchMap,
  instSlot1Based: number,
): XmWorkbenchMap {
  let next: XmWorkbenchMap | null = null;
  for (const key of map.keys()) {
    if (parseKey(key)[0] !== instSlot1Based) continue;
    next ??= new Map(map);
    next.delete(key);
  }
  return next ?? map;
}

/**
 * Mirror the removal of sample `sampleIdx` from an instrument: its
 * workbench is dropped and every later sample's workbench shifts down one
 * index, matching how `removeXmInstrumentSample` re-indexes the samples.
 */
export function withXmSampleRemoved(
  map: XmWorkbenchMap,
  instSlot1Based: number,
  sampleIdx: number,
): XmWorkbenchMap {
  const touched = [...map.keys()].filter((key) => {
    const [inst, idx] = parseKey(key);
    return inst === instSlot1Based && idx >= sampleIdx;
  });
  if (touched.length === 0) return map;
  const next = new Map(map);
  const moved: Array<[number, XmSampleWorkbench]> = [];
  for (const key of touched) {
    const idx = parseKey(key)[1];
    if (idx > sampleIdx) moved.push([idx - 1, map.get(key)!]);
    next.delete(key);
  }
  for (const [idx, wb] of moved) {
    next.set(xmWorkbenchKey(instSlot1Based, idx), wb);
  }
  return next;
}

/**
 * Give `(toInst, toIdx)` the same workbench as `(fromInst, fromIdx)` — or
 * none, when the source has none. Used when sample bytes are duplicated so
 * the copy's pipeline matches the audio it was copied with. The workbench
 * object is shared by reference; workbenches are immutable values.
 */
export function withXmWorkbenchCopied(
  map: XmWorkbenchMap,
  fromInst: number,
  fromIdx: number,
  toInst: number,
  toIdx: number,
): XmWorkbenchMap {
  const src = map.get(xmWorkbenchKey(fromInst, fromIdx));
  return src
    ? store.withSet(map, xmWorkbenchKey(toInst, toIdx), src)
    : store.withClear(map, xmWorkbenchKey(toInst, toIdx));
}
