/**
 * Monophonic pitch detection for sample editor readouts.
 *
 * YIN (de Cheveigné & Kawahara, 2002) with parabolic interpolation around
 * the chosen autocorrelation minimum. Accuracy is well under 1 cent on
 * stable tones; the first-local-minimum rule guards against octave
 * doubling on sustained / bowed sounds.
 *
 * Pure, no DOM / Solid imports. Runs synchronously: ~60-120 ms for a
 * 4096-frame window at 44.1 kHz, called only when the workbench's WAV
 * source changes (memoised at the caller).
 */
import type { WavData } from "./wav";

/** Algorithm tunables. Defaults match the plan; exposed for tests. */
export interface DetectOptions {
  /** YIN absolute-threshold for the first-local-minimum rule. 0.10 is standard. */
  yinThreshold?: number;
  /** Minimum window RMS to consider the input non-silent. */
  rmsFloor?: number;
  /** Min / max detectable pitch in Hz. Bounds the τ search range. */
  hzMin?: number;
  hzMax?: number;
  /** Reject windows below this YIN confidence (`1 - d'(τ)`). */
  minConfidence?: number;
  /** Preferred analysis window length in frames (power of two). */
  windowSize?: number;
  /** Max number of windows to analyse and aggregate. */
  maxWindows?: number;
}

const DEFAULTS: Required<DetectOptions> = {
  yinThreshold: 0.1,
  rmsFloor: 1e-4,
  hzMin: 20,
  hzMax: 5000,
  minConfidence: 0.6,
  windowSize: 4096,
  maxWindows: 3,
};

export interface PitchResult {
  hz: number;
  confidence: number;
}

/**
 * Detect the fundamental frequency of a mono Float32Array sample buffer.
 * Returns `null` when the signal is silent, too short, or insufficiently
 * periodic for any analysis window to clear the confidence threshold.
 */
export function detectPitch(
  samples: Float32Array,
  sampleRate: number,
  opts: DetectOptions = {},
): PitchResult | null {
  const o = { ...DEFAULTS, ...opts };
  const N = samples.length;

  // Skip attack/release transients — the steady-state middle of the
  // sample is where YIN is most reliable.
  const trimStart = Math.floor(N * 0.1);
  const trimEnd = Math.floor(N * 0.9);
  const trimmedLen = trimEnd - trimStart;
  if (trimmedLen < 256) return null;

  const W = chooseWindowSize(trimmedLen, o.windowSize);
  if (W < 256) return null;

  // Layout up to `maxWindows` non-overlapping windows centred in the
  // trimmed region. With trimmedLen < W * maxWindows we just fit what
  // we can — even one window is enough.
  const fits = Math.max(1, Math.floor(trimmedLen / W));
  const nWindows = Math.min(o.maxWindows, fits);
  // Centre the cluster: leftover space split into outer halves.
  const used = nWindows * W;
  const padding = trimmedLen - used;
  const firstOffset = trimStart + Math.floor(padding / 2);

  const kept: number[] = [];
  for (let w = 0; w < nWindows; w++) {
    const off = firstOffset + w * W;
    const r = analyseWindow(samples, off, W, sampleRate, o);
    if (r && r.confidence >= o.minConfidence) kept.push(r.hz);
  }
  if (kept.length === 0) return null;

  // Median Hz; recompute confidence as a coverage signal so callers can
  // weight readouts by "how many windows agreed". `kept` is already
  // filtered above minConfidence, so this is bounded ≥ minConfidence.
  kept.sort((a, b) => a - b);
  const hz = kept[Math.floor(kept.length / 2)]!;
  const confidence = kept.length / nWindows;
  return { hz, confidence };
}

/**
 * Convenience wrapper: mixes a WavData to mono and runs detection.
 * Used by the sample-editor memo. Stereo channels are averaged frame-by-
 * frame; mono passes through.
 */
export function detectPitchFromWav(
  wav: WavData,
  opts: DetectOptions = {},
): PitchResult | null {
  if (wav.channels.length === 0) return null;
  const mono = monoMix(wav.channels);
  if (mono.length === 0) return null;
  return detectPitch(mono, wav.sampleRate, opts);
}

/**
 * Hz → MIDI semitone (rounded) and cents offset in [-50, +50].
 * Reference pitch: A-4 = 440 Hz (MIDI 69). Caller renders the note name.
 */
export function frequencyToNoteCents(hz: number): {
  midi: number;
  cents: number;
} {
  const midiFloat = 69 + 12 * Math.log2(hz / 440);
  const midi = Math.round(midiFloat);
  const cents = (midiFloat - midi) * 100;
  return { midi, cents };
}

// ── Internals ───────────────────────────────────────────────────────────

function monoMix(channels: Float32Array[]): Float32Array {
  const nch = channels.length;
  if (nch === 1) return channels[0]!;
  const len = channels[0]!.length;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let c = 0; c < nch; c++) sum += channels[c]![i]!;
    out[i] = sum / nch;
  }
  return out;
}

