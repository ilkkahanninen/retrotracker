import { Icon } from "./Icon";
import { FileMusic, FileVolume, Trash, X } from "./icons";
import {
  createSignal,
  createResource,
  For,
  Show,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import {
  BackendError,
  deleteEntry,
  listEntries,
  type BackendEntry,
  type BackendResource,
} from "../state/backend";

export type ServerBrowserMode = "open" | "save";

/** A backend entry annotated with the resource bucket it came from. */
export interface BrowserEntry extends BackendEntry {
  resource: BackendResource;
}

interface Props {
  /** Resources to list, merged. Open mode may span several (e.g. projects + modules); save mode is typically a single bucket. */
  resources: BackendResource[];
  mode: ServerBrowserMode;
  /** Required when `mode === "save"`: the bucket the typed name is written to. */
  saveTo?: BackendResource;
  title: string;
  /** Pre-filled filename when `mode === "save"`. Ignored for open. */
  initialName?: string;
  /**
   * Called when the user picks (open) or commits (save). Resource is the
   * source bucket (open) or `saveTo` (save). `signal` aborts when the user
   * dismisses the dialog mid-request: pass it to the fetch and don't apply
   * the result once it has fired.
   */
  onPick: (
    name: string,
    resource: BackendResource,
    signal: AbortSignal,
  ) => void | Promise<void>;
  onClose: () => void;
}

/**
 * Shared modal for browsing files on the optional cloud backend. Powers
 * the "Open from cloud" entry (lists `.retro` projects + `.mod`/`.xm`
 * modules merged) and the "Save to cloud" entry (writes a `.retro` into
 * the projects bucket). Path validation lives server-side; the UI only
 * does minimal client-side checks (empty input) for immediate feedback.
 */
export const ServerBrowser: Component<Props> = (props) => {
  const [name, setName] = createSignal(props.initialName ?? "");
  const [busy, setBusy] = createSignal(false);
  const [opError, setOpError] = createSignal<string | null>(null);

  const [entries, { refetch }] = createResource(
    () => props.resources.join(","),
    async () => {
      try {
        const lists = await Promise.all(
          props.resources.map(async (r) => {
            const items = await listEntries(r);
            return items.map((e) => ({ ...e, resource: r }) as BrowserEntry);
          }),
        );
        const merged = lists.flat();
        merged.sort((a, b) => b.mtime - a.mtime);
        return merged;
      } catch (e) {
        setOpError(formatError(e));
        return [] as BrowserEntry[];
      }
    },
  );

  let dialog: HTMLDivElement | undefined;
  // While a request is in flight rows can't be picked (a double-click
  // used to fire the load three times: click, click, dblclick), and
  // dismissing the dialog CANCELS the request. Closing without cancelling
  // let the user go back to editing and then have the song replaced under
  // them when the fetch landed; refusing to close at all left no way out
  // of a stalled request short of reloading the page.
  let inFlight: AbortController | null = null;
  const begin = (): AbortSignal => {
    inFlight = new AbortController();
    setBusy(true);
    setOpError(null);
    return inFlight.signal;
  };
  const close = () => {
    inFlight?.abort();
    inFlight = null;
    props.onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  onMount(() => {
    window.addEventListener("keydown", onKey);
    queueMicrotask(() => dialog?.focus());
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKey);
    inFlight?.abort();
  });

  const commit = async () => {
    const trimmed = name().trim();
    if (trimmed.length === 0) {
      setOpError("Name is required");
      return;
    }
    const target = props.saveTo;
    if (!target) {
      setOpError("Internal: saveTo missing");
      return;
    }
    const signal = begin();
    try {
      await props.onPick(trimmed, target, signal);
    } catch (e) {
      if (signal.aborted) return;
      setOpError(formatError(e));
      setBusy(false);
      return;
    }
    // The caller closes the modal on success.
  };

  const pickRow = async (entry: BrowserEntry) => {
    if (busy()) return;
    if (props.mode === "open") {
      const signal = begin();
      try {
        await props.onPick(entry.name, entry.resource, signal);
      } catch (e) {
        if (signal.aborted) return;
        setOpError(formatError(e));
        setBusy(false);
      }
    } else {
      setName(entry.name);
    }
  };

  const removeRow = async (entry: BrowserEntry, ev: MouseEvent) => {
    ev.stopPropagation();
    if (!window.confirm(`Delete "${entry.name}" from cloud?`)) return;
    const signal = begin();
    try {
      await deleteEntry(entry.resource, entry.name, signal);
      await refetch();
    } catch (e) {
      if (!signal.aborted) setOpError(formatError(e));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };

  const nameExists = () => {
    const trimmed = name().trim();
    if (!trimmed || !props.saveTo) return false;
    const target = props.saveTo;
    return entries()?.some((e) => e.name === trimmed && e.resource === target);
  };

  return (
    <div class="modal-backdrop" role="presentation" onClick={close}>
      <div
        class="modal server-browser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-browser-title"
        ref={dialog}
        tabindex="-1"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal__head">
          <h2 id="server-browser-title">{props.title}</h2>
          <button
            type="button"
            class="modal__close"
            onClick={close}
            aria-label="Close"
            title="Close (Esc)"
          >
            <Icon of={X} size={16} />
          </button>
        </div>
        <div class="modal__body server-browser__body">
          <Show when={opError()}>
            <p class="server-browser__error" role="alert">
              {opError()}
            </p>
          </Show>

          <div class="server-browser__list" role="listbox">
            <Show when={entries.loading}>
              <p class="server-browser__hint">Loading…</p>
            </Show>
            <Show when={!entries.loading && (entries() ?? []).length === 0}>
              <p class="server-browser__hint">No files in cloud.</p>
            </Show>
            <For each={entries()}>
              {(entry) => (
                <div
                  class="server-browser__row"
                  role="option"
                  aria-selected={name() === entry.name}
                  onClick={() => void pickRow(entry)}
                >
                  <span class="server-browser__name">
                    <Icon
                      of={
                        entry.name.toLowerCase().endsWith(".wav")
                          ? FileVolume
                          : FileMusic
                      }
                    />
                    {entry.name}
                  </span>
                  <span class="server-browser__meta">
                    {formatSize(entry.size)} · {formatTime(entry.mtime)}
                  </span>
                  <button
                    type="button"
                    class="server-browser__delete"
                    title={`Delete ${entry.name}`}
                    aria-label={`Delete ${entry.name}`}
                    onClick={(e) => void removeRow(entry, e)}
                  >
                    <Icon of={Trash} />
                  </button>
                </div>
              )}
            </For>
          </div>

          <Show when={props.mode === "save"}>
            <div class="server-browser__save">
              <label class="server-browser__label">
                Name
                <input
                  class="server-browser__input"
                  type="text"
                  value={name()}
                  placeholder="e.g. demos/intro.retro"
                  onInput={(e) => setName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commit();
                  }}
                />
              </label>
              <Show when={nameExists()}>
                <p class="server-browser__warn">
                  Saving will overwrite the existing file.
                </p>
              </Show>
            </div>
          </Show>

          <div class="server-browser__actions">
            <button type="button" class="server-browser__btn" onClick={close}>
              Cancel
            </button>
            <Show when={props.mode === "save"}>
              <button
                type="button"
                class="server-browser__btn server-browser__btn--primary"
                onClick={() => void commit()}
                disabled={busy() || name().trim().length === 0}
              >
                Save
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const date = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  return `${date} ${time}`;
}

function formatError(e: unknown): string {
  if (e instanceof BackendError) {
    if (e.kind === "network") return "Could not reach server.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
