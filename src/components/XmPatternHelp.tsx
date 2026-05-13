import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import type { XmNote, XmSong } from "../core/xm/types";
import {
  decodeVolumeColumn,
  effectChar,
  noteString,
} from "../core/xm/effectLabels";
import type { XmCursor, XmField } from "../state/cursorXm";
import { xmSelection } from "../state/selection";
import { registerShortcut } from "../state/shortcuts";
import { view } from "../state/view";
import { remapPositionKeys } from "../state/keyboardLayout";
import { ALT_LABEL, MOD_LABEL } from "../state/platform";

/**
 * Map an XM volume column byte to a human-readable description.
 * Returns null for an empty volume cell (byte === 0).
 *
 * XM packs (kind, magnitude) into the byte:
 *   0x10..0x50  → set volume (0..64), top nibble = magnitude/16
 *   0x60..0x6F  → volume slide down by lo
 *   0x70..0x7F  → volume slide up by lo
 *   0x80..0x8F  → fine vol down by lo
 *   0x90..0x9F  → fine vol up by lo
 *   0xA0..0xAF  → vibrato speed = lo
 *   0xB0..0xBF  → vibrato w/ depth lo
 *   0xC0..0xCF  → set panning (lo<<4)
 *   0xD0..0xDF  → pan slide left
 *   0xE0..0xEF  → pan slide right
 *   0xF0..0xFF  → tone portamento toward last note (speed lo<<4)
 */
function explainVolumeColumn(byte: number): {
  cell: string;
  name: string;
  detail?: string;
} | null {
  if (byte === 0) return null;
  const decoded = decodeVolumeColumn(byte);
  const cell = decoded
    ? `${decoded.kind}${decoded.magnitude.toString(16).toUpperCase()}`
    : "··";
  const hi = (byte >>> 4) & 0xf;
  const lo = byte & 0xf;
  if (hi >= 0x1 && hi <= 0x4) {
    return { cell, name: "Set volume", detail: `${hi * 16 + lo} / 64` };
  }
  if (hi === 0x5) {
    return {
      cell,
      name: "Set volume",
      detail: `${Math.min(64, 0x50 + lo)} / 64`,
    };
  }
  switch (hi) {
    case 0x6:
      return { cell, name: "Vol slide down", detail: `−${lo} / tick` };
    case 0x7:
      return { cell, name: "Vol slide up", detail: `+${lo} / tick` };
    case 0x8:
      return { cell, name: "Fine vol down", detail: `−${lo}` };
    case 0x9:
      return { cell, name: "Fine vol up", detail: `+${lo}` };
    case 0xa:
      return { cell, name: "Vibrato speed", detail: `speed = ${lo}` };
    case 0xb:
      return { cell, name: "Vibrato depth", detail: `depth = ${lo}` };
    case 0xc:
      return { cell, name: "Set panning", detail: `${lo * 16} (0..240)` };
    case 0xd:
      return { cell, name: "Pan slide left", detail: `−${lo} / tick` };
    case 0xe:
      return { cell, name: "Pan slide right", detail: `+${lo} / tick` };
    case 0xf:
      return {
        cell,
        name: "Tone portamento",
        detail: `speed = ${lo * 16}`,
      };
    default:
      return { cell, name: "Unknown", detail: undefined };
  }
}

interface EffectExplanation {
  name: string;
  /** Combined param meaning (when nibbles fuse). */
  param?: string;
  /** What the high nibble means, when nibbles are independent. */
  hi?: string;
  /** What the low nibble means, when nibbles are independent. */
  lo?: string;
}

/**
 * XM-native effect breakdown. Mirrors `explainEffect` from PatternHelp.tsx
 * but uses XM's broader effect map (0x00..0x21) and XM-specific
 * semantics — Bxx jumps in *decimal* tens-encoded form in XM, Dxy is
 * also decimal, Fxx splits speed/tempo at 0x20, plus the letter
 * commands G..X.
 */
