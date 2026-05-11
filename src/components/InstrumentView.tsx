import { For, Show, createEffect, type Component } from "solid-js";

import type {
  XmAutoVibratoType,
  XmInstrument,
  XmLoopType,
  XmSong,
} from "../core/xm/types";
import {
  currentXmInstrument,
  currentXmSampleIndex,
  setCurrentXmSampleIndex,
} from "../state/xmEdit";
import {
  addXmEnvelopePoint,
  addXmSample,
  patchXmAutoVibrato,
  patchXmInstrumentEnvelope,
  patchXmSample,
  removeXmEnvelopePoint,
  removeXmSample,
  setXmEnvelopePoint,
  setXmFadeout,
} from "../state/xmInstrumentEdit";
import {
  addXmEffect,
  applyXmChainToSource,
  convertXmChiptuneToSampler,
  moveXmEffect,
  newXmChiptune,
  patchXmEffect,
  removeXmEffect,
  setXmBitDepth,
  setXmDither,
  setXmEffectBypass,
  setXmMonoMix,
  setXmSelectedEffectIndex,
  setXmSelectedEffectParam,
  setXmSourceKind,
  updateXmChiptune,
  xmSelectedEffectIndex,
  xmSelectedEffectParam,
} from "../state/xmSampleEdit";
import { getXmWorkbench } from "../state/xmSampleWorkbench";
import {
  SOURCE_KINDS,
  SOURCE_LABELS,
  xmWorkbenchFromSample,
} from "../core/audio/sampleWorkbench";
import { ChiptuneEditor } from "./ChiptuneEditor";
import { EnvelopeEditor } from "./EnvelopeEditor";
import { XmKeyMapEditor } from "./XmKeyMapEditor";
import { XmPipelineEditor } from "./XmPipelineEditor";
import { XmWaveform } from "./XmWaveform";

interface Props {
  song: XmSong;
}

const VIBRATO_TYPES: XmAutoVibratoType[] = [
  "sine",
  "square",
  "ramp-down",
  "ramp-up",
];
const LOOP_TYPES: XmLoopType[] = ["none", "forward", "ping-pong"];

/**
 * FT2 instrument editor. Renders the instrument-level fields (volume +
 * panning envelopes, autovibrato, fadeout), the per-sample meta row
 * (volume / finetune / panning / rel. note / loop), and — when an
 * instrument carries more than one sample — a multi-sample picker plus
 * the 96-cell note → sample keymap editor.
 *
 * The "active sample index" is held in `currentXmSampleIndex` and
 * resets to 0 whenever the user switches instruments, so a freshly
 * selected instrument always opens on its first sample.
 */
