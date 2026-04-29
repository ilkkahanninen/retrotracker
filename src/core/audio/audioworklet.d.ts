/**
 * Ambient declarations for the AudioWorklet global scope.
 * These globals only exist inside an `AudioWorkletProcessor`, not on the
 * main thread. Kept local to the audio module so they don't leak.
 */

declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;

interface AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare const AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor;
};

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;
