import type { Component } from "solid-js";

import { decEditStep, editStep, incEditStep } from "../state/edit";
import { transport } from "../state/song";
import { Icon } from "./Icon";
import { Minus, Plus } from "./icons";

/**
 * Edit-step readout with −/+ buttons for the pattern meta strip. The
 * step signal is format-agnostic (both pattern editors advance by it),
 * so the PT and FT2 strips render the same control.
 */
export const EditStepControl: Component = () => (
  <span class="patternpane__editstep">
    step
    <button
      type="button"
      class="patternpane__editstep-btn"
      onClick={decEditStep}
      disabled={transport() === "playing"}
      title="Decrease edit step (<)"
      aria-label="Decrease edit step"
    >
      <Icon of={Minus} />
    </button>
    <span class="patternpane__editstep-value" aria-label="Edit step">
      {editStep()}
    </span>
    <button
      type="button"
      class="patternpane__editstep-btn"
      onClick={incEditStep}
      disabled={transport() === "playing"}
      title="Increase edit step (>)"
      aria-label="Increase edit step"
    >
      <Icon of={Plus} />
    </button>
  </span>
);
