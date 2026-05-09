import {
  For,
  Index,
  Match,
  Show,
  Switch,
  createMemo,
  type Component,
} from "solid-js";
import {
  DEFAULT_RESAMPLE_MODE,
  EFFECT_LABELS,
  FILTER_TYPE_LABELS,
  RESAMPLE_LABELS,
  RESAMPLE_MODES,
  materializeSource,
  sourceDisplayName,
  type EffectNode,
  type EnvelopeParamKey,
  type EnvelopePoint,
  type FilterType,
  type MonoMix,
  type ResampleMode,
  type SampleWorkbench,
} from "../core/audio/sampleWorkbench";
import {
  SHAPER_LABELS,
  SHAPER_MODES,
  type ShaperMode,
} from "../core/audio/shapers";
import { Slider } from "./Slider";

const NOTE_NAMES = [
  "C-",
  "C#",
  "D-",
  "D#",
  "E-",
  "F-",
  "F#",
  "G-",
  "G#",
  "A-",
  "A#",
  "B-",
] as const;
function noteIndexName(i: number): string {
  return `${NOTE_NAMES[i % 12]}${1 + Math.floor(i / 12)}`;
}

export interface PipelineEditorProps {
  wb: SampleWorkbench;
  onRemoveEffect: (index: number) => void;
  onMoveEffect: (index: number, delta: -1 | 1) => void;
  onPatchEffect: (index: number, next: EffectNode) => void;
  /** Toggle a chain entry's bypass flag — when bypassed the effect
   *  short-circuits to a pass-through but its params stay intact. */
  onSetEffectBypass: (index: number, bypassed: boolean) => void;
  /** Burn the chain into the source. See SampleView.Props.onApplyChain. */
  onApplyChain: () => void;
  onSetMonoMix: (monoMix: MonoMix) => void;
  onSetTargetNote: (targetNote: number | null) => void;
  onSetResampleMode: (mode: ResampleMode) => void;
  onSetDither: (dither: boolean) => void;
  /** Index of the chain entry whose visual editor (envelope overlay) is
   *  active, or null. */
  selectedEffectIndex: number | null;
  /** Click on a chain entry → select it as the active editor. Pass
   *  `null` to deselect. */
  onSelectEffect: (index: number | null) => void;
  /** Which envelope of the selected effect is currently being edited.
   *  null when no effect is selected or the kind has no envelope. */
  selectedEffectParam: EnvelopeParamKey | null;
  /** Switch which envelope the overlay edits — used by the Cutoff / Q
   *  toggle on filter chain entries. */
  onSelectParam: (param: EnvelopeParamKey) => void;
}

/** "3 points · 0.50..1.20" — compact one-liner for any envelope. The
 *  overlay on the waveform is the actual editor; this is just
 *  orientation in the chain panel. `format` lets us tag the value
 *  range with the param's unit (e.g. "Hz" for cutoff). */
function envelopeSummary(
  points: ReadonlyArray<EnvelopePoint>,
  format: (v: number) => string,
): string {
  if (points.length === 0) return "(empty)";
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    if (p.value < lo) lo = p.value;
    if (p.value > hi) hi = p.value;
  }
  const noun = points.length === 1 ? "point" : "points";
  return `${points.length} ${noun} · ${format(lo)}..${format(hi)}`;
}

const formatGain = (v: number): string => v.toFixed(2);
const formatHz = (v: number): string => `${Math.round(v)} Hz`;
const formatQ = (v: number): string => v.toFixed(2);
const formatAmount = (v: number): string => v.toFixed(2);
const formatSpeed = (v: number): string => `${v.toFixed(2)}×`;

