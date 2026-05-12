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
import {
  setXmRightPanelCollapsed,
  xmRightPanelCollapsed,
} from "../../src/state/view";
import { clearAllXmWorkbenches } from "../../src/state/xmSampleWorkbench";

function seed(): void {
  const s = emptyXmSong();
  const inst = emptyXmInstrument();
  inst.name = "ins-a";
  inst.samples[0]!.name = "sa";
  inst.samples[0]!.data = new Int8Array([1, 2, 3, 4]);
  inst.samples[0]!.bits = 8;
  s.instruments = [inst];
  setSong(s);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
  setXmRightPanelCollapsed(false);
  clearAllXmWorkbenches();
  clearHistory();
}

beforeEach(seed);
afterEach(() => {
  cleanup();
  setSong(null);
  clearHistory();
  setXmRightPanelCollapsed(false);
});

function mountView() {
  const song = () => xm2Song()!;
  return render(() => <InstrumentView song={song()} />);
}

describe("InstrumentView right column collapse", () => {
  it("right column is expanded by default and the body holds envelope sections", () => {
    const view = mountView();
    const rightcol = view.container.querySelector(".instrument-view__rightcol");
    expect(rightcol).not.toBeNull();
    expect(
      rightcol!.classList.contains("instrument-view__rightcol--collapsed"),
    ).toBe(false);
    // Body present + holds Volume envelope heading.
    const headings = rightcol!.querySelectorAll(".instrument-view__heading");
    expect(
      Array.from(headings).some((h) => h.textContent === "Volume envelope"),
    ).toBe(true);
  });

  it("clicking the toggle collapses the right column", () => {
    const view = mountView();
    const toggle = view.container.querySelector<HTMLButtonElement>(
      ".instrument-view__rightcol-toggle",
    );
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    expect(xmRightPanelCollapsed()).toBe(true);
    const rightcol = view.container.querySelector(".instrument-view__rightcol");
    expect(
      rightcol!.classList.contains("instrument-view__rightcol--collapsed"),
    ).toBe(true);
    // Body hides when collapsed → no envelope heading rendered.
    const headings = rightcol!.querySelectorAll(".instrument-view__heading");
    expect(headings.length).toBe(0);
  });

  it("toggle round-trip restores the expanded body", () => {
    const view = mountView();
    const toggle = view.container.querySelector<HTMLButtonElement>(
      ".instrument-view__rightcol-toggle",
    );
    fireEvent.click(toggle!);
    fireEvent.click(toggle!);
    expect(xmRightPanelCollapsed()).toBe(false);
    const headings = view.container.querySelectorAll(
      ".instrument-view__rightcol .instrument-view__heading",
    );
    expect(
      Array.from(headings).some((h) => h.textContent === "Panning envelope"),
    ).toBe(true);
  });
});
