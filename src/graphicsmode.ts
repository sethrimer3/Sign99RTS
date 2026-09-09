/**
 * Global "Legacy Graphics" toggle.
 *
 * When enabled, newer visual systems fall back to their original ("legacy")
 * rendering path.  Any time a visual system is upgraded from now on, gate the
 * new look behind `!isLegacyGraphics()` and keep the previous implementation
 * reachable when this flag is on, so players can always switch back via the
 * "Legacy Graphics" checkbox in Settings → Graphics.
 *
 * Mirrors the load/save/global-accessor pattern used by cinematic.ts and
 * visualquality.ts.
 */

const LEGACY_GRAPHICS_STORAGE_KEY = 'sign99_legacy_graphics';

let legacyGraphics = false;

/** True when the player has opted into the original/legacy visual systems. */
export function isLegacyGraphics(): boolean {
  return legacyGraphics;
}

export function setLegacyGraphics(value: boolean): boolean {
  legacyGraphics = !!value;
  return legacyGraphics;
}

/** Load the persisted preference from localStorage (defaults to off). */
export function loadLegacyGraphics(): boolean {
  try {
    legacyGraphics = window.localStorage?.getItem(LEGACY_GRAPHICS_STORAGE_KEY) === '1';
  } catch {
    // localStorage unavailable; keep the default.
  }
  return legacyGraphics;
}

export function saveLegacyGraphics(value: boolean): void {
  legacyGraphics = !!value;
  try {
    window.localStorage?.setItem(LEGACY_GRAPHICS_STORAGE_KEY, value ? '1' : '0');
  } catch {
    // Ignore write failures.
  }
}
