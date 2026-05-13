import { createSignal } from "solid-js";
import type { XmSampleWorkbench } from "../core/audio/sampleWorkbench";

// Why: composite key because XM samples live nested inside instruments.
export type XmWorkbenchKey = `${number}:${number}`;
export type XmWorkbenchMap = Map<XmWorkbenchKey, XmSampleWorkbench>;

export function xmWorkbenchKey(
  instSlot1Based: number,
  sampleIdx: number,
): XmWorkbenchKey {
  return `${instSlot1Based}:${sampleIdx}`;
}

const [xmWorkbenches, setXmWorkbenchesRaw] = createSignal<XmWorkbenchMap>(
  new Map(),
);

export function getXmWorkbench(
  instSlot1Based: number,
  sampleIdx: number,
): XmSampleWorkbench | undefined {
  return xmWorkbenches().get(xmWorkbenchKey(instSlot1Based, sampleIdx));
}

export function setXmWorkbench(
  instSlot1Based: number,
  sampleIdx: number,
  wb: XmSampleWorkbench,
): void {
  const next = new Map(xmWorkbenches());
  next.set(xmWorkbenchKey(instSlot1Based, sampleIdx), wb);
  setXmWorkbenchesRaw(next);
}

export function clearXmWorkbench(
  instSlot1Based: number,
  sampleIdx: number,
): void {
  const key = xmWorkbenchKey(instSlot1Based, sampleIdx);
  if (!xmWorkbenches().has(key)) return;
  const next = new Map(xmWorkbenches());
  next.delete(key);
  setXmWorkbenchesRaw(next);
}

export function clearAllXmWorkbenches(): void {
  if (xmWorkbenches().size === 0) return;
  setXmWorkbenchesRaw(new Map());
}

export function withXmWorkbench(
  map: XmWorkbenchMap,
  instSlot1Based: number,
  sampleIdx: number,
  wb: XmSampleWorkbench,
): XmWorkbenchMap {
  const next = new Map(map);
  next.set(xmWorkbenchKey(instSlot1Based, sampleIdx), wb);
  return next;
}

export function withoutXmWorkbench(
  map: XmWorkbenchMap,
  instSlot1Based: number,
  sampleIdx: number,
): XmWorkbenchMap {
  const key = xmWorkbenchKey(instSlot1Based, sampleIdx);
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

export { xmWorkbenches, setXmWorkbenchesRaw };
