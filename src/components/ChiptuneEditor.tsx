import { type Component } from "solid-js";
import {
  COMBINE_MODES,
  COMBINE_LABELS,
  CYCLE_FRAMES_MIN,
  CYCLE_FRAMES_MAX,
  SHAPE_INDEX_MIN,
  SHAPE_INDEX_MAX,
  PHASE_SPLIT_MIN,
  PHASE_SPLIT_MAX,
  RATIO_MIN,
  RATIO_MAX,
  LFO_MULT_MIN,
  LFO_MULT_MAX,
  LFO_TARGETS,
  LFO_TARGET_LABELS,
  snapCycleFramesToMusical,
  snapRatioToMusical,
  type ChiptuneParams,
  type Lfo,
  type LfoTarget,
  type Oscillator,
} from "../core/audio/chiptune";
import { SHAPER_LABELS, SHAPER_MODES } from "../core/audio/shapers";
import { Slider } from "./Slider";

export interface ChiptuneEditorProps {
  params: ChiptuneParams;
  disabled: boolean;
  onUpdate: (patch: Partial<ChiptuneParams>) => void;
}

/** Shape names for the clickable hint under the Shape slider. The order
 *  matches the integer shapeIndex values (0..5) so click → set is a
 *  direct index lookup. */
const SHAPE_NAMES = ["sine", "tri", "stair", "trap", "sq", "saw"] as const;

export const ChiptuneEditor: Component<ChiptuneEditorProps> = (props) => {
  const patchOsc1 = (patch: Partial<Oscillator>) =>
    props.onUpdate({ osc1: { ...props.params.osc1, ...patch } });
  const patchOsc2 = (patch: Partial<Oscillator>) =>
    props.onUpdate({ osc2: { ...props.params.osc2, ...patch } });

  return (
    <section class="chiptune">
      <div class="chiptune__group">
        <span class="chiptune__group-label">Synth</span>
        <div class="chiptune__sliders">
          <Slider
            label="Cycle frames"
            min={CYCLE_FRAMES_MIN}
            max={CYCLE_FRAMES_MAX}
            step={1}
            value={props.params.cycleFrames}
            disabled={props.disabled}
            // Snap to octave-aligned cycle lengths so a "C" pattern note
            // always plays as some C — never a detuned C-ish.
            snap={snapCycleFramesToMusical}
            format={(v) => `${v}`}
            onInput={(v) => props.onUpdate({ cycleFrames: v })}
          />
          <Slider
            label="Amplitude"
            min={0}
            max={1}
            step={0.01}
            value={props.params.amplitude}
            disabled={props.disabled}
            onInput={(v) => props.onUpdate({ amplitude: v })}
          />
        </div>
      </div>

      <OscillatorSliders
        label="Oscillator 1"
        osc={props.params.osc1}
        disabled={props.disabled}
        onUpdate={patchOsc1}
      />
      <OscillatorSliders
        label="Oscillator 2"
        osc={props.params.osc2}
        disabled={props.disabled}
        onUpdate={patchOsc2}
      />

      <div class="chiptune__group">
        <span class="chiptune__group-label">Combine</span>
        <div
          class="chiptune__modes"
          role="radiogroup"
          aria-label="Combine mode"
        >
          {COMBINE_MODES.map((m) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.params.combineMode === m}
              classList={{ "is-active": props.params.combineMode === m }}
              disabled={props.disabled}
              onClick={() => props.onUpdate({ combineMode: m })}
            >
              {COMBINE_LABELS[m]}
            </button>
          ))}
        </div>
        <div class="chiptune__sliders">
          <Slider
            label="Amount"
            min={0}
            max={1}
            step={0.01}
            value={props.params.combineAmount}
            disabled={props.disabled}
            onInput={(v) => props.onUpdate({ combineAmount: v })}
          />
        </div>
        <div class="chiptune__modes" role="radiogroup" aria-label="Shaper mode">
          {SHAPER_MODES.map((m) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.params.shaperMode === m}
              classList={{ "is-active": props.params.shaperMode === m }}
              disabled={props.disabled}
              onClick={() => props.onUpdate({ shaperMode: m })}
            >
              {SHAPER_LABELS[m]}
            </button>
          ))}
        </div>
        <div class="chiptune__sliders">
          <Slider
            label="Drive"
            min={0}
            max={1}
            step={0.01}
            value={props.params.shaperAmount}
            disabled={props.disabled || props.params.shaperMode === "none"}
            hint="0 = bypass"
            onInput={(v) => props.onUpdate({ shaperAmount: v })}
          />
        </div>
      </div>

      <LfoSection
        lfo={props.params.lfo}
        disabled={props.disabled}
        onUpdate={(patch) =>
          props.onUpdate({ lfo: { ...props.params.lfo, ...patch } })
        }
      />
    </section>
  );
};

