import { beforeEach, describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "../src/core/xm/format";
import {
  clearHistory,
  setSong,
  setTransport,
  xm2Song,
} from "../src/state/song";
import {
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "../src/state/xmEdit";
import { setXmSelection, clearXmSelection } from "../src/state/selection";
import { bounceXmSelectionToInstrument } from "../src/state/xmSampleEdit";
import { clearAllXmWorkbenches } from "../src/state/xmSampleWorkbench";

function seedSong() {
  const s = emptyXmSong();
  // Give instrument 1 a small triangle-like sample so the bounce has
  // audible material to render.
  const inst = emptyXmInstrument();
  inst.name = "ins1";
  const data = new Int8Array(64);
  for (let i = 0; i < 64; i++) data[i] = i < 32 ? i * 4 : (63 - i) * 4;
  inst.samples[0] = { ...inst.samples[0]!, data, bits: 8, name: "saw" };
  s.instruments = [inst];
  // Place a note at row 0 channel 0 so the replayer triggers something.
  s.patterns[0]!.rows[0]![0]!.note = 49; // C-4 in XM numbering
  s.patterns[0]!.rows[0]![0]!.instrument = 1;
  setSong(s);
  setTransport("idle");
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  clearXmSelection();
  clearAllXmWorkbenches();
  clearHistory();
}

beforeEach(seedSong);

describe("bounceXmSelectionToInstrument", () => {
  it("renders the selection into the next free instrument slot", () => {
    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 3,
      startChannel: 0,
      endChannel: 0,
    });
    expect(xm2Song()!.instruments.length).toBe(1);
    bounceXmSelectionToInstrument();
    // A new instrument was added at slot 2 (1-based) i.e. index 1.
    const after = xm2Song()!;
    expect(after.instruments.length).toBeGreaterThanOrEqual(2);
    const bounced = after.instruments[1]!;
    expect(bounced.samples.length).toBeGreaterThan(0);
    expect(bounced.samples[0]!.data.length).toBeGreaterThan(0);
    expect(bounced.samples[0]!.name.startsWith("Bnc")).toBe(true);
  });

  it("is a no-op when there's no selection", () => {
    bounceXmSelectionToInstrument();
    // No instruments added.
    expect(xm2Song()!.instruments.length).toBe(1);
  });
});
