import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App";
import { setCursor, INITIAL_CURSOR, cursor } from "../../src/state/cursor";
import {
  setSong,
  setTransport,
  setPlayPos,
  clearHistory,
  song,
} from "../../src/state/song";
import {
  currentSample,
  setCurrentSample,
  setCurrentOctave,
} from "../../src/state/edit";
import { setView } from "../../src/state/view";

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setView("pattern");
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  resetState();
});

describe("sample list: click", () => {
  it("clicking a sample row sets currentSample to that index (1-based)", async () => {
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    const items = container.querySelectorAll<HTMLElement>(".app__samples li");
    expect(items).toHaveLength(31);
    await user.click(items[4]!); // visual sample #5
    expect(currentSample()).toBe(5);
  });

  it("the current sample row carries the .sample--current class", async () => {
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    const items = container.querySelectorAll<HTMLElement>(".app__samples li");
    await user.click(items[10]!); // sample #11
    expect(currentSample()).toBe(11);
    expect(items[10]!.classList.contains("sample--current")).toBe(true);
    expect(items[0]!.classList.contains("sample--current")).toBe(false);
  });
});

describe("sample quick-select keys (cursor on note field)", () => {
  it("'1'..'9' map to samples 1..9", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    for (let i = 1; i <= 9; i++) {
      await user.keyboard(String(i));
      expect(currentSample()).toBe(i);
    }
  });

  it("'0' maps to sample 10", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard("0");
    expect(currentSample()).toBe(10);
  });
});

describe("sample quick-select with Shift (samples 11..20)", () => {
  it("Shift+1 → sample 11", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard("{Shift>}1{/Shift}");
    expect(currentSample()).toBe(11);
  });

  it("Shift+0 → sample 20", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard("{Shift>}0{/Shift}");
    expect(currentSample()).toBe(20);
  });

  it("Shift+digit also works while cursor is on a hex field", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}"); // → sampleHi (a hex field)
    await user.keyboard("{Shift>}5{/Shift}");
    expect(currentSample()).toBe(15);
  });
});

describe("sample quick-select does not steal hex entry", () => {
  it("plain digit on a hex field still types into the cell", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}"); // sampleHi
    await user.keyboard("1"); // hex digit, not sample-select
    // Hex routing: writes 0x10 into the cell. currentSample stays at default (1).
    expect(currentSample()).toBe(1);
    const c = cursor();
    const s = song()!;
    const cell = s.patterns[s.orders[c.order]!]!.rows[0]![0]!;
    expect(cell.sample).toBe(0x10);
  });
});

describe("-/= step previous/next sample", () => {
  it("'=' increments currentSample", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setCurrentSample(5);
    await user.keyboard("=");
    expect(currentSample()).toBe(6);
  });

  it("'-' decrements currentSample", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setCurrentSample(5);
    await user.keyboard("-");
    expect(currentSample()).toBe(4);
  });

  it("'-' clamps at 1", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setCurrentSample(1);
    await user.keyboard("-");
    expect(currentSample()).toBe(1);
  });

  it("'=' clamps at 31", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setCurrentSample(31);
    await user.keyboard("=");
    expect(currentSample()).toBe(31);
  });
});

describe("quick-select is suppressed during playback", () => {
  it("a digit does not change currentSample while transport is playing", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setTransport("playing");
    await user.keyboard("5");
    expect(currentSample()).toBe(1);
  });
});

describe("quick-select also works in the sample view", () => {
  // Earlier the gate was wholesale-disabled here because the sample editor
  // had bare numeric inputs that would have eaten plain digits. With the
  // editor on sliders + selects (focused inputs are protected upstream),
  // sample selection works the same as in pattern view.

  it('plain digits select samples 1..10 when view is "sample"', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setView("sample");
    await user.keyboard("5");
    expect(currentSample()).toBe(5);
    await user.keyboard("0");
    expect(currentSample()).toBe(10);
  });

  it("plain digits work in sample view even when cursor is on a hex field", async () => {
    // The hex-field gate is pattern-view-specific (digits there type into the
    // cell). In sample view the cursor is dormant, so the field doesn't
    // matter — plain digits still select samples.
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}"); // sampleHi (a hex field)
    setView("sample");
    await user.keyboard("5");
    expect(currentSample()).toBe(5);
  });

  it("Shift+digit selects samples 11..20 in sample view", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setView("sample");
    await user.keyboard("{Shift>}3{/Shift}");
    expect(currentSample()).toBe(13);
  });

  it("'-' / '=' step previous/next sample in sample view", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setCurrentSample(5);
    setView("sample");
    await user.keyboard("=");
    expect(currentSample()).toBe(6);
    await user.keyboard("-");
    expect(currentSample()).toBe(5);
  });
});
