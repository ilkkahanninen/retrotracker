/**
 * Pure helpers for editing envelope point lists on chain nodes.
 * Format-agnostic — used by both PT2's sampleEdit and FT2's xmSampleEdit
 * so the two pipelines share the same clamp / normalise / dispatch
 * rules.
 */

import {
  PARAM_AXES,
  type EffectNode,
  type EnvelopeParamKey,
  type EnvelopePoint,
} from "./sampleWorkbench";

/** Clamp `v` into the param's value axis (e.g. volume is 0..2). */
export function clampValueForParam(v: number, param: EnvelopeParamKey): number {
  const axis = PARAM_AXES[param];
  return Math.max(axis.min, Math.min(axis.max, v));
}

/** Snap a frame index to a non-negative integer. */
export function clampFrame(f: number): number {
  return Math.max(0, Math.floor(f));
}

/**
 * Sort by frame, snap to integers, clamp value to the param's axis,
 * dedupe identical-frame points (keep the last one written so a drag
 * landing on top of an existing point overwrites it).
 */
export function normaliseEnvelope(
  points: ReadonlyArray<EnvelopePoint>,
  param: EnvelopeParamKey,
): EnvelopePoint[] {
  const cleaned = points.map((p) => ({
    frame: clampFrame(p.frame),
    value: clampValueForParam(p.value, param),
  }));
  cleaned.sort((a, b) => a.frame - b.frame);
  const out: EnvelopePoint[] = [];
  for (const p of cleaned) {
    const prev = out[out.length - 1];
    if (prev && prev.frame === p.frame) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * Pull the envelope addressed by `param` out of `node`, or null when
 * the combination doesn't refer to a real envelope. Returns a fresh
 * array — callers mutate it freely.
 */
export function extractEnvelopeFromNode(
  node: EffectNode,
  param: EnvelopeParamKey,
): EnvelopePoint[] | null {
  if (param === "volume" && node.kind === "volume") {
    return [...node.params.points];
  }
  if (param === "cutoff" && node.kind === "filter") {
    return [...node.params.cutoff];
  }
  if (param === "q" && node.kind === "filter") {
    return [...node.params.q];
  }
  if (param === "amount" && node.kind === "shaper") {
    return [...node.params.amount];
  }
  if (param === "pitch" && node.kind === "pitch") {
    return [...node.params.envelope];
  }
  return null;
}

/**
 * Build a new chain node with `param`'s envelope replaced by `points`.
 * Returns null when the (kind, param) combination is invalid.
 */
export function nodeWithEnvelope(
  node: EffectNode,
  param: EnvelopeParamKey,
  points: EnvelopePoint[],
): EffectNode | null {
  if (param === "volume" && node.kind === "volume") {
    return { ...node, kind: "volume", params: { points } };
  }
  if (param === "cutoff" && node.kind === "filter") {
    return {
      ...node,
      kind: "filter",
      params: { ...node.params, cutoff: points },
    };
  }
  if (param === "q" && node.kind === "filter") {
    return { ...node, kind: "filter", params: { ...node.params, q: points } };
  }
  if (param === "amount" && node.kind === "shaper") {
    return {
      ...node,
      kind: "shaper",
      params: { ...node.params, amount: points },
    };
  }
  if (param === "pitch" && node.kind === "pitch") {
    return { ...node, kind: "pitch", params: { envelope: points } };
  }
  return null;
}
