import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import type { Note, Song } from "../core/mod/types";
import { PERIOD_TABLE } from "../core/mod/format";
import type { Cursor, Field } from "../state/cursor";
import { selection } from "../state/selection";
import { registerShortcut } from "../state/shortcuts";
import { view } from "../state/view";
import { remapPositionKeys } from "../state/keyboardLayout";
import { ALT_LABEL, MOD_LABEL } from "../state/platform";

const NOTE_NAMES = [
  "C-",
  "C#",
  "D-",
  "D#",
  "E-",
  "F-",
  "F#",
  "G-",
  "G#",
  "A-",
  "A#",
  "B-",
] as const;

/**
 * Map a stored Paula period back to its note slot (finetune-0 row, first
 * matching slot scan — same routine pt2-clone uses in setPeriod). Returns
 * null when the period is 0 (no note).
 */
function periodToNoteName(period: number): string | null {
  if (period === 0) return null;
  const row = PERIOD_TABLE[0]!;
  for (let i = 0; i < row.length; i++) {
    if (period >= row[i]!) {
      const oct = 1 + Math.floor(i / 12);
      return `${NOTE_NAMES[i % 12]}${oct}`;
    }
  }
  return "???";
}

/**
 * Break an effect command + parameter byte into a human-readable
 * explanation. `null` means "no effect" (effect=0, param=0). Effects with
 * independent nibbles populate `hi` and `lo`; effects with a combined
 * 8-bit parameter populate `param`. Field naming mirrors PT documentation
 * so a curious user can search for the canonical reference.
 */
interface EffectExplanation {
  /** Display name, e.g. "Vibrato". */
  name: string;
  /** What the high nibble means, when nibbles are independent. */
  hi?: string;
  /** What the low nibble means, when nibbles are independent. */
  lo?: string;
  /** What the whole xx parameter means, when nibbles fuse. */
  param?: string;
}

function explainEffect(
  effect: number,
  paramByte: number,
): EffectExplanation | null {
  if (effect === 0 && paramByte === 0) return null;
  const hi = (paramByte >> 4) & 0xf;
  const lo = paramByte & 0xf;
  switch (effect) {
    case 0x0:
      return {
        name: "Arpeggio",
        hi: "halftones up (1st tick)",
        lo: "halftones up (2nd tick)",
      };
    case 0x1:
      return { name: "Slide up", param: "period units / tick" };
    case 0x2:
      return { name: "Slide down", param: "period units / tick" };
    case 0x3:
      return { name: "Tone portamento", param: "slide speed (0 = continue)" };
    case 0x4:
      return { name: "Vibrato", hi: "speed", lo: "depth" };
    case 0x5:
      return {
        name: "Tone portamento + volume slide",
        hi: "volume up",
        lo: "volume down",
      };
    case 0x6:
      return {
        name: "Vibrato + volume slide",
        hi: "volume up",
        lo: "volume down",
      };
    case 0x7:
      return { name: "Tremolo", hi: "speed", lo: "depth" };
    case 0x8:
      return {
        name: "Set panning (ignored in PT 2.3D)",
        param: "pan position",
      };
    case 0x9:
      return {
        name: "Sample offset",
        param: `start at $${paramByte.toString(16).toUpperCase().padStart(2, "0")}00 bytes`,
      };
    case 0xa:
      return { name: "Volume slide", hi: "volume up", lo: "volume down" };
    case 0xb:
      return {
        name: "Position jump",
        param: `to order $${paramByte.toString(16).toUpperCase().padStart(2, "0")}`,
      };
    case 0xc:
      return { name: "Set volume", param: `${paramByte} (0..64)` };
    case 0xd:
      return {
        name: "Pattern break",
        param: `to row ${hi * 10 + lo} (decimal xy)`,
      };
    case 0xe:
      return explainExtended(hi, lo);
    case 0xf:
      if (paramByte === 0)
        return { name: "Stop song", param: "F00 halts playback" };
      return paramByte < 0x20
        ? { name: "Set speed", param: `${paramByte} ticks/row` }
        : { name: "Set tempo", param: `${paramByte} BPM` };
    default:
      return {
        name: `Effect ${effect.toString(16).toUpperCase()}`,
        param: "unknown",
      };
  }
}

