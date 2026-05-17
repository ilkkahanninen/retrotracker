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
  createShare,
  listMyShares,
  revokeShare,
  type ShareEntry,
} from "../state/share";
import { BackendError } from "../state/backend";
import type { CloudOrigin } from "../state/session";

interface Props {
  /** The currently-loaded song's cloud origin. When non-null the
   *  modal shows a "Create / copy link" panel; null callers should
   *  not render this modal (the menu item is disabled). */
  origin: CloudOrigin | null;
  onClose: () => void;
}

/**
 * Share-link manager modal. Two stacked panels:
 *
 *   1. **This song** — when `origin` is set, a button creates (or
 *      reuses) a share for that file and shows the resulting URL
 *      with a copy-to-clipboard button.
 *   2. **Your shared songs** — list of every share the user owns,
 *      with copy + revoke buttons each. Loaded lazily on mount.
 *
 * Reuses the `.modal-backdrop` / `.modal` pattern from
 * `ServerBrowser.tsx` so it inherits Escape-dismiss + focus mgmt.
 */
export const ShareModal: Component<Props> = (props) => {
  const [currentShare, setCurrentShare] = createSignal<{
    token: string;
    url: string;
    created: boolean;
  } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const [shares, { refetch }] = createResource(async () => {
    try {
      return await listMyShares();
    } catch (e) {
      setError(formatError(e));
      return [] as ShareEntry[];
    }
  });

  let dialog: HTMLDivElement | undefined;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => {
    window.addEventListener("keydown", onKey);
    queueMicrotask(() => dialog?.focus());
  });
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const onCreate = async () => {
    const origin = props.origin;
    if (!origin) return;
    setBusy(true);
    setError(null);
    try {
      const r = await createShare({
        resource: origin.resource,
        name: origin.name,
      });
      setCurrentShare({ token: r.token, url: r.url, created: r.created });
      await refetch();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (token: string) => {
    if (!window.confirm("Revoke this share link?")) return;
    setBusy(true);
    setError(null);
    try {
      await revokeShare(token);
      if (currentShare()?.token === token) setCurrentShare(null);
      await refetch();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async (url: string) => {
    const full = absoluteUrl(url);
    try {
      await navigator.clipboard.writeText(full);
    } catch {
      // Clipboard API can refuse on insecure contexts; fall back to
      // selecting the text in the input so the user can copy by hand.
    }
  };

  return (
    <div
      class="modal-backdrop"
      role="presentation"
      onClick={() => props.onClose()}
    >
      <div
        class="modal share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-modal-title"
        ref={dialog}
        tabindex="-1"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal__head">
          <h2 id="share-modal-title">Share songs</h2>
          <button
            type="button"
            class="modal__close"
            onClick={() => props.onClose()}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
        <div class="modal__body share-modal__body">
          <Show when={error()}>
            <p class="server-browser__error" role="alert">
              {error()}
            </p>
          </Show>

          <Show when={props.origin}>
            {(o) => (
              <section class="share-modal__section">
                <h3 class="share-modal__section-title">This song</h3>
                <p class="share-modal__hint">
                  <code>{o().name}</code> · {o().resource}
                </p>
                <Show
                  when={currentShare()}
                  fallback={
                    <button
                      type="button"
                      class="server-browser__btn server-browser__btn--primary"
                      onClick={() => void onCreate()}
                      disabled={busy()}
                    >
                      Create share link
                    </button>
                  }
                >
                  {(cs) => (
                    <div class="share-modal__url-row">
                      <input
                        class="server-browser__input share-modal__url"
                        type="text"
                        readonly
                        value={absoluteUrl(cs().url)}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <button
                        type="button"
                        class="server-browser__btn"
                        onClick={() => void onCopy(cs().url)}
                      >
                        Copy
                      </button>
                    </div>
                  )}
                </Show>
                <p class="share-modal__hint">
                  Anyone with this link can open the song. Recipients can save a
                  copy to their own cloud. You can revoke it any time from the
                  list below.
                </p>
              </section>
            )}
          </Show>

          <section class="share-modal__section">
            <h3 class="share-modal__section-title">Your shared songs</h3>
            <Show when={shares.loading}>
              <p class="server-browser__hint">Loading…</p>
            </Show>
            <Show when={!shares.loading && (shares() ?? []).length === 0}>
              <p class="server-browser__hint">No shared songs yet.</p>
            </Show>
            <div class="share-modal__list">
              <For each={shares()}>
                {(s) => (
                  <div class="share-modal__row">
                    <span class="share-modal__row-name">
                      <code>{s.name}</code>
                    </span>
                    <span class="share-modal__row-meta">
                      {s.resource} · {formatTime(s.createdAt)}
                    </span>
                    <button
                      type="button"
                      class="server-browser__btn"
                      onClick={() => void onCopy(s.url)}
                      title="Copy link"
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      class="server-browser__btn"
                      onClick={() => void onRevoke(s.token)}
                      title="Revoke this share"
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </For>
            </div>
          </section>

          <div class="server-browser__actions">
            <button
              type="button"
              class="server-browser__btn"
              onClick={() => props.onClose()}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function absoluteUrl(relative: string): string {
  if (typeof window === "undefined") return relative;
  return new URL(relative, window.location.href).toString();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function formatError(e: unknown): string {
  if (e instanceof BackendError) {
    if (e.kind === "network") return "Could not reach server.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