export const InstrumentView: Component<Props> = (props) => {
  const slot1Based = () => currentXmInstrument();
  const instrument = (): XmInstrument | undefined =>
    props.song.instruments[slot1Based() - 1];

  // Reset to the first sample whenever the instrument switches so the
  // user doesn't land on a stale index that no longer exists.
  createEffect(() => {
    currentXmInstrument();
    setCurrentXmSampleIndex(0);
  });

  // Clamp the sample index whenever the current instrument's sample
  // count shrinks (e.g. after Remove).
  createEffect(() => {
    const inst = instrument();
    if (!inst) return;
    const max = Math.max(0, inst.samples.length - 1);
    if (currentXmSampleIndex() > max) setCurrentXmSampleIndex(max);
  });

  const activeSampleIndex = (): number => {
    const inst = instrument();
    if (!inst) return 0;
    const idx = currentXmSampleIndex();
    const max = Math.max(0, inst.samples.length - 1);
    return Math.min(max, Math.max(0, idx));
  };

  return (
    <Show
      when={instrument()}
      fallback={
        <p class="instrument-view__placeholder">
          Empty instrument slot. Drop a WAV onto the slot, or onto the waveform
          area below, to load a sample.
        </p>
      }
    >
      {(inst) => (
        <div class="instrument-view">
          {/* Sample list — one button per sample, showing the hex index
              and the sample's name. Add / remove sit on the right so
              they don't shove the active selection around. */}
          <section class="instrument-view__section">
            <h4 class="instrument-view__heading">Samples</h4>
            <div class="instrument-view__sample-list">
              <For each={inst().samples}>
                {(s, i) => (
                  <button
                    type="button"
                    class="instrument-view__sample-chip"
                    classList={{
                      "instrument-view__sample-chip--active":
                        i() === activeSampleIndex(),
                    }}
                    onClick={() => setCurrentXmSampleIndex(i())}
                    title={`Sample ${i().toString(16).toUpperCase()}: ${
                      s.name || "(unnamed)"
                    }`}
                  >
                    <span class="instrument-view__sample-chip-idx">
                      {i().toString(16).toUpperCase()}
                    </span>
                    <span class="instrument-view__sample-chip-name">
                      {s.name || <em>(unnamed)</em>}
                    </span>
                  </button>
                )}
              </For>
              <div class="instrument-view__sample-actions">
                <button
                  type="button"
                  onClick={() => addXmSample(slot1Based())}
                  disabled={inst().samples.length >= 16}
                  title="Add sample (max 16)"
                  aria-label="Add sample"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() =>
                    removeXmSample(slot1Based(), activeSampleIndex())
                  }
                  disabled={inst().samples.length <= 1}
                  title="Remove current sample"
                  aria-label="Remove sample"
                >
                  −
                </button>
              </div>
            </div>
          </section>

          {/* Source kind toggle — sampler vs chiptune. Chiptune feeds a
              synth cycle into the pipeline instead of a WAV; the result
              still terminates in the XM transformer like any other
              sample. The toggle reads from the live workbench so the UI
              tracks state set elsewhere (alt-stash restores, etc.). */}
          {(() => {
            const wb = () => getXmWorkbench(slot1Based(), activeSampleIndex());
            const sourceKind = () => wb()?.source.kind ?? "sampler";
            const chiptuneParams = () => {
              const src = wb()?.source;
              if (!src || src.kind !== "chiptune") return null;
              return src.params;
            };
            return (
              <Show when={inst().samples[activeSampleIndex()]}>
                <section class="instrument-view__section">
                  <h4 class="instrument-view__heading">Source</h4>
                  <div class="instrument-view__row">
                    <label>
                      Kind
                      <select
                        value={sourceKind()}
                        onChange={(e) =>
                          setXmSourceKind(
                            e.currentTarget.value as "sampler" | "chiptune",
                          )
                        }
                      >
                        {SOURCE_KINDS.map((k) => (
                          <option value={k}>{SOURCE_LABELS[k]}</option>
                        ))}
                      </select>
                    </label>
                    <Show when={sourceKind() === "chiptune"}>
                      <button
                        type="button"
                        onClick={convertXmChiptuneToSampler}
                        title="Bake the chiptune cycle into a WAV and switch to sampler mode"
                      >
                        Convert to sampler
                      </button>
                      <button
                        type="button"
                        onClick={newXmChiptune}
                        title="Reset chiptune to default params"
                      >
                        Reset
                      </button>
                    </Show>
                  </div>
                  <Show when={chiptuneParams()}>
                    {(params) => (
                      <ChiptuneEditor
                        params={params()}
                        disabled={false}
                        onUpdate={updateXmChiptune}
                      />
                    )}
                  </Show>
                </section>
              </Show>
            );
          })()}

          <Show when={inst().samples[activeSampleIndex()]}>
            {(sample) => (
              <section class="instrument-view__section">
                <h4 class="instrument-view__heading">Sample</h4>
                <label class="instrument-view__sample-name">
                  Name
                  <input
                    type="text"
                    maxlength={22}
                    value={sample().name}
                    onInput={(e) =>
                      patchXmSample(
                        slot1Based(),
                        { name: e.currentTarget.value },
                        activeSampleIndex(),
                      )
                    }
                  />
                </label>
                <XmWaveform sample={sample()} />
                <div class="instrument-view__row">
                  <label>
                    Volume
                    <input
                      type="number"
                      min={0}
                      max={64}
                      value={sample().volume}
                      onInput={(e) =>
                        patchXmSample(
                          slot1Based(),
                          { volume: Number(e.currentTarget.value) },
                          activeSampleIndex(),
                        )
                      }
                    />
                  </label>
                  <label>
                    Finetune
                    <input
                      type="number"
                      min={-128}
                      max={127}
                      value={sample().finetune}
                      onInput={(e) =>
                        patchXmSample(
                          slot1Based(),
                          { finetune: Number(e.currentTarget.value) },
                          activeSampleIndex(),
                        )
                      }
                    />
                  </label>
                  <label>
                    Panning
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={sample().panning}
                      onInput={(e) =>
                        patchXmSample(
                          slot1Based(),
                          { panning: Number(e.currentTarget.value) },
                          activeSampleIndex(),
                        )
                      }
                    />
                  </label>
                  <label>
                    Rel. note
                    <input
                      type="number"
                      min={-96}
                      max={95}
                      value={sample().relativeNote}
                      onInput={(e) =>
                        patchXmSample(
                          slot1Based(),
                          { relativeNote: Number(e.currentTarget.value) },
                          activeSampleIndex(),
                        )
                      }
                    />
                  </label>
                  <label>
                    Loop
                    <select
                      value={sample().loopType}
                      onChange={(e) =>
                        patchXmSample(
                          slot1Based(),
                          {
                            loopType: e.currentTarget.value as XmLoopType,
                          },
                          activeSampleIndex(),
                        )
                      }
                    >
                      {LOOP_TYPES.map((t) => (
                        <option value={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Loop start
                    <input
                      type="number"
                      min={0}
                      max={sample().data.length}
                      value={sample().loopStart}
                      disabled={sample().loopType === "none"}
                      onInput={(e) =>
                        patchXmSample(
                          slot1Based(),
                          { loopStart: Number(e.currentTarget.value) },
                          activeSampleIndex(),
                        )
                      }
                    />
                  </label>
                  <label>
                    Loop length
                    <input
                      type="number"
                      min={0}
                      max={sample().data.length}
                      value={sample().loopLength}
                      disabled={sample().loopType === "none"}
                      onInput={(e) =>
                        patchXmSample(
                          slot1Based(),
                          { loopLength: Number(e.currentTarget.value) },
                          activeSampleIndex(),
                        )
                      }
                    />
                  </label>
                  <span class="instrument-view__readout">
                    {sample().bits}-bit · {sample().data.length} samples
                  </span>
                </div>
              </section>
            )}
          </Show>

          {/* DSP pipeline — feeds the active sample through a chain of
              effects (gain envelope, normalize, filter, shaper, …) then
              quantises to the chosen bit depth. The workbench is
              session-only and not persisted in the .xm file. */}
          <Show when={inst().samples[activeSampleIndex()]}>
            {(sample) => {
              const wb = () => {
                const existing = getXmWorkbench(
                  slot1Based(),
                  activeSampleIndex(),
                );
                if (existing) return existing;
                return xmWorkbenchFromSample(
                  sample().data,
                  sample().bits,
                  sample().name,
                );
              };
              return (
                <section class="instrument-view__section">
                  <h4 class="instrument-view__heading">DSP pipeline</h4>
                  <XmPipelineEditor
                    wb={wb()}
                    onAddEffect={addXmEffect}
                    onRemoveEffect={removeXmEffect}
                    onMoveEffect={moveXmEffect}
                    onPatchEffect={patchXmEffect}
                    onSetEffectBypass={setXmEffectBypass}
                    onApplyChain={applyXmChainToSource}
                    onSetMonoMix={setXmMonoMix}
                    onSetBitDepth={setXmBitDepth}
                    onSetDither={setXmDither}
                    selectedEffectIndex={xmSelectedEffectIndex()}
                    onSelectEffect={setXmSelectedEffectIndex}
                    selectedEffectParam={xmSelectedEffectParam()}
                    onSelectParam={setXmSelectedEffectParam}
                  />
                </section>
              );
            }}
          </Show>

          {/* KeyMap editor — only relevant once an instrument carries
              more than one sample. With just one sample the keymap is a
              degenerate all-zeros table and there's nothing to paint. */}
          <Show when={inst().samples.length > 1}>
            <section class="instrument-view__section">
              <h4 class="instrument-view__heading">Key map</h4>
              <XmKeyMapEditor instrument={inst()} slot1Based={slot1Based()} />
            </section>
          </Show>

          <section class="instrument-view__section">
            <h4 class="instrument-view__heading">Autovibrato</h4>
            <div class="instrument-view__row">
              <label>
                Waveform
                <select
                  value={inst().vibratoType}
                  onChange={(e) =>
                    patchXmAutoVibrato(slot1Based(), {
                      vibratoType: e.currentTarget.value as XmAutoVibratoType,
                    })
                  }
                >
                  {VIBRATO_TYPES.map((t) => (
                    <option value={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label>
                Sweep
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={inst().vibratoSweep}
                  onInput={(e) =>
                    patchXmAutoVibrato(slot1Based(), {
                      vibratoSweep: Number(e.currentTarget.value),
                    })
                  }
                />
              </label>
              <label>
                Depth
                <input
                  type="number"
                  min={0}
                  max={15}
                  value={inst().vibratoDepth}
                  onInput={(e) =>
                    patchXmAutoVibrato(slot1Based(), {
                      vibratoDepth: Number(e.currentTarget.value),
                    })
                  }
                />
              </label>
              <label>
                Rate
                <input
                  type="number"
                  min={0}
                  max={63}
                  value={inst().vibratoRate}
                  onInput={(e) =>
                    patchXmAutoVibrato(slot1Based(), {
                      vibratoRate: Number(e.currentTarget.value),
                    })
                  }
                />
              </label>
              <label class="instrument-view__inline-slider">
                Fadeout
                <input
                  type="range"
                  min={0}
                  max={0xfff}
                  value={inst().fadeout}
                  onInput={(e) =>
                    setXmFadeout(slot1Based(), Number(e.currentTarget.value))
                  }
                  aria-label="Fadeout"
                />
                <span class="instrument-view__readout">
                  {inst().fadeout.toString(16).padStart(3, "0").toUpperCase()}h
                </span>
              </label>
            </div>
          </section>

          <div class="instrument-view__envelopes">
            <section class="instrument-view__section">
              <h4 class="instrument-view__heading">Volume envelope</h4>
              <EnvelopeEditor
                envelope={inst().volumeEnvelope}
                kind="volume"
                onPatchFlags={(patch) =>
                  patchXmInstrumentEnvelope(slot1Based(), "volume", patch)
                }
                onAddPoint={(p) =>
                  addXmEnvelopePoint(slot1Based(), "volume", p)
                }
                onSetPoint={(i, p) =>
                  setXmEnvelopePoint(slot1Based(), "volume", i, p)
                }
                onRemovePoint={(i) =>
                  removeXmEnvelopePoint(slot1Based(), "volume", i)
                }
              />
            </section>

            <section class="instrument-view__section">
              <h4 class="instrument-view__heading">Panning envelope</h4>
              <EnvelopeEditor
                envelope={inst().panningEnvelope}
                kind="panning"
                onPatchFlags={(patch) =>
                  patchXmInstrumentEnvelope(slot1Based(), "panning", patch)
                }
                onAddPoint={(p) =>
                  addXmEnvelopePoint(slot1Based(), "panning", p)
                }
                onSetPoint={(i, p) =>
                  setXmEnvelopePoint(slot1Based(), "panning", i, p)
                }
                onRemovePoint={(i) =>
                  removeXmEnvelopePoint(slot1Based(), "panning", i)
                }
              />
            </section>
          </div>
        </div>
      )}
    </Show>
  );
};
