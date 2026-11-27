import { createSignal } from "solid-js";

/**
 * Session-only clipboard for XM sample bytes. Separate from the pattern
 * clipboard so a sample-view copy can't clobber a pattern-view copy and
 * vice versa. Mirrors PT2's `state/sampleClipboard.ts`.
 *
 * Holds the raw audio payload plus its bit depth so paste can land it
 * back into a sample slot at the right precision.
 */
export interface XmSampleClipboardData {
  data: Int8Array | Int16Array;
  bits: 8 | 16;
  /** Optional source name for downstream display. */
  name?: string;
  /** Tuning of the sample the bytes were copied from. The bytes only
   *  play at the right pitch with it, so paste carries it along. */
  relativeNote?: number;
  finetune?: number;
}

export const [xmSampleClipboard, setXmSampleClipboard] =
  createSignal<XmSampleClipboardData | null>(null);

export function clearXmSampleClipboard(): void {
  setXmSampleClipboard(null);
}
