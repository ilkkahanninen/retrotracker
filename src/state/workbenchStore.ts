import { createSignal, type Accessor, type Setter } from "solid-js";

export interface WorkbenchStore<K, V> {
  signal: Accessor<Map<K, V>>;
  setRaw: Setter<Map<K, V>>;
  get(key: K): V | undefined;
  set(key: K, v: V): void;
  clear(key: K): void;
  clearAll(): void;
  withSet(map: Map<K, V>, key: K, v: V): Map<K, V>;
  withClear(map: Map<K, V>, key: K): Map<K, V>;
}

// Why: fresh Map per write so component memos re-render — Solid doesn't
// deeply track Map mutations. setRaw is consumed by song-history snapshot.
export function createWorkbenchStore<K, V>(): WorkbenchStore<K, V> {
  const [signal, setRaw] = createSignal<Map<K, V>>(new Map());

  return {
    signal,
    setRaw,
    get(key) {
      return signal().get(key);
    },
    set(key, v) {
      const next = new Map(signal());
      next.set(key, v);
      setRaw(next);
    },
    clear(key) {
      if (!signal().has(key)) return;
      const next = new Map(signal());
      next.delete(key);
      setRaw(next);
    },
    clearAll() {
      if (signal().size === 0) return;
      setRaw(new Map());
    },
    withSet(map, key, v) {
      const next = new Map(map);
      next.set(key, v);
      return next;
    },
    withClear(map, key) {
      if (!map.has(key)) return map;
      const next = new Map(map);
      next.delete(key);
      return next;
    },
  };
}
