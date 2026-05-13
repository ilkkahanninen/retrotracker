import { createSignal } from "solid-js";
import type { SampleWorkbench } from "../core/audio/sampleWorkbench";

export type WorkbenchMap = Map<number, SampleWorkbench>;

// Why: signal of a fresh Map per write so component memos re-render —
// Solid doesn't deeply track Map mutations. setWorkbenchesRaw is consumed by
// state/song.ts's history snapshot.
const [workbenches, setWorkbenchesRaw] = createSignal<WorkbenchMap>(new Map());

export function getWorkbench(slot: number): SampleWorkbench | undefined {
  return workbenches().get(slot);
}

export function setWorkbench(slot: number, wb: SampleWorkbench): void {
  const next = new Map(workbenches());
  next.set(slot, wb);
  setWorkbenchesRaw(next);
}

export function clearWorkbench(slot: number): void {
  if (!workbenches().has(slot)) return;
  const next = new Map(workbenches());
  next.delete(slot);
  setWorkbenchesRaw(next);
}

export function clearAllWorkbenches(): void {
  if (workbenches().size === 0) return;
  setWorkbenchesRaw(new Map());
}

export function withWorkbench(
  map: WorkbenchMap,
  slot: number,
  wb: SampleWorkbench,
): WorkbenchMap {
  const next = new Map(map);
  next.set(slot, wb);
  return next;
}

export function withoutWorkbench(
  map: WorkbenchMap,
  slot: number,
): WorkbenchMap {
  if (!map.has(slot)) return map;
  const next = new Map(map);
  next.delete(slot);
  return next;
}

export { workbenches, setWorkbenchesRaw };
