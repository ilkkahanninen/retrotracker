import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";

import { App } from "../../src/App";
import { resetXmCursor } from "../../src/state/cursorXm";
import {
  clearHistory,
  setPlayPos,
  setSong,
  setTransport,
} from "../../src/state/song";
import { setView } from "../../src/state/view";
import { io } from "../../src/state/io";
import { emptyXmSong } from "../../src/core/xm/format";
import { clearSession } from "../../src/state/persistence";
import { readWav } from "../../src/core/audio/wav";

function resetFt2Session() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  resetXmCursor();
  setView("pattern");
  clearSession();
}

const realDownload = io.download;

beforeEach(() => {
  resetFt2Session();
  io.download = vi.fn();
});
afterEach(() => {
  cleanup();
  io.download = realDownload;
  resetFt2Session();
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

describe("FT2: Export .wav…", () => {
  it("exports an .xm song to a valid WAV", () => {
    const s = emptyXmSong();
    s.title = "DemoXm";
    setSong(s);
    const { container } = render(() => <App />);
    clickFileMenuItem(container, "Export .wav");

    expect(io.download).toHaveBeenCalledTimes(1);
    const [name, bytes, mime] = (io.download as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(name).toBe("DemoXm.wav");
    expect(mime).toBe("audio/wav");
    expect(bytes).toBeInstanceOf(Uint8Array);

    const wav = readWav(bytes as Uint8Array);
    expect(wav.sampleRate).toBe(44100);
    expect(wav.channels.length).toBe(2);
    expect(wav.channels[0]!.length).toBeGreaterThan(0);
    expect(wav.channels[0]!.length).toBe(wav.channels[1]!.length);
  });
});
