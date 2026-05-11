/**
 * Test double for `AudioEngine`. Mirrors the engine's public surface but
 * records every method invocation into a list instead of touching audio.
 *
 * Used by `tests/ui/engine-sync.test.tsx` to verify the App's reactive
 * forwarders (channel mute, Paula model, stereo separation, mid-playback
 * sample / song shape) push the right messages through the engine. The
 * real engine can't run in jsdom — `new AudioContext()` throws — so
 * production code's `AudioEngine.create` is `vi.spyOn`'d to resolve to one
 * of these instead. The forwarders see "an engine appeared" and fire
 * exactly as they would in a browser.
 *
 * Add new fields here whenever AudioEngine grows another method that the
 * App syncs through; the keep-in-sync tax keeps the bed honest. If a
 * future App effect calls a method that this fake doesn't define, the
 * test would throw — that's the desired loud failure.
 */

import { vi } from "vitest";
import { AudioEngine } from "../../src/core/audio/engine";
import type { Sample, ModSong } from "../../src/core/mod/types";
import type { AmigaModel } from "../../src/core/audio/paula";

export interface EngineCall {
  method: string;
  args: unknown[];
}

export class RecordingEngine {
  /** Every method call in invocation order. */
  readonly calls: EngineCall[] = [];

  /** Engine ↔ main-thread callbacks are public properties on the real
   *  engine; tests never assert on these but `playback.ensureEngine`
   *  assigns them on construction so they have to exist. */
  onPosition: ((order: number, row: number) => void) | null = null;
  onLevels: ((peaks: number[]) => void) | null = null;

  /** Real engine reads this off the AudioContext; tests don't care. */
  readonly sampleRate = 48000;

  private rec(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  load(song: ModSong): void {
    this.rec("load", [song]);
  }
  setSampleData(slot: number, sample: Sample): void {
    this.rec("setSampleData", [slot, sample]);
  }
  replaceSong(song: ModSong): void {
    this.rec("replaceSong", [song]);
  }
  async play(): Promise<void> {
    this.rec("play", []);
  }
  async playFrom(
    order: number,
    row: number,
    opts: { loopPattern?: boolean } = {},
  ): Promise<void> {
    this.rec("playFrom", [order, row, opts]);
  }
  stop(): void {
    this.rec("stop", []);
  }
  setChannelMuted(channel: number, muted: boolean): void {
    this.rec("setChannelMuted", [channel, muted]);
  }
  setPaulaModel(model: AmigaModel): void {
    this.rec("setPaulaModel", [model]);
  }
  setStereoSeparation(sep: number): void {
    this.rec("setStereoSeparation", [sep]);
  }
  setMasterGain(percent: number): void {
    this.rec("setMasterGain", [percent]);
  }
  async previewNote(sample: Sample, period: number): Promise<void> {
    this.rec("previewNote", [sample, period]);
  }
  stopPreview(): void {
    this.rec("stopPreview", []);
  }
  async dispose(): Promise<void> {
    this.rec("dispose", []);
  }

  /** Subset of `calls` whose method matches `name`. */
  callsTo(name: string): EngineCall[] {
    return this.calls.filter((c) => c.method === name);
  }

  /** Drop everything recorded so far. Use after a setup phase to assert
   *  only on calls made during the test's "act" step. */
  reset(): void {
    this.calls.length = 0;
  }
}

/**
 * Mock `AudioEngine.create` to resolve with a fresh `RecordingEngine`. The
 * returned instance is the same object the App will receive on the next
 * `ensureEngine()` — assert against its `calls` list.
 *
 * Tests must clean up via `vi.restoreAllMocks()` (typically in afterEach).
 */
export function installRecordingEngine(): RecordingEngine {
  const fake = new RecordingEngine();
  vi.spyOn(AudioEngine, "create").mockResolvedValue(
    fake as unknown as AudioEngine,
  );
  return fake;
}