export const PipelineEditor: Component<PipelineEditorProps> = (props) => {
  // The chain operates on the materialised source — for chiptune that's a
  // synth cycle, for sampler the loaded WAV. Read both off the same memo.
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
        {/* Index (not For) keys by position, so editing an effect's params
            updates the existing <li> instead of disposing and remounting it.
            Without this, a controlled <input> loses focus on every keystroke
            because the patch produces a new node object at the same index. */}
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
                    ⏻
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
                    ↑
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
                    ↓
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
                    // Clicking a param toggle (Cutoff / Q) on a chain
                    // entry that isn't yet selected has to also select
                    // the entry, otherwise the overlay won't render and
                    // the click looks broken.
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
      {/* Hide the row entirely when there's nothing to apply — a disabled
          button is just visual clutter when the chain is empty. */}
      <Show when={props.wb.chain.length > 0}>
        <div class="pipeline__chain-actions">
          <button
            type="button"
            onClick={() => props.onApplyChain()}
            title="Run the chain into the source and clear it. Useful after a Crop — the trimmed source shrinks the project file size, but playback stays identical."
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
              value={props.wb.pt.monoMix}
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
          <span class="samplemeta__label">Target note</span>
          <select
            aria-label="Target note"
            value={
              props.wb.pt.targetNote === null
                ? ""
                : String(props.wb.pt.targetNote)
            }
            onChange={(e) => {
              const v = e.currentTarget.value;
              props.onSetTargetNote(v === "" ? null : parseInt(v, 10));
            }}
          >
            <option value="">(none) — keep source rate</option>
            <For each={Array.from({ length: 36 }, (_, i) => i)}>
              {(i) => <option value={i}>{noteIndexName(i)}</option>}
            </For>
          </select>
        </label>
        {/* Resampler picker — only relevant when targetNote drives a rate
            conversion. Hidden when targetNote is null since there's no
            resample step to influence. */}
        <Show when={props.wb.pt.targetNote !== null}>
          <label>
            <span class="samplemeta__label">Resample</span>
            <select
              aria-label="Resample mode"
              value={props.wb.pt.resampleMode ?? DEFAULT_RESAMPLE_MODE}
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
        {/* TPDF dither at int8 quantisation. Always shown — quantisation runs
            on every export regardless of resample, so the toggle's effect
            doesn't depend on targetNote. Lays out like the Looping checkbox
            (caption above, checkbox + "Enabled" on one row). */}
        <label>
          <span class="samplemeta__label">Dither</span>
          <span class="samplemeta__check">
            <input
              type="checkbox"
              aria-label="Dither"
              checked={props.wb.pt.dither === true}
              onChange={(e) => props.onSetDither(e.currentTarget.checked)}
            />
            <span>Enabled</span>
          </span>
        </label>
      </div>
    </section>
  );
};

interface EffectParamsProps {
  node: EffectNode;
  sourceFrames: number;
  onPatch: (next: EffectNode) => void;
  /** Active envelope-param for this chain entry (drives toggle styling). */
  selectedParam: EnvelopeParamKey | null;
  /** Switch which envelope the waveform overlay edits. Click handler for
   *  the Cutoff / Q (filter) and Drive (shaper) toggles. */
  onSelectParam: (param: EnvelopeParamKey) => void;
}

/** Discriminated-union narrowing of the range-aware kinds. */
type RangeKind = "reverse" | "crop" | "cut";

