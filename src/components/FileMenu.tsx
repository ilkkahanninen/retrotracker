import { For, Show, createSignal, onCleanup, type Component } from 'solid-js';

interface FileMenuItem {
  label: string;
  hint?: string;       // right-aligned shortcut hint (purely cosmetic)
  separator?: boolean; // when true, renders as a divider line
  onClick?: () => void;
  disabled?: boolean;
}

interface FileMenuProps {
  hasSong: boolean;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onExportMod: () => void;
}

/**
 * Lightweight File ▾ dropdown for the app header.
 *
 * Click the button → menu opens. Click an item → handler fires + menu
 * closes. Click anywhere else → menu closes. Escape closes too. The
 * outside-click / escape handlers are window-level and self-cleanup via
 * `onCleanup`, so the menu instance doesn't leak listeners on unmount.
 *
 * Items are described as plain data so the App can keep all the
 * action handlers in one place; the component is a render-only shell.
 */
export const FileMenu: Component<FileMenuProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const close = () => setOpen(false);

  // Outside-click / Escape close. Listeners live as long as the menu is
  // open; opening sets them up, closing tears them down (createEffect on
  // `open()` re-installs as the user toggles).
  const onWindowDown = (e: MouseEvent) => {
    if (!containerRef) return;
    if (e.target instanceof Node && containerRef.contains(e.target)) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const subscribe = () => {
    window.addEventListener('mousedown', onWindowDown);
    window.addEventListener('keydown', onKey);
  };
  const unsubscribe = () => {
    window.removeEventListener('mousedown', onWindowDown);
    window.removeEventListener('keydown', onKey);
  };
  onCleanup(unsubscribe);

  const items = (): FileMenuItem[] => [
    { label: 'New', onClick: props.onNew },
    { label: 'Open…', hint: '⌘O', onClick: props.onOpen },
    { separator: true, label: '' },
    { label: 'Save…',        hint: '⌘S', disabled: !props.hasSong, onClick: props.onSave },
    { label: 'Export .mod…',             disabled: !props.hasSong, onClick: props.onExportMod },
  ];

  const onItemClick = (item: FileMenuItem) => {
    if (item.separator || item.disabled) return;
    item.onClick?.();
    close();
  };

  return (
    <div class="filemenu" ref={(el) => (containerRef = el)}>
      <button
        type="button"
        class="filemenu__button"
        aria-haspopup="menu"
        aria-expanded={open()}
        title="File menu"
        onClick={() => {
          const next = !open();
          setOpen(next);
          if (next) subscribe(); else unsubscribe();
        }}
      >
        File ▾
      </button>
      <Show when={open()}>
        <ul class="filemenu__menu" role="menu">
          <For each={items()}>
            {(item) => (
              <Show
                when={!item.separator}
                fallback={<li class="filemenu__separator" role="separator" />}
              >
                <li
                  class="filemenu__item"
                  classList={{ 'filemenu__item--disabled': !!item.disabled }}
                  role="menuitem"
                  aria-disabled={!!item.disabled}
                  onClick={() => onItemClick(item)}
                >
                  <span class="filemenu__label">{item.label}</span>
                  <Show when={item.hint}>
                    <span class="filemenu__hint">{item.hint}</span>
                  </Show>
                </li>
              </Show>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
};
