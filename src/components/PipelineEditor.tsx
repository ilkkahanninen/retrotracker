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
  EFFECT_LABELS,
  materializeSource,
  sourceDisplayName,
  type EffectNode,
  type MonoMix,
  type SampleWorkbench,
} from "../core/audio/sampleWorkbench";

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
  /** Burn the chain into the source. See SampleView.Props.onApplyChain. */
  onApplyChain: () => void;
  onSetMonoMix: (monoMix: MonoMix) => void;
  onSetTargetNote: (targetNote: number | null) => void;
}

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
          {sourceDisplayName(props.wb.source)} · {materialised().sampleRate} Hz ·{" "}
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
          {(node, i) => (
            <li class="effect-node">
              <div class="effect-node__controls">
                <button
                  type="button"
                  title="Move up"
                  aria-label={`Move effect ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => props.onMoveEffect(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  title="Move down"
                  aria-label={`Move effect ${i + 1} down`}
                  disabled={i === props.wb.chain.length - 1}
                  onClick={() => props.onMoveEffect(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  title="Remove effect"
                  aria-label={`Remove effect ${i + 1}`}
                  onClick={() => props.onRemoveEffect(i)}
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
                />
              </div>
            </li>
          )}
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
      </div>
    </section>
  );
};

interface EffectParamsProps {
  node: EffectNode;
  sourceFrames: number;
  onPatch: (next: EffectNode) => void;
}

/** Discriminated-union narrowing of the range-aware kinds. */
type RangeKind = "reverse" | "crop" | "cut" | "fadeIn" | "fadeOut";

const EffectParams: Component<EffectParamsProps> = (props) => {
  // Non-keyed Match (static children, no `(n) => ...` callback) so the
  // controlled <input>s aren't disposed every time the user types — focus
  // would otherwise jump on every keystroke. Each Match's `when` predicate
  // narrows the discriminated union, but TS can't see that across the
  // children boundary, so we re-narrow with typed accessors.
  const asGain = () => props.node as Extract<EffectNode, { kind: "gain" }>;
  const asRange = () => props.node as Extract<EffectNode, { kind: RangeKind }>;
  return (
    <Switch>
      <Match when={props.node.kind === "gain"}>
        <label class="effect-node__param">
          <span class="samplemeta__label">Gain ×</span>
          <input
            type="number"
            step="0.1"
            min="0"
            max="20"
            value={asGain().params.gain}
            onInput={(e) => {
              const v = parseFloat(e.currentTarget.value);
              if (!Number.isFinite(v)) return;
              props.onPatch({ kind: "gain", params: { gain: Math.max(0, v) } });
            }}
          />
        </label>
      </Match>
      <Match when={props.node.kind === "normalize"}>
        <span class="effect-node__hint">Scales to peak ±1.0</span>
      </Match>
      <Match
        when={
          props.node.kind === "reverse" ||
          props.node.kind === "crop" ||
          props.node.kind === "cut" ||
          props.node.kind === "fadeIn" ||
          props.node.kind === "fadeOut"
        }
      >
        <label class="effect-node__param">
          <span class="samplemeta__label">Start (frame)</span>
          <input
            type="number"
            min="0"
            max={props.sourceFrames}
            value={asRange().params.startFrame}
            onInput={(e) => {
              const v = parseInt(e.currentTarget.value, 10);
              if (!Number.isFinite(v)) return;
              const node = asRange();
              props.onPatch({
                kind: node.kind,
                params: {
                  startFrame: Math.max(0, v),
                  endFrame: node.params.endFrame,
                },
              });
            }}
          />
        </label>
        <label class="effect-node__param">
          <span class="samplemeta__label">End (frame)</span>
          <input
            type="number"
            min="0"
            max={props.sourceFrames}
            value={asRange().params.endFrame}
            onInput={(e) => {
              const v = parseInt(e.currentTarget.value, 10);
              if (!Number.isFinite(v)) return;
              const node = asRange();
              props.onPatch({
                kind: node.kind,
                params: {
                  startFrame: node.params.startFrame,
                  endFrame: Math.max(0, v),
                },
              });
            }}
          />
        </label>
      </Match>
    </Switch>
  );
};
