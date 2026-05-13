import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";

import { App } from "../../src/App";
import { setCursor, INITIAL_CURSOR } from "../../src/state/cursor";
import { resetXmCursor } from "../../src/state/cursorXm";
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
import { emptyXmSong } from "../../src/core/xm/format";
import { clearSession } from "../../src/state/persistence";
import { setFilename } from "../../src/state/session";

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  resetXmCursor();
  setCurrentSample(1);
  setCurrentOctave(2);
  setDirty(false);
  setView("pattern");
  setFilename(null);
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

function clickMenuItem(
  container: HTMLElement,
  menu: "File" | "Edit",
  label: string,
): void {
  let trigger: HTMLButtonElement | null = null;
  for (const btn of container.querySelectorAll<HTMLButtonElement>(
    ".menu__button",
  )) {
    if (btn.textContent?.startsWith(menu)) {
      trigger = btn;
      break;
    }
  }
  if (!trigger) throw new Error(`${menu} menu button not found`);
  fireEvent.click(trigger);
  for (const item of container.querySelectorAll<HTMLElement>(".menu__item")) {
    if (item.textContent?.includes(label)) {
      fireEvent.click(item);
      return;
    }
  }
  throw new Error(`No ${menu}-menu item labelled "${label}"`);
}

describe("export: File ▾ → Export .xm… item (FT2 mode)", () => {
  it("the menu label switches to '.xm' when an FT2 song is loaded", () => {
    const s = emptyXmSong();
    setSong(s);
    const { container } = render(() => <App />);
    // Open the File menu and assert the export item label.
    let fileTrigger: HTMLButtonElement | null = null;
    for (const btn of container.querySelectorAll<HTMLButtonElement>(
      ".menu__button",
    )) {
      if (btn.textContent?.startsWith("File")) {
        fileTrigger = btn;
        break;
      }
    }
    fireEvent.click(fileTrigger!);
    const items = Array.from(
      container.querySelectorAll<HTMLElement>(".menu__item"),
    ).map((el) => el.textContent ?? "");
    expect(items.some((t) => t.includes("Export .xm"))).toBe(true);
    expect(items.some((t) => t.includes("Export .mod"))).toBe(false);
  });

  it("clicking the item calls io.download with .xm filename and audio/x-xm mime", () => {
    const s = emptyXmSong();
    s.title = "FT2 Demo";
    setSong(s);
    const { container } = render(() => <App />);
    clickMenuItem(container, "File", "Export .xm");
    expect(io.download).toHaveBeenCalledTimes(1);
    const [name, bytes, mime] = (io.download as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(name).toBe("FT2_Demo.xm");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(mime).toBe("audio/x-xm");
    // 60-byte XM signature + 276-byte header at minimum.
    expect((bytes as Uint8Array).byteLength).toBeGreaterThan(336);
  });

  it("export → parseXm round-trips the song", async () => {
    const s = emptyXmSong();
    s.title = "RoundTrip";
    setSong(s);
    const { container } = render(() => <App />);
    clickMenuItem(container, "File", "Export .xm");
    const [, bytes] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const { parseXm } = await import("../../src/core/xm/parser");
    const parsed = parseXm(bytes as Uint8Array);
    expect(parsed.format).toBe("FT2");
    expect(parsed.title).toBe("RoundTrip");
    expect(parsed.channelCount).toBe(s.channelCount);
  });

  it("loaded-name's .xm extension is stripped before re-extension", () => {
    const s = emptyXmSong();
    s.title = "ignored";
    setSong(s);
    setFilename("MYSONG.XM");
    const { container } = render(() => <App />);
    clickMenuItem(container, "File", "Export .xm");
    const [name] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(name).toBe("MYSONG.xm");
  });
});
