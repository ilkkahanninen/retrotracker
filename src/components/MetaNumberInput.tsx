import type { Component } from "solid-js";

interface Props {
  label: string;
  ariaLabel: string;
  /** Tooltip prefix; the allowed range is appended. */
  title: string;
  min: number;
  max: number;
  value: number;
  disabled?: boolean;
  /** Called with an integer already clamped to `min..max`. */
  onCommit: (value: number) => void;
}

/**
 * Labelled integer input for the pattern meta strip. Commits on change
 * (blur / Enter / spinner click), clamping to the range first.
 */
export const MetaNumberInput: Component<Props> = (props) => (
  <label class="patternpane__num">
    {props.label}
    <input
      type="number"
      min={props.min}
      max={props.max}
      step={1}
      aria-label={props.ariaLabel}
      title={`${props.title} (range ${props.min}..${props.max})`}
      disabled={props.disabled}
      value={props.value}
      onChange={(e) => {
        const el = e.currentTarget;
        const n = Math.floor(Number(el.value));
        if (el.value.trim() !== "" && Number.isFinite(n)) {
          props.onCommit(Math.max(props.min, Math.min(props.max, n)));
        }
        // Why: when the clamped value equals the current one (or the
        // edit was refused) `props.value` doesn't change, so Solid won't
        // rewrite the field and the rejected text would stay on screen.
        el.value = String(props.value);
      }}
    />
  </label>
);
