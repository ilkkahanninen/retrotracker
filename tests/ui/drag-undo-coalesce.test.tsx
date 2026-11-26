/**
 * Regression: envelope-point / segment drags committed on every
 * pointermove without opening a coalesced edit group, so one drag pushed
 * hundreds of undo entries (evicting the whole 200-entry history), and
 * `beginDragEdit` refused to open a group at all for FT2 songs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

import { EnvelopeOverlay } from "../../src/components/EnvelopeOverlay";
import { EnvelopeEditor } from "../../src/components/EnvelopeEditor";
import { PARAM_AXES } from "../../src/core/audio/sampleWorkbench";
import { emptySong } from "../../src/core/mod/format";
import { emptyXmSong } from "../../src/core/xm/format";
import {
  beginDragEdit,
  canUndo,
  clearHistory,
  commitEdit,
  commitEditXm,
  endDragEdit,
  setSong,
  setTransport,
  song,
  undo,
} from "../../src/state/song";

function reset() {
  setSong(null);
  setTransport("idle");
  clearHistory();
}
beforeEach(reset);
afterEach(() => {
  cleanup();
  endDragEdit(); // never leave a group open for the next test
  reset();
});

/** How many undo steps it takes to empty the history. */
function undoDepth(): number {
  let n = 0;
  while (canUndo() && n < 1000) {
    undo();
    n++;
  }
  return n;
}

const pointer = (type: string, x = 0, y = 0) =>
  new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });

describe("beginDragEdit / endDragEdit", () => {
  it("coalesces XM commits into one undo entry", () => {
    setSong(emptyXmSong());
    const original = song();
    beginDragEdit();
    for (let i = 1; i <= 25; i++) {
      commitEditXm((s) => ({ ...s, title: `t${i}` }));
    }
    endDragEdit();
    expect(song()!.title).toBe("t25");
    undo();
    expect(song()).toBe(original);
    expect(canUndo()).toBe(false);
  });

  it("records nothing when the group changed nothing", () => {
    setSong(emptyXmSong());
    beginDragEdit();
    endDragEdit();
    expect(canUndo()).toBe(false);
  });
});

describe("EnvelopeOverlay drags", () => {
  function mount() {
    setSong(emptySong());
    const [points, setPoints] = createSignal([
      { frame: 0, value: 1 },
      { frame: 50, value: 1 },
      { frame: 100, value: 1 },
    ]);
    let n = 0;
    // Each callback commits to history, like the real pipeline actions do.
    const commit = () => commitEdit((s) => ({ ...s, title: `drag${++n}` }));
    const result = render(() => (
      <svg>
        <EnvelopeOverlay
          points={points()}
          axis={PARAM_AXES.volume}
          sourceFrames={101}
          width={1000}
          height={160}
          xForFrame={(f) => f * 10}
          frameForX={(x) => x / 10}
          clientToCanvasX={(x) => x}
          clientToCanvasY={(y) => y}
          onAddPoint={() => {}}
          onRemovePoint={() => {}}
          onPatchPoint={(i, next) => {
            setPoints((p) =>
              p.map((pt, j) => (j === i ? { ...pt, ...next } : pt)),
            );
            commit();
          }}
          onNudgeSegment={() => commit()}
        />
      </svg>
    ));
    return result;
  }

  it("a point drag is one undo entry, however many moves it takes", () => {
    const { container } = mount();
    const original = song();
    const point = container.querySelectorAll(".envelope__point")[1]!;
    fireEvent(point, pointer("pointerdown", 500, 80));
    for (let i = 1; i <= 30; i++) {
      window.dispatchEvent(pointer("pointermove", 500 + i, 80 - i));
    }
    window.dispatchEvent(pointer("pointerup"));
    expect(song()!.title).toBe("drag30");
    expect(undoDepth()).toBe(1);
    expect(song()).toBe(original);
  });

  it("a segment drag is one undo entry", () => {
    const { container } = mount();
    const segment = container.querySelector(".envelope__segment")!;
    fireEvent(segment, pointer("pointerdown", 250, 80));
    for (let i = 1; i <= 20; i++) {
      window.dispatchEvent(pointer("pointermove", 250, 80 - i));
    }
    window.dispatchEvent(pointer("pointerup"));
    expect(song()!.title).not.toBe("");
    expect(undoDepth()).toBe(1);
  });

  it("the group is closed on release: later edits get their own entries", () => {
    const { container } = mount();
    const point = container.querySelectorAll(".envelope__point")[1]!;
    fireEvent(point, pointer("pointerdown", 500, 80));
    window.dispatchEvent(pointer("pointermove", 510, 70));
    window.dispatchEvent(pointer("pointerup"));
    commitEdit((s) => ({ ...s, title: "after-1" }));
    commitEdit((s) => ({ ...s, title: "after-2" }));
    expect(undoDepth()).toBe(3);
  });

  it("unmounting mid-drag closes the group", () => {
    const { container, unmount } = mount();
    const point = container.querySelectorAll(".envelope__point")[1]!;
    fireEvent(point, pointer("pointerdown", 500, 80));
    window.dispatchEvent(pointer("pointermove", 510, 70));
    unmount();
    commitEdit((s) => ({ ...s, title: "after-1" }));
    commitEdit((s) => ({ ...s, title: "after-2" }));
    expect(undoDepth()).toBe(3);
  });
});

describe("XM instrument EnvelopeEditor drags", () => {
  it("a point drag is one undo entry", () => {
    setSong(emptyXmSong());
    const original = song();
    const [env, setEnv] = createSignal({
      enabled: true,
      sustainEnabled: false,
      loopEnabled: false,
      sustainPoint: 0,
      loopStart: 0,
      loopEnd: 0,
      points: [
        { tick: 0, value: 64 },
        { tick: 20, value: 32 },
        { tick: 40, value: 0 },
      ],
    });
    let n = 0;
    const editorProps = {
      kind: "volume",
      get envelope() {
        return env();
      },
      onPatchFlags: () => {},
      onAddPoint: () => {},
      onRemovePoint: () => {},
      onSetPoint: (i: number, p: { tick: number; value: number }) => {
        setEnv((e) => ({
          ...e,
          points: e.points.map((pt, j) => (j === i ? p : pt)),
        }));
        commitEditXm((s) => ({ ...s, title: `env${++n}` }));
      },
    } as unknown as Parameters<typeof EnvelopeEditor>[0];
    const { container } = render(() => <EnvelopeEditor {...editorProps} />);
    const svg = container.querySelector("svg")!;
    svg.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 100,
        right: 400,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const points = container.querySelectorAll(".envelope-editor__point-hit");
    expect(points.length).toBeGreaterThanOrEqual(3);
    fireEvent(points[1]!, pointer("pointerdown", 100, 50));
    for (let i = 1; i <= 15; i++) {
      window.dispatchEvent(pointer("pointermove", 100 + i * 2, 50 + i));
    }
    window.dispatchEvent(pointer("pointerup"));
    expect(n).toBeGreaterThan(1);
    expect(undoDepth()).toBe(1);
    expect(song()).toBe(original);
  });
});