function explainExtended(sub: number, val: number): EffectExplanation {
  const WAVES = ["sine", "ramp", "square", "random"] as const;
  switch (sub) {
    case 0x0:
      return {
        name: "E0x Set filter",
        param: val === 0 ? "LED filter off" : "LED filter on",
      };
    case 0x1:
      return { name: "E1x Fine slide up", param: `${val} period units` };
    case 0x2:
      return { name: "E2x Fine slide down", param: `${val} period units` };
    case 0x3:
      return {
        name: "E3x Glissando",
        param: val === 0 ? "off" : "on (snap to halftone)",
      };
    case 0x4:
      return { name: "E4x Vibrato waveform", param: WAVES[val & 3]! };
    case 0x5:
      return {
        name: "E5x Set finetune",
        param: val < 8 ? `+${val}` : `${val - 16}`,
      };
    case 0x6:
      return {
        name: "E6x Pattern loop",
        param: val === 0 ? "set loop point" : `play ${val}× more`,
      };
    case 0x7:
      return { name: "E7x Tremolo waveform", param: WAVES[val & 3]! };
    case 0x8:
      return { name: "E8x Unused", param: "no effect" };
    case 0x9:
      return { name: "E9x Retrigger", param: `every ${val} ticks` };
    case 0xa:
      return { name: "EAx Fine volume up", param: `+${val}` };
    case 0xb:
      return { name: "EBx Fine volume down", param: `-${val}` };
    case 0xc:
      return { name: "ECx Note cut", param: `at tick ${val}` };
    case 0xd:
      return { name: "EDx Note delay", param: `${val} ticks` };
    case 0xe:
      return { name: "EEx Pattern delay", param: `${val} rows` };
    case 0xf:
      return { name: "EFx Invert loop", param: `speed ${val}` };
    default:
      return {
        name: `Extended E${sub.toString(16).toUpperCase()}x`,
        param: "unknown",
      };
  }
}

function effectCellText(note: Note): string {
  if (note.effect === 0 && note.effectParam === 0) return "...";
  const cmd = note.effect.toString(16).toUpperCase();
  const hi = ((note.effectParam >> 4) & 0xf).toString(16).toUpperCase();
  const lo = (note.effectParam & 0xf).toString(16).toUpperCase();
  return `${cmd}${hi}${lo}`;
}

// ── Tip sections ────────────────────────────────────────────────────────
//
// Static tables of (keys, action) pairs. Picked at render time based on
// where the cursor is and whether a selection is active. Keys are rendered
// as <kbd> chips; the `keys` string can hold multiple comma-separated
// chips ("⌘C, ⌘X") or a span of glyphs to show as one block (the
// piano-keys row uses one chip with all 17 letters in it).
//
// Synced manually with the registerShortcut calls in App.tsx — there's no
// runtime registry to query, but the shortcut list is small enough that a
// small drift in the help text is preferable to building one.

interface Tip {
  keys: string;
  action: string;
  /**
   * When true the `keys` string is a sequence of QWERTY-position glyphs
   * — render-time `remapPositionKeys` rewrites each letter / mapped
   * punctuation to the user's actual keycap label. Use for piano keys
   * and Z/X octave; leave false for character-named shortcuts (Cmd+S)
   * and pure punctuation (`[`, `]`, `,`).
   */
  position?: boolean;
}
interface TipSection {
  title: string;
  items: Tip[];
}

