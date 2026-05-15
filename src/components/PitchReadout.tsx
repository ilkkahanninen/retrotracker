import type { Accessor } from "solid-js";
import type { PitchResult } from "../core/audio/pitchDetect";
import { frequencyToNoteCents } from "../core/audio/pitchDetect";
import { NOTE_NAMES } from "../core/xm/effectLabels";

interface Props {
  pitch: Accessor<PitchResult | null>;
}

const MIN_CONFIDENCE = 0.6;

/**
 * Compact "Pitch" readout for the sample-meta row. Renders the detected
 * fundamental as a musical note + cents offset in standard tuning
 * (A-4 = 440 Hz). Hover shows the raw Hz for users who want to dial in
 * finetune by number rather than by ear.
 *
 * Format-agnostic on purpose: the same component sits in both the PT
 * SampleView and the XM InstrumentView. Format-native finetune /
 * relativeNote suggestions are intentionally not rendered here — the
 * musical readout is enough to tune the sample, and the format's own
 * finetune slider remains the source of truth.
 */
export function PitchReadout(props: Props) {
  const result = () => {
    const p = props.pitch();
    if (!p || p.confidence < MIN_CONFIDENCE) return null;
    const { midi, cents } = frequencyToNoteCents(p.hz);
    return { hz: p.hz, midi, cents };
  };

  const primary = (): string => {
    const r = result();
    if (!r) return "—";
    return `${noteLabel(r.midi)} ${formatCents(r.cents)}`;
  };

  const tooltip = (): string => {
    const p = props.pitch();
    if (!p) return "No pitch detected";
    if (p.confidence < MIN_CONFIDENCE) {
      return `Low-confidence detection (${p.hz.toFixed(1)} Hz)`;
    }
    return `${p.hz.toFixed(2)} Hz`;
  };

  return (
    <label>
      <span class="samplemeta__label">Pitch</span>
      <span class="samplemeta__static" title={tooltip()}>
        {primary()}
      </span>
    </label>
  );
}

/** MIDI note number → label in standard tuning. MIDI 60 = C-4. */
function noteLabel(midi: number): string {
  const idx = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[idx]!}${octave}`;
}

/** Cents offset → signed integer suffix like "+0¢", "-23¢". */
function formatCents(cents: number): string {
  const rounded = Math.round(cents);
  // U+2212 minus sign for visual symmetry with the "+" sign in fixed-
  // width fonts; ASCII "-" is also fine but tends to render shorter.
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
  return `${sign}${Math.abs(rounded)}¢`;
}
