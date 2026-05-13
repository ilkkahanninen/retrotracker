import { createSignal, type Accessor, type Setter } from "solid-js";

export interface Range {
  start: number;
  end: number;
}

export function createSampleSelectionSignal(): {
  signal: Accessor<Range | null>;
  set: Setter<Range | null>;
  clear: () => void;
} {
  const [signal, set] = createSignal<Range | null>(null);
  return {
    signal,
    set,
    clear: () => set(null),
  };
}
