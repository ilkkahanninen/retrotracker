import { describe, expect, it } from 'vitest';
import { projectToBytes, projectFromBytes } from '../src/state/persistence';
import { defaultChiptuneParams } from '../src/core/audio/chiptune';
import { emptySong } from '../src/core/mod/format';
import { INITIAL_CURSOR } from '../src/state/cursor';

const baseInputs = () => ({
  song: emptySong(),
  filename: null,
  infoText: '',
  view: 'sample' as const,
  cursor: { ...INITIAL_CURSOR },
  currentSample: 1,
  currentOctave: 2,
  editStep: 1,
});

describe('persistence: chiptune source round-trip', () => {
  it('persists chiptune params per slot through projectToBytes / projectFromBytes', () => {
    // Pick a cycleFrames that's already on the musical (octave-aligned)
    // grid so the round-trip is bit-identical — `chiptuneFromJson` snaps
    // off-grid values, which is the right behaviour but would muddle this
    // assertion.
    const params = {
      ...defaultChiptuneParams(),
      cycleFrames: 128,
      amplitude: 0.7,
      osc1: { shapeIndex: 1.5, phaseSplit: 0.3, ratio: 2 },
      osc2: { shapeIndex: 2.75, phaseSplit: 0.6, ratio: 1 },
      combineMode: 'fm' as const,
      combineAmount: 0.4,
    };
    const bytes = projectToBytes({
      ...baseInputs(),
      chiptuneSources: { 0: params, 5: defaultChiptuneParams() },
    });
    const restored = projectFromBytes(bytes);
    expect(restored).not.toBeNull();
    expect(restored!.chiptuneSources).toEqual({ 0: params, 5: defaultChiptuneParams() });
  });

  it('omits chiptuneSources when the map is empty (back-compat with v=1 readers)', () => {
    const bytes = projectToBytes(baseInputs());
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    expect(parsed.v).toBe(1);
    expect(parsed.chiptuneSources).toBeUndefined();
  });

  it('writes v=2 when chiptune slots are present', () => {
    const bytes = projectToBytes({
      ...baseInputs(),
      chiptuneSources: { 0: defaultChiptuneParams() },
    });
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    expect(parsed.v).toBe(2);
  });

  it('drops slot entries with corrupt params instead of failing the whole load', () => {
    // Hand-craft a payload with one valid + one corrupt slot.
    const bytes = projectToBytes({
      ...baseInputs(),
      chiptuneSources: { 0: defaultChiptuneParams() },
    });
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    parsed.chiptuneSources['7'] = { combineMode: 'bogus' };
    const tampered = new TextEncoder().encode(JSON.stringify(parsed));
    const restored = projectFromBytes(tampered);
    expect(restored).not.toBeNull();
    expect(restored!.chiptuneSources).toEqual({ 0: defaultChiptuneParams() });
  });

  it('returns an empty chiptuneSources record for v=1 payloads', () => {
    // A "v=1" payload — same shape as today's bytes when no chiptune slots
    // exist. The loader must still yield a (materialised) empty record.
    const bytes = projectToBytes(baseInputs());
    const restored = projectFromBytes(bytes);
    expect(restored).not.toBeNull();
    expect(restored!.chiptuneSources).toEqual({});
  });
});
