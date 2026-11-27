import type { Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { LucideIcon } from "lucide-solid";

export type IconType = LucideIcon;

interface IconProps {
  /** The Lucide icon component to render — import it from `./icons`. */
  of: IconType;
  /** Edge length in CSS px. 14 sits well next to the 11px UI font. */
  size?: number;
}

/**
 * Decorative icon. Always `aria-hidden` and text-free, so the control it
 * sits in must carry its own name: visible text next to the icon, or an
 * `aria-label` on icon-only buttons.
 */
export const Icon: Component<IconProps> = (props) => (
  <Dynamic
    component={props.of}
    class="icon"
    size={props.size ?? 14}
    strokeWidth={2}
    aria-hidden="true"
  />
);
