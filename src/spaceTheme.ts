/**
 * Space theme — user-selectable colour for the deep-space background shared by
 * the main menu and the in-game view.
 *
 * A single choice drives three things:
 *  - the main-menu radial background gradient,
 *  - the in-game background fill + radial depth gradient,
 *  - (optionally) the main-menu triangle palette.
 *
 * Persisted to localStorage and loaded once at start-up from main.ts, mirroring
 * the pattern used by theme.ts for player/enemy colours.
 */

export type SpaceColorId = 'menuBlue' | 'ingameGradient' | 'black';

/** A radial-gradient stop: [offset 0..1, CSS colour]. */
export type GradientStop = [number, string];

export interface SpaceColorOption {
  readonly id: SpaceColorId;
  readonly label: string;
  /** Swatch colour shown next to the label in the settings dropdown. */
  readonly swatch: string;
  /** Main-menu background radial gradient (centre → edge). */
  readonly menuGradient: readonly GradientStop[];
  /** Solid fill drawn first behind the in-game view. */
  readonly gameFill: string;
  /** In-game radial depth gradient painted over the fill, or null for none. */
  readonly gameGradient: readonly GradientStop[] | null;
  /**
   * Replacement palette for the main-menu triangles (4 RGB triplets, blended
   * across the tile "heat" range), or null to keep the default palette.
   */
  readonly trianglePalette: readonly (readonly [number, number, number])[] | null;
}

export const SPACE_COLOR_OPTIONS: readonly SpaceColorOption[] = [
  {
    id: 'menuBlue',
    label: 'Menu Blue',
    swatch: '#0c3a66',
    menuGradient: [
      [0.0, '#082746'],
      [0.42, '#06142d'],
      [1.0, '#13051f'],
    ],
    gameFill: '#04101f',
    gameGradient: [
      [0.0, 'rgba(8, 39, 70, 0.30)'],
      [0.42, 'rgba(6, 20, 45, 0.62)'],
      [1.0, 'rgba(19, 5, 31, 0.86)'],
    ],
    trianglePalette: null,
  },
  {
    id: 'ingameGradient',
    label: 'Nebula Gradient',
    swatch: '#3a1a65',
    menuGradient: [
      [0.0, '#0a1430'],
      [0.5, '#0c0a24'],
      [1.0, '#0a0416'],
    ],
    gameFill: 'rgb(0, 1, 3)',
    gameGradient: [
      [0.0, 'rgba(0, 1, 4, 0.24)'],
      [0.35, 'rgba(1, 1, 8, 0.66)'],
      [0.68, 'rgba(3, 1, 10, 0.78)'],
      [1.0, 'rgba(1, 0, 5, 0.88)'],
    ],
    trianglePalette: null,
  },
  {
    id: 'black',
    label: 'Deep Black',
    swatch: '#050505',
    menuGradient: [
      [0.0, '#050506'],
      [0.5, '#020203'],
      [1.0, '#000000'],
    ],
    gameFill: '#000000',
    gameGradient: null,
    trianglePalette: [
      [20, 22, 30],
      [40, 44, 58],
      [90, 96, 120],
      [180, 190, 210],
    ],
  },
];

export const DEFAULT_SPACE_COLOR: SpaceColorId = 'menuBlue';

export interface SpaceThemeSettings {
  spaceColor: SpaceColorId;
}

export const spaceThemeSettings: SpaceThemeSettings = {
  spaceColor: DEFAULT_SPACE_COLOR,
};

const STORAGE_KEY = 'sign99:space-color';

function isSpaceColorId(value: unknown): value is SpaceColorId {
  return SPACE_COLOR_OPTIONS.some((option) => option.id === value);
}

export function loadSpaceThemeSettings(): void {
  try {
    const saved = JSON.parse(window.localStorage?.getItem(STORAGE_KEY) ?? '{}') as Partial<SpaceThemeSettings>;
    if (isSpaceColorId(saved.spaceColor)) spaceThemeSettings.spaceColor = saved.spaceColor;
  } catch { /* keep default */ }
}

export function saveSpaceThemeSettings(): void {
  try { window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(spaceThemeSettings)); } catch { /* optional */ }
}

export function spaceColorOption(id: SpaceColorId = spaceThemeSettings.spaceColor): SpaceColorOption {
  return SPACE_COLOR_OPTIONS.find((option) => option.id === id) ?? SPACE_COLOR_OPTIONS[0];
}

export function spaceColorLabel(id: SpaceColorId): string {
  return spaceColorOption(id).label;
}

/** Currently-selected option — convenience for render code. */
export function activeSpaceColor(): SpaceColorOption {
  return spaceColorOption(spaceThemeSettings.spaceColor);
}
