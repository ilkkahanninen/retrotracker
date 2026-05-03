import { afterEach, describe, expect, it } from 'vitest';
import {
  __setLayoutMapForTests,
  keyLabel,
  remapPositionKeys,
} from '../src/state/keyboardLayout';

afterEach(() => { __setLayoutMapForTests(null); });

describe('keyLabel', () => {
  it('returns the input unchanged (uppercased) when no layout map is loaded', () => {
    // No layout map → fallback path. Single letters get uppercased to
    // match keycap convention; multi-char keys (no obvious "label")
    // pass through.
    expect(keyLabel('a')).toBe('A');
    expect(keyLabel('z')).toBe('Z');
    expect(keyLabel('arrowleft')).toBe('arrowleft');
  });

  it('translates QWERTY keys to AZERTY keycap labels when a layout map is supplied', () => {
    // Stub of `navigator.keyboard.getLayoutMap()` for a French AZERTY
    // keyboard — only the codes we exercise here are populated.
    const azerty = new Map<string, string>([
      ['KeyA', 'q'],   // QWERTY-A position has a Q keycap on AZERTY
      ['KeyW', 'z'],   // QWERTY-W position has a Z keycap
      ['KeyZ', 'w'],
      ['KeyQ', 'a'],
      ['Semicolon', 'm'],
    ]);
    __setLayoutMapForTests(azerty);

    expect(keyLabel('a')).toBe('Q');
    expect(keyLabel('w')).toBe('Z');
    expect(keyLabel('z')).toBe('W');
    // ';' is mapped to 'Semicolon'; the AZERTY keycap shows M. Keycaps
    // display uppercase by convention so the rendered label is 'M'.
    expect(keyLabel(';')).toBe('M');
  });

  it('falls back to the input when the code is not in the layout map', () => {
    __setLayoutMapForTests(new Map([['KeyA', 'q']]));
    expect(keyLabel('m')).toBe('M');
  });
});

describe('remapPositionKeys', () => {
  it('returns the input unchanged when no layout map is loaded', () => {
    expect(remapPositionKeys('A W S E D F T G Y H U J')).toBe('A W S E D F T G Y H U J');
    expect(remapPositionKeys('Z / X')).toBe('Z / X');
  });

  it('rewrites each letter to the user keyboard label, preserving separators', () => {
    const azerty = new Map<string, string>([
      ['KeyA', 'q'], ['KeyW', 'z'], ['KeyS', 's'], ['KeyE', 'e'],
      ['KeyD', 'd'], ['KeyF', 'f'], ['KeyT', 't'], ['KeyG', 'g'],
      ['KeyY', 'y'], ['KeyH', 'h'], ['KeyU', 'u'], ['KeyJ', 'j'],
      ['KeyZ', 'w'], ['KeyX', 'x'],
    ]);
    __setLayoutMapForTests(azerty);

    expect(remapPositionKeys('A W S E D F T G Y H U J')).toBe('Q Z S E D F T G Y H U J');
    expect(remapPositionKeys('Z / X')).toBe('W / X');
  });
});
