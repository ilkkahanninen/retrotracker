import { createSignal, type Accessor, type Setter } from "solid-js";

export interface RangedSignal {
  sig: Accessor<number>;
  set: Setter<number>;
  inc: () => void;
  dec: () => void;
  selectClamped: (n: number) => void;
}

export function createRangedSignal(opts: {
  min: number;
  max: number;
  initial: number;
}): RangedSignal {
  const [sig, set] = createSignal<number>(opts.initial);
  const clamp = (n: number) => Math.max(opts.min, Math.min(opts.max, n));
  return {
    sig,
    set,
    inc: () => set((v) => Math.min(opts.max, v + 1)),
    dec: () => set((v) => Math.max(opts.min, v - 1)),
    selectClamped: (n: number) => set(clamp(n)),
  };
}
