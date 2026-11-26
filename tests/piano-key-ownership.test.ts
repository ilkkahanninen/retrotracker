import { describe, expect, it } from "vitest";
import { pianoKeyDown, pianoKeyUp } from "../src/state/keybindHelpers";

describe("piano key ownership of the audition voice", () => {
  it("releasing an older key leaves the newer key's note alone", () => {
    pianoKeyDown("a");
    pianoKeyDown("s");
    expect(pianoKeyUp("a")).toBe(false);
    expect(pianoKeyUp("s")).toBe(true);
  });

  it("a lone or untracked release still stops the audition", () => {
    pianoKeyDown("a");
    expect(pianoKeyUp("a")).toBe(true);
    expect(pianoKeyUp("d")).toBe(true);
  });
});