const EffectParams: Component<EffectParamsProps> = (props) => {
  // Non-keyed Match (static children, no `(n) => ...` callback) so the
  // controlled <input>s aren't disposed every time the user types — focus
  // would otherwise jump on every keystroke. Each Match's `when` predicate
  // narrows the discriminated union, but TS can't see that across the
  // children boundary, so we re-narrow with typed accessors.
  const asVolume = () => props.node as Extract<EffectNode, { kind: "volume" }>;
  const asRange = () => props.node as Extract<EffectNode, { kind: RangeKind }>;
  const asFilter = () => props.node as Extract<EffectNode, { kind: "filter" }>;
  const asCrossfade = () =>
    props.node as Extract<EffectNode, { kind: "crossfade" }>;
  const asShaper = () => props.node as Extract<EffectNode, { kind: "shaper" }>;
  const asPitch = () => props.node as Extract<EffectNode, { kind: "pitch" }>;
  return (
    <Switch>
      <Match when={props.node.kind === "volume"}>
        <span class="effect-node__hint">
          {envelopeSummary(asVolume().params.points, formatGain)}
        </span>
      </Match>
      <Match when={props.node.kind === "pitch"}>
        <span class="effect-node__hint">
          speed {envelopeSummary(asPitch().params.envelope, formatSpeed)}
        </span>
      </Match>
      <Match when={props.node.kind === "normalize"}>
        <span class="effect-node__hint">Scales to peak ±1.0</span>
      </Match>
      <Match when={props.node.kind === "shaper"}>
        <label class="effect-node__param">
          <span class="samplemeta__label">Mode</span>
          <select
            value={asShaper().params.mode}
            onChange={(e) => {
              const node = asShaper();
              props.onPatch({
                kind: "shaper",
                params: {
                  mode: e.currentTarget.value as ShaperMode,
                  amount: node.params.amount,
                },
              });
            }}
          >
            {SHAPER_MODES.map((m) => (
              <option value={m}>{SHAPER_LABELS[m]}</option>
            ))}
          </select>
        </label>
        <span class="effect-node__hint">
          drive {envelopeSummary(asShaper().params.amount, formatAmount)}
        </span>
      </Match>
      <Match when={props.node.kind === "crossfade"}>
        <Slider
          label="Length (frames)"
          min={1}
          // Cap at half the source so the slider stays in a useful band —
          // applyCrossfade clamps to (loopStart, loopLength) anyway, so the
          // visible max only needs to be roughly the right ballpark.
          max={Math.max(1, Math.floor(props.sourceFrames / 2))}
          step={1}
          value={asCrossfade().params.length}
          snap={(v) => Math.max(1, Math.round(v))}
          format={(v) => `${Math.round(v)}`}
          onInput={(v) =>
            props.onPatch({
              kind: "crossfade",
              params: { length: Math.max(1, Math.round(v)) },
            })
          }
        />
      </Match>
      <Match when={props.node.kind === "filter"}>
        <label class="effect-node__param">
          <span class="samplemeta__label">Type</span>
          <select
            value={asFilter().params.type}
            onChange={(e) => {
              const node = asFilter();
              props.onPatch({
                kind: "filter",
                params: {
                  type: e.currentTarget.value as FilterType,
                  cutoff: node.params.cutoff,
                  q: node.params.q,
                },
              });
            }}
          >
            <option value="lowpass">{FILTER_TYPE_LABELS.lowpass}</option>
            <option value="highpass">{FILTER_TYPE_LABELS.highpass}</option>
          </select>
        </label>
        {/* Cutoff and Q are envelopes — the actual editor lives on the
            waveform overlay. These two buttons pick which curve the
            overlay edits. Stop click propagation so the wider chain-li's
            click-to-select handler doesn't see a deselect. */}
        <button
          type="button"
          class="effect-node__param-toggle"
          classList={{
            "effect-node__param-toggle--selected":
              props.selectedParam === "cutoff",
          }}
          onClick={(e) => {
            e.stopPropagation();
            props.onSelectParam("cutoff");
          }}
        >
          Cutoff
        </button>
        <button
          type="button"
          class="effect-node__param-toggle"
          classList={{
            "effect-node__param-toggle--selected": props.selectedParam === "q",
          }}
          onClick={(e) => {
            e.stopPropagation();
            props.onSelectParam("q");
          }}
        >
          Q
        </button>
        <span class="effect-node__hint">
          {envelopeSummary(asFilter().params.cutoff, formatHz)} · Q{" "}
          {envelopeSummary(asFilter().params.q, formatQ)}
        </span>
      </Match>
      <Match
        when={
          props.node.kind === "reverse" ||
          props.node.kind === "crop" ||
          props.node.kind === "cut"
        }
      >
        <Slider
          label="Start (frame)"
          min={0}
          max={Math.max(1, props.sourceFrames)}
          step={1}
          value={asRange().params.startFrame}
          snap={(v) => Math.max(0, Math.round(v))}
          format={(v) => `${Math.round(v)}`}
          onInput={(v) => {
            const node = asRange();
            props.onPatch({
              kind: node.kind,
              params: {
                startFrame: v,
                endFrame: node.params.endFrame,
              },
            });
          }}
        />
        <Slider
          label="End (frame)"
          min={0}
          max={Math.max(1, props.sourceFrames)}
          step={1}
          value={asRange().params.endFrame}
          snap={(v) => Math.max(0, Math.round(v))}
          format={(v) => `${Math.round(v)}`}
          onInput={(v) => {
            const node = asRange();
            props.onPatch({
              kind: node.kind,
              params: {
                startFrame: node.params.startFrame,
                endFrame: v,
              },
            });
          }}
        />
      </Match>
    </Switch>
  );
};