const NOTE_TIPS: TipSection[] = [
  {
    title: "Note entry",
    items: [
      {
        keys: "A W S E D F T G Y H U J",
        action: "piano (current octave)",
        position: true,
      },
      { keys: "K O L P ;", action: "piano (octave + 1)", position: true },
      { keys: "Shift + piano key", action: "preview note (no commit)" },
      { keys: "Z / X", action: "octave − / +", position: true },
      { keys: ".", action: "clear field" },
      { keys: "Backspace", action: "pull cell up" },
      { keys: "Shift + Backspace", action: "pull row up" },
      { keys: "Return", action: "push cell down" },
      { keys: "Shift + Return", action: "push row down" },
    ],
  },
  {
    title: "Edit step",
    items: [
      // `< / >` and `/` are position-mapped (Comma / Period / Slash physical
      // keys). The renderer remaps each glyph to the user's keycap label
      // via `remapPositionKeys`, so a Nordic user sees the right keycap.
      { keys: "< / >", action: "edit step − / +", position: true },
      { keys: "/", action: "reset edit step to 1", position: true },
    ],
  },
  {
    title: "Order / pattern",
    items: [
      {
        keys: "[ / ]",
        action: "previous / next pattern at slot",
        position: true,
      },
      // Chord help strings stay literal — `remapPositionKeys` is per-character
      // and would mangle "Cmd"-style words on non-QWERTY layouts.
      { keys: `${MOD_LABEL} + [`, action: "delete order slot" },
      { keys: `${MOD_LABEL} + ]`, action: "insert order slot" },
      { keys: `${ALT_LABEL} + [`, action: "new blank pattern at slot" },
      { keys: `${ALT_LABEL} + ]`, action: "duplicate pattern at slot" },
    ],
  },
  {
    title: "Sample",
    items: [
      { keys: "1 – 0", action: "select samples 1 – 10" },
      { keys: "Shift + 1 – 0", action: "select samples 11 – 20" },
      {
        keys: `${ALT_LABEL} + Arrow up / down`,
        action: "previous / next sample",
      },
    ],
  },
  {
    title: "Play",
    items: [
      { keys: "Space", action: "play song / stop" },
      { keys: `${ALT_LABEL} + Space`, action: "play pattern (loop)" },
      { keys: "Shift + Space", action: "play song from cursor" },
      {
        keys: `${ALT_LABEL} + Shift + Space`,
        action: "play pattern from cursor",
      },
    ],
  },
  {
    title: "Channels",
    items: [
      { keys: `${ALT_LABEL} + 1 – 4`, action: "mute channel" },
      { keys: `${ALT_LABEL} + Shift + 1 – 4`, action: "solo channel" },
    ],
  },
];

/**
 * The 16 effect command codes in PT order. Names are short on purpose —
 * this is a quick reference, not an effect manual; the cell breakdown
 * above already shows the full description for whatever the user typed.
 * 8xy is intentionally listed as "(unused)" because PT 2.3D ignores it
 * and our replayer does the same.
 */
const EFFECT_LIST: ReadonlyArray<{ code: string; name: string }> = [
  { code: "0xy", name: "Arpeggio" },
  { code: "1xx", name: "Slide up" },
  { code: "2xx", name: "Slide down" },
  { code: "3xx", name: "Tone portamento" },
  { code: "4xy", name: "Vibrato" },
  { code: "5xy", name: "Tone porta + vol slide" },
  { code: "6xy", name: "Vibrato + vol slide" },
  { code: "7xy", name: "Tremolo" },
  { code: "8xx", name: "(unused in PT 2.3D)" },
  { code: "9xx", name: "Sample offset" },
  { code: "Axy", name: "Volume slide" },
  { code: "Bxx", name: "Position jump" },
  { code: "Cxx", name: "Set volume" },
  { code: "Dxy", name: "Pattern break" },
  { code: "Exy", name: "Extended (E0..EF)" },
  { code: "Fxx", name: "Speed (<$20) / Tempo (≥$20)" },
];

/**
 * The 16 extended effect sub-commands (Exy, where x picks one of these
 * and y is the value). E8x and "unused" entries are kept in the list for
 * completeness — a tracker following PT 2.3D ignores them, but a curious
 * user reading the help shouldn't wonder whether they were forgotten.
 */
const EXTENDED_EFFECT_LIST: ReadonlyArray<{ code: string; name: string }> = [
  { code: "E0x", name: "Set filter (LED on/off)" },
  { code: "E1x", name: "Fine slide up" },
  { code: "E2x", name: "Fine slide down" },
  { code: "E3x", name: "Glissando on/off" },
  { code: "E4x", name: "Vibrato waveform" },
  { code: "E5x", name: "Set finetune" },
  { code: "E6x", name: "Pattern loop" },
  { code: "E7x", name: "Tremolo waveform" },
  { code: "E8x", name: "(unused in PT 2.3D)" },
  { code: "E9x", name: "Retrigger note" },
  { code: "EAx", name: "Fine volume up" },
  { code: "EBx", name: "Fine volume down" },
  { code: "ECx", name: "Note cut" },
  { code: "EDx", name: "Note delay" },
  { code: "EEx", name: "Pattern delay" },
  { code: "EFx", name: "Invert loop" },
];

const EFFECT_TIPS: TipSection[] = [
  {
    title: "Hex digits",
    items: [
      { keys: "0 – 9, A – F", action: "enter nibble" },
      { keys: ".", action: "clear field" },
      { keys: ",", action: "repeat last effect" },
    ],
  },
];

