import { onCleanup, type Component, type JSX } from "solid-js";
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

  // Track the active drag's pointerup listener so we can detach it (and
  // close the drag group) if the component unmounts before the user lifts
  // the pointer. Without this, `dragSnapshot` would stay non-null and every
  // subsequent commit would silently skip its undo entry until the next
  // pointerup *anywhere* on window.
  let activeRelease: (() => void) | null = null;
  onCleanup(() => activeRelease?.());

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
            // still closes the group; the matching cleanup also runs on
            // component unmount via `activeRelease` so a mid-drag unmount
            // can't leave `dragSnapshot` stuck.
            activeRelease?.();
            beginDragEdit();
            const release = () => {
              window.removeEventListener("pointerup", release);
              activeRelease = null;
              endDragEdit();
            };
            activeRelease = release;
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
