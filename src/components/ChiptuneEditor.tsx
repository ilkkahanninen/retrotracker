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
  snapLfoMultiplierToDivisor,
  snapRatioToMusical,
  type ChiptuneParams,
  type CombineMode,
  type Lfo,
  type LfoTarget,
  type Oscillator,
} from "../core/audio/chiptune";
import {
  SHAPER_LABELS,
  SHAPER_MODES,
  type ShaperMode,
} from "../core/audio/shapers";
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
          <Slider
            label="Offset"
            min={0}
            max={1}
            step={0.01}
            value={props.params.offset}
            disabled={props.disabled}
            // Display as a percentage to match the user-facing 0–100% scale.
            // The underlying value is 0..1 so it composes cleanly with the
            // synth's clamp() and stays JSON-friendly for `.retro` round-trips.
            format={(v) => `${Math.round(v * 100)}%`}
            onInput={(v) => props.onUpdate({ offset: v })}
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
        <div class="chiptune__row">
          <label class="chiptune__select">
            <span class="slider__label">Mode</span>
            <select
              aria-label="Combine mode"
              value={props.params.combineMode}
              disabled={props.disabled}
              onChange={(e) =>
                props.onUpdate({
                  combineMode: e.currentTarget.value as CombineMode,
                })
              }
            >
              {COMBINE_MODES.map((m) => (
                <option value={m}>{COMBINE_LABELS[m]}</option>
              ))}
            </select>
          </label>
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
        <div class="chiptune__row">
          <label class="chiptune__select">
            <span class="slider__label">Shaper</span>
            <select
              aria-label="Shaper mode"
              value={props.params.shaperMode}
              disabled={props.disabled}
              onChange={(e) =>
                props.onUpdate({
                  shaperMode: e.currentTarget.value as ShaperMode,
                })
              }
            >
              {SHAPER_MODES.map((m) => (
                <option value={m}>{SHAPER_LABELS[m]}</option>
              ))}
            </select>
          </label>
          <Slider
            label="Drive"
            min={0}
            max={1}
            step={0.01}
            value={props.params.shaperAmount}
            disabled={props.disabled || props.params.shaperMode === "none"}
            onInput={(v) => props.onUpdate({ shaperAmount: v })}
          />
        </div>
      </div>

      <LfoSection
        label="LFO 1"
        ariaLabel="LFO 1"
        lfo={props.params.lfo}
        disabled={props.disabled}
        multMin={LFO_MULT_MIN}
        multMax={LFO_MULT_MAX}
        multHint="defines rendered length"
        onUpdate={(patch) => {
          const newLfo1 = { ...props.params.lfo, ...patch };
          // When m1 changes the divisor set changes too — re-snap m2
          // immediately so it stays a valid divisor of the new m1
          // instead of silently drifting at render time.
          if (patch.cycleMultiplier !== undefined) {
            const newM2 = snapLfoMultiplierToDivisor(
              props.params.lfo2.cycleMultiplier,
              newLfo1.cycleMultiplier,
            );
            props.onUpdate({
              lfo: newLfo1,
              lfo2: { ...props.params.lfo2, cycleMultiplier: newM2 },
            });
          } else {
            props.onUpdate({ lfo: newLfo1 });
          }
        }}
      />
      <LfoSection
        label="LFO 2"
        ariaLabel="LFO 2"
        lfo={props.params.lfo2}
        disabled={props.disabled}
        multMin={LFO_MULT_MIN}
        // Cap LFO 2's range at LFO 1's multiplier — values beyond it
        // can't divide L, so the slider only spans the valid divisors.
        multMax={Math.max(
          LFO_MULT_MIN,
          Math.floor(props.params.lfo.cycleMultiplier),
        )}
        multSnap={(v) =>
          snapLfoMultiplierToDivisor(v, props.params.lfo.cycleMultiplier)
        }
        multHint="snaps to divisors of LFO 1"
        onUpdate={(patch) =>
          props.onUpdate({ lfo2: { ...props.params.lfo2, ...patch } })
        }
      />
    </section>
  );
};

interface LfoSectionProps {
  label: string;
  ariaLabel: string;
  lfo: Lfo;
  disabled: boolean;
  multMin: number;
  multMax: number;
  multSnap?: (v: number) => number;
  multHint: string;
  onUpdate: (patch: Partial<Lfo>) => void;
}

const LfoSection: Component<LfoSectionProps> = (props) => (
  <div class="chiptune__group">
    <span class="chiptune__group-label">{props.label}</span>
    <label class="chiptune__select">
      <span class="slider__label">Target</span>
      <select
        aria-label={`${props.ariaLabel} target`}
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
    <div class="chiptune__row">
      <Slider
        label="Cycle multiplier"
        min={props.multMin}
        max={props.multMax}
        step={1}
        value={props.lfo.cycleMultiplier}
        // When LFO 2's max collapses to 1 (LFO 1 at multiplier 1),
        // there's only one valid value — disable the slider so the
        // user sees that explicitly instead of a dead-feeling drag.
        disabled={props.disabled || props.multMax <= props.multMin}
        snap={props.multSnap ?? snapToInteger}
        format={(v) => `${Math.round(v)}×`}
        hint={props.multHint}
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
      <div class="chiptune__row">
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
          onInput={(v) => props.onUpdate({ ratio: v })}
        />
      </div>
    </div>
  </div>
);

function snapToInteger(v: number): number {
  return Math.round(v);
}
