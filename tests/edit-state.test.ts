import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_OCTAVE, MIN_OCTAVE, clearFieldPatch, currentOctave, octaveDown, octaveUp, setCurrentOctave,
  MAX_EDIT_STEP, MIN_EDIT_STEP, editStep, incEditStep, decEditStep, setEditStep,
} from '../src/state/edit';
import type { Note } from '../src/core/mod/types';

describe('octave state', () => {
  afterEach(() => setCurrentOctave(2));

  it('defaults to 2', () => {
    expect(currentOctave()).toBe(2);
  });

  it('octaveUp clamps at MAX_OCTAVE', () => {
    setCurrentOctave(MAX_OCTAVE);
    octaveUp();
    expect(currentOctave()).toBe(MAX_OCTAVE);
  });

  it('octaveDown clamps at MIN_OCTAVE', () => {
    setCurrentOctave(MIN_OCTAVE);
    octaveDown();
    expect(currentOctave()).toBe(MIN_OCTAVE);
  });

  it('octaveUp/octaveDown move by one', () => {
    setCurrentOctave(2);
    octaveDown();
    expect(currentOctave()).toBe(1);
    octaveUp();
    octaveUp();
    expect(currentOctave()).toBe(3);
  });
});

describe('edit-step state', () => {
  afterEach(() => setEditStep(1));

  it('defaults to 1', () => {
    expect(editStep()).toBe(1);
  });

  it('incEditStep clamps at MAX_EDIT_STEP', () => {
    setEditStep(MAX_EDIT_STEP);
    incEditStep();
    expect(editStep()).toBe(MAX_EDIT_STEP);
  });

  it('decEditStep clamps at MIN_EDIT_STEP (0)', () => {
    setEditStep(MIN_EDIT_STEP);
    decEditStep();
    expect(editStep()).toBe(MIN_EDIT_STEP);
    expect(MIN_EDIT_STEP).toBe(0);
  });

  it('incEditStep / decEditStep move by one', () => {
    setEditStep(3);
    incEditStep();
    expect(editStep()).toBe(4);
    decEditStep();
    decEditStep();
    expect(editStep()).toBe(2);
  });
});

describe('clearFieldPatch', () => {
  const full: Note = { period: 428, sample: 7, effect: 0xC, effectParam: 0x4A };

  it('clears period AND sample when cursor is on note', () => {
    expect(clearFieldPatch(full, 'note')).toEqual({ period: 0, sample: 0 });
  });

  it('clears only the high nibble of sample', () => {
    expect(clearFieldPatch(full, 'sampleHi')).toEqual({ sample: 0x07 });
  });

  it('clears only the low nibble of sample', () => {
    expect(clearFieldPatch(full, 'sampleLo')).toEqual({ sample: 0x00 });
  });

  it('clears effect AND param when cursor is on the effect command', () => {
    expect(clearFieldPatch(full, 'effectCmd')).toEqual({ effect: 0, effectParam: 0 });
  });

  it('clears effect AND param when cursor is on the high nibble too', () => {
    // `.` from any of the three effect nibbles wipes the whole 3-nibble
    // column — partial clears would leave a half-typed effect that the
    // user has to keep tap-deleting until it's fully gone.
    expect(clearFieldPatch(full, 'effectHi')).toEqual({ effect: 0, effectParam: 0 });
  });

  it('clears effect AND param when cursor is on the low nibble too', () => {
    expect(clearFieldPatch(full, 'effectLo')).toEqual({ effect: 0, effectParam: 0 });
  });
});
