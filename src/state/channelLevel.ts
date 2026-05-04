import { createSignal } from 'solid-js';
import { CHANNELS } from '../core/mod/types';

/**
 * Per-channel peak amplitudes for the VU meter UI. Updated at ~30 Hz from
 * the audio worklet via `engine.onLevels`. Values are pre-pan absolute
 * peaks — typically [0, ~1.0] (PT max-volume sample) with occasional BLEP
 * overshoot. Components can clamp to 1 for display.
 *
 * Session-only; reset to zeros when no engine has fed an update yet, when
 * playback stops, and when the song changes.
 */
const initial = (): number[] => Array.from({ length: CHANNELS }, () => 0);

const [channelLevels, setChannelLevels] = createSignal<readonly number[]>(initial());

export { channelLevels, setChannelLevels };

export function resetChannelLevels(): void {
  setChannelLevels(initial());
}
