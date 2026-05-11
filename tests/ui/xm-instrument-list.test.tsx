import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

import { SlotList, type SlotDisplay } from "../../src/components/SlotList";
import { emptyXmSong } from "../../src/core/xm/format";
import { renameXmInstrument as renameMut } from "../../src/core/xm/mutations";
import {
  setCurrentXmInstrument,
  currentXmInstrument,
} from "../../src/state/xmEdit";
import {
  XM_INSTRUMENT_NAME_MAX,
  XM_MAX_INSTRUMENTS,
  type XmSong,
} from "../../src/core/xm/types";

beforeEach(() => {
  setCurrentXmInstrument(1);
});
afterEach(() => {
  cleanup();
});

/** Replicate App.tsx's FT2 slot-list wiring so the test exercises the
 *  same composition the user sees. */
function renderInstrumentList(
  song: XmSong,
  opts: {
    onSelect?: (n: number) => void;
    onRename?: (slot: number, name: string) => void;
  } = {},
) {
  return render(() => (
    <SlotList
      slots={() => {
        const insts = song.instruments;
        const arr: SlotDisplay[] = new Array(XM_MAX_INSTRUMENTS);
        for (let i = 0; i < XM_MAX_INSTRUMENTS; i++) {
          const inst = insts[i];
          arr[i] = {
            name: inst?.name ?? "",
            isEmpty: !inst || inst.samples.length === 0,
          };
        }
        return arr;
      }}
      currentSlot={currentXmInstrument}
      onSelect={opts.onSelect ?? (() => {})}
      onRename={opts.onRename ?? (() => {})}
      nameMaxLength={XM_INSTRUMENT_NAME_MAX}
      itemLabel="instrument"
    />
  ));
}

describe("InstrumentList (FT2 SlotList binding)", () => {
  it("renders all 128 slots, even when the song carries 0 instruments", () => {
    const { container } = renderInstrumentList(emptyXmSong());
    const slots = container.querySelectorAll("li");
    expect(slots).toHaveLength(128);
  });

  it("highlights the currentXmInstrument slot", () => {
    setCurrentXmInstrument(5);
    const { container } = renderInstrumentList(emptyXmSong());
    const slots = container.querySelectorAll("li");
    expect(slots[4]?.classList.contains("sample--current")).toBe(true);
    expect(slots[0]?.classList.contains("sample--current")).toBe(false);
  });

  it("shows an existing instrument name", () => {
    let song: XmSong = emptyXmSong();
    song = renameMut(song, 1, "kick");
    const { container } = renderInstrumentList(song);
    const firstSlot = container.querySelector("li")!;
    expect(firstSlot.textContent).toContain("kick");
  });

  it("clicking a slot fires onSelect with the 1-based index", async () => {
    const user = userEvent.setup();
    let selected: number | null = null;
    const { container } = renderInstrumentList(emptyXmSong(), {
      onSelect: (n) => (selected = n),
    });
    const slots = container.querySelectorAll<HTMLElement>("li");
    await user.click(slots[6]!);
    expect(selected).toBe(7);
  });

  it("double-click opens an inline rename input; Enter commits", () => {
    let renamed: { slot: number; name: string } | null = null;
    const { container } = renderInstrumentList(emptyXmSong(), {
      onRename: (slot, name) => (renamed = { slot, name }),
    });
    const firstSlot = container.querySelector("li")!;
    fireEvent.dblClick(firstSlot);
    const input = container.querySelector(
      ".sample__name-input",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = "synthlead";
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renamed).toEqual({ slot: 1, name: "synthlead" });
  });

  it("Escape cancels the rename without firing onRename", () => {
    let fired = false;
    const { container } = renderInstrumentList(emptyXmSong(), {
      onRename: () => (fired = true),
    });
    const firstSlot = container.querySelector("li")!;
    fireEvent.dblClick(firstSlot);
    const input = container.querySelector(
      ".sample__name-input",
    ) as HTMLInputElement;
    input.value = "ignore me";
    fireEvent.keyDown(input, { key: "Escape" });
    expect(fired).toBe(false);
  });

  it("highlights renders reactively when currentXmInstrument changes", () => {
    setCurrentXmInstrument(1);
    const { container } = renderInstrumentList(emptyXmSong());
    const slots = container.querySelectorAll("li");
    expect(slots[0]?.classList.contains("sample--current")).toBe(true);
    setCurrentXmInstrument(3);
    expect(currentXmInstrument()).toBe(3);
    expect(slots[2]?.classList.contains("sample--current")).toBe(true);
    expect(slots[0]?.classList.contains("sample--current")).toBe(false);
  });
});
