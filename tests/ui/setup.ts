/**
 * jsdom polyfills for the UI test environment.
 *
 * jsdom @26 (the version vitest 2.x pulls in transitively) ships without
 * `Blob.prototype.arrayBuffer` / `Blob.prototype.text` / `Blob.prototype.stream`
 * — the methods every modern browser implements, that the app uses to read
 * dropped/picked files in App.tsx and SampleView.tsx. Without these, every
 * UI test that drives a file-input or drop event throws "f.arrayBuffer is
 * not a function" before the production code can do anything observable.
 *
 * Polyfilling on Blob.prototype covers `File` too, since jsdom's File
 * extends Blob.
 *
 * Implementations match the spec semantics (return a fresh ArrayBuffer / a
 * UTF-8-decoded string) and route through `FileReader`, which jsdom does
 * provide. They run only when missing, so a future jsdom upgrade that
 * fills the gap is a no-op.
 */

// Vitest's `setupFiles` runs for every suite — node-env tests included —
// so guard on the existence of `Blob` and `FileReader`. Node-env suites
// have a global `Blob` (Node 18+) but no `FileReader`; the polyfill is
// only meaningful when both are present (i.e. inside jsdom).
if (
  typeof Blob !== "undefined" &&
  typeof FileReader !== "undefined" &&
  typeof Blob.prototype.arrayBuffer !== "function"
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Blob.prototype as any).arrayBuffer =
    function arrayBuffer(): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this as Blob);
      });
    };
}

if (
  typeof Blob !== "undefined" &&
  typeof FileReader !== "undefined" &&
  typeof Blob.prototype.text !== "function"
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Blob.prototype as any).text = function text(): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this as Blob);
    });
  };
}

// jsdom ships HTMLCanvasElement but no 2D / WebGL context — so the
// Waveform component (and any other canvas-using component the App
// renders) hits a "Not implemented: HTMLCanvasElement.prototype.getContext"
// stack trace on every render that gets dumped to stderr. None of our
// UI tests assert on rendered pixels; stub the method to a minimal
// no-op object so renders complete silently. Real canvas testing would
// need the optional `canvas` npm package and a different stub policy.
if (
  typeof HTMLCanvasElement !== "undefined" &&
  typeof HTMLCanvasElement.prototype.getContext === "function"
) {
  // The original impl exists (jsdom defines it but routes to the
  // not-implemented warning). Replace with a no-op stub that returns a
  // minimally-populated 2D context — enough to satisfy code paths that
  // call methods like `clearRect`, `fillRect`, `beginPath` without
  // throwing. Tests that genuinely care about canvas output should not
  // run in jsdom anyway.
  const stub2d = new Proxy(
    {},
    {
      get: () => () => undefined,
    },
  );
  HTMLCanvasElement.prototype.getContext = function getContext(
    contextId: string,
  ): unknown {
    return contextId === "2d" ? stub2d : null;
  } as typeof HTMLCanvasElement.prototype.getContext;
}
