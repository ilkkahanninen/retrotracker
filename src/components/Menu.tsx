import {
  Index,
  Show,
  createEffect,
  createSignal,
  type Component,
  type JSX,
} from "solid-js";
import { useWindowListener } from "./hooks";

export interface MenuItem {
  /** Visible label. Ignored when `separator: true`. */
  label: string;
  /** Right-aligned shortcut hint (purely cosmetic). */
  hint?: string;
  /** When true, renders as a divider line; `label` / `onClick` are ignored. */
  separator?: boolean;
  /** Click handler. Item is treated as disabled when omitted (with no
   *  visual greyed-out state — the parent normally signals that via
   *  `disabled` instead). */
  onClick?: () => void;
  /** Greyed-out + non-clickable. */
  disabled?: boolean;
}

interface MenuProps {
  /** Trigger button label (a `▾` arrow is appended automatically). */
  label: string;
  /** Items to render. Solid re-evaluates this prop on access, so the parent
   *  can return a fresh array each render and the disabled / label fields
   *  stay reactive — Index keys by position so only changed slots re-render. */
  items: MenuItem[];
  /** Optional className appended to the wrapper, e.g. `menu--right` if a
   *  parent layout wants the dropdown anchored to a different edge. */
  classExtra?: string;
}

/**
 * Lightweight dropdown menu used by the app header (File, Edit). Click the
 * button → menu opens; click an item, click outside, or press Escape →
 * menu closes. Outside-click / Escape listeners are window-level and only
 * installed while the menu is open — closing tears them down so several
 * Menus on screen don't all listen to every event.
 *
 * Items are described as plain data (label / hint / separator / onClick /
 * disabled). The component is render-only — every action lives in the
 * parent's onClick callbacks.
 */
export const Menu: Component<MenuProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const close = () => setOpen(false);

  const onWindowDown = (e: MouseEvent) => {
    if (!containerRef) return;
    if (e.target instanceof Node && containerRef.contains(e.target)) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  createEffect(() => {
    if (!open()) return;
    useWindowListener("mousedown", onWindowDown);
    useWindowListener("keydown", onKey);
  });

  const onItemClick = (item: MenuItem) => {
    if (item.separator || item.disabled) return;
    item.onClick?.();
    close();
  };

  const wrapperClass = (): string =>
    "menu" + (props.classExtra ? " " + props.classExtra : "");

  // Pulled into a small helper so the inline JSX inside the Index callback
  // stays readable — Index keys by position, so the per-slot reactive
  // expressions inside the returned <li> see fresh `item()` values when
  // the parent's items array changes (e.g. `disabled` flipping).
  const renderItem = (item: MenuItem): JSX.Element => (
    <Show
      when={!item.separator}
      fallback={<li class="menu__separator" role="separator" />}
    >
      <li
        class="menu__item"
        classList={{ "menu__item--disabled": !!item.disabled }}
        role="menuitem"
        aria-disabled={!!item.disabled}
        onClick={() => onItemClick(item)}
      >
        <span class="menu__label">{item.label}</span>
        <Show when={item.hint}>
          <span class="menu__hint">{item.hint}</span>
        </Show>
      </li>
    </Show>
  );

  return (
    <div class={wrapperClass()} ref={(el) => (containerRef = el)}>
      <button
        type="button"
        class="menu__button"
        aria-haspopup="menu"
        aria-expanded={open()}
        title={`${props.label} menu`}
        onClick={() => {
          setOpen(!open());
        }}
      >
        {props.label} ▾
      </button>
      <Show when={open()}>
        <ul class="menu__list" role="menu">
          <Index each={props.items}>{(item) => renderItem(item())}</Index>
        </ul>
      </Show>
    </div>
  );
};
