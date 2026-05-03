/**
 * Platform-specific labels for the keyboard modifiers shown in help and
 * tooltips. The shortcut dispatcher's `mod: true` flag already routes
 * Ctrl/Cmd to the same handler regardless of OS — this module only
 * decides which label the *user* sees in cheat-sheet UI.
 *
 * Detection prefers the modern `userAgentData.platform` (Chromium 90+),
 * falls back to `navigator.platform` (deprecated but universal), and
 * finally to a userAgent substring match. Resolved once on module load —
 * the OS doesn't change mid-session.
 */

interface UserAgentData { platform?: string }

function detectIsMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: UserAgentData };
  // Chromium ships userAgentData.platform as the canonical, non-deprecated
  // source. Returns "macOS" / "Windows" / "Linux" / "Android" / "iOS".
  const ua = nav.userAgentData?.platform;
  if (ua) return /mac/i.test(ua);
  // Older browsers / Safari / Firefox: navigator.platform is deprecated
  // but still works. Mac values include "MacIntel", "MacPPC", "iPhone".
  if (typeof nav.platform === 'string' && nav.platform) {
    return /mac|iphone|ipad/i.test(nav.platform);
  }
  // Final fallback: userAgent string sniffing.
  return /Mac|iPhone|iPad/i.test(nav.userAgent ?? '');
}

export const IS_MAC = detectIsMac();

/** "Cmd" on macOS, "Ctrl" elsewhere — for the modifier the dispatcher
 *  matches when a shortcut declares `mod: true`. */
export const MOD_LABEL = IS_MAC ? 'Cmd' : 'Ctrl';

/** "Option" on macOS, "Alt" elsewhere — for `alt: true` shortcuts. */
export const ALT_LABEL = IS_MAC ? 'Option' : 'Alt';
