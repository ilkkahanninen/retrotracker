import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  type Component,
} from "solid-js";

import { emptyXmInstrument } from "../core/xm/format";
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
  clearXmSampleSelection,
  setXmSampleSelection,
  xmSampleSelection,
} from "../state/xmSampleSelection";
import {
  addXmEnvelopePoint,
  addXmSample,
  patchXmAutoVibrato,
  patchXmInstrumentEnvelope,
  patchXmSample,
  removeXmEnvelopePoint,
  removeXmSample,
  renameXmInstrument,
  setXmEnvelopePoint,
  setXmFadeout,
} from "../state/xmInstrumentEdit";
import {
  addXmChainEnvelopePoint,
  addXmEffect,
  applyXmChainToSource,
  clearCurrentXmInstrument,
  convertXmChiptuneToSampler,
  copyXmSampleRange,
  cropXmCurrentSampleToSelection,
  cutXmSampleRange,
  duplicateCurrentXmSample,
  loadXmWavIntoCurrentSample,
  moveXmEffect,
  newXmChiptune,
  nudgeXmChainEnvelopeSegment,
  pasteXmSampleBytes,
  patchXmChainEnvelopePoint,
  patchXmEffect,
  removeXmChainEnvelopePoint,
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
import { xmSampleClipboard } from "../state/xmSampleClipboard";
import { getXmWorkbench } from "../state/xmSampleWorkbench";
import { defaultParamForKind } from "../state/selectedEffect";
import { dropWavsToXmInstrumentView } from "../state/dropImport";
import { setXmRightPanelCollapsed, xmRightPanelCollapsed } from "../state/view";
import {
  EFFECT_LABELS,
  PARAM_AXES,
  SOURCE_KINDS,
  SOURCE_LABELS,
  materializeSource,
  runChain,
  type EnvelopePoint,
  xmWorkbenchFromSample,
} from "../core/audio/sampleWorkbench";
import { ChiptuneEditor } from "./ChiptuneEditor";
import { EnvelopeEditor } from "./EnvelopeEditor";
import { Slider } from "./Slider";
import { XmAutoVibratoPreview } from "./XmAutoVibratoPreview";
import { XmKeyMapEditor } from "./XmKeyMapEditor";
import { XmPipelineEditor } from "./XmPipelineEditor";
import { XmWaveform, type XmWaveformEnvelopeOverlay } from "./XmWaveform";
import {
  EFFECT_BUTTON_KINDS,
  titleForEffectButton,
} from "./sampleEditorShared";

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

const XM_SAMPLE_NAME_MAX = 22;
const XM_MAX_SAMPLES_PER_INSTRUMENT = 16;

/**
 * FT2 instrument editor. The left column mirrors the PT2 SampleView
 * layout (header tabs + actions, sample-meta row, waveform, selection
 * toolbar with effect quick-adds, chiptune editor, DSP pipeline) so the
 * two editors feel identical. The collapsible right column hosts the
 * FT2-only instrument-scoped automation: key map (multi-sample only),
 * volume + panning envelopes, autovibrato + fadeout.
 */
export const InstrumentView: Component<Props> = (props) => {
  const slot1Based = () => currentXmInstrument();
  const instrument = (): XmInstrument | undefined =>
    props.song.instruments[slot1Based() - 1];

  // Reset to the first sample whenever the instrument switches.
  createEffect(() => {
    currentXmInstrument();
    setCurrentXmSampleIndex(0);
  });

  // Selections are bound to a specific buffer — drop them when the
  // active (instrument, sample) pair changes.
  createEffect(() => {
    currentXmInstrument();
    currentXmSampleIndex();
    clearXmSampleSelection();
  });

  // Clamp the sample index when the instrument's sample count shrinks.
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

  let wavInput: HTMLInputElement | undefined;

  const onPickWav = async (e: Event) => {
    const target = e.currentTarget as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    loadXmWavIntoCurrentSample(bytes, file.name);
    target.value = "";
  };

  // Inline-edit state for the per-sample chip rename. Matches the
  // SlotList double-click pattern (active when the editing index ===
  // this chip's index).
  const [editingChip, setEditingChip] = createSignal<number | null>(null);
  // Dropzone hover state — toggles the `.instrument-view--drop-target`
  // class so the editor can highlight while a WAV is dragged over it.
  const [dropActive, setDropActive] = createSignal(false);

  /**
   * Loop-type change is more involved than a plain field write: when the
   * user activates a loop, we adopt the current waveform selection as
   * the loop range (and clear it — the on-canvas handles take over),
   * falling back to the whole sample. Switching back to "none" leaves
   * the existing loopStart/Length values untouched so the user can flip
   * the loop on and off without losing their range.
   */
  const setXmSampleLoopType = (nextType: XmLoopType): void => {
    const inst = instrument();
    if (!inst) return;
    const sample = inst.samples[activeSampleIndex()];
    if (!sample) return;
    if (nextType === sample.loopType) return;
    if (nextType === "none") {
      patchXmSample(slot1Based(), { loopType: "none" }, activeSampleIndex());
      return;
    }
    // Activating a loop. Prefer the current selection; clamp to bounds.
    const sel = xmSampleSelection();
    const len = sample.data.length;
    let nextStart = 0;
    let nextLength = len;
    if (sel && sel.end - sel.start > 0 && len > 0) {
      nextStart = Math.max(0, Math.min(len - 1, sel.start));
      nextLength = Math.max(1, Math.min(len - nextStart, sel.end - sel.start));
      setXmSampleSelection(null);
    }
    patchXmSample(
      slot1Based(),
      { loopType: nextType, loopStart: nextStart, loopLength: nextLength },
      activeSampleIndex(),
    );
  };

  // Stable placeholder so an empty slot still renders the full editor
  // structure. Any mutation against an empty slot lazy-creates a real
  // instrument via withInstrumentAt in core/xm/mutations.ts, so reads
  // against this stand-in never need to mutate the song.
  const placeholderInstrument = emptyXmInstrument();

  const inst = () => instrument() ?? placeholderInstrument;
  const workbench = () => getXmWorkbench(slot1Based(), activeSampleIndex());
  const sourceKind = () => workbench()?.source.kind ?? "sampler";
  const chiptuneParams = () => {
    const src = workbench()?.source;
    if (!src || src.kind !== "chiptune") return null;
    return src.params;
  };
  const activeSample = () => inst().samples[activeSampleIndex()];
  const hasData = () => (activeSample()?.data.length ?? 0) > 0;

  return (() => {
    return (() => {
      // Envelope overlay payload for the on-canvas waveform editor.
      // Renders only when the user has selected a chain entry whose
      // (kind, param) combination owns an editable envelope. Mirrors
      // PT2 SampleView's `envelopeOverlay` memo.
      const envelopeOverlay = createMemo<XmWaveformEnvelopeOverlay | null>(
        () => {
          const wb = workbench();
          const idx = xmSelectedEffectIndex();
          const param = xmSelectedEffectParam();
          if (!wb || idx === null || param === null) return null;
          if (wb.source.kind === "chiptune") return null;
          const node = wb.chain[idx];
          if (!node) return null;
          const points: ReadonlyArray<EnvelopePoint> | null =
            param === "volume" && node.kind === "volume"
              ? node.params.points
              : param === "cutoff" && node.kind === "filter"
                ? node.params.cutoff
                : param === "q" && node.kind === "filter"
                  ? node.params.q
                  : param === "amount" && node.kind === "shaper"
                    ? node.params.amount
                    : param === "pitch" && node.kind === "pitch"
                      ? node.params.envelope
                      : null;
          if (!points) return null;
          const sample = activeSample();
          const sampleFrames = sample?.data.length ?? 0;
          if (sampleFrames <= 0) return null;
          // Chain output up to (but NOT including) the active effect —
          // that's the input the envelope sees, so its frames are the
          // X-axis domain. Same approach as PT.
          const stageInput = runChain(
            materializeSource(wb.source),
            wb.chain.slice(0, idx),
          );
          const sourceFrames = stageInput.channels[0]?.length ?? 0;
          if (sourceFrames <= 0) return null;
          return {
            points,
            axis: PARAM_AXES[param],
            sourceFrames,
            sampleFrames,
            onAddPoint: (p) => addXmChainEnvelopePoint(idx, param, p),
            onRemovePoint: (pi) => removeXmChainEnvelopePoint(idx, param, pi),
            onPatchPoint: (pi, next) =>
              patchXmChainEnvelopePoint(idx, param, pi, next),
            onNudgeSegment: (li, dv) =>
              nudgeXmChainEnvelopeSegment(idx, param, li, dv),
          };
        },
      );

      const dragHasFiles = (e: DragEvent): boolean =>
        !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
      const onWavDragOver = (e: DragEvent) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropActive(true);
      };
      const onWavDragLeave = (e: DragEvent) => {
        e.stopPropagation();
        setDropActive(false);
      };
      const onWavDrop = (e: DragEvent) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropActive(false);
        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;
        dropWavsToXmInstrumentView(Array.from(files));
      };

      return (
        <div
          class="instrument-view"
          classList={{
            "instrument-view--drop-target": dropActive(),
          }}
          onDragOver={onWavDragOver}
          onDragLeave={onWavDragLeave}
          onDrop={onWavDrop}
        >
          <div class="instrument-view__layout">
            <div class="instrument-view__main sampleview">
              {/* Header: source tabs + action buttons. Mirrors PT2's
                    .sampleview__header so the two editors share visual
                    chrome. */}
              <header class="sampleview__header">
                <div
                  class="source-picker"
                  role="tablist"
                  aria-label="Sample source"
                >
                  {SOURCE_KINDS.map((k) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={sourceKind() === k}
                      classList={{ "is-active": sourceKind() === k }}
                      title={`Use the ${SOURCE_LABELS[k]} source for this sample`}
                      onClick={() => setXmSourceKind(k)}
                    >
                      {SOURCE_LABELS[k]}
                    </button>
                  ))}
                </div>
                <div class="sampleview__actions">
                  <input
                    ref={(el) => (wavInput = el)}
                    type="file"
                    accept=".wav,audio/wav,audio/x-wav"
                    hidden
                    onChange={onPickWav}
                  />
                  <Show when={sourceKind() === "sampler"}>
                    <button
                      type="button"
                      class="file-button"
                      title="Load a WAV file into this sample"
                      onClick={() => wavInput?.click()}
                    >
                      Load WAV…
                    </button>
                  </Show>
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
                  <button
                    type="button"
                    onClick={duplicateCurrentXmSample}
                    disabled={
                      !hasData() ||
                      inst().samples.length >= XM_MAX_SAMPLES_PER_INSTRUMENT
                    }
                    title={
                      !hasData()
                        ? "Nothing to duplicate"
                        : inst().samples.length >= XM_MAX_SAMPLES_PER_INSTRUMENT
                          ? `Sample cap reached (${XM_MAX_SAMPLES_PER_INSTRUMENT})`
                          : "Copy this sample into the next free slot on the instrument"
                    }
                  >
                    Duplicate sample
                  </button>
                  <button
                    type="button"
                    onClick={clearCurrentXmInstrument}
                    title="Wipe the whole instrument (samples, envelopes, autovibrato, keymap)"
                  >
                    Clear instrument
                  </button>
                </div>
              </header>

              <Show when={activeSample()}>
                {(sample) => (
                  <>
                    {/* Sample meta row — mirrors PT2's .samplemeta.
                          The Name field renames the *instrument* (a
                          per-instrument property in XM); individual
                          samples are renamed by double-clicking their
                          chip below. */}
                    <div class="samplemeta">
                      <label>
                        <span class="samplemeta__label">Name</span>
                        <input
                          type="text"
                          maxLength={XM_SAMPLE_NAME_MAX}
                          value={inst().name}
                          placeholder="(unnamed instrument)"
                          onInput={(e) =>
                            renameXmInstrument(
                              slot1Based(),
                              e.currentTarget.value,
                            )
                          }
                        />
                      </label>
                      <label>
                        <span class="samplemeta__label">Length</span>
                        <span class="samplemeta__static">
                          {sample().data.length} samples ({sample().bits}-bit)
                        </span>
                      </label>
                      <label>
                        <span class="samplemeta__label">Rel. note</span>
                        <input
                          type="number"
                          min={-96}
                          max={95}
                          value={sample().relativeNote}
                          onInput={(e) =>
                            patchXmSample(
                              slot1Based(),
                              {
                                relativeNote: Number(e.currentTarget.value),
                              },
                              activeSampleIndex(),
                            )
                          }
                        />
                      </label>
                      <label>
                        <span class="samplemeta__label">Finetune</span>
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
                        <span class="samplemeta__label">Loop</span>
                        <select
                          value={sample().loopType}
                          onChange={(e) =>
                            setXmSampleLoopType(
                              e.currentTarget.value as XmLoopType,
                            )
                          }
                        >
                          {LOOP_TYPES.map((t) => (
                            <option value={t}>{t}</option>
                          ))}
                        </select>
                      </label>
                      {/* Force the wide sliders onto a second row so
                          Volume and Panning share the bottom line. */}
                      <div class="samplemeta__break" aria-hidden="true" />
                      <Slider
                        label={`Volume (0–64)`}
                        min={0}
                        max={64}
                        step={1}
                        value={sample().volume}
                        snap={(v) => Math.max(0, Math.min(64, Math.round(v)))}
                        format={(v) => `${Math.round(v)}`}
                        onInput={(v) =>
                          patchXmSample(
                            slot1Based(),
                            { volume: v },
                            activeSampleIndex(),
                          )
                        }
                      />
                      <Slider
                        label={`Panning`}
                        min={0}
                        max={255}
                        step={1}
                        value={sample().panning}
                        snap={(v) => Math.max(0, Math.min(255, Math.round(v)))}
                        format={(v) => {
                          const n = Math.round(v);
                          if (n === 128) return "C";
                          return n < 128 ? `L${128 - n}` : `R${n - 128}`;
                        }}
                        onInput={(v) =>
                          patchXmSample(
                            slot1Based(),
                            { panning: v },
                            activeSampleIndex(),
                          )
                        }
                      />
                    </div>

                    {/* Sample chips — sit right above the waveform so
                          switching the active sample feels adjacent to
                          editing it. Add / remove on the right keep the
                          chip list stable. */}
                    <div class="instrument-view__sample-list">
                      <For each={inst().samples}>
                        {(s, i) => {
                          const isEditing = () => editingChip() === i();
                          const submit = (value: string) => {
                            setEditingChip(null);
                            patchXmSample(
                              slot1Based(),
                              { name: value.slice(0, XM_SAMPLE_NAME_MAX) },
                              i(),
                            );
                          };
                          return (
                            <button
                              type="button"
                              class="instrument-view__sample-chip"
                              classList={{
                                "instrument-view__sample-chip--active":
                                  i() === activeSampleIndex(),
                                "instrument-view__sample-chip--editing":
                                  isEditing(),
                              }}
                              onClick={() => {
                                if (isEditing()) return;
                                setCurrentXmSampleIndex(i());
                              }}
                              onDblClick={() => setEditingChip(i())}
                              title={`Sample ${i()
                                .toString(16)
                                .toUpperCase()}: ${
                                s.name || "(unnamed)"
                              } — double-click to rename`}
                            >
                              <span class="instrument-view__sample-chip-idx">
                                {i().toString(16).toUpperCase()}
                              </span>
                              <Show
                                when={isEditing()}
                                fallback={
                                  <span class="instrument-view__sample-chip-name">
                                    {s.name || <em>(unnamed)</em>}
                                  </span>
                                }
                              >
                                <input
                                  class="instrument-view__sample-chip-input"
                                  type="text"
                                  maxLength={XM_SAMPLE_NAME_MAX}
                                  value={s.name}
                                  ref={(el) =>
                                    queueMicrotask(() => {
                                      el.focus();
                                      el.select();
                                    })
                                  }
                                  onClick={(e) => e.stopPropagation()}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      submit(e.currentTarget.value);
                                    } else if (e.key === "Escape") {
                                      e.preventDefault();
                                      setEditingChip(null);
                                    }
                                  }}
                                  onBlur={(e) => {
                                    if (editingChip() === i())
                                      submit(e.currentTarget.value);
                                  }}
                                />
                              </Show>
                            </button>
                          );
                        }}
                      </For>
                      <div class="instrument-view__sample-actions">
                        <button
                          type="button"
                          onClick={() => addXmSample(slot1Based())}
                          disabled={
                            inst().samples.length >=
                            XM_MAX_SAMPLES_PER_INSTRUMENT
                          }
                          title={`Add sample (max ${XM_MAX_SAMPLES_PER_INSTRUMENT})`}
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

                    <XmWaveform
                      sample={sample()}
                      selection={xmSampleSelection()}
                      onSelect={setXmSampleSelection}
                      selectable={
                        sample().data.length > 0 && sourceKind() !== "chiptune"
                      }
                      onPatch={(patch) =>
                        patchXmSample(slot1Based(), patch, activeSampleIndex())
                      }
                      envelope={envelopeOverlay()}
                    />

                    {/* Selection toolbar — same shape as PT2's
                          .sampleview__selection: clipboard ops + crop,
                          followed by quick-add effect buttons. Chiptune
                          mode hides the toolbar because the synth output
                          rebuilds on every param edit. */}
                    <Show when={sourceKind() !== "chiptune"}>
                      <div class="sampleview__selection">
                        {(() => {
                          const sel = () => xmSampleSelection();
                          const len = () => sample().data.length;
                          const range = () => {
                            const s = sel();
                            const l = len();
                            const start = s ? s.start : 0;
                            const end = s ? s.end : l;
                            return { start, end };
                          };
                          return (
                            <>
                              <button
                                type="button"
                                disabled={!hasData()}
                                title="Select the whole sample (⌘A)"
                                onClick={() =>
                                  setXmSampleSelection({
                                    start: 0,
                                    end: len(),
                                  })
                                }
                              >
                                Select all
                              </button>
                              <button
                                type="button"
                                disabled={!hasData()}
                                title="Copy the selection (or the whole sample) to the clipboard (⌘C)"
                                onClick={() => {
                                  const r = range();
                                  if (r.end - r.start < 1) return;
                                  copyXmSampleRange(r.start, r.end);
                                }}
                              >
                                Copy
                              </button>
                              <button
                                type="button"
                                disabled={!hasData()}
                                title="Copy and remove the selection (or the whole sample) (⌘X)"
                                onClick={() => {
                                  const r = range();
                                  if (r.end - r.start < 1) return;
                                  cutXmSampleRange(r.start, r.end);
                                  setXmSampleSelection(null);
                                }}
                              >
                                Cut
                              </button>
                              <button
                                type="button"
                                disabled={!xmSampleClipboard()}
                                title="Replace the sample with the clipboard contents (⌘V)"
                                onClick={pasteXmSampleBytes}
                              >
                                Paste
                              </button>
                              <button
                                type="button"
                                disabled={
                                  !sel() || sel()!.end - sel()!.start < 1
                                }
                                title="Keep the selected range, discard the rest"
                                onClick={() => {
                                  const s = sel();
                                  if (!s) return;
                                  cropXmCurrentSampleToSelection(
                                    s.start,
                                    s.end,
                                  );
                                }}
                              >
                                Crop
                              </button>
                              <For each={EFFECT_BUTTON_KINDS}>
                                {(kind) => {
                                  const requiresLoop = kind === "crossfade";
                                  const loopActive = () =>
                                    sample().loopType !== "none" &&
                                    sample().loopLength > 0;
                                  return (
                                    <button
                                      type="button"
                                      onClick={() => addXmEffect(kind)}
                                      disabled={
                                        !hasData() ||
                                        (requiresLoop && !loopActive())
                                      }
                                      title={
                                        requiresLoop && !loopActive()
                                          ? "Enable looping first — Crossfade smooths the loop join"
                                          : titleForEffectButton(
                                              kind,
                                              sel() !== null,
                                            )
                                      }
                                    >
                                      {EFFECT_LABELS[kind]}
                                    </button>
                                  );
                                }}
                              </For>
                              <Show when={sel()}>
                                <span class="sampleview__selection-info">
                                  Selection: frames {sel()!.start} –{" "}
                                  {sel()!.end} ({sel()!.end - sel()!.start}{" "}
                                  frames)
                                </span>
                              </Show>
                            </>
                          );
                        })()}
                      </div>
                    </Show>

                    <Show when={chiptuneParams()}>
                      {(params) => (
                        <ChiptuneEditor
                          params={params()}
                          disabled={false}
                          onUpdate={updateXmChiptune}
                        />
                      )}
                    </Show>

                    <Show when={sourceKind() !== "chiptune"}>
                      {(() => {
                        const wb = () => {
                          const existing = workbench();
                          if (existing) return existing;
                          return xmWorkbenchFromSample(
                            sample().data,
                            sample().bits,
                            sample().name,
                          );
                        };
                        return (
                          <XmPipelineEditor
                            wb={wb()}
                            onRemoveEffect={removeXmEffect}
                            onMoveEffect={moveXmEffect}
                            onPatchEffect={patchXmEffect}
                            onSetEffectBypass={setXmEffectBypass}
                            onApplyChain={applyXmChainToSource}
                            onSetMonoMix={setXmMonoMix}
                            onSetBitDepth={setXmBitDepth}
                            onSetDither={setXmDither}
                            selectedEffectIndex={xmSelectedEffectIndex()}
                            onSelectEffect={(i) => {
                              setXmSelectedEffectIndex(i);
                              // Auto-pick the right envelope param so
                              // the on-canvas overlay shows up the
                              // moment the user selects an effect.
                              if (i === null) {
                                setXmSelectedEffectParam(null);
                                return;
                              }
                              const node = wb().chain[i];
                              if (!node) return;
                              setXmSelectedEffectParam(
                                defaultParamForKind(node.kind),
                              );
                            }}
                            selectedEffectParam={xmSelectedEffectParam()}
                            onSelectParam={setXmSelectedEffectParam}
                          />
                        );
                      })()}
                    </Show>
                  </>
                )}
              </Show>
            </div>

            {/* Right column: FT2-only instrument-scoped automation
                  (key map + envelopes + autovibrato). Collapsible so the
                  user can give the sample editor the full width when
                  they're not editing automation. */}
            <aside
              class="instrument-view__rightcol"
              classList={{
                "instrument-view__rightcol--collapsed": xmRightPanelCollapsed(),
              }}
            >
              <button
                type="button"
                class="instrument-view__rightcol-toggle"
                onClick={() => setXmRightPanelCollapsed((c) => !c)}
                aria-expanded={!xmRightPanelCollapsed()}
                title={
                  xmRightPanelCollapsed()
                    ? "Expand instrument panel"
                    : "Collapse instrument panel"
                }
              >
                <span class="instrument-view__rightcol-toggle-icon">
                  {xmRightPanelCollapsed() ? "▸" : "▾"}
                </span>
                <span class="instrument-view__rightcol-toggle-label">
                  Instrument
                </span>
              </button>
              <Show when={!xmRightPanelCollapsed()}>
                <div class="instrument-view__rightcol-body">
                  <Show when={inst().samples.length > 1}>
                    <section class="instrument-view__section">
                      <h4 class="instrument-view__heading">Key map</h4>
                      <XmKeyMapEditor
                        instrument={inst()}
                        slot1Based={slot1Based()}
                      />
                    </section>
                  </Show>

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
                        patchXmInstrumentEnvelope(
                          slot1Based(),
                          "panning",
                          patch,
                        )
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

                  <section class="instrument-view__section">
                    <h4 class="instrument-view__heading">Autovibrato</h4>
                    <div class="instrument-view__row">
                      <label>
                        Waveform
                        <select
                          value={inst().vibratoType}
                          onChange={(e) =>
                            patchXmAutoVibrato(slot1Based(), {
                              vibratoType: e.currentTarget
                                .value as XmAutoVibratoType,
                            })
                          }
                        >
                          {VIBRATO_TYPES.map((t) => (
                            <option value={t}>{t}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div class="instrument-view__autovibrato">
                      <Slider
                        label="Sweep"
                        min={0}
                        max={255}
                        step={1}
                        value={inst().vibratoSweep}
                        snap={(v) => Math.max(0, Math.min(255, Math.round(v)))}
                        format={(v) => `${Math.round(v)}`}
                        onInput={(v) =>
                          patchXmAutoVibrato(slot1Based(), {
                            vibratoSweep: v,
                          })
                        }
                      />
                      <Slider
                        label="Depth"
                        min={0}
                        max={15}
                        step={1}
                        value={inst().vibratoDepth}
                        snap={(v) => Math.max(0, Math.min(15, Math.round(v)))}
                        format={(v) => `${Math.round(v)}`}
                        onInput={(v) =>
                          patchXmAutoVibrato(slot1Based(), {
                            vibratoDepth: v,
                          })
                        }
                      />
                      <Slider
                        label="Rate"
                        min={0}
                        max={63}
                        step={1}
                        value={inst().vibratoRate}
                        snap={(v) => Math.max(0, Math.min(63, Math.round(v)))}
                        format={(v) => `${Math.round(v)}`}
                        onInput={(v) =>
                          patchXmAutoVibrato(slot1Based(), {
                            vibratoRate: v,
                          })
                        }
                      />
                      <Slider
                        label="Fadeout"
                        min={0}
                        max={0xfff}
                        step={1}
                        value={inst().fadeout}
                        snap={(v) =>
                          Math.max(0, Math.min(0xfff, Math.round(v)))
                        }
                        format={(v) =>
                          `${Math.round(v)
                            .toString(16)
                            .padStart(3, "0")
                            .toUpperCase()}h`
                        }
                        onInput={(v) => setXmFadeout(slot1Based(), v)}
                      />
                    </div>
                    <XmAutoVibratoPreview
                      vibratoType={inst().vibratoType}
                      vibratoSweep={inst().vibratoSweep}
                      vibratoDepth={inst().vibratoDepth}
                      vibratoRate={inst().vibratoRate}
                    />
                  </section>
                </div>
              </Show>
            </aside>
          </div>
        </div>
      );
    })();
  })();
};
