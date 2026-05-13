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
