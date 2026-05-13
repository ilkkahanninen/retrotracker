import type { Component } from "solid-js";

import type { ProjectFormat } from "../core/song";

interface Props {
  format: ProjectFormat;
}

/**
 * Tiny "PT2" / "FT2" pill rendered next to the song title in the header.
 * Always visible so the user never wonders which mode they're editing in.
 */
export const ModeBadge: Component<Props> = (props) => (
  <span
    class={`mode-badge mode-badge--${props.format.toLowerCase()}`}
    title={
      props.format === "PT2"
        ? "ProTracker (.mod) — 4 channels"
        : "FastTracker 2 (.xm) — up to 32 channels"
    }
  >
    {props.format}
  </span>
);