/** Transpose works on a single cell or a whole selection — it's relevant
 *  in both the note-column and selection contexts, so we show it in
 *  either mode rather than burying it inside one of them. */
const TRANSPOSE_TIPS: TipSection = {
  title: "Transpose",
  items: [
    { keys: "Shift + − / =", action: "transpose −/+ semitone" },
    { keys: `${MOD_LABEL} + Shift + − / =`, action: "transpose −/+ octave" },
  ],
};

const SELECTION_TIPS: TipSection = {
  title: "Selection",
  items: [
    { keys: `${MOD_LABEL} + C`, action: "copy" },
    { keys: `${MOD_LABEL} + X`, action: "cut" },
    { keys: `${MOD_LABEL} + V`, action: "paste at cursor" },
    { keys: `${MOD_LABEL} + A`, action: "select all (channel, then pattern)" },
    { keys: `${MOD_LABEL} + E`, action: "bounce to next free sample slot" },
    { keys: "Shift + arrows", action: "extend selection" },
    { keys: "Backspace", action: "clear cells" },
  ],
};

/** True when the cursor field addresses any part of the effect column. */
function isEffectField(f: Field): boolean {
  return f === "effectCmd" || f === "effectHi" || f === "effectLo";
}

interface Props {
  song: Song;
  cursor: Cursor;
}

/**
 * Inline help pane for the pattern view. Reads the cell under the edit
 * cursor and shows what's there (note, sample, effect breakdown) without
 * the user having to remember PT effect codes. Hidden during playback
 * isn't necessary — the cursor still has a position then; the help just
 * describes wherever it is.
 *
 * A "Tips" toggle expands the pane with context-sensitive shortcut help:
 * note-entry / edit-step / sample / play tips on the note column, the
 * full effect-code list on the effect columns, and copy / paste tips
 * whenever a selection is active. The toggle state is local to the
 * component — the pattern view stays mounted (`view-hidden` toggle, not
 * unmount), so the user's preference survives view switches.
 */
