import {
  ENVELOPE_MIN_POINTS,
  type EffectKind,
  type EffectNode,
  type EnvelopeParamKey,
  type EnvelopePoint,
  type SampleSource,
} from "../core/audio/sampleWorkbench";
import {
  clampFrame,
  clampValueForParam,
  extractEnvelopeFromNode,
  nodeWithEnvelope,
  normaliseEnvelope,
} from "../core/audio/envelopeOps";

export interface WorkbenchShape {
  chain: EffectNode[];
  source: SampleSource;
}

export interface PipelineHost<W extends WorkbenchShape> {
  getWorkbench: () => W | null;
  setWorkbench: (next: W) => void;
  setSelectedIndex: (n: number | null) => void;
  setSelectedParam: (p: EnvelopeParamKey | null) => void;
  defaultParamForKind: (k: EffectKind) => EnvelopeParamKey | null;
}

export function makePipelineActions<W extends WorkbenchShape>(
  host: PipelineHost<W>,
) {
  function appendEffect(node: EffectNode): void {
    const wb = host.getWorkbench();
    if (!wb) return;
    const newIndex = wb.chain.length;
    host.setWorkbench({ ...wb, chain: [...wb.chain, node] });
    host.setSelectedIndex(newIndex);
    host.setSelectedParam(host.defaultParamForKind(node.kind));
  }

  function removeEffect(index: number): void {
    const wb = host.getWorkbench();
    if (!wb) return;
    if (index < 0 || index >= wb.chain.length) return;
    // Why: indices shift after a removal — clearing the selection is the
    // simplest correct policy.
    host.setSelectedIndex(null);
    host.setSelectedParam(null);
    host.setWorkbench({
      ...wb,
      chain: wb.chain.filter((_, i) => i !== index),
    });
  }

  function moveEffect(index: number, delta: -1 | 1): void {
    const wb = host.getWorkbench();
    if (!wb) return;
    const target = index + delta;
    if (target < 0 || target >= wb.chain.length) return;
    const chain = [...wb.chain];
    [chain[index], chain[target]] = [chain[target]!, chain[index]!];
    host.setSelectedIndex(null);
    host.setSelectedParam(null);
    host.setWorkbench({ ...wb, chain });
  }

  function patchEffect(index: number, next: EffectNode): void {
    const wb = host.getWorkbench();
    if (!wb) return;
    if (index < 0 || index >= wb.chain.length) return;
    const chain = wb.chain.map((n, i) => (i === index ? next : n));
    host.setWorkbench({ ...wb, chain });
  }

  function setEffectBypass(index: number, bypassed: boolean): void {
    const wb = host.getWorkbench();
    if (!wb) return;
    const node = wb.chain[index];
    if (!node) return;
    // Why: drop the field entirely when re-enabling so a reset effect
    // serialises bit-identical to its pre-bypass form.
    const next: EffectNode = bypassed
      ? { ...node, bypassed: true }
      : (() => {
          const { bypassed: _drop, ...rest } = node;
          void _drop;
          return rest as EffectNode;
        })();
    patchEffect(index, next);
  }

  function envelopeAt(
    index: number,
    param: EnvelopeParamKey,
  ): EnvelopePoint[] | null {
    const wb = host.getWorkbench();
    if (!wb) return null;
    const node = wb.chain[index];
    if (!node) return null;
    return extractEnvelopeFromNode(node, param);
  }

  function commitEnvelope(
    index: number,
    param: EnvelopeParamKey,
    points: EnvelopePoint[],
  ): void {
    if (points.length < ENVELOPE_MIN_POINTS) return;
    const wb = host.getWorkbench();
    if (!wb) return;
    const node = wb.chain[index];
    if (!node) return;
    const next = nodeWithEnvelope(node, param, points);
    if (!next) return;
    patchEffect(index, next);
  }

  function addEnvelopePoint(
    index: number,
    param: EnvelopeParamKey,
    point: EnvelopePoint,
  ): void {
    const points = envelopeAt(index, param);
    if (!points) return;
    commitEnvelope(index, param, normaliseEnvelope([...points, point], param));
  }

  function removeEnvelopePoint(
    index: number,
    param: EnvelopeParamKey,
    pointIndex: number,
  ): void {
    const points = envelopeAt(index, param);
    if (!points) return;
    if (points.length <= ENVELOPE_MIN_POINTS) return;
    if (pointIndex < 0 || pointIndex >= points.length) return;
    const next = points.filter((_, i) => i !== pointIndex);
    commitEnvelope(index, param, normaliseEnvelope(next, param));
  }

  function patchEnvelopePoint(
    index: number,
    param: EnvelopeParamKey,
    pointIndex: number,
    next: Partial<EnvelopePoint>,
  ): void {
    const points = envelopeAt(index, param);
    if (!points) return;
    if (pointIndex < 0 || pointIndex >= points.length) return;
    const cur = points[pointIndex]!;
    points[pointIndex] = {
      frame: next.frame !== undefined ? clampFrame(next.frame) : cur.frame,
      value:
        next.value !== undefined
          ? clampValueForParam(next.value, param)
          : cur.value,
    };
    commitEnvelope(index, param, normaliseEnvelope(points, param));
  }

  function nudgeEnvelopeSegment(
    index: number,
    param: EnvelopeParamKey,
    leftPointIndex: number,
    deltaValue: number,
  ): void {
    const points = envelopeAt(index, param);
    if (!points) return;
    if (leftPointIndex < 0 || leftPointIndex >= points.length - 1) return;
    const a = points[leftPointIndex]!;
    const b = points[leftPointIndex + 1]!;
    points[leftPointIndex] = {
      frame: a.frame,
      value: clampValueForParam(a.value + deltaValue, param),
    };
    points[leftPointIndex + 1] = {
      frame: b.frame,
      value: clampValueForParam(b.value + deltaValue, param),
    };
    commitEnvelope(index, param, normaliseEnvelope(points, param));
  }

  return {
    appendEffect,
    removeEffect,
    moveEffect,
    patchEffect,
    setEffectBypass,
    addEnvelopePoint,
    removeEnvelopePoint,
    patchEnvelopePoint,
    nudgeEnvelopeSegment,
  };
}
