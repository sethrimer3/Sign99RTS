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

export type SpaceColorId =
  | 'menuBlue'
  | 'ingameGradient'
  | 'black'
  | 'emberFall'
  | 'auroraDream'
  | 'violetHaze'
  | 'roseGold';

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
   * Whether the faction-coloured nebula wisp layer is drawn in-game. Set false
   * for colours that want a pure-black void behind the scene.
   */
  readonly nebula: boolean;
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
    gameFill: '#041426',
    gameGradient: [
      [0.0, 'rgba(14, 52, 92, 0.30)'],
      [0.45, 'rgba(7, 30, 62, 0.64)'],
      [1.0, 'rgba(2, 12, 30, 0.88)'],
    ],
    nebula: true,
    // Deep blue → azure → sky → white: stays on-theme but the bright tip pops
    // hard against the dark blue ground.
    trianglePalette: [
      [10, 40, 95],
      [35, 92, 178],
      [92, 182, 240],
      [212, 245, 255],
    ],
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
    nebula: true,
    // Teal → cyan → aqua → near-white against the indigo ground.
    trianglePalette: [
      [8, 50, 72],
      [22, 112, 142],
      [96, 205, 214],
      [224, 255, 248],
    ],
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
    nebula: false,
    gameGradient: null,
    // Neon on pure black — slate → violet → magenta → electric cyan.
    trianglePalette: [
      [28, 28, 44],
      [92, 40, 144],
      [214, 62, 182],
      [120, 240, 255],
    ],
  },
  {
    id: 'emberFall',
    label: 'Ember Fall',
    swatch: '#a83a12',
    menuGradient: [
      [0.0, '#6b2c0a'],
      [0.5, '#3a1006'],
      [1.0, '#160305'],
    ],
    gameFill: '#1a0705',
    gameGradient: [
      [0.0, 'rgba(150, 64, 22, 0.30)'],
      [0.45, 'rgba(92, 28, 14, 0.64)'],
      [1.0, 'rgba(30, 6, 8, 0.9)'],
    ],
    nebula: false,
    // Glowing coals: deep red → burnt orange → amber → pale gold.
    trianglePalette: [
      [58, 18, 10],
      [156, 52, 16],
      [238, 138, 32],
      [255, 240, 172],
    ],
  },
  {
    id: 'auroraDream',
    label: 'Aurora Dream',
    swatch: '#0f7a6a',
    menuGradient: [
      [0.0, '#0a3f3a'],
      [0.5, '#06281f'],
      [1.0, '#050f1c'],
    ],
    gameFill: '#03121a',
    gameGradient: [
      [0.0, 'rgba(20, 92, 90, 0.28)'],
      [0.45, 'rgba(14, 60, 50, 0.6)'],
      [1.0, 'rgba(4, 16, 32, 0.88)'],
    ],
    nebula: false,
    // Complementary pink curtains over the teal-green ground.
    trianglePalette: [
      [18, 40, 58],
      [82, 42, 122],
      [206, 66, 162],
      [255, 186, 224],
    ],
  },
  {
    id: 'violetHaze',
    label: 'Violet Haze',
    swatch: '#7a3ab0',
    menuGradient: [
      [0.0, '#3d1454'],
      [0.5, '#231038'],
      [1.0, '#0d0a24'],
    ],
    gameFill: '#120b22',
    gameGradient: [
      [0.0, 'rgba(110, 42, 142, 0.28)'],
      [0.45, 'rgba(64, 28, 96, 0.6)'],
      [1.0, 'rgba(16, 10, 34, 0.88)'],
    ],
    nebula: false,
    // Amber-gold heat against the violet ground.
    trianglePalette: [
      [34, 16, 54],
      [96, 42, 116],
      [224, 124, 62],
      [255, 226, 146],
    ],
  },
  {
    id: 'roseGold',
    label: 'Rose Gold',
    swatch: '#b05070',
    menuGradient: [
      [0.0, '#4a1832'],
      [0.5, '#3a1424'],
      [1.0, '#1a0a16'],
    ],
    gameFill: '#1a0a14',
    gameGradient: [
      [0.0, 'rgba(150, 62, 92, 0.28)'],
      [0.45, 'rgba(96, 40, 60, 0.6)'],
      [1.0, 'rgba(24, 10, 22, 0.88)'],
    ],
    nebula: false,
    // Plum → mauve → gold → pale gold.
    trianglePalette: [
      [40, 18, 30],
      [112, 50, 62],
      [222, 152, 92],
      [255, 236, 184],
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