function explainEffect(
  effect: number,
  paramByte: number,
): EffectExplanation | null {
  if (effect === 0 && paramByte === 0) return null;
  const hi = (paramByte >>> 4) & 0xf;
  const lo = paramByte & 0xf;
  switch (effect) {
    case 0x00:
      return {
        name: "Arpeggio",
        hi: "halftones up (1st tick)",
        lo: "halftones up (2nd tick)",
      };
    case 0x01:
      return { name: "Slide up", param: "period units / tick" };
    case 0x02:
      return { name: "Slide down", param: "period units / tick" };
    case 0x03:
      return { name: "Tone portamento", param: "slide speed (0 = continue)" };
    case 0x04:
      return { name: "Vibrato", hi: "speed", lo: "depth" };
    case 0x05:
      return {
        name: "Tone porta + vol slide",
        hi: "volume up",
        lo: "volume down",
      };
    case 0x06:
      return {
        name: "Vibrato + vol slide",
        hi: "volume up",
        lo: "volume down",
      };
    case 0x07:
      return { name: "Tremolo", hi: "speed", lo: "depth" };
    case 0x08:
      return { name: "Set panning", param: `${paramByte} (0..255)` };
    case 0x09:
      return {
        name: "Sample offset",
        param: `start at $${paramByte
          .toString(16)
          .toUpperCase()
          .padStart(2, "0")}00 bytes`,
      };
    case 0x0a:
      return { name: "Volume slide", hi: "volume up", lo: "volume down" };
    case 0x0b:
      return {
        name: "Position jump",
        param: `to order $${paramByte.toString(16).toUpperCase().padStart(2, "0")}`,
      };
    case 0x0c:
      return { name: "Set volume", param: `${paramByte} (0..64)` };
    case 0x0d:
      return {
        name: "Pattern break",
        param: `to row ${hi * 10 + lo} (decimal xy)`,
      };
    case 0x0e:
      return explainExtended(hi, lo);
    case 0x0f:
      if (paramByte === 0)
        return { name: "Stop song", param: "F00 halts playback" };
      return paramByte < 0x20
        ? { name: "Set speed", param: `${paramByte} ticks/row` }
        : { name: "Set tempo", param: `${paramByte} BPM` };
    case 0x10:
      return { name: "Set global volume", param: `${paramByte} (0..64)` };
    case 0x11:
      return {
        name: "Global volume slide",
        hi: "global vol up",
        lo: "global vol down",
      };
    case 0x14:
      return { name: "Key off", param: `at tick ${paramByte}` };
    case 0x15:
      return { name: "Set envelope position", param: `tick ${paramByte}` };
    case 0x19:
      return { name: "Panning slide", hi: "pan right", lo: "pan left" };
    case 0x1b:
      return {
        name: "Multi retrigger",
        hi: "volume change",
        lo: "every N ticks",
      };
    case 0x1d:
      return { name: "Tremor", hi: "on-ticks", lo: "off-ticks" };
    case 0x21:
      return explainXExtended(hi, lo);
    default:
      return {
        name: `Effect ${effectChar(effect)}`,
        param: "(unused in FT2)",
      };
  }
}

function explainExtended(sub: number, val: number): EffectExplanation {
  const WAVES = ["sine", "ramp", "square", "random"] as const;
  switch (sub) {
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
    case 0x9:
      return { name: "E9x Retrigger", param: `every ${val} ticks` };
    case 0xa:
      return { name: "EAx Fine volume up", param: `+${val}` };
    case 0xb:
      return { name: "EBx Fine volume down", param: `−${val}` };
    case 0xc:
      return { name: "ECx Note cut", param: `at tick ${val}` };
    case 0xd:
      return { name: "EDx Note delay", param: `${val} ticks` };
    case 0xe:
      return { name: "EEx Pattern delay", param: `${val} rows` };
    default:
      return {
        name: `Extended E${sub.toString(16).toUpperCase()}x`,
        param: "(unused in FT2)",
      };
  }
}

function explainXExtended(sub: number, val: number): EffectExplanation {
  switch (sub) {
    case 0x1:
      return { name: "X1x Extra fine slide up", param: `${val} period units` };
    case 0x2:
      return {
        name: "X2x Extra fine slide down",
        param: `${val} period units`,
      };
    default:
      return {
        name: `X${sub.toString(16).toUpperCase()}x`,
        param: "(unused in FT2)",
      };
  }
}

function effectCellText(note: XmNote): string {
  if (note.effect === 0 && note.effectParam === 0) return "...";
  const cmd = effectChar(note.effect);
  const hi = ((note.effectParam >>> 4) & 0xf).toString(16).toUpperCase();
  const lo = (note.effectParam & 0xf).toString(16).toUpperCase();
  return `${cmd}${hi}${lo}`;
}

