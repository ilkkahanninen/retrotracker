import type { Component } from "solid-js";

import {
  sampleOffsetParam,
  type WaveformCursorInfo,
} from "./sampleEditorShared";

/** Pixel offset between the pointer and the readout. Keeps it visible
 *  without sitting directly under the pointer. */
const OFFSET_PX = 12;

/**
 * Pointer-anchored readout over a sample waveform: the frame under the
 * pointer and the `9xx` (Set Sample Offset) command that starts playback
 * there. Shared by the PT and FT2 waveforms; the parent box must be
 * `position: relative`.
 */
export const WaveformCursorReadout: Component<{ info: WaveformCursorInfo }> = (
  props,
) => (
  <div
    class="waveform__cursor-info"
    // Pin to the pointer with a small offset; flip to its left side near
    // the right edge so the readout isn't clipped by the waveform box.
    style={{
      left: `${
        props.info.flipLeft
          ? props.info.x - OFFSET_PX
          : props.info.x + OFFSET_PX
      }px`,
      top: `${props.info.y + OFFSET_PX}px`,
      transform: props.info.flipLeft ? "translateX(-100%)" : "",
    }}
  >
    <span>Frame: {props.info.frame}</span>
    <span>(cmd: {sampleOffsetParam(props.info.frame)})</span>
  </div>
);
