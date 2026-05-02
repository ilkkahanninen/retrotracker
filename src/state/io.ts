/**
 * Browser-side I/O helpers — exporting a Song to a downloadable .mod file.
 *
 * `deriveExportFilename` is pure (unit-testable). The actual DOM dance lives
 * on the `io` object so tests can stub it cheaply (`io.download = vi.fn()`).
 */

/**
 * Pick a download filename. Prefers the originally-loaded file's name, then
 * the song title (sanitised), then "untitled". Always ends in `.mod`.
 *
 *   - "song.mod"     → "song.mod"
 *   - "Song.MOD"     → "Song.mod"          (existing extension normalised)
 *   - null + "Demo"  → "Demo.mod"
 *   - null + ""      → "untitled.mod"
 *   - "Cool/Song"    → "Cool_Song.mod"     (path/special chars sanitised)
 */
export function deriveExportFilename(
  loadedName: string | null,
  songTitle: string,
): string {
  const base = loadedName
    ? loadedName.replace(/\.mod$/i, '')
    : songTitle.trim();
  const sanitised = base.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_');
  const trimmed = sanitised.slice(0, 64);
  return `${trimmed || 'untitled'}.mod`;
}

/**
 * DOM side-effects bag. Methods are mutable so tests can replace them with
 * spies — Vitest's `vi.fn()` plugs right in. Keep the surface small.
 */
export const io = {
  /**
   * Push `bytes` to the user as a download named `filename`. Uses the
   * standard hidden-anchor technique; revokes the object URL after click
   * so we don't leak. `mimeType` defaults to `application/octet-stream`
   * — the browser doesn't really care, the extension drives what the OS
   * does with the file. .mod / .retro callers can pass a more specific
   * type if they like.
   */
  download(filename: string, bytes: Uint8Array, mimeType: string = 'application/octet-stream'): void {
    // Copy into a fresh ArrayBuffer so we never hand a SharedArrayBuffer to
    // Blob (TS narrows Uint8Array.buffer to ArrayBufferLike, which Blob's
    // BlobPart parameter doesn't accept).
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    const blob = new Blob([buf], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
