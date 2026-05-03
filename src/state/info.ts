import { createSignal } from 'solid-js';

/**
 * Free-form info text the user can attach to a song. On `.mod` export,
 * each line is written into one of the 31 sample-name slots (22 chars
 * each, ASCII-clipped by writeModule), which is how trackers since the
 * Amiga have embedded credits / readme text inside a `.mod` — players
 * surface sample names in their UI even for empty slots, so the message
 * shows up wherever the file is opened.
 *
 * Held as a session-level signal alongside `filename`, persisted in
 * `.retro` projects but not part of the Song's data model — round-tripping
 * a `.mod` doesn't carry it (it'd be indistinguishable from real sample
 * names on disk). Lines beyond 31 and characters past column 22 are
 * silently dropped at export time; the editor doesn't enforce either
 * limit so the user can paste / type freely.
 */
export const [infoText, setInfoText] = createSignal<string>('');

/** Per-sample-slot capacity for the info text, in characters. */
export const INFO_LINE_WIDTH = 22;
/** Number of sample slots available to embed lines into. */
export const INFO_MAX_LINES = 31;

/**
 * Word-wrap `text` for export — explicit newlines stay as paragraph
 * breaks, anything longer than `width` is split on whitespace at the last
 * break point that fits. This matches what the user sees as the textarea
 * wraps soft lines, instead of silently dropping characters past column 22.
 *
 * A "word" longer than `width` (a long URL, a glued identifier) is hard-cut
 * at `width` rather than overflowing — the alternative would be a single
 * row that exceeds the .mod sample-name field, and writeAscii would chop
 * the tail anyway.
 *
 * The breaking whitespace character is consumed (not emitted on the next
 * line), which is how every text-rendering path the user has seen handles
 * soft wrap. Output capped at `max` rows; surplus content is dropped
 * (we only have 31 sample-name slots and there's no other home for it).
 */
export function wrapInfoText(
  text: string,
  width: number = INFO_LINE_WIDTH,
  max: number = INFO_MAX_LINES,
): string[] {
  const out: string[] = [];
  // Normalise CRLF/CR so the paragraph split is consistent regardless of
  // where the textarea content originated (paste from a Windows source,
  // synthetic test input, etc.).
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');

  for (const para of paragraphs) {
    if (out.length >= max) break;
    if (para.length <= width) {
      out.push(para);
      continue;
    }
    let rest = para;
    while (rest.length > width && out.length < max) {
      // Search backward from the wrap column for the last whitespace
      // character that still fits. Index `width` itself is fair game —
      // a whitespace there means we land at exactly the field width.
      let breakAt = -1;
      const start = Math.min(width, rest.length - 1);
      for (let i = start; i > 0; i--) {
        if (/\s/.test(rest[i] ?? '')) { breakAt = i; break; }
      }
      if (breakAt <= 0) {
        // No whitespace inside the window — hard cut. Better truncate
        // mid-word than let writeAscii silently chop it.
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      } else {
        out.push(rest.slice(0, breakAt));
        rest = rest.slice(breakAt + 1);
      }
    }
    if (out.length < max) out.push(rest);
  }

  return out.slice(0, max);
}

/**
 * Inverse of the export-time stamping: pull the 31 sample names out of a
 * loaded .mod and join them as the info text. Trailing empty slots are
 * stripped so a typical .mod with 3 credit lines doesn't load with 28
 * blank rows underneath.
 *
 * Round-trips cleanly with `wrapInfoText` for the common case where the
 * info text was originally produced by this editor's exporter, and is the
 * obvious thing to do for arbitrary .mods — sample names are how every
 * tracker since 1987 has surfaced credits / readme content.
 */
export function infoTextFromSampleNames(names: readonly string[]): string {
  const arr = [...names];
  while (arr.length > 0 && arr[arr.length - 1] === '') arr.pop();
  return arr.join('\n');
}
