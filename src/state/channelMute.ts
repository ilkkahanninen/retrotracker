import { createSignal } from "solid-js";
import { CHANNELS } from "../core/mod/types";

/**
 * Per-channel mute and solo state for live playback. Persisted in `.retro`
 * project files (re-applied via `setChannelMuteState` on restore) but not
 * in `.mod` / `.xm` (the formats have no slot for it). Cleared on every
 * song load so the previous song's mutes don't carry over to a fresh
 * open / new file.
 *
 * The signals are dynamic-length: PT2 uses 4 channels, FT2 anywhere from
 * 2..32. `resetChannelMute(n)` sizes the arrays to match the loaded
 * song's `channelCount`. Bounds checks read off the signal length so
 * `toggleMute` for an out-of-range channel silently no-ops.
 *
 * Mute and solo are independent flags; `isChannelMuted` combines them so
 * the user can hold a "muted" set and momentarily solo something without
 * losing which channels were muted before.
 */
const initial = (n: number): boolean[] =>
  Array.from({ length: Math.max(0, n) }, () => false);

const [mutedChannels, setMutedRaw] = createSignal<readonly boolean[]>(
  initial(CHANNELS),
);
const [soloedChannels, setSoloedRaw] = createSignal<readonly boolean[]>(
  initial(CHANNELS),
);

export { mutedChannels, soloedChannels };

export function toggleMute(channel: number): void {
  const arr = [...mutedChannels()];
  if (channel < 0 || channel >= arr.length) return;
  arr[channel] = !arr[channel];
  setMutedRaw(arr);
}

export function toggleSolo(channel: number): void {
  const arr = [...soloedChannels()];
  if (channel < 0 || channel >= arr.length) return;
  arr[channel] = !arr[channel];
  setSoloedRaw(arr);
}

/**
 * Drop all mute and solo flags and (re)size the arrays. Called when the
 * song is replaced (Open / New) so the user doesn't carry "channel 3
 * muted" from one project into the next AND so the array length tracks
 * the new song's `channelCount`. Defaults to PT's 4 channels when the
 * caller doesn't yet know the format (e.g. boot).
 */
export function resetChannelMute(channelCount: number = CHANNELS): void {
  setMutedRaw(initial(channelCount));
  setSoloedRaw(initial(channelCount));
}

/**
 * Apply a saved mute/solo snapshot. Inputs are clamped to `channelCount`
 * in length and any non-boolean / out-of-range entry is treated as false,
 * so a malformed payload can't smuggle an undefined into the signals.
 * Used by the project-restore path so a `.retro` file remembers the
 * user's per-channel mute/solo state.
 */
export function setChannelMuteState(
  muted: readonly unknown[] | null | undefined,
  soloed: readonly unknown[] | null | undefined,
  channelCount: number = CHANNELS,
): void {
  const sanitise = (xs: readonly unknown[] | null | undefined): boolean[] =>
    Array.from({ length: channelCount }, (_, i) => xs?.[i] === true);
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
