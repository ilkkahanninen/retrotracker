import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

import { App } from "../../src/App";
import { emptySong } from "../../src/core/mod/format";
import { emptyXmSong } from "../../src/core/xm/format";
import { writeXm } from "../../src/core/xm/writer";
import { resetXmCursor } from "../../src/state/cursorXm";
import { editStep, setEditStep } from "../../src/state/edit";
import {
  clearHistory,
  setPlayPos,
  setSong,
  setTransport,
  xm2Song,
} from "../../src/state/song";

beforeEach(() => {
  setSong(emptyXmSong());
  resetXmCursor();
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  setEditStep(1);
});
afterEach(() => {
  cleanup();
  setSong(null);
  clearHistory();
});

/** Type a value into a meta-strip number input and commit it. */
function commit(input: HTMLInputElement, value: string): void {
  fireEvent.input(input, { target: { value } });
  fireEvent.change(input);
}

describe("FT2 pattern meta strip: initial speed / tempo", () => {
  it("shows the song's initial speed and tempo", () => {
    const { getByLabelText } = render(() => <App />);
    expect((getByLabelText("Initial speed") as HTMLInputElement).value).toBe(
      "6",
    );
    expect((getByLabelText("Initial tempo") as HTMLInputElement).value).toBe(
      "125",
    );
  });

  it("committing a value writes it to the song", () => {
    const { getByLabelText } = render(() => <App />);
    commit(getByLabelText("Initial speed") as HTMLInputElement, "3");
    commit(getByLabelText("Initial tempo") as HTMLInputElement, "150");
    expect(xm2Song()!.defaultTempo).toBe(3);
    expect(xm2Song()!.defaultBpm).toBe(150);
  });

  it("clamps out-of-range values and shows the clamped result", () => {
    const { getByLabelText } = render(() => <App />);
    const speed = getByLabelText("Initial speed") as HTMLInputElement;
    const tempo = getByLabelText("Initial tempo") as HTMLInputElement;
    commit(speed, "99");
    commit(tempo, "5");
    expect(xm2Song()!.defaultTempo).toBe(31);
    expect(xm2Song()!.defaultBpm).toBe(32);
    expect(speed.value).toBe("31");
    expect(tempo.value).toBe("32");
  });

  it("restores the field when the clamped value equals the current one", () => {
    const { getByLabelText } = render(() => <App />);
    const tempo = getByLabelText("Initial tempo") as HTMLInputElement;
    commit(tempo, "255");
    commit(tempo, "999");
    expect(xm2Song()!.defaultBpm).toBe(255);
    expect(tempo.value).toBe("255");
  });

  it("ignores an emptied field instead of committing the minimum", () => {
    const { getByLabelText } = render(() => <App />);
    const rows = getByLabelText("Pattern row count") as HTMLInputElement;
    commit(rows, "");
    expect(xm2Song()!.patterns[0]!.rowCount).toBe(64);
    expect(rows.value).toBe("64");
  });

  it("disables both inputs while playing", () => {
    const { getByLabelText } = render(() => <App />);
    setTransport("playing");
    expect((getByLabelText("Initial speed") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((getByLabelText("Initial tempo") as HTMLInputElement).disabled).toBe(
      true,
    );
  });
});

describe("FT2 pattern meta strip: edit step", () => {
  it("displays the edit step and steps it with the −/+ buttons", async () => {
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    setEditStep(2);
    const value = container.querySelector(".patternpane__editstep-value")!;
    expect(value.textContent).toBe("2");
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      ".patternpane__editstep-btn",
    );
    expect(buttons).toHaveLength(2); // [−, +]
    await user.click(buttons[1]!);
    expect(editStep()).toBe(3);
    await user.click(buttons[0]!);
    expect(editStep()).toBe(2);
  });
});

describe("header size pill", () => {
  const firstSeg = (container: HTMLElement) =>
    container.querySelector(".filesize__seg")!.textContent!.trim();

  it("shows the .xm size for an FT2 song", () => {
    // An empty XM packs to well under 1 KB, which rounds to the same
    // "0 KB" an unwired readout would show — fill the pattern first.
    const song = emptyXmSong();
    for (const row of song.patterns[0]!.rows) {
      for (const cell of row) cell.note = 49;
    }
    setSong(song);
    const kb = Math.round(writeXm(song).length / 1024);
    expect(kb).toBeGreaterThan(0);
    const { container } = render(() => <App />);
    expect(firstSeg(container)).toBe(`.xm ${kb} KB`);
  });

  it("still shows the .mod size for a PT song", () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    expect(firstSeg(container)).toMatch(/^\.mod \d+ KB$/);
  });
});
