/**
 * Pure helpers for the worklet's per-channel mute cache.
 *
 * The cache has to accept a flag for ANY channel at ANY time: the engine
 * sync effect posts the user's mutes as soon as the engine exists, which
 * is before the first `load` has told the worklet how many channels the
 * song has. The cache used to start at 4 entries and drop every flag for
 * a channel beyond its current length, so muting channel 6 of an FT2 song
 * before the first Play was silently lost — the UI showed it muted while
 * it played.
 */

import { XM_MAX_CHANNELS } from "../xm/types";

/** FT2's channel cap — upper bound for a flag we're willing to cache. */
export const MAX_MUTE_CHANNELS = XM_MAX_CHANNELS;

/**
 * Record `muted` for `channel`, growing the array when the channel lies
 * past its end. Returns the (possibly new) array; out-of-range channels
 * leave it untouched.
 */
export function withMuteFlag(
  flags: boolean[],
  channel: number,
  muted: boolean,
): boolean[] {
  if (!Number.isInteger(channel)) return flags;
  if (channel < 0 || channel >= MAX_MUTE_CHANNELS) return flags;
  if (channel < flags.length) {
    flags[channel] = muted;
    return flags;
  }
  const next = flags.slice();
  while (next.length <= channel) next.push(false);
  next[channel] = muted;
  return next;
}

/**
 * Resize to exactly `n` channels for a freshly loaded song, keeping the
 * flags of channels that still exist. Returns the same array when the
 * length already matches.
 */
export function resizeMuteFlags(flags: boolean[], n: number): boolean[] {
  if (flags.length === n) return flags;
  const next = new Array<boolean>(Math.max(0, n)).fill(false);
  for (let i = 0; i < Math.min(next.length, flags.length); i++) {
    next[i] = flags[i] ?? false;
  }
  return next;
}
