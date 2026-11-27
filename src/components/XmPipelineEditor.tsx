import {
  For,
  Index,
  Show,
  createMemo,
  createSignal,
  type Component,
} from "solid-js";

import {
  EFFECT_LABELS,
  materializeSource,
  sourceDisplayName,
  type EffectKind,
  type EffectNode,
  type EnvelopeParamKey,
  type MonoMix,
  type ResampleMode,
  type XmPlayingLength,
  type XmSampleWorkbench,
  RESAMPLE_LABELS,
  RESAMPLE_MODES,
  XM_DEFAULT_RESAMPLE_MODE,
} from "../core/audio/sampleWorkbench";
import { XM_DEFAULT_BPM } from "../core/xm/format";
import { XM_MAX_BPM, XM_MIN_BPM } from "../core/xm/types";
import { EffectParams } from "./PipelineEditor";
import { PlayLengthCalculator } from "./PlayLengthCalculator";
import { Icon } from "./Icon";
import { ArrowDown, ArrowUp, Power, X } from "./icons";

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
  /** Set or clear (null) the length fit. */
  onSetPlayingLength: (length: XmPlayingLength | null) => void;
  onSetResampleMode: (mode: ResampleMode) => void;
  /** Speed / tempo in effect at the pattern cursor — pre-fills the
   *  calculator. A function, read when the dialog opens: working it out
   *  walks the song, which is too much to redo on every cursor move. */
  speedTempoAtCursor: () => { speed: number; tempo: number };
  selectedEffectIndex: number | null;
  onSelectEffect: (index: number | null) => void;
  selectedEffectParam: EnvelopeParamKey | null;
  onSelectParam: (param: EnvelopeParamKey) => void;
}

/**
 * FT2 sibling of `PipelineEditor`. Reuses the chain UI idiom (source
 * header, ordered list of effect entries with move / bypass / remove,
 * per-effect parameter editing via `EffectParams`) and adds the
 * XM-specific terminal panel: mono mix, output bit depth (8 / 16),
 * dither and the length fit. No target note — XM stores playback rate
 * via finetune + relativeNote, so the terminal only resamples when a fit
 * asks for an exact length (the drum-loop helper, PT's "Length (ticks)").
 */
export const XmPipelineEditor: Component<XmPipelineEditorProps> = (props) => {
  const materialised = createMemo(() => materializeSource(props.wb.source));
  const channels = () => materialised().channels.length;
  const sourceFrames = () => materialised().channels[0]?.length ?? 0;
  const [calc, setCalc] = createSignal<{
    speed: number;
    tempo: number;
  } | null>(null);
  const fit = () => props.wb.xm.playingLength ?? null;

  /** Commit the Ticks / BPM pair. An empty or zero Ticks field clears
   *  the fit; BPM falls back to the fit's own, then the format default. */
  const commitFit = (ticksRaw: string, bpmRaw: string) => {
    const ticks = Math.floor(Number(ticksRaw));
    if (ticksRaw.trim() === "" || !Number.isFinite(ticks) || ticks <= 0) {
      props.onSetPlayingLength(null);
      return;
    }
    const bpmNum = Math.floor(Number(bpmRaw));
    const bpm =
      bpmRaw.trim() !== "" && Number.isFinite(bpmNum)
        ? Math.max(XM_MIN_BPM, Math.min(XM_MAX_BPM, bpmNum))
        : (fit()?.bpm ?? XM_DEFAULT_BPM);
    props.onSetPlayingLength({ ticks, bpm });
  };
  let ticksInput: HTMLInputElement | undefined;
  let bpmInput: HTMLInputElement | undefined;
  const commitFitFromInputs = () =>
    commitFit(ticksInput?.value ?? "", bpmInput?.value ?? "");

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
                    aria-label={
                      isBypassed()
                        ? `Enable effect ${i + 1}`
                        : `Bypass effect ${i + 1}`
                    }
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
                    <Icon of={Power} />
                  </button>
                  <button
                    type="button"
                    title="Move up"
                    aria-label={`Move effect ${i + 1} up`}
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onMoveEffect(i, -1);
                    }}
                  >
                    <Icon of={ArrowUp} />
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    aria-label={`Move effect ${i + 1} down`}
                    disabled={i === props.wb.chain.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onMoveEffect(i, 1);
                    }}
                  >
                    <Icon of={ArrowDown} />
                  </button>
                  <button
                    type="button"
                    title="Remove effect"
                    aria-label={`Remove effect ${i + 1}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onRemoveEffect(i);
                    }}
                  >
                    <Icon of={X} />
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
        {/* Fit length — drum-loop helper. Resamples the sample so it
            plays for exactly this many song ticks at this tempo when
            triggered at C-4. Empty = off. */}
        <label>
          <span class="samplemeta__label">Fit length</span>
          <span class="pipeline__length-row">
            <input
              ref={ticksInput}
              type="number"
              min="0"
              step="1"
              aria-label="Fit length in ticks"
              title="Length in song ticks (rows × speed) the sample should play for at C-4. Empty / 0 = off."
              placeholder="(off)"
              value={fit()?.ticks ?? ""}
              onChange={commitFitFromInputs}
            />
            <span class="pipeline__length-unit">ticks at</span>
            <input
              ref={bpmInput}
              type="number"
              min={XM_MIN_BPM}
              max={XM_MAX_BPM}
              step="1"
              aria-label="Fit length tempo in BPM"
              title="Tempo the tick count is measured at"
              value={fit()?.bpm ?? XM_DEFAULT_BPM}
              onChange={commitFitFromInputs}
            />
            <span class="pipeline__length-unit">BPM</span>
            <button
              type="button"
              onClick={() => setCalc(props.speedTempoAtCursor())}
              title="Work out the ticks from rows / speed / tempo"
            >
              Calc
            </button>
          </span>
        </label>
        {/* Resampler picker — only the fit resamples, so it is hidden
            until one is set. */}
        <Show when={fit()}>
          <label>
            <span class="samplemeta__label">Resample</span>
            <select
              aria-label="Resample mode"
              value={props.wb.xm.resampleMode ?? XM_DEFAULT_RESAMPLE_MODE}
              onChange={(e) =>
                props.onSetResampleMode(e.currentTarget.value as ResampleMode)
              }
            >
              <For each={RESAMPLE_MODES}>
                {(m) => <option value={m}>{RESAMPLE_LABELS[m]}</option>}
              </For>
            </select>
          </label>
        </Show>
      </div>
      <Show when={calc()}>
        {(seed) => (
          <PlayLengthCalculator
            unit="xm"
            initialSpeed={seed().speed}
            initialTempo={seed().tempo}
            onApply={(r) => props.onSetPlayingLength(r)}
            onClose={() => setCalc(null)}
          />
        )}
      </Show>
    </section>
  );
};
