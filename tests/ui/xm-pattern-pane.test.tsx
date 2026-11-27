import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

import { App } from "../../src/App";
import { emptySong } from "../../src/core/mod/format";
import { emptyXmInstrument, emptyXmSong } from "../../src/core/xm/format";
import { setXmChannelCount } from "../../src/core/xm/mutations";
import { writeXm } from "../../src/core/xm/writer";
import { resetXmCursor, setXmCursor } from "../../src/state/cursorXm";
import { clearXmSelection, setXmSelection } from "../../src/state/selection";
import { editStep, setEditStep } from "../../src/state/edit";
import {
  setCurrentXmInstrument,
  setCurrentXmOctave,
} from "../../src/state/xmEdit";
import { patternNames, resetPatternNames } from "../../src/state/patternNames";
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
  resetPatternNames();
  clearXmSelection();
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

describe("FT2 pattern meta strip: song title", () => {
  /** Double-click the title and return the inline editor that replaces it. */
  async function openEditor(container: HTMLElement) {
    fireEvent.dblClick(container.querySelector(".patternpane__title")!);
    // The editor focuses and selects itself in a microtask.
    await Promise.resolve();
    return container.querySelector<HTMLInputElement>(
      ".patternpane__title-input",
    )!;
  }

  it("double-click opens an editor and Enter commits the new title", async () => {
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    const input = await openEditor(container);
    expect(input).toBeTruthy();
    // Piano-row letters: must land in the field, not in the pattern.
    await user.keyboard("qwerty{Enter}");
    expect(xm2Song()!.title).toBe("qwerty");
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(0);
    expect(container.querySelector(".patternpane__title-input")).toBeNull();
    expect(container.querySelector(".patternpane__title")!.textContent).toBe(
      "qwerty",
    );
  });

  it("Escape cancels without changing the title", async () => {
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await openEditor(container);
    await user.keyboard("nope{Escape}");
    expect(xm2Song()!.title).toBe(emptyXmSong().title);
    expect(container.querySelector(".patternpane__title-input")).toBeNull();
  });

  it("stays editable while playing", async () => {
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    setTransport("playing");
    await openEditor(container);
    await user.keyboard("live{Enter}");
    expect(xm2Song()!.title).toBe("live");
  });
});

describe("FT2 order list: pattern names", () => {
  it("double-click opens an editor and Enter names the pattern", async () => {
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    const row = container.querySelector(".orderlist--xm li")!;
    fireEvent.dblClick(row);
    await Promise.resolve(); // the editor focuses itself in a microtask
    expect(row.querySelector(".orderlist__name-input")).toBeTruthy();
    // Piano-row letters: must land in the field, not in the pattern.
    await user.keyboard("qwerty{Enter}");
    expect(patternNames()[0]).toBe("qwerty");
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(0);
    expect(row.querySelector(".orderlist__name-input")).toBeNull();
    expect(row.querySelector(".orderlist__name")!.textContent).toBe("qwerty");
  });

  it("Escape cancels without naming the pattern", async () => {
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    const row = container.querySelector(".orderlist--xm li")!;
    fireEvent.dblClick(row);
    await Promise.resolve();
    await user.keyboard("nope{Escape}");
    expect(patternNames()[0]).toBeUndefined();
    expect(row.querySelector(".orderlist__name-input")).toBeNull();
  });
});

describe("FT2 Cmd+E: bounce selection to a new instrument", () => {
  it("runs the FT2 bounce (the PT binding used to swallow the key)", async () => {
    const song = emptyXmSong();
    const inst = emptyXmInstrument();
    inst.samples[0] = {
      ...inst.samples[0]!,
      data: new Int8Array(64).fill(60),
      bits: 8,
      volume: 64,
    };
    song.instruments = [inst];
    song.patterns[0]!.rows[0]![0] = {
      ...song.patterns[0]!.rows[0]![0]!,
      note: 49,
      instrument: 1,
    };
    setSong(song);
    render(() => <App />);
    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 3,
      startChannel: 0,
      endChannel: 0,
    });
    const user = userEvent.setup();
    await user.keyboard("{Meta>}e{/Meta}");
    expect(xm2Song()!.instruments).toHaveLength(2);
    expect(xm2Song()!.instruments[1]!.samples[0]!.data.length).toBeGreaterThan(
      0,
    );
  });
});

