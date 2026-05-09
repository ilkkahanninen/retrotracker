import {
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { palTicksFromRowsSpeedTempo } from "../core/mod/flatten";

interface Props {
  /** Auto-fill: speed in effect at the cursor's (order, row). */
  initialSpeed: number;
  /** Auto-fill: tempo in effect at the cursor's (order, row). */
  initialTempo: number;
  /** Default row count to fit. 16 = one bar at default speed/tempo. */
  initialRows?: number;
  onApply: (palTicks: number) => void;
  onClose: () => void;
}

/**
 * Convert a musical interval (rows × speed at tempo B) into the PAL-tick
 * count the sample pipeline's "Length (ticks)" field expects. Rows / Speed
 * / Tempo are seeded from the song state at the cursor; user can override
 * any of them. Apply writes the computed value back via `onApply`.
 */
export const PlayLengthCalculator: Component<Props> = (props) => {
  let firstInput: HTMLInputElement | undefined;

  const [rows, setRows] = createSignal(props.initialRows ?? 16);
  const [speed, setSpeed] = createSignal(props.initialSpeed);
  const [tempo, setTempo] = createSignal(props.initialTempo);

  const result = createMemo(() => {
    const r = rows();
    const s = speed();
    const t = tempo();
    if (!Number.isFinite(r) || !Number.isFinite(s) || !Number.isFinite(t))
      return 0;
    if (r <= 0 || s <= 0 || t <= 0) return 0;
    return palTicksFromRowsSpeedTempo(r, s, t);
  });

  const apply = () => {
    const t = result();
    if (t > 0) props.onApply(t);
    props.onClose();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
    else if (e.key === "Enter") apply();
  };

  onMount(() => {
    window.addEventListener("keydown", onKey);
    queueMicrotask(() => firstInput?.select());
  });
  onCleanup(() => window.removeEventListener("keydown", onKey));

  // Coerce a number-input value: empty / NaN → 0 so the result memo treats
  // it as "not yet entered" instead of crashing.
  const num = (raw: string): number => {
    if (raw === "") return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  };

  return (
    <div
      class="modal-backdrop"
      role="presentation"
      onClick={() => props.onClose()}
    >
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="play-length-calc-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal__head">
          <h2 id="play-length-calc-title">Length calculator</h2>
          <button
            type="button"
            class="modal__close"
            onClick={() => props.onClose()}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
        <div class="modal__body">
          <p>
            Compute the playing length, in PAL ticks (1/50 s), of a musical
            interval. Speed and tempo are pre-filled from the song state at the
            cursor.
          </p>
          <div class="play-length-calc__fields">
            <label>
              <span class="samplemeta__label">Rows</span>
              <input
                ref={firstInput}
                type="number"
                min="1"
                step="1"
                value={rows()}
                onInput={(e) => setRows(Math.floor(num(e.currentTarget.value)))}
              />
            </label>
            <label>
              <span class="samplemeta__label">Speed (ticks/row)</span>
              <input
                type="number"
                min="1"
                max="31"
                step="1"
                value={speed()}
                onInput={(e) =>
                  setSpeed(Math.floor(num(e.currentTarget.value)))
                }
              />
            </label>
            <label>
              <span class="samplemeta__label">Tempo (BPM)</span>
              <input
                type="number"
                min="32"
                max="255"
                step="1"
                value={tempo()}
                onInput={(e) =>
                  setTempo(Math.floor(num(e.currentTarget.value)))
                }
              />
            </label>
          </div>
          <p class="play-length-calc__result">
            <span class="samplemeta__label">Result</span>
            <strong>{result()} ticks</strong>
          </p>
        </div>
        <div class="play-length-calc__footer">
          <button type="button" onClick={() => props.onClose()}>
            Cancel
          </button>
          <button
            type="button"
            class="play-length-calc__apply"
            onClick={apply}
            disabled={result() <= 0}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
};
