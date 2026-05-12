import { Index, Show, createMemo, type Component } from "solid-js";

import {
  EFFECT_LABELS,
  materializeSource,
  sourceDisplayName,
  type EffectKind,
  type EffectNode,
  type EnvelopeParamKey,
  type MonoMix,
  type XmSampleWorkbench,
} from "../core/audio/sampleWorkbench";
import { EffectParams } from "./PipelineEditor";

export interface XmPipelineEditorProps {
  wb: XmSampleWorkbench;
  onRemoveEffect: (index: number) => void;
  onMoveEffect: (index: number, delta: -1 | 1) => void;
  onPatchEffect: (index: number, next: EffectNode) => void;
  onSetEffectBypass: (index: number, bypassed: boolean) => void;
  onApplyChain: () => void;
  onSetMonoMix: (monoMix: MonoMix) => void;
  onSetBitDepth: (bits: 8 | 16) => void;
  onSetDither: (dither: boolean) => void;
  selectedEffectIndex: number | null;
  onSelectEffect: (index: number | null) => void;
  selectedEffectParam: EnvelopeParamKey | null;
  onSelectParam: (param: EnvelopeParamKey) => void;
}

/**
 * FT2 sibling of `PipelineEditor`. Reuses the chain UI idiom (source
 * header, ordered list of effect entries with move / bypass / remove,
 * per-effect parameter editing via `EffectParams`) and adds the
 * XM-specific terminal panel: mono mix, output bit depth (8 / 16), and
 * dither. No target-note / resample mode — XM stores playback rate via
 * finetune + relativeNote, so the terminal doesn't resample.
 */
export const XmPipelineEditor: Component<XmPipelineEditorProps> = (props) => {
  const materialised = createMemo(() => materializeSource(props.wb.source));
  const channels = () => materialised().channels.length;
  const sourceFrames = () => materialised().channels[0]?.length ?? 0;

  return (
    <section class="pipeline">
      <header class="pipeline__header">
        <span class="pipeline__source">
          {sourceDisplayName(props.wb.source)} · {materialised().sampleRate} Hz
          ·{" "}
          {channels() === 1
            ? "mono"
            : channels() === 2
              ? "stereo"
              : `${channels()} ch`}{" "}
          · {sourceFrames()} frames
        </span>
      </header>
      <ol class="pipeline__chain">
        <Index each={props.wb.chain}>
          {(node, i) => {
            const isSelected = () => props.selectedEffectIndex === i;
            const isBypassed = () => node().bypassed === true;
            return (
              <li
                class="effect-node"
                classList={{
                  "effect-node--selected": isSelected(),
                  "effect-node--bypassed": isBypassed(),
                }}
                aria-current={isSelected() ? "true" : undefined}
                onClick={() => props.onSelectEffect(isSelected() ? null : i)}
              >
                <div class="effect-node__controls">
                  <button
                    type="button"
                    title={isBypassed() ? "Enable effect" : "Bypass effect"}
                    aria-pressed={isBypassed() ? "true" : "false"}
                    classList={{
                      "effect-node__bypass": true,
                      "effect-node__bypass--on": isBypassed(),
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onSetEffectBypass(i, !isBypassed());
                    }}
                  >
                    ⏻
                  </button>
                  <button
                    type="button"
                    title="Move up"
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onMoveEffect(i, -1);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    disabled={i === props.wb.chain.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onMoveEffect(i, 1);
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    title="Remove effect"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onRemoveEffect(i);
                    }}
                  >
                    ×
                  </button>
                </div>
                <div class="effect-node__body">
                  <span class="effect-node__kind">
                    {EFFECT_LABELS[node().kind]}
                  </span>
                  <EffectParams
                    node={node()}
                    sourceFrames={sourceFrames()}
                    onPatch={(next) => props.onPatchEffect(i, next)}
                    selectedParam={
                      isSelected() ? props.selectedEffectParam : null
                    }
                    onSelectParam={(param) => {
                      if (!isSelected()) props.onSelectEffect(i);
                      props.onSelectParam(param);
                    }}
                  />
                </div>
              </li>
            );
          }}
        </Index>
      </ol>
      <Show when={props.wb.chain.length > 0}>
        <div class="pipeline__chain-actions">
          <button
            type="button"
            onClick={() => props.onApplyChain()}
            title="Burn the chain into the source and clear it."
          >
            Apply changes
          </button>
        </div>
      </Show>
      <div class="pipeline__transformer">
        <Show when={channels() > 1}>
          <label>
            <span class="samplemeta__label">Mono mix</span>
            <select
              aria-label="Mono mix"
              value={props.wb.xm.monoMix}
              onChange={(e) =>
                props.onSetMonoMix(e.currentTarget.value as MonoMix)
              }
            >
              <option value="average">Average channels</option>
              <option value="left">Left only</option>
              <option value="right">Right only</option>
            </select>
          </label>
        </Show>
        <label>
          <span class="samplemeta__label">Bit depth</span>
          <select
            aria-label="Bit depth"
            value={String(props.wb.xm.bitDepth)}
            onChange={(e) =>
              props.onSetBitDepth(e.currentTarget.value === "16" ? 16 : 8)
            }
          >
            <option value="8">8-bit</option>
            <option value="16">16-bit</option>
          </select>
        </label>
        <label>
          <span class="samplemeta__label">Dither</span>
          <span class="samplemeta__check">
            <input
              type="checkbox"
              aria-label="Dither"
              checked={props.wb.xm.dither === true}
              onChange={(e) => props.onSetDither(e.currentTarget.checked)}
            />
            <span>Enabled</span>
          </span>
        </label>
      </div>
    </section>
  );
};
