import { createSignal } from "solid-js";
import { CHANNELS } from "../core/mod/types";

/**
 * Per-channel mute and solo state for live playback. Kept session-only —
 * never serialised into the .mod, never reset on song load. Mute and solo
 * are independent flags; `isChannelMuted` combines them so the user can
 * hold a "muted" set and momentarily solo something without losing which
 * channels were muted before.
 */
const initial = (): boolean[] => Array.from({ length: CHANNELS }, () => false);

const [mutedChannels, setMutedRaw] =
  createSignal<readonly boolean[]>(initial());
const [soloedChannels, setSoloedRaw] =
  createSignal<readonly boolean[]>(initial());

export { mutedChannels, soloedChannels };

export function toggleMute(channel: number): void {
  if (channel < 0 || channel >= CHANNELS) return;
  const arr = [...mutedChannels()];
  arr[channel] = !arr[channel];
  setMutedRaw(arr);
}

export function toggleSolo(channel: number): void {
  if (channel < 0 || channel >= CHANNELS) return;
  const arr = [...soloedChannels()];
  arr[channel] = !arr[channel];
  setSoloedRaw(arr);
}

/**
 * Drop all mute and solo flags. Called when the song is replaced (Open /
 * New) so the user doesn't carry "channel 3 muted" from one project into
 * the next.
 */
export function resetChannelMute(): void {
  setMutedRaw(initial());
  setSoloedRaw(initial());
}

/**
 * Apply a saved mute/solo snapshot. Inputs are clamped to CHANNELS in
 * length and any non-boolean / out-of-range entry is treated as false,
 * so a malformed payload can't smuggle an undefined into the signals.
 * Used by the project-restore path so a `.retro` file remembers the
 * user's per-channel mute/solo state.
 */
export function setChannelMuteState(
  muted: readonly unknown[] | null | undefined,
  soloed: readonly unknown[] | null | undefined,
): void {
  const sanitise = (xs: readonly unknown[] | null | undefined): boolean[] =>
    Array.from({ length: CHANNELS }, (_, i) => xs?.[i] === true);
  setMutedRaw(sanitise(muted));
  setSoloedRaw(sanitise(soloed));
}

/**
 * Effective audibility for the live mixer. When at least one channel is
 * solo'd, only solo'd channels are audible (mute on those is overridden);
 * otherwise the muted flag decides. Reactive — call inside an effect /
 * tracking scope to subscribe to both signals.
 */
export function isChannelMuted(channel: number): boolean {
  const solo = soloedChannels();
  const anySolo = solo.some((b) => b);
  if (anySolo) return !solo[channel];
  return !!mutedChannels()[channel];
}