// ── Tip sections ────────────────────────────────────────────────────────
//
// Same structure as PatternHelp.tsx — small static tables picked at
// render time based on cursor field / selection state. Synced manually
// with `appKeybindsXm.ts`.

interface Tip {
  keys: string;
  action: string;
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
      { keys: "`", action: "key-off (note 97)", position: true },
      { keys: "Z / X", action: "octave − / +", position: true },
      { keys: ".", action: "clear field" },
      { keys: "Backspace", action: "clear cell, step up" },
    ],
  },
  {
    title: "Edit step",
    items: [
      { keys: "< / >", action: "edit step − / +", position: true },
      { keys: "/", action: "reset edit step to 1", position: true },
    ],
  },
  {
    title: "Order / pattern",
    items: [
      {
        keys: "[ / ]",
        action: "previous / next order in song",
        position: true,
      },
      {
        keys: "Shift + [ / ]",
        action: "previous / next pattern at slot",
        position: true,
      },
      { keys: `${MOD_LABEL} + [`, action: "delete order slot" },
      { keys: `${MOD_LABEL} + ]`, action: "insert order slot" },
      { keys: `${ALT_LABEL} + [`, action: "new blank pattern at slot" },
      { keys: `${ALT_LABEL} + ]`, action: "duplicate pattern at slot" },
    ],
  },
  {
    title: "Instrument",
    items: [
      { keys: "1 – 0", action: "select instruments 1 – 10" },
      { keys: "Shift + 1 – 0", action: "select instruments 11 – 20" },
      {
        keys: `${ALT_LABEL} + Arrow up / down`,
        action: "previous / next instrument",
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
      { keys: `${ALT_LABEL} + 1 – 9, 0`, action: "mute channels 1 – 10" },
      {
        keys: `${ALT_LABEL} + Shift + 1 – 9, 0`,
        action: "solo channels 1 – 10",
      },
    ],
  },
];

const VOLUME_TIPS: TipSection[] = [
  {
    title: "Volume column",
    items: [
      { keys: "0 – 9, A – F", action: "enter nibble (set volume 0..64)" },
      { keys: ".", action: "clear field" },
    ],
  },
];

/**
 * XM effect reference. Letters G..X correspond to extended commands
 * (0x10..0x21). Slots marked "(unused)" stay listed for completeness —
 * FT2 ignores them, and a user reading the help shouldn't wonder.
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
  { code: "8xx", name: "Set panning" },
  { code: "9xx", name: "Sample offset" },
  { code: "Axy", name: "Volume slide" },
  { code: "Bxx", name: "Position jump" },
  { code: "Cxx", name: "Set volume" },
  { code: "Dxy", name: "Pattern break" },
  { code: "Exy", name: "Extended (E1..EE)" },
  { code: "Fxx", name: "Speed (<$20) / Tempo (≥$20)" },
  { code: "Gxx", name: "Set global volume" },
  { code: "Hxy", name: "Global volume slide" },
  { code: "Kxx", name: "Key off" },
  { code: "Lxx", name: "Set envelope position" },
  { code: "Pxy", name: "Panning slide" },
  { code: "Rxy", name: "Multi retrigger" },
  { code: "Txy", name: "Tremor" },
  { code: "Xxy", name: "X-extended (X1/X2)" },
];

const EXTENDED_EFFECT_LIST: ReadonlyArray<{ code: string; name: string }> = [
  { code: "E1x", name: "Fine slide up" },
  { code: "E2x", name: "Fine slide down" },
  { code: "E3x", name: "Glissando on/off" },
  { code: "E4x", name: "Vibrato waveform" },
  { code: "E5x", name: "Set finetune" },
  { code: "E6x", name: "Pattern loop" },
  { code: "E7x", name: "Tremolo waveform" },
  { code: "E9x", name: "Retrigger note" },
  { code: "EAx", name: "Fine volume up" },
  { code: "EBx", name: "Fine volume down" },
  { code: "ECx", name: "Note cut" },
  { code: "EDx", name: "Note delay" },
  { code: "EEx", name: "Pattern delay" },
];

const EFFECT_TIPS: TipSection[] = [
  {
    title: "Hex digits",
    items: [
      { keys: "0 – 9, A – F", action: "enter nibble" },
      { keys: "G – X", action: "extended XM effect (on cmd field)" },
      { keys: ".", action: "clear field" },
    ],
  },
];

const SELECTION_TIPS: TipSection = {
  title: "Selection",
  items: [
    { keys: `${MOD_LABEL} + C`, action: "copy" },
    { keys: `${MOD_LABEL} + X`, action: "cut" },
    { keys: `${MOD_LABEL} + V`, action: "paste at cursor" },
    { keys: `${MOD_LABEL} + A`, action: "select all (channel, then pattern)" },
    { keys: "Shift + arrows", action: "extend selection" },
    { keys: "Delete", action: "clear cells" },
  ],
};

/** True if the cursor field addresses any part of the effect column. */
function isEffectField(f: XmField): boolean {
  return f === "effectCmd" || f === "effectHi" || f === "effectLo";
}

