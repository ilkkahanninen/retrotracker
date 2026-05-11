import { createSignal } from "solid-js";
import { CHANNELS } from "../core/mod/types";

/**
 * Per-channel peak amplitudes for the VU meter UI. Updated at ~30 Hz from
 * the audio worklet via `engine.onLevels`. Values are pre-pan absolute
 * peaks — typically [0, ~1.0] (PT max-volume sample) with occasional BLEP
 * overshoot. Components can clamp to 1 for display.
 *
 * Dynamic-length: PT uses 4 entries, FT2 anywhere from 2..32.
 * `resetChannelLevels(n)` sizes the array to match the loaded song.
 *
 * Session-only; reset to zeros when no engine has fed an update yet, when
 * playback stops, and when the song changes.
 */
const initial = (n: number): number[] =>
  Array.from({ length: Math.max(0, n) }, () => 0);

const [channelLevels, setChannelLevels] = createSignal<readonly number[]>(
  initial(CHANNELS),
);

export { channelLevels, setChannelLevels };

export function resetChannelLevels(channelCount: number = CHANNELS): void {
  setChannelLevels(initial(channelCount));
}
