import type { SampleWorkbench } from "../core/audio/sampleWorkbench";
import { createWorkbenchStore } from "./workbenchStore";

export type WorkbenchMap = Map<number, SampleWorkbench>;

const store = createWorkbenchStore<number, SampleWorkbench>();

export const workbenches = store.signal;
export const setWorkbenchesRaw = store.setRaw;

export function getWorkbench(slot: number): SampleWorkbench | undefined {
  return store.get(slot);
}

export function setWorkbench(slot: number, wb: SampleWorkbench): void {
  store.set(slot, wb);
}

export function clearWorkbench(slot: number): void {
  store.clear(slot);
}

export function clearAllWorkbenches(): void {
  store.clearAll();
}

export function withWorkbench(
  map: WorkbenchMap,
  slot: number,
  wb: SampleWorkbench,
): WorkbenchMap {
  return store.withSet(map, slot, wb);
}

export function withoutWorkbench(
  map: WorkbenchMap,
  slot: number,
): WorkbenchMap {
  return store.withClear(map, slot);
}