describe("FT2 pattern meta strip: live readouts", () => {
  const stripText = (container: HTMLElement) =>
    container.querySelector(".patternpane__meta")!.textContent!;

  it("shows the position, octave and current instrument", async () => {
    const song = emptyXmSong();
    setSong({ ...song, songLength: 3 });
    setCurrentXmOctave(4);
    setCurrentXmInstrument(1);
    const { container } = render(() => <App />);
    expect(stripText(container)).toContain("order 00/02");
    expect(stripText(container)).toContain("pat 00");
    expect(stripText(container)).toContain("row 00");
    expect(stripText(container)).toContain("oct 4");
    expect(stripText(container)).toContain("ins 01");

    // Z / X change the octave — it used to have no readout anywhere.
    setCurrentXmOctave(6);
    setCurrentXmInstrument(0x1f);
    setPlayPos({ order: 2, row: 0x2a });
    expect(stripText(container)).toContain("oct 6");
    expect(stripText(container)).toContain("ins 1F");
    expect(stripText(container)).toContain("order 02/02");
    expect(stripText(container)).toContain("row 2A");
  });

  it("counts instruments that have something to play, not declared slots", () => {
    const song = emptyXmSong();
    const loaded = emptyXmInstrument();
    loaded.samples[0] = {
      ...loaded.samples[0]!,
      data: new Int8Array(8).fill(1),
    };
    // Three slots, one of them with audio.
    song.instruments = [emptyXmInstrument(), loaded, emptyXmInstrument()];
    setSong(song);
    const { container } = render(() => <App />);
    expect(stripText(container)).toContain("1 instruments");
  });
});

describe("FT2 help pane and channel-header tooltips", () => {
  function openTips(container: HTMLElement): string {
    fireEvent.click(container.querySelector(".patternhelp__toggle")!);
    return container.querySelector(".patternhelp__tips")!.textContent!;
  }

  it("lists the shortcuts that work in FT2 mode", () => {
    const { container } = render(() => <App />);
    const tips = openTips(container);
    // Backspace pulls the channel up — it used to be labelled as a clear.
    expect(tips).toContain("pull cell up");
    expect(tips).not.toContain("clear cell, step up");
    for (const action of [
      "pull row up",
      "push cell down",
      "push row down",
      "transpose −/+ semitone",
      "transpose −/+ octave",
      "bounce to next free instrument",
    ]) {
      expect(tips).toContain(action);
    }
  });

  it("shows repeat-last-effect on the effect column", () => {
    const { container } = render(() => <App />);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "effectCmd" });
    expect(openTips(container)).toContain("repeat last effect");
  });

  it("names the real Song / Pattern and Follow shortcuts", () => {
    const { container } = render(() => <App />);
    const tips = openTips(container);
    expect(tips).toMatch(/\+ N\s*toggle Song \/ Pattern mode/);
    expect(tips).toMatch(/\+ M\s*toggle Follow playhead/);
  });

  it("mute / solo buttons carry their Alt+digit hint for the first ten channels", () => {
    setSong(setXmChannelCount(emptyXmSong(), 12));
    const { container } = render(() => <App />);
    const titles = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".patgrid--xm .patgrid__chbtn",
      ),
    ).map((b) => b.title);
    expect(titles[0]).toBe("Mute channel 1 (Alt+1)");
    expect(titles[1]).toBe("Solo channel 1 (Alt+Shift+1)");
    // The tenth channel is on the 0 key; the eleventh has none.
    expect(titles[18]).toBe("Mute channel 10 (Alt+0)");
    expect(titles[20]).toBe("Mute channel 11");
  });
});
