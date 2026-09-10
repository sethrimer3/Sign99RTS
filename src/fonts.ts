export type GameFontId =
  | 'poiretOne'
  | 'aldrich'
  | 'chakraPetch'
  | 'notoSansSundanese'
  | 'orbitron'
  | 'oxanium';

export interface GameFontOption {
  readonly id: GameFontId;
  readonly label: string;
  readonly family: string;
}

export const GAME_FONT_OPTIONS: readonly GameFontOption[] = [
  { id: 'poiretOne', label: 'Poiret One', family: 'Poiret One' },
  { id: 'aldrich', label: 'Aldrich', family: 'Aldrich' },
  { id: 'chakraPetch', label: 'Chakra Petch', family: 'Chakra Petch' },
  { id: 'notoSansSundanese', label: 'Noto Sans Sundanese', family: 'Noto Sans Sundanese' },
  { id: 'orbitron', label: 'Orbitron', family: 'Orbitron' },
  { id: 'oxanium', label: 'Oxanium', family: 'Oxanium' },
];

export const DEFAULT_FONT_ID: GameFontId = 'poiretOne';
export const MENU_DECODE_FONT = 'BJ Cree';

/**
 * Non-Latin fallback faces. The bundled fonts only carry Latin/specialized
 * glyphs, so localized text (Cyrillic, Japanese, Simplified Chinese) is
 * rendered by whichever of these the player's OS provides.
 */
export const I18N_FALLBACK_FONTS =
  '"Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';

const FONT_STORAGE_KEY = 'sign99:font-choice';

let activeFontId: GameFontId = DEFAULT_FONT_ID;

export function getActiveFont(): GameFontId {
  return activeFontId;
}

export function setActiveFont(id: GameFontId): void {
  if (GAME_FONT_OPTIONS.some((opt) => opt.id === id)) {
    activeFontId = id;
    saveFontSettings();
  }
}

export function activeFontOption(): GameFontOption {
  return GAME_FONT_OPTIONS.find((opt) => opt.id === activeFontId) ?? GAME_FONT_OPTIONS[0];
}

export function fontLabel(id: GameFontId): string {
  return GAME_FONT_OPTIONS.find((opt) => opt.id === id)?.label ?? id;
}

export function loadFontSettings(): void {
  try {
    const saved = window.localStorage?.getItem(FONT_STORAGE_KEY);
    if (saved && GAME_FONT_OPTIONS.some((opt) => opt.id === saved)) {
      activeFontId = saved as GameFontId;
    }
  } catch {
    // Keep default
  }
}

export function saveFontSettings(): void {
  try {
    window.localStorage?.setItem(FONT_STORAGE_KEY, activeFontId);
  } catch {
    // Optional
  }
}

// URLs for font assets
const POIRET_ONE_URL = new URL('../ASSETS/fonts/Poiret_One/PoiretOne-Regular.ttf', import.meta.url).href;
const BJ_CREE_URL = new URL('../ASSETS/fonts/BJ_Cree/BJCree-Bold.ttf', import.meta.url).href;

const ALDRICH_URL = new URL('../ASSETS/fonts/Aldrich/Aldrich-Regular.ttf', import.meta.url).href;

const CHAKRA_PETCH_REGULAR_URL = new URL('../ASSETS/fonts/Chakra_Petch/ChakraPetch-Regular.ttf', import.meta.url).href;
const CHAKRA_PETCH_BOLD_URL = new URL('../ASSETS/fonts/Chakra_Petch/ChakraPetch-Bold.ttf', import.meta.url).href;

const NOTO_SUNDANESE_REGULAR_URL = new URL('../ASSETS/fonts/Noto_Sans_Sundanese/static/NotoSansSundanese-Regular.ttf', import.meta.url).href;
const NOTO_SUNDANESE_BOLD_URL = new URL('../ASSETS/fonts/Noto_Sans_Sundanese/static/NotoSansSundanese-Bold.ttf', import.meta.url).href;

const ORBITRON_REGULAR_URL = new URL('../ASSETS/fonts/Orbitron/static/Orbitron-Regular.ttf', import.meta.url).href;
const ORBITRON_BOLD_URL = new URL('../ASSETS/fonts/Orbitron/static/Orbitron-Bold.ttf', import.meta.url).href;

const OXANIUM_REGULAR_URL = new URL('../ASSETS/fonts/Oxanium/static/Oxanium-Regular.ttf', import.meta.url).href;
const OXANIUM_BOLD_URL = new URL('../ASSETS/fonts/Oxanium/static/Oxanium-Bold.ttf', import.meta.url).href;

export async function loadGameFonts(): Promise<void> {
  if (!('fonts' in document)) return;

  const faces = [
    new FontFace('Poiret One', `url("${POIRET_ONE_URL}")`),
    new FontFace('Aldrich', `url("${ALDRICH_URL}")`),
    new FontFace('Chakra Petch', `url("${CHAKRA_PETCH_REGULAR_URL}")`, { weight: 'normal' }),
    new FontFace('Chakra Petch', `url("${CHAKRA_PETCH_BOLD_URL}")`, { weight: 'bold' }),
    new FontFace('Noto Sans Sundanese', `url("${NOTO_SUNDANESE_REGULAR_URL}")`, { weight: 'normal' }),
    new FontFace('Noto Sans Sundanese', `url("${NOTO_SUNDANESE_BOLD_URL}")`, { weight: 'bold' }),
    new FontFace('Orbitron', `url("${ORBITRON_REGULAR_URL}")`, { weight: 'normal' }),
    new FontFace('Orbitron', `url("${ORBITRON_BOLD_URL}")`, { weight: 'bold' }),
    new FontFace('Oxanium', `url("${OXANIUM_REGULAR_URL}")`, { weight: 'normal' }),
    new FontFace('Oxanium', `url("${OXANIUM_BOLD_URL}")`, { weight: 'bold' }),
    new FontFace(MENU_DECODE_FONT, `url("${BJ_CREE_URL}")`),
  ];

  for (const face of faces) {
    document.fonts.add(face);
    try {
      await face.load();
    } catch (err) {
      console.warn('Failed to load font face', face.family, err);
    }
  }
}

export function getMainFontFamily(): string {
  return activeFontOption().family;
}

export function getMainCanvasFont(): string {
  return `"${getMainFontFamily()}", ${I18N_FALLBACK_FONTS}`;
}

export function getMenuCanvasFont(): string {
  return `"${MENU_DECODE_FONT}", "${getMainFontFamily()}", ${I18N_FALLBACK_FONTS}`;
}

// Backwards-compatible constants for legacy imports
export const MAIN_FONT = 'Poiret One';
export const MAIN_CANVAS_FONT = `"${MAIN_FONT}", ${I18N_FALLBACK_FONTS}`;
export const MENU_CANVAS_FONT = `"${MENU_DECODE_FONT}", "${MAIN_FONT}", ${I18N_FALLBACK_FONTS}`;

export function gameFont(sizePx: number, bold: boolean = true): string {
  return `${bold ? 'bold ' : ''}${sizePx}px ${getMainCanvasFont()}`;
}

export function menuFont(sizePx: number, bold: boolean = true): string {
  return `${bold ? 'bold ' : ''}${sizePx}px ${getMenuCanvasFont()}`;
}

