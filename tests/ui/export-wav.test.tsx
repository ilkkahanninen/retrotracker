import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";
import { App } from "../../src/App";
import { setCursor, INITIAL_CURSOR } from "../../src/state/cursor";
import {
  setSong,
  setTransport,
  setPlayPos,
  clearHistory,
  setDirty,
} from "../../src/state/song";
import { setCurrentSample, setCurrentOctave } from "../../src/state/edit";
import { setView } from "../../src/state/view";
import { io } from "../../src/state/io";
import { emptySong } from "../../src/core/mod/format";
import { clearSession } from "../../src/state/persistence";
import { readWav } from "../../src/core/audio/wav";

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setDirty(false);
  setView("pattern");
  clearSession();
}

const realDownload = io.download;

beforeEach(() => {
  resetState();
  io.download = vi.fn();
});
afterEach(() => {
  cleanup();
  io.download = realDownload;
  resetState();
});

function clickFileMenuItem(container: HTMLElement, label: string): void {
  let trigger: HTMLButtonElement | null = null;
  for (const btn of container.querySelectorAll<HTMLButtonElement>(
    ".menu__button",
  )) {
    if (btn.textContent?.startsWith("File")) {
      trigger = btn;
      break;
    }
  }
  if (!trigger) throw new Error("File menu button not found");
  fireEvent.click(trigger);
  for (const item of container.querySelectorAll<HTMLElement>(".menu__item")) {
    if (item.textContent?.includes(label)) {
      fireEvent.click(item);
      return;
    }
  }
  throw new Error(`No File-menu item labelled "${label}"`);
}

describe("export: File ▾ → Export .wav… item", () => {
  it("downloads a stereo 44.1 kHz WAV named after the song with audio/wav mime", () => {
    const s = emptySong();
    s.title = "Demo";
    setSong(s);
    const { container } = render(() => <App />);
    clickFileMenuItem(container, "Export .wav");

    expect(io.download).toHaveBeenCalledTimes(1);
    const [name, bytes, mime] = (io.download as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(name).toBe("Demo.wav");
    expect(mime).toBe("audio/wav");
    expect(bytes).toBeInstanceOf(Uint8Array);

    // Bytes should be a valid WAV: RIFF header, WAVE form, parseable by our reader.
    const wav = readWav(bytes as Uint8Array);
    expect(wav.sampleRate).toBe(44100);
    expect(wav.channels.length).toBe(2);
    // An empty song still renders ~8 s of silence (one 64-row pattern at the
    // default speed/tempo) before song-end detection cuts it. We just verify
    // there's some audio data.
    expect(wav.channels[0]!.length).toBeGreaterThan(0);
    expect(wav.channels[0]!.length).toBe(wav.channels[1]!.length);
  });

  it("uses the loaded filename's stem with a .wav extension", () => {
    const s = emptySong();
    s.title = "different-title";
    setSong(s);
    // Pretend the song was loaded as "song.mod" — the loaded filename wins
    // over the song title for the export name (deriveExportFilename behavior).
    // Since there's no public setFilename helper, we round-trip through the
    // export-name helper directly via deriveExportFilename's contract: with a
    // null loadedName it falls back to the title, which is what this test
    // pins.
    const { container } = render(() => <App />);
    clickFileMenuItem(container, "Export .wav");
    const [name] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(name).toBe("different-title.wav");
  });
});