export const PatternHelp: Component<Props> = (props) => {
  const [tipsOpen, setTipsOpen] = createSignal(false);

  // `?` (Shift+/ on US, also Shift+- on Nordic) toggles the tips block.
  // We register by `/` + shift because the shortcut matcher's KEY_CODE_MAP
  // includes `'/' → 'Slash'`, so the codeMatches path catches the keypress
  // regardless of how `event.key` resolves under shift across layouts and
  // jsdom. Restrict to pattern view because the help pane only exists there.
  onMount(() => {
    const cleanup = registerShortcut({
      key: "/",
      shift: true,
      description: "Toggle pattern-view help tips (?)",
      when: () => view() === "pattern",
      run: () => setTipsOpen((v) => !v),
    });
    onCleanup(cleanup);
  });

  const tipSections = (): TipSection[] => {
    // Selection active → selection management + transpose. Transpose
    // operates on the selection rectangle, so it earns a slot here even
    // though everything else collapses away to keep the user focused.
    if (selection() !== null) return [SELECTION_TIPS, TRANSPOSE_TIPS];
    // No selection: show context tips for the field. The note column
    // also gets transpose + selection tips so the user discovers
    // Shift+arrows / Cmd+C/V / transpose before making a first selection.
    if (isEffectField(props.cursor.field)) return [...EFFECT_TIPS];
    return [...NOTE_TIPS, TRANSPOSE_TIPS, SELECTION_TIPS];
  };

  const showEffectList = () =>
    isEffectField(props.cursor.field) && selection() === null;

  const cell = (): Note | null => {
    const patNum = props.song.orders[props.cursor.order];
    if (patNum === undefined) return null;
    const pat = props.song.patterns[patNum];
    if (!pat) return null;
    return pat.rows[props.cursor.row]?.[props.cursor.channel] ?? null;
  };

  const noteName = () => {
    const c = cell();
    return c ? periodToNoteName(c.period) : null;
  };

  const sampleSlot = () => {
    const c = cell();
    return c && c.sample > 0 ? c.sample : null;
  };

  const sampleName = () => {
    const slot = sampleSlot();
    if (slot === null) return null;
    return props.song.samples[slot - 1]?.name ?? "";
  };

  const effect = () => {
    const c = cell();
    return c ? explainEffect(c.effect, c.effectParam) : null;
  };

  return (
    <div class="patternhelp" classList={{ "patternhelp--open": tipsOpen() }}>
      <div class="patternhelp__row">
        <span class="patternhelp__seg">
          <span class="patternhelp__label">Note</span>
          <span class="patternhelp__value">
            <Show
              when={noteName()}
              fallback={<span class="patternhelp__muted">—</span>}
            >
              {(n) => <>{n()}</>}
            </Show>
          </span>
        </span>
        <span class="patternhelp__seg">
          <span class="patternhelp__label">Sample</span>
          <span class="patternhelp__value">
            <Show
              when={sampleSlot() !== null}
              fallback={<span class="patternhelp__muted">— (no change)</span>}
            >
              {(() => {
                const slot = sampleSlot()!;
                const name = sampleName();
                return (
                  <>
                    {slot.toString(16).toUpperCase().padStart(2, "0")}
                    <Show when={name}>
                      <span class="patternhelp__sub"> · {name}</span>
                    </Show>
                  </>
                );
              })()}
            </Show>
          </span>
        </span>
        <span class="patternhelp__seg patternhelp__seg--wide">
          <span class="patternhelp__label">Effect</span>
          <span class="patternhelp__value">
            <Show
              when={effect()}
              fallback={
                <>
                  <span class="patternhelp__mono">
                    {cell() ? effectCellText(cell()!) : "..."}
                  </span>
                  <span class="patternhelp__muted"> · none</span>
                </>
              }
            >
              {(ex) => (
                <>
                  <span class="patternhelp__mono">
                    {effectCellText(cell()!)}
                  </span>
                  <span class="patternhelp__sub"> · {ex().name}</span>
                  <Show when={ex().param}>
                    {(p) => <span class="patternhelp__sub"> ({p()})</span>}
                  </Show>
                  <Show when={ex().hi !== undefined && ex().lo !== undefined}>
                    {(() => {
                      const c = cell()!;
                      const hi = ((c.effectParam >> 4) & 0xf)
                        .toString(16)
                        .toUpperCase();
                      const lo = (c.effectParam & 0xf)
                        .toString(16)
                        .toUpperCase();
                      return (
                        <span class="patternhelp__sub">
                          {" "}
                          ({hi} = {ex().hi}, {lo} = {ex().lo})
                        </span>
                      );
                    })()}
                  </Show>
                </>
              )}
            </Show>
          </span>
        </span>
        <button
          type="button"
          class="patternhelp__toggle"
          onClick={() => setTipsOpen((v) => !v)}
          aria-expanded={tipsOpen()}
          aria-controls="patternhelp-tips"
          title={tipsOpen() ? "Hide tips (?)" : "Show tips (?)"}
        >
          {tipsOpen() ? "Hide tips" : "Show tips"}
        </button>
      </div>
      <Show when={tipsOpen()}>
        <div class="patternhelp__tips" id="patternhelp-tips">
          <For each={tipSections()}>
            {(section) => (
              <section class="patternhelp__tip-section">
                <h4 class="patternhelp__tip-title">{section.title}</h4>
                <ul class="patternhelp__tip-list">
                  <For each={section.items}>
                    {(item) => (
                      <li class="patternhelp__tip">
                        <kbd class="patternhelp__kbd">
                          {item.position
                            ? remapPositionKeys(item.keys)
                            : item.keys}
                        </kbd>
                        <span class="patternhelp__tip-action">
                          {item.action}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>
          <Show when={showEffectList()}>
            <section class="patternhelp__tip-section patternhelp__tip-section--effects">
              <h4 class="patternhelp__tip-title">Effects</h4>
              <ul class="patternhelp__effect-grid">
                <For each={EFFECT_LIST}>
                  {(eff) => (
                    <li class="patternhelp__effect">
                      <kbd class="patternhelp__kbd">{eff.code}</kbd>
                      <span class="patternhelp__tip-action">{eff.name}</span>
                    </li>
                  )}
                </For>
              </ul>
            </section>
            <section class="patternhelp__tip-section patternhelp__tip-section--effects">
              <h4 class="patternhelp__tip-title">Extended effects (Exy)</h4>
              <ul class="patternhelp__effect-grid">
                <For each={EXTENDED_EFFECT_LIST}>
                  {(eff) => (
                    <li class="patternhelp__effect">
                      <kbd class="patternhelp__kbd">{eff.code}</kbd>
                      <span class="patternhelp__tip-action">{eff.name}</span>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
        </div>
      </Show>
    </div>
  );
};
