import { type Component } from "solid-js";
import {
  COMBINE_MODES, COMBINE_LABELS,
  CYCLE_FRAMES_MIN, CYCLE_FRAMES_MAX,
  SHAPE_INDEX_MIN, SHAPE_INDEX_MAX,
  PHASE_SPLIT_MIN, PHASE_SPLIT_MAX,
  RATIO_MIN, RATIO_MAX,
  snapCycleFramesToMusical, snapRatioToMusical,
  type ChiptuneParams, type Oscillator,
} from "../core/audio/chiptune";
import { Slider } from "./Slider";

export interface ChiptuneEditorProps {
  params: ChiptuneParams;
  disabled: boolean;
  onUpdate: (patch: Partial<ChiptuneParams>) => void;
}

const SHAPE_HINT = "sine ─ tri ─ sq ─ saw";

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
        <div class="chiptune__modes" role="radiogroup" aria-label="Combine mode">
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
      </div>
    </section>
  );
};

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
        hint={SHAPE_HINT}
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
