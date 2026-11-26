import { createMemo, createSignal } from "solid-js";
import { CHANNELS } from "../core/mod/types";
import { XM_MAX_CHANNELS } from "../core/xm/types";

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
/**
 * Flags are kept for every channel a song could ever have, and only the
 * first `channelCount` are exposed. Shrinking the channel count therefore
 * hides flags instead of destroying them: if the count grows back (most
 * commonly by undoing the shrink) the user's mutes and solos are still
 * there. Hidden flags never affect audibility — `isChannelMuted` reads
 * the exposed arrays only, so a solo on a removed channel can't silence
 * the rest.
 */
const MAX_CHANNELS = XM_MAX_CHANNELS;
const blank = (): boolean[] =>
  Array.from({ length: MAX_CHANNELS }, () => false);

const [mutedAll, setMutedAll] = createSignal<readonly boolean[]>(blank());
const [soloedAll, setSoloedAll] = createSignal<readonly boolean[]>(blank());
const [channelCount, setChannelCount] = createSignal(CHANNELS);

const clampCount = (n: number): number =>
  Math.max(0, Math.min(MAX_CHANNELS, Math.floor(n)));

const mutedChannels = createMemo<readonly boolean[]>(() =>
  mutedAll().slice(0, channelCount()),
);
const soloedChannels = createMemo<readonly boolean[]>(() =>
  soloedAll().slice(0, channelCount()),
);

export { mutedChannels, soloedChannels };

export function toggleMute(channel: number): void {
  if (channel < 0 || channel >= channelCount()) return;
  const arr = [...mutedAll()];
  arr[channel] = !arr[channel];
  setMutedAll(arr);
}

export function toggleSolo(channel: number): void {
  if (channel < 0 || channel >= channelCount()) return;
  const arr = [...soloedAll()];
  arr[channel] = !arr[channel];
  setSoloedAll(arr);
}

/**
 * Drop all mute and solo flags and (re)size the arrays. Called when the
 * song is replaced (Open / New) so the user doesn't carry "channel 3
 * muted" from one project into the next AND so the array length tracks
 * the new song's `channelCount`. Defaults to PT's 4 channels when the
 * caller doesn't yet know the format (e.g. boot).
 */
export function resetChannelMute(count: number = CHANNELS): void {
  setMutedAll(blank());
  setSoloedAll(blank());
  setChannelCount(clampCount(count));
}

/**
 * Change how many channels are exposed WITHOUT touching any flag. Used
 * when the loaded song's channel count changes (FT2 channel-count edit,
 * undo / redo of one): flags of channels that go away are kept hidden and
 * come back if the channels do.
 */
export function resizeChannelMute(count: number): void {
  setChannelCount(clampCount(count));
}

/**
 * Apply a saved mute/solo snapshot. Inputs are clamped to `channelCount`
 * in length and any non-boolean / out-of-range entry is treated as false,
 * so a malformed payload can't smuggle an undefined into the signals.
 * Used by the project-restore path so a `.retro` file remembers the
 * user's per-channel mute/solo state. Replaces every flag, hidden ones
 * included.
 */
export function setChannelMuteState(
  muted: readonly unknown[] | null | undefined,
  soloed: readonly unknown[] | null | undefined,
  count: number = CHANNELS,
): void {
  const n = clampCount(count);
  const sanitise = (xs: readonly unknown[] | null | undefined): boolean[] =>
    Array.from({ length: MAX_CHANNELS }, (_, i) => i < n && xs?.[i] === true);
  setMutedAll(sanitise(muted));
  setSoloedAll(sanitise(soloed));
  setChannelCount(n);
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
