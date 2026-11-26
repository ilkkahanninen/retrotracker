/**
 * Regressions for:
 *  - Info / Settings panes being rendered only inside the PT2 branch, so
 *    both views were blank for FT2 songs;
 *  - a failed load with a song open showing no error anywhere;
 *  - Save to cloud leaving the dirty flag set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

import { App } from "../../src/App";
import { emptySong } from "../../src/core/mod/format";
import { setCell } from "../../src/core/mod/mutations";
import { emptyXmSong } from "../../src/core/xm/format";
import { clearSession } from "../../src/state/persistence";
import {
  cloudOrigin,
  loadFile,
  setCloudOrigin,
  setError,
} from "../../src/state/session";
import {
  clearHistory,
  commitEdit,
  dirty,
  setDirty,
  setSong,
  setTransport,
  song,
  undo,
  xm2Song,
} from "../../src/state/song";
import { setView } from "../../src/state/view";

function reset() {
  setSong(null);
  setTransport("idle");
  clearHistory();
  setError(null);
  setCloudOrigin(null);
  setDirty(false);
  setView("pattern");
  clearSession();
}
beforeEach(reset);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  reset();
});

const visible = (el: Element | null) =>
  !!el && !el.classList.contains("view-hidden");

describe("Info and Settings views with an FT2 song", () => {
  beforeEach(() => {
    setSong({ ...emptyXmSong(), title: "xm tune" });
    setTransport("ready");
  });

  it("the Info view renders and shows the song title", () => {
    setView("info");
    const { container } = render(() => <App />);
    const wrapper = container.querySelector(".infoview-wrapper");
    expect(visible(wrapper)).toBe(true);
    const title = wrapper!.querySelector<HTMLInputElement>(".infoview__input")!;
    expect(title.value).toBe("xm tune");
  });

  it("editing the title in the Info view is an undoable FT2 edit", () => {
    setView("info");
    const { container } = render(() => <App />);
    const title = container.querySelector<HTMLInputElement>(
      ".infoview-wrapper .infoview__input",
    )!;
    fireEvent.input(title, { target: { value: "renamed" } });
    expect(xm2Song()!.title).toBe("renamed");
    undo();
    expect(xm2Song()!.title).toBe("xm tune");
  });

  it("the Settings view renders, including the FT2 mixer options", () => {
    setView("settings");
    const { container } = render(() => <App />);
    const wrapper = container.querySelector(".settingsview-wrapper");
    expect(visible(wrapper)).toBe(true);
    expect(wrapper!.textContent).toContain("XM mixer interpolation");
  });

  it("only one main pane is visible per view", () => {
    const { container } = render(() => <App />);
    const panes = () =>
      [
        ".patternpane",
        ".sampleview-wrapper",
        ".infoview-wrapper",
        ".settingsview-wrapper",
      ].filter((sel) => visible(container.querySelector(sel)));
    for (const [v, sel] of [
      ["pattern", ".patternpane"],
      ["sample", ".sampleview-wrapper"],
      ["info", ".infoview-wrapper"],
      ["settings", ".settingsview-wrapper"],
    ] as const) {
      setView(v);
      expect(panes()).toEqual([sel]);
    }
  });
});

describe("Info and Settings views with a PT song (unchanged)", () => {
  it("still render exactly once each", () => {
    setSong(emptySong());
    setView("info");
    const { container } = render(() => <App />);
    expect(container.querySelectorAll(".infoview-wrapper")).toHaveLength(1);
    expect(container.querySelectorAll(".settingsview-wrapper")).toHaveLength(1);
    expect(visible(container.querySelector(".infoview-wrapper"))).toBe(true);
  });
});

describe("failed load with a song open", () => {
  it("shows a dismissible error banner and keeps the song", async () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const before = song();

    const ok = await loadFile(
      new File([new Uint8Array(2000).fill(7)], "broken.mod"),
    );
    expect(ok).toBe(false);
    expect(song()).toBe(before);

    const banner = container.querySelector('[role="alert"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("broken.mod");

    fireEvent.click(banner!.querySelector("button")!);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("Save to cloud", () => {
  function mockBackend() {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/health"))
          return json({ ok: true, version: "test", shareAvailable: false });
        if (url.endsWith("/api/auth/status"))
          return json({ authRequired: false, user: null });
        if (url.includes("/api/projects/") && method === "PUT")
          return json({ ok: true });
        if (url.includes("/api/projects"))
          return json({
            resource: "projects",
            extensions: [".retro"],
            entries: [],
          });
        return new Response("not mocked: " + url, { status: 500 });
      }),
    );
  }
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("clears the dirty flag", async () => {
    mockBackend();
    setSong(emptySong());
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await tick(10);

    commitEdit((s) => setCell(s, 0, 0, 0, { period: 428, sample: 1 }));
    expect(dirty()).toBe(true);

    const fileMenu = [
      ...container.querySelectorAll<HTMLButtonElement>(".menu__button"),
    ].find((b) => b.textContent?.startsWith("File"))!;
    fireEvent.click(fileMenu);
    const saveItem = [
      ...container.querySelectorAll<HTMLElement>(".menu__item"),
    ].find((i) => i.textContent?.includes("Save to cloud"))!;
    fireEvent.click(saveItem);
    await tick(10);
    const input = container.querySelector<HTMLInputElement>(
      ".server-browser__input",
    )!;
    await user.clear(input);
    await user.type(input, "tune.retro");
    const saveBtn = [
      ...container.querySelectorAll<HTMLButtonElement>(".server-browser__btn"),
    ].find((b) => b.textContent === "Save")!;
    fireEvent.click(saveBtn);
    await tick(20);

    expect(cloudOrigin()).toEqual({ resource: "projects", name: "tune.retro" });
    expect(dirty()).toBe(false);
  });
});