/** True if the cursor is on the volume column. */
function isVolumeField(f: XmField): boolean {
  return f === "volHi" || f === "volLo";
}

interface Props {
  song: XmSong;
  cursor: XmCursor;
}

/**
 * Inline help pane for the FT2 pattern view. Mirrors `PatternHelp` but
 * adapted to the XM cell shape (note + instrument + volume column +
 * effect + param) and the XM-native effect/volume labelling.
 *
 * The "?" shortcut toggle is shared semantics with PT2 — registered here
 * gated on FT2 mode + pattern view so both PT and XM users get the same
 * muscle memory.
 */
export const XmPatternHelp: Component<Props> = (props) => {
  const [tipsOpen, setTipsOpen] = createSignal(false);

  onMount(() => {
    const cleanup = registerShortcut({
      key: "/",
      shift: true,
      description: "Toggle pattern-view help tips (?)",
      when: () => view() === "pattern" && props.song.format === "FT2",
      run: () => setTipsOpen((v) => !v),
    });
    onCleanup(cleanup);
  });

  const tipSections = (): TipSection[] => {
    if (xmSelection() !== null) return [SELECTION_TIPS];
    if (isEffectField(props.cursor.field)) return [...EFFECT_TIPS];
    if (isVolumeField(props.cursor.field))
      return [...VOLUME_TIPS, SELECTION_TIPS];
    return [...NOTE_TIPS, SELECTION_TIPS];
  };

  const showEffectList = () =>
    isEffectField(props.cursor.field) && xmSelection() === null;

  const cell = (): XmNote | null => {
    const patIdx = props.song.orders[props.cursor.order];
    if (patIdx === undefined) return null;
    const pat = props.song.patterns[patIdx];
    if (!pat) return null;
    return pat.rows[props.cursor.row]?.[props.cursor.channel] ?? null;
  };

  const noteName = () => {
    const c = cell();
    if (!c) return null;
    if (c.note === 0) return null;
    return noteString(c.note);
  };

  const instrumentSlot = () => {
    const c = cell();
    return c && c.instrument > 0 ? c.instrument : null;
  };

  const instrumentName = () => {
    const slot = instrumentSlot();
    if (slot === null) return null;
    return props.song.instruments[slot - 1]?.name ?? "";
  };

  const volume = () => {
    const c = cell();
    return c ? explainVolumeColumn(c.volumeColumn) : null;
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
          <span class="patternhelp__label">Instrument</span>
          <span class="patternhelp__value">
            <Show
              when={instrumentSlot() !== null}
              fallback={<span class="patternhelp__muted">— (no change)</span>}
            >
              {(() => {
                const slot = instrumentSlot()!;
                const name = instrumentName();
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
        <span class="patternhelp__seg">
          <span class="patternhelp__label">Vol</span>
          <span class="patternhelp__value">
            <Show
              when={volume()}
              fallback={<span class="patternhelp__muted">··</span>}
            >
              {(v) => (
                <>
                  <span class="patternhelp__mono">{v().cell}</span>
                  <span class="patternhelp__sub"> · {v().name}</span>
                  <Show when={v().detail}>
                    {(d) => <span class="patternhelp__sub"> ({d()})</span>}
                  </Show>
                </>
              )}
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
                      const hi = ((c.effectParam >>> 4) & 0xf)
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
