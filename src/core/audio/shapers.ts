/**
 * Single-parameter waveshapers — pure float-in / float-out functions used
 * by the chiptune synth's end-of-pipeline shaper stage and (later) by a
 * sampler effect node. Keeping the modes / labels / `applyShaper` here
 * means both consumers share one source of truth: adding a mode shows up
 * in the chiptune editor and the sampler chain at the same time.
 *
 * Each mode honours the `amount=0 ⇒ bypass`, `amount=1 ⇒ full effect`
 * contract so a slider / LFO sweep across `amount` always feels
 * meaningful regardless of the selected mode. Outputs stay inside
 * [-1, 1] for any input the upstream stage produces.
 */

export type ShaperMode =
  | "none" // straight passthrough
  | "hardClip" // drive then clamp to ±1
  | "softClip" // tanh saturation, blended with input
  | "wavefold" // drive then triangle-fold back into ±1
  | "chebyshev" // continuous odd-order blend (T1→T3→T5→T7)
  | "bitcrush"; // quantise to 256→2 levels exponentially

export const SHAPER_MODES: readonly ShaperMode[] = [
  "none",
  "hardClip",
  "softClip",
  "wavefold",
  "chebyshev",
  "bitcrush",
] as const;

export const SHAPER_LABELS: Readonly<Record<ShaperMode, string>> = {
  none: "Off",
  hardClip: "Clip",
  softClip: "Soft",
  wavefold: "Fold",
  chebyshev: "Cheby",
  bitcrush: "Crush",
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Apply the selected shaper. `amount` is normalised in [0, 1]:
 * 0 ⇒ bypass, 1 ⇒ maximum effect. Pure / stateless / per-sample.
 */
export function applyShaper(
  x: number,
  mode: ShaperMode,
  amount: number,
): number {
  if (mode === "none") return x;
  const a = clamp(amount, 0, 1);
  switch (mode) {
    case "hardClip": {
      // Drive 1×→9× into a hard clipper. At a=0 the drive is 1 so any
      // |x|≤1 passes through unchanged — clean bypass without a special-case.
      const drive = 1 + a * 8;
      return clamp(x * drive, -1, 1);
    }
    case "softClip": {
      // tanh saturation, blended with the dry signal so a=0 is a literal
      // pass-through. Drive is fixed; the wet/dry blend covers the
      // amount range so the slider feels linear.
      const drive = 5;
      const sat = Math.tanh(drive * x) / Math.tanh(drive);
      return (1 - a) * x + a * sat;
    }
    case "wavefold": {
      // Drive then triangle-fold back into [-1, 1]. The closed-form
      // triangle wrap (period 4 in the driven signal) handles arbitrary
      // drive in O(1) — much cleaner than iterating reflect-on-overflow.
      // y=0→0, y=±1→±1, y=±2→0, y=±3→∓1.
      const drive = 1 + a * 5;
      const y = x * drive;
      let t = (y + 1) / 4;
      t = t - Math.floor(t);
      return t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
    }
    case "chebyshev": {
      // Chebyshev polynomials of the first kind via the recurrence
      // T_n = 2x·T_{n-1} − T_{n-2}. Restricting to odd orders (T1, T3,
      // T5, T7) avoids DC build-up — odd polynomials map x=0 → 0 and
      // stay bounded in [-1, 1] for x ∈ [-1, 1]. amount sweeps the
      // blend continuously through the four orders.
      const T1 = x;
      const T2 = 2 * x * x - 1;
      const T3 = 2 * x * T2 - T1;
      const T4 = 2 * x * T3 - T2;
      const T5 = 2 * x * T4 - T3;
      const T6 = 2 * x * T5 - T4;
      const T7 = 2 * x * T6 - T5;
      const odds = [T1, T3, T5, T7] as const;
      const f = a * (odds.length - 1);
      const k = Math.min(odds.length - 2, Math.floor(f));
      const frac = f - k;
      return (1 - frac) * odds[k]! + frac * odds[k + 1]!;
    }
    case "bitcrush": {
      // Quantise to N levels evenly spaced in [-1, 1] (step = 2/(N-1)).
      // Exponential so the lower half of the slider gives audible (but
      // musical) crush without dropping straight to square-wave
      // territory. a=0 → 256 levels (effectively bypass under the int8
      // quantiser downstream); a=1 → 2 levels (pure ±1 square).
      const levels = Math.max(2, Math.round(Math.pow(2, 8 - 7 * a)));
      const step = 2 / (levels - 1);
      return clamp(Math.round((x + 1) / step) * step - 1, -1, 1);
    }
  }
}