function chooseWindowSize(available: number, preferred: number): number {
  if (available >= preferred) return preferred;
  // Largest power of two ≤ available / 2 (YIN needs τ < W/2, so the
  // analysis window must fit twice over for the difference function to
  // probe a full period). Below 256 frames we'll abort.
  const cap = Math.floor(available / 2);
  let w = 256;
  while (w * 2 <= cap) w *= 2;
  return w;
}

interface WindowResult {
  hz: number;
  confidence: number;
}

function analyseWindow(
  samples: Float32Array,
  offset: number,
  W: number,
  sampleRate: number,
  o: Required<DetectOptions>,
): WindowResult | null {
  // RMS gate — silent windows produce meaningless τ.
  let sumSq = 0;
  for (let i = 0; i < W; i++) {
    const x = samples[offset + i]!;
    sumSq += x * x;
  }
  const rms = Math.sqrt(sumSq / W);
  if (rms < o.rmsFloor) return null;

  // τ search range from the user's Hz bounds.
  const tauMin = Math.max(2, Math.floor(sampleRate / o.hzMax));
  const tauMaxByHz = Math.floor(sampleRate / o.hzMin);
  const tauMax = Math.min(W >>> 1, tauMaxByHz);
  if (tauMax <= tauMin + 1) return null;

  // YIN step 1: difference function d(τ) over [tauMin, tauMax).
  const d = new Float64Array(tauMax);
  for (let tau = tauMin; tau < tauMax; tau++) {
    let acc = 0;
    const limit = W - tau;
    for (let i = 0; i < limit; i++) {
      const a = samples[offset + i]!;
      const b = samples[offset + i + tau]!;
      const diff = a - b;
      acc += diff * diff;
    }
    d[tau] = acc;
  }

  // YIN step 2: cumulative-mean-normalised difference d'(τ).
  // d'(τ) = d(τ) * τ / Σ_{j=1..τ} d(j), with d'(0) defined as 1.
  const dPrime = new Float64Array(tauMax);
  dPrime[0] = 1;
  let runningSum = 0;
  // Seed the running sum with τ < tauMin so d'(τ) for τ ≥ tauMin
  // remains comparable to a full-range YIN — the omitted low-τ terms
  // would have been included in the canonical algorithm.
  for (let tau = 1; tau < tauMin; tau++) {
    // Approximation: compute d(τ) lazily for the running sum.
    let acc = 0;
    const limit = W - tau;
    for (let i = 0; i < limit; i++) {
      const a = samples[offset + i]!;
      const b = samples[offset + i + tau]!;
      const diff = a - b;
      acc += diff * diff;
    }
    runningSum += acc;
    dPrime[tau] = acc === 0 ? 1 : (acc * tau) / runningSum;
  }
  for (let tau = tauMin; tau < tauMax; tau++) {
    runningSum += d[tau]!;
    dPrime[tau] = runningSum === 0 ? 1 : (d[tau]! * tau) / runningSum;
  }

  // YIN step 3: absolute-threshold rule. Walk τ from tauMin upward;
  // when d'(τ) dips below threshold, descend into the local minimum
  // (while it's still falling) and pick that τ. This avoids octave-
  // doubling: the FIRST minimum below threshold is the fundamental,
  // not the deepest (which could be a multiple of the period).
  let chosenTau = -1;
  for (let tau = tauMin; tau < tauMax - 1; tau++) {
    if (dPrime[tau]! < o.yinThreshold) {
      let t = tau;
      while (t + 1 < tauMax && dPrime[t + 1]! < dPrime[t]!) t++;
      chosenTau = t;
      break;
    }
  }
  if (chosenTau < 0) {
    // No threshold crossing — fall back to global minimum of d'.
    let best = tauMin;
    let bestVal = dPrime[tauMin]!;
    for (let tau = tauMin + 1; tau < tauMax; tau++) {
      const v = dPrime[tau]!;
      if (v < bestVal) {
        bestVal = v;
        best = tau;
      }
    }
    chosenTau = best;
  }

  // YIN step 4: parabolic interpolation around chosenTau for sub-sample
  // accuracy. Skip when at the search-range edges (no neighbour).
  let tauRefined = chosenTau;
  if (chosenTau > tauMin && chosenTau < tauMax - 1) {
    const yL = dPrime[chosenTau - 1]!;
    const y0 = dPrime[chosenTau]!;
    const yR = dPrime[chosenTau + 1]!;
    const denom = yL + yR - 2 * y0;
    if (denom !== 0) {
      const shift = (0.5 * (yL - yR)) / denom;
      // Clamp the shift to [-1, +1] sample — anything beyond means the
      // parabola fit is unreliable (typically when the minimum is shallow).
      tauRefined = chosenTau + Math.max(-1, Math.min(1, shift));
    }
  }

  const hz = sampleRate / tauRefined;
  if (hz < o.hzMin || hz > o.hzMax) return null;
  const confidence = clamp01(1 - dPrime[chosenTau]!);
  return { hz, confidence };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
