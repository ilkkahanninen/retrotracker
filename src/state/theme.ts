import type { ColorSchemeId } from './settings';

/**
 * Theme application — translates the typed `Settings` into CSS custom
 * properties on `document.documentElement`.
 *
 * Colour schemes are flat var maps; switching schemes overwrites every
 * entry on the root, so a user can flip back to 'default' without the
 * previous scheme's leftovers shading through. Users wanting boosted
 * legibility pick the 'high-contrast' scheme rather than a separate
 * contrast slider.
 */

interface ColorScheme {
  readonly id: ColorSchemeId;
  readonly label: string;
  /** Each scheme must override every key in `THEME_VAR_KEYS`. */
  readonly vars: Readonly<Record<string, string>>;
}

export const COLOR_SCHEMES: readonly ColorScheme[] = [
  {
    id: 'default',
    label: 'Default Dark',
    vars: {
      '--bg':              '#14151a',
      '--panel':           '#1c1e26',
      '--panel-2':         '#232631',
      '--fg':              '#d8dae5',
      '--muted':           '#8a8f9c',
      '--accent':          '#5ec8ff',
      '--accent-dim':      '#2a4f66',
      '--grid-line':       '#2a2d38',
      '--error':           '#ff6b6b',
      '--warn':            '#e6b800',
      '--text-on-accent':  '#0a1118',
    },
  },
  {
    id: 'light',
    label: 'Light',
    vars: {
      '--bg':              '#f5f5f7',
      '--panel':           '#ffffff',
      '--panel-2':         '#eceff3',
      '--fg':              '#1a1a1f',
      '--muted':           '#6b7280',
      '--accent':          '#2563eb',
      '--accent-dim':      '#bfd4ff',
      '--grid-line':       '#d1d5db',
      '--error':           '#dc2626',
      '--warn':            '#b45309',
      '--text-on-accent':  '#ffffff',
    },
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    vars: {
      '--bg':              '#000000',
      '--panel':           '#000000',
      '--panel-2':         '#0a0a0a',
      '--fg':              '#ffffff',
      '--muted':           '#cfcfcf',
      '--accent':          '#00e0ff',
      '--accent-dim':      '#00557a',
      '--grid-line':       '#555555',
      '--error':           '#ff5555',
      '--warn':            '#ffd700',
      '--text-on-accent':  '#000000',
    },
  },
  {
    id: 'amber',
    label: 'Amber Retro',
    vars: {
      '--bg':              '#1a0d00',
      '--panel':           '#251400',
      '--panel-2':         '#3a2100',
      '--fg':              '#ffb000',
      '--muted':           '#a06800',
      '--accent':          '#ffd060',
      '--accent-dim':      '#553300',
      '--grid-line':       '#3a2100',
      '--error':           '#ff5050',
      '--warn':            '#ffe066',
      '--text-on-accent':  '#1a0d00',
    },
  },
];

const FALLBACK_SCHEME = COLOR_SCHEMES[0]!;
const THEME_VAR_KEYS = Object.keys(FALLBACK_SCHEME.vars);

export function applyColorScheme(id: ColorSchemeId): void {
  if (typeof document === 'undefined') return;
  const scheme = COLOR_SCHEMES.find((s) => s.id === id) ?? FALLBACK_SCHEME;
  const style = document.documentElement.style;
  for (const k of THEME_VAR_KEYS) {
    style.setProperty(k, scheme.vars[k]!);
  }
}