interface LfoSectionProps {
  lfo: Lfo;
  disabled: boolean;
  onUpdate: (patch: Partial<Lfo>) => void;
}

const LfoSection: Component<LfoSectionProps> = (props) => (
  <div class="chiptune__group">
    <span class="chiptune__group-label">LFO</span>
    <label class="lfo__target">
      <span class="samplemeta__label">Target</span>
      <select
        aria-label="LFO target"
        value={props.lfo.target}
        disabled={props.disabled}
        onChange={(e) =>
          props.onUpdate({ target: e.currentTarget.value as LfoTarget })
        }
      >
        {LFO_TARGETS.map((t) => (
          <option value={t}>{LFO_TARGET_LABELS[t]}</option>
        ))}
      </select>
    </label>
    <div class="chiptune__sliders">
      <Slider
        label="Cycle multiplier"
        min={LFO_MULT_MIN}
        max={LFO_MULT_MAX}
        step={1}
        value={props.lfo.cycleMultiplier}
        disabled={props.disabled}
        snap={snapToInteger}
        format={(v) => `${Math.round(v)}×`}
        hint="longer = slower LFO"
        onInput={(v) => props.onUpdate({ cycleMultiplier: v })}
      />
      <Slider
        label="Amplitude"
        min={0}
        max={1}
        step={0.01}
        value={props.lfo.amplitude}
        disabled={props.disabled}
        hint="0 = LFO off"
        onInput={(v) => props.onUpdate({ amplitude: v })}
      />
    </div>
  </div>
);

interface OscillatorSlidersProps {
  label: string;
  osc: Oscillator;
  disabled: boolean;
  onUpdate: (patch: Partial<Oscillator>) => void;
}

const OscillatorSliders: Component<OscillatorSlidersProps> = (props) => (
  <div class="chiptune__group">
    <span class="chiptune__group-label">{props.label}</span>
    <div class="chiptune__sliders">
      <Slider
        label="Shape"
        min={SHAPE_INDEX_MIN}
        max={SHAPE_INDEX_MAX}
        step={0.01}
        value={props.osc.shapeIndex}
        disabled={props.disabled}
        hint={
          <>
            {SHAPE_NAMES.map((name, idx) => (
              <>
                {idx > 0 ? " ─ " : null}
                <button
                  type="button"
                  class="slider__hint-link"
                  classList={{
                    "is-active": Math.round(props.osc.shapeIndex) === idx,
                  }}
                  disabled={props.disabled}
                  onClick={() => props.onUpdate({ shapeIndex: idx })}
                >
                  {name}
                </button>
              </>
            ))}
          </>
        }
        onInput={(v) => props.onUpdate({ shapeIndex: v })}
      />
      <Slider
        label="Phase split"
        min={PHASE_SPLIT_MIN}
        max={PHASE_SPLIT_MAX}
        step={0.01}
        value={props.osc.phaseSplit}
        disabled={props.disabled}
        onInput={(v) => props.onUpdate({ phaseSplit: v })}
      />
      <Slider
        label="Ratio"
        min={RATIO_MIN}
        max={RATIO_MAX}
        step={1}
        value={props.osc.ratio}
        disabled={props.disabled}
        // Snap to powers of two so the cycle stays octave-aligned and the
        // shorter cycle wraps cleanly inside the longer one.
        snap={snapRatioToMusical}
        format={(v) => `${v}×`}
        hint="1× ─ 2× ─ 4× ─ 8×"
        onInput={(v) => props.onUpdate({ ratio: v })}
      />
    </div>
  </div>
);

function snapToInteger(v: number): number {
  return Math.round(v);
}
