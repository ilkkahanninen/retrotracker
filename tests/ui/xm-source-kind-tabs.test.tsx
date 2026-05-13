import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";

import { InstrumentView } from "../../src/components/InstrumentView";
import { emptyXmInstrument, emptyXmSong } from "../../src/core/xm/format";
import {
  clearHistory,
  setSong,
  setTransport,
  xm2Song,
} from "../../src/state/song";
import {
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "../../src/state/xmEdit";
import { getXmWorkbench } from "../../src/state/xmSampleWorkbench";
import { clearAllXmWorkbenches } from "../../src/state/xmSampleWorkbench";

function seed(): void {
  const s = emptyXmSong();
  const inst = emptyXmInstrument();
  inst.name = "ins-a";
  inst.samples[0]!.data = new Int8Array([1, 2, 3, 4]);
  inst.samples[0]!.bits = 8;
  inst.samples[0]!.name = "sa";
  s.instruments = [inst];
  setSong(s);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
  clearAllXmWorkbenches();
  clearHistory();
}

beforeEach(seed);
afterEach(() => {
  cleanup();
  setSong(null);
  clearHistory();
});

function mountView() {
  const song = () => xm2Song()!;
  return render(() => <InstrumentView song={song()} />);
}

describe("InstrumentView source-kind tabs", () => {
  it("renders Sampler and Chiptune as tab buttons in the header", () => {
    const view = mountView();
    const tablist = view.container.querySelector(
      ".sampleview__header .source-picker",
    );
    expect(tablist).not.toBeNull();
    const tabs = Array.from(
      tablist!.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
    );
    expect(tabs.length).toBe(2);
    expect(tabs.map((t) => t.textContent)).toEqual(["Sampler", "Chiptune"]);
  });

  it("Sampler tab is active by default for a sample with bytes", () => {
    const view = mountView();
    const samplerTab = view.container.querySelector<HTMLButtonElement>(
      '.source-picker button[role="tab"][aria-selected="true"]',
    );
    expect(samplerTab?.textContent).toBe("Sampler");
  });

  it("clicking Chiptune flips the active workbench to chiptune mode", () => {
    const view = mountView();
    const tabs = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(
        '.source-picker button[role="tab"]',
      ),
    );
    const chiptuneTab = tabs.find((t) => t.textContent === "Chiptune");
    expect(chiptuneTab).toBeDefined();
    fireEvent.click(chiptuneTab!);
    const wb = getXmWorkbench(1, 0);
    expect(wb?.source.kind).toBe("chiptune");
    // The aria-selected reflects the flip on the next render.
    const stillActiveTabs = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(
        '.source-picker button[role="tab"]',
      ),
    );
    const active = stillActiveTabs.find(
      (t) => t.getAttribute("aria-selected") === "true",
    );
    expect(active?.textContent).toBe("Chiptune");
  });

  it("switching instruments and back keeps Chiptune active on the first instrument", () => {
    // Seed a second instrument so the user has somewhere to navigate.
    const s = xm2Song()!;
    const inst2 = emptyXmInstrument();
    inst2.name = "ins-b";
    inst2.samples[0]!.data = new Int8Array([5, 6, 7, 8]);
    inst2.samples[0]!.bits = 8;
    setSong({ ...s, instruments: [s.instruments[0]!, inst2] });

    const view = mountView();
    const chiptuneTab = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(
        '.source-picker button[role="tab"]',
      ),
    ).find((t) => t.textContent === "Chiptune");
    fireEvent.click(chiptuneTab!);
    expect(getXmWorkbench(1, 0)?.source.kind).toBe("chiptune");

    // Navigate to instrument 2 then back to 1.
    setCurrentXmInstrument(2);
    setCurrentXmInstrument(1);

    const activeAfter = view.container.querySelector<HTMLButtonElement>(
      '.source-picker button[role="tab"][aria-selected="true"]',
    );
    expect(activeAfter?.textContent).toBe("Chiptune");
    expect(getXmWorkbench(1, 0)?.source.kind).toBe("chiptune");
  });

  it("clicking Chiptune on an empty instrument slot lazy-creates instrument + chiptune workbench", () => {
    // Reseed without any instruments — mirrors a freshly-created XM
    // song where the user hasn't loaded a WAV yet but lands on the
    // first instrument slot.
    const s = emptyXmSong();
    s.instruments = [];
    setSong(s);
    setCurrentXmInstrument(1);
    setCurrentXmSampleIndex(0);
    setTransport("idle");
    clearAllXmWorkbenches();
    clearHistory();

    const view = mountView();
    const chiptuneTab = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(
        '.source-picker button[role="tab"]',
      ),
    ).find((t) => t.textContent === "Chiptune");
    expect(chiptuneTab).toBeDefined();
    fireEvent.click(chiptuneTab!);

    const wb = getXmWorkbench(1, 0);
    expect(wb?.source.kind).toBe("chiptune");
    // The song should now have a materialised instrument + sample.
    const song = xm2Song();
    expect(song?.instruments[0]).toBeDefined();
    expect(song?.instruments[0]?.samples[0]).toBeDefined();
  });

  it("hides the Loop dropdown in chiptune mode", () => {
    const view = mountView();
    // Sampler mode: dropdown present.
    const loopBefore = Array.from(
      view.container.querySelectorAll<HTMLLabelElement>(".samplemeta label"),
    ).find((l) => l.textContent?.startsWith("Loop"));
    expect(loopBefore).toBeDefined();
    expect(loopBefore!.querySelector("select")).not.toBeNull();

    // Flip to chiptune.
    const chiptuneTab = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(
        '.source-picker button[role="tab"]',
      ),
    ).find((t) => t.textContent === "Chiptune");
    fireEvent.click(chiptuneTab!);

    const loopAfter = Array.from(
      view.container.querySelectorAll<HTMLLabelElement>(".samplemeta label"),
    ).find((l) => l.textContent?.startsWith("Loop"));
    expect(loopAfter).toBeUndefined();
  });
});
