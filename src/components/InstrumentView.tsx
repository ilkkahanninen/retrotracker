import { Show, type Component } from "solid-js";

import type {
  XmAutoVibratoType,
  XmInstrument,
  XmLoopType,
  XmSong,
} from "../core/xm/types";
import { currentXmInstrument } from "../state/xmEdit";
import {
  addXmEnvelopePoint,
  patchXmAutoVibrato,
  patchXmInstrumentEnvelope,
  patchXmSample,
  removeXmEnvelopePoint,
  setXmEnvelopePoint,
  setXmFadeout,
} from "../state/xmInstrumentEdit";
import { EnvelopeEditor } from "./EnvelopeEditor";
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
 * panning envelopes, autovibrato, fadeout) plus a compact sample-meta
 * row for the inner sample (relative note, finetune, panning, loop). The
 * waveform preview, name field, and audio-level "in this slot" pieces
 * stay in the host `SampleView` so PT2 and FT2 share visual chrome.
 *
 * Phase 4 carries exactly one sample per instrument; the multi-sample
 * key-map editor lands later. Editing while the slot is empty is a
 * no-op — selecting an empty slot shows a placeholder hint to drop a
 * WAV.
 */
export const InstrumentView: Component<Props> = (props) => {
  const slot1Based = () => currentXmInstrument();
  const instrument = (): XmInstrument | undefined =>
    props.song.instruments[slot1Based() - 1];

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
          {/* Sample / waveform / instrument-level scalar fields sit
              at the top — they fit a single row each and give the
              user a quick read on what the instrument actually is
              before they edit envelope shapes underneath. */}
          <Show when={inst().samples[0]}>
            {(sample) => (
              <section class="instrument-view__section">
                <h4 class="instrument-view__heading">Sample</h4>
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
                        patchXmSample(slot1Based(), {
                          volume: Number(e.currentTarget.value),
                        })
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
                        patchXmSample(slot1Based(), {
                          finetune: Number(e.currentTarget.value),
                        })
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
                        patchXmSample(slot1Based(), {
                          panning: Number(e.currentTarget.value),
                        })
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
                        patchXmSample(slot1Based(), {
                          relativeNote: Number(e.currentTarget.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Loop
                    <select
                      value={sample().loopType}
                      onChange={(e) =>
                        patchXmSample(slot1Based(), {
                          loopType: e.currentTarget.value as XmLoopType,
                        })
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
                        patchXmSample(slot1Based(), {
                          loopStart: Number(e.currentTarget.value),
                        })
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
                        patchXmSample(slot1Based(), {
                          loopLength: Number(e.currentTarget.value),
                        })
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

          {/* Envelopes go side-by-side when the pane is wide enough;
              fall back to a single column below the breakpoint. */}
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
