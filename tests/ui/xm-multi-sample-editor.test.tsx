import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

import { InstrumentView } from "../../src/components/InstrumentView";
import {
  emptyXmInstrument,
  emptyXmSample,
  emptyXmSong,
} from "../../src/core/xm/format";
import {
  clearHistory,
  setSong,
  setTransport,
  xm2Song,
} from "../../src/state/song";
import {
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
  currentXmSampleIndex,
} from "../../src/state/xmEdit";

function seed(): void {
  const s = emptyXmSong();
  const inst = emptyXmInstrument();
  inst.name = "ins-a";
  inst.samples[0]!.name = "sample-zero";
  s.instruments = [inst];
  setSong(s);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
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

describe("InstrumentView multi-sample picker", () => {
  it("renders one chip for the initial single sample", () => {
    const { container } = mountView();
    const chips = container.querySelectorAll(".instrument-view__sample-chip");
    expect(chips.length).toBe(1);
  });

  it("Add button appends a second sample chip", async () => {
    const view = mountView();
    const user = userEvent.setup();
    const addBtn = view.getByRole("button", { name: /add sample/i });
    await user.click(addBtn);
    const chips = view.container.querySelectorAll(
      ".instrument-view__sample-chip",
    );
    expect(chips.length).toBe(2);
    expect(xm2Song()!.instruments[0]!.samples.length).toBe(2);
  });

  it("clicking a chip selects that sample", async () => {
    const view = mountView();
    const user = userEvent.setup();
    await user.click(view.getByRole("button", { name: /add sample/i }));
    // Rename the second sample so we can find its chip text reliably.
    const s = xm2Song()!;
    s.instruments[0]!.samples[1] = { ...emptyXmSample(), name: "second" };
    setSong({ ...s });
    const chips = view.container.querySelectorAll(
      ".instrument-view__sample-chip",
    );
    expect(chips.length).toBe(2);
    await user.click(chips[1] as HTMLElement);
    expect(currentXmSampleIndex()).toBe(1);
  });

  it("Remove button drops the active sample and prevents emptying", async () => {
    const view = mountView();
    const user = userEvent.setup();
    const addBtn = view.getByRole("button", { name: /add sample/i });
    const remBtn = view.getByRole("button", { name: /remove sample/i });
    await user.click(addBtn);
    expect(xm2Song()!.instruments[0]!.samples.length).toBe(2);
    await user.click(remBtn);
    expect(xm2Song()!.instruments[0]!.samples.length).toBe(1);
    // Cannot remove the last one.
    expect(remBtn.hasAttribute("disabled")).toBe(true);
  });
});

describe("InstrumentView keymap editor", () => {
  it("hidden when only one sample exists", () => {
    const view = mountView();
    expect(view.container.querySelector(".xm-keymap")).toBeNull();
  });

  it("painting writes the active sample index into the cell", async () => {
    const view = mountView();
    const user = userEvent.setup();
    // Add a second sample so the keymap renders.
    await user.click(view.getByRole("button", { name: /add sample/i }));
    setCurrentXmSampleIndex(1);

    const cell = view.container.querySelector(
      '[data-keymap-note="48"]',
    ) as HTMLElement | null;
    expect(cell).not.toBeNull();
    // pointerdown to paint
    fireEvent.pointerDown(cell!, { pointerId: 1 });
    expect(xm2Song()!.instruments[0]!.keyMap[48]).toBe(1);
  });
});
