import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isChannelMuted,
  mutedChannels,
  resetChannelMute,
  setChannelMuteState,
  soloedChannels,
  toggleMute,
  toggleSolo,
} from "~/state/channelMute";
import {
  channelLevels,
  resetChannelLevels,
  setChannelLevels,
} from "~/state/channelLevel";

beforeEach(() => {
  resetChannelMute(4);
  resetChannelLevels(4);
});
afterEach(() => {
  resetChannelMute(4);
  resetChannelLevels(4);
});

describe("channelMute: dynamic length", () => {
  it("resetChannelMute(n) sizes the arrays to n", () => {
    resetChannelMute(16);
    expect(mutedChannels().length).toBe(16);
    expect(soloedChannels().length).toBe(16);
  });

  it("toggleMute respects the current array length", () => {
    resetChannelMute(8);
    toggleMute(7);
    expect(mutedChannels()[7]).toBe(true);
    // Out-of-range — silently no-op.
    toggleMute(99);
    expect(mutedChannels().length).toBe(8);
  });

  it("toggleSolo also bounds-checks against array length", () => {
    resetChannelMute(8);
    toggleSolo(0);
    toggleSolo(99);
    expect(soloedChannels()[0]).toBe(true);
    expect(soloedChannels().length).toBe(8);
  });

  it("setChannelMuteState honours the channelCount param", () => {
    setChannelMuteState([true, false, true, false], [], 16);
    expect(mutedChannels().length).toBe(16);
    expect(mutedChannels()[0]).toBe(true);
    expect(mutedChannels()[2]).toBe(true);
    expect(mutedChannels()[15]).toBe(false);
  });

  it("isChannelMuted: solo overrides mute when any channel is solo'd", () => {
    resetChannelMute(8);
    toggleMute(0);
    toggleMute(1);
    toggleSolo(2);
    expect(isChannelMuted(0)).toBe(true);
    expect(isChannelMuted(1)).toBe(true);
    // Channel 2 is solo'd — audible (not muted).
    expect(isChannelMuted(2)).toBe(false);
    // Channel 3 isn't muted but isn't solo'd either; with solo active,
    // only solo'd channels are audible.
    expect(isChannelMuted(3)).toBe(true);
  });
});

describe("channelLevel: dynamic length", () => {
  it("resetChannelLevels(n) sizes the array to n", () => {
    resetChannelLevels(32);
    expect(channelLevels().length).toBe(32);
  });

  it("setChannelLevels accepts arbitrary-length arrays", () => {
    resetChannelLevels(16);
    setChannelLevels([0.1, 0.2, 0.3]);
    expect(channelLevels().length).toBe(3);
  });
});
