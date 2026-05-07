import { type Component, type JSX } from "solid-js";
import { beginDragEdit, endDragEdit } from "../state/song";

interface Props {
  label: JSX.Element;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  /** Format the read-out shown next to the slider. Defaults to value.toFixed(2). */
  format?: (v: number) => string;
  /** Snap a raw input value to the value the model should see (e.g. force even). */
  snap?: (v: number) => number;
  onInput: (v: number) => void;
  /** Optional secondary hint shown under the row. */
  hint?: JSX.Element;
}

/**
 * Labelled range slider with a numeric read-out. Used by the chiptune editor
 * for shape morph / phase split / cycle frames; will be reused as more synth
 * controls land.
 *
 * `snap` is applied before `onInput` fires so callers can enforce constraints
 * (PT loops are word-aligned ⇒ even cycle frames).
 */
export const Slider: Component<Props> = (props) => {
  const fmt = (v: number) => (props.format ?? ((x) => x.toFixed(2)))(v);
  return (
    <label class="slider" classList={{ "slider--disabled": props.disabled }}>
      <span class="slider__label">{props.label}</span>
      <span class="slider__row">
        <input
          class="slider__range"
          type="range"
          min={props.min}
          max={props.max}
          step={props.step ?? 0.01}
          value={props.value}
          disabled={props.disabled}
          onPointerDown={() => {
            // Open a coalesced edit group for the drag — every `input` event
            // commits live, but they collapse into a single undo entry.
            // Uses a window-level pointerup so a release outside the thumb
            // still closes the group.
            beginDragEdit();
            const release = () => {
              endDragEdit();
              window.removeEventListener("pointerup", release);
            };
            window.addEventListener("pointerup", release);
          }}
          onInput={(e) => {
            const v = parseFloat(e.currentTarget.value);
            if (!Number.isFinite(v)) return;
            props.onInput(props.snap ? props.snap(v) : v);
          }}
        />
        <span class="slider__value">{fmt(props.value)}</span>
      </span>
      {props.hint ? <span class="slider__hint">{props.hint}</span> : null}
    </label>
  );
};
