import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App";
import { setSong } from "../../src/state/song";
import { emptySong } from "../../src/core/mod/format";
import { cloudOrigin, setCloudOrigin } from "../../src/state/session";
import { clearSession } from "../../src/state/persistence";

/**
 * Repro for "After saving a song to cloud the 'Share this song'
 * option is not enabled". Mocks /api/health → shareAvailable=true,
 * /api/auth/status → anonymous, and the PUT round-trip so the
 * frontend can take the full save-to-cloud path without a backend.
 */

function mockFetch() {
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/health") && method === "GET") {
      return new Response(
        JSON.stringify({ ok: true, version: "test", shareAvailable: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/api/auth/status") && method === "GET") {
      return new Response(JSON.stringify({ authRequired: false, user: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/projects") && method === "GET") {
      // Listing call from ServerBrowser. Empty list so the modal
      // shows immediately without an overwrite warning.
      return new Response(
        JSON.stringify({
          resource: "projects",
          extensions: [".retro"],
          entries: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/modules") && method === "GET") {
      return new Response(
        JSON.stringify({
          resource: "modules",
          extensions: [".mod", ".xm"],
          entries: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/projects/") && method === "PUT") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not mocked: " + url, { status: 500 });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

beforeEach(() => {
  mockFetch();
  // Module-level signals + localStorage leak between tests; reset
  // both so each case starts from the same clean baseline a fresh
  // page load would see.
  setCloudOrigin(null);
  setSong(null);
  clearSession();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function menuTrigger(container: HTMLElement, label: string): HTMLButtonElement {
  for (const btn of container.querySelectorAll<HTMLButtonElement>(
    ".menu__button",
  )) {
    if (btn.textContent?.startsWith(label)) return btn;
  }
  throw new Error(`${label} menu button not found`);
}

function findItem(container: HTMLElement, label: string): HTMLElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLElement>(".menu__item")).find(
      (it) => it.textContent?.includes(label),
    ) ?? null
  );
}

describe("Share this song menu item", () => {
  it("survives a page reload via the autosave round-trip", async () => {
    // Repro: user saves to cloud, autosave fires, page reloads,
    // localStorage restore brings the song back — and Share should
    // still be enabled because cloudOrigin was persisted alongside it.
    setSong(emptySong());
    const first = render(() => <App />);
    const user = userEvent.setup();

    await new Promise((r) => setTimeout(r, 10));
    fireEvent.click(menuTrigger(first.container, "File"));
    const saveItem = findItem(first.container, "Save to cloud");
    fireEvent.click(saveItem!);
    await new Promise((r) => setTimeout(r, 10));
    const input = first.container.querySelector<HTMLInputElement>(
      ".server-browser__input",
    )!;
    await user.clear(input);
    await user.type(input, "reload-me.retro");
    const saveBtn = Array.from(
      first.container.querySelectorAll<HTMLButtonElement>(
        ".server-browser__btn",
      ),
    ).find((b) => b.textContent === "Save")!;
    fireEvent.click(saveBtn);
    await new Promise((r) => setTimeout(r, 20));
    expect(cloudOrigin()).toEqual({
      resource: "projects",
      name: "reload-me.retro",
    });

    // Give the debounced autosave (250 ms) time to flush.
    await new Promise((r) => setTimeout(r, 300));

    // Simulate a real page reload: unmount the first App AND reset
    // the module-level signals (which would be re-initialised on a
    // fresh JS context). localStorage persists across reloads in a
    // real browser; we keep it intact here so loadSession can restore.
    cleanup();
    setSong(null);
    setCloudOrigin(null);

    const second = render(() => <App />);
    await new Promise((r) => setTimeout(r, 10));
    expect(cloudOrigin()).toEqual({
      resource: "projects",
      name: "reload-me.retro",
    });
    fireEvent.click(menuTrigger(second.container, "File"));
    const shareAfter = findItem(second.container, "Share this song");
    expect(shareAfter).not.toBeNull();
    expect(shareAfter!.getAttribute("aria-disabled")).toBe("false");
  });

  it("starts disabled, becomes enabled after saving to cloud", async () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const user = userEvent.setup();

    // Wait for the boot-time probes to settle.
    await new Promise((r) => setTimeout(r, 10));

    // Open File menu — Share should appear but be disabled (song
    // never saved to cloud yet, so cloudOrigin is still null).
    fireEvent.click(menuTrigger(container, "File"));
    const shareBefore = findItem(container, "Share this song");
    expect(shareBefore, "Share menu item should be rendered").not.toBeNull();
    expect(shareBefore!.getAttribute("aria-disabled")).toBe("true");

    // Trigger Save to cloud — opens the modal.
    const saveItem = findItem(container, "Save to cloud");
    expect(saveItem, "Save to cloud menu item should exist").not.toBeNull();
    fireEvent.click(saveItem!);

    // Wait for the ServerBrowser to mount + load its listing.
    await new Promise((r) => setTimeout(r, 10));
    const input = container.querySelector<HTMLInputElement>(
      ".server-browser__input",
    );
    expect(input, "Save modal should render the name input").not.toBeNull();
    await user.clear(input!);
    await user.type(input!, "demo.retro");

    // Click Save in the modal.
    const saveBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".server-browser__btn"),
    ).find((b) => b.textContent === "Save");
    expect(saveBtn, "Modal Save button should exist").not.toBeNull();
    fireEvent.click(saveBtn!);

    // Wait for the PUT round-trip + setCloudOrigin + modal close.
    await new Promise((r) => setTimeout(r, 20));

    expect(cloudOrigin()).toEqual({ resource: "projects", name: "demo.retro" });

    // Re-open the File menu — Share should now be enabled.
    fireEvent.click(menuTrigger(container, "File"));
    const shareAfter = findItem(container, "Share this song");
    expect(
      shareAfter,
      "Share menu item should still be rendered",
    ).not.toBeNull();
    expect(shareAfter!.getAttribute("aria-disabled")).toBe("false");
  });
});
