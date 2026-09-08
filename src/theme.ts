import { Colors, TextColors, type Color } from './colors.js';

export type ThemeColorId = 'green' | 'cyan' | 'gold' | 'violet' | 'rose';

export const THEME_COLOR_OPTIONS: ReadonlyArray<{ id: ThemeColorId; label: string; color: Color }> = [
  { id: 'green', label: 'Light Green', color: { r: 178, g: 255, b: 184, intensity: 1 } },
  { id: 'cyan', label: 'Light Cyan', color: { r: 150, g: 238, b: 255, intensity: 1 } },
  { id: 'gold', label: 'Light Gold', color: { r: 255, g: 232, b: 142, intensity: 1 } },
  { id: 'violet', label: 'Light Violet', color: { r: 218, g: 190, b: 255, intensity: 1 } },
  { id: 'rose', label: 'Light Rose', color: { r: 255, g: 180, b: 198, intensity: 1 } },
];

export interface ThemeSettings {
  playerColor: ThemeColorId;
  enemyColor: ThemeColorId;
}

export const themeSettings: ThemeSettings = {
  playerColor: 'green',
  enemyColor: 'rose',
};

function cloneColor(color: Color, intensity: number = color.intensity): Color {
  return { r: color.r, g: color.g, b: color.b, intensity };
}

export function themeColor(id: ThemeColorId): Color {
  return THEME_COLOR_OPTIONS.find((item) => item.id === id)?.color ?? THEME_COLOR_OPTIONS[0].color;
}

function assign(target: Color, source: Color): void {
  target.r = source.r;
  target.g = source.g;
  target.b = source.b;
  target.intensity = source.intensity;
}

export function applyThemeColors(): void {
  const player = themeColor(themeSettings.playerColor);
  const enemy = themeColor(themeSettings.enemyColor);
  const text = cloneColor(player, 0.9);
  const playerOutline = cloneColor(player, 1.12);
  const playerDimOutline = cloneColor(player, 0.72);
  const playerHealth = cloneColor(player, 1.18);

  assign(TextColors.normal, text);
  assign(TextColors.highlight, cloneColor(player, 1.05));
  assign(TextColors.title, cloneColor(player, 1.0));
  assign(TextColors.system, cloneColor(player, 1.05));
  assign(Colors.general_building, text);
  assign(Colors.advanced_building, playerDimOutline);
  assign(Colors.healthbar, playerHealth);
  assign(Colors.radar_gridlines, cloneColor(player, 0.58));
  assign(Colors.radar_friendly_status, playerOutline);
  assign(Colors.friendly_status, playerDimOutline);
  assign(Colors.friendlyfire, cloneColor(player, 0.95));
  assign(Colors.mainguy, cloneColor(player, 0.82));
  assign(Colors.particles_friendly_exhaust, cloneColor(player, 0.52));

  assign(TextColors.enemy, cloneColor(enemy, 0.95));
  assign(Colors.enemy_status, cloneColor(enemy, 0.78));
  assign(Colors.radar_enemy_status, cloneColor(enemy, 0.95));
  assign(Colors.enemyfire, cloneColor(enemy, 0.95));
  assign(Colors.particles_enemy_exhaust, cloneColor(enemy, 0.55));
}

export function cycleThemeColor(current: ThemeColorId, dir: number, excluded?: ThemeColorId): ThemeColorId {
  const index = THEME_COLOR_OPTIONS.findIndex((item) => item.id === current);
  const start = index >= 0 ? index : 0;
  const step = dir < 0 ? -1 : 1;
  for (let offset = 1; offset <= THEME_COLOR_OPTIONS.length; offset++) {
    const candidate = THEME_COLOR_OPTIONS[
      (start + step * offset + THEME_COLOR_OPTIONS.length * offset) % THEME_COLOR_OPTIONS.length
    ].id;
    if (candidate !== excluded) return candidate;
  }
  return current;
}

export function themeColorLabel(id: ThemeColorId): string {
  return THEME_COLOR_OPTIONS.find((item) => item.id === id)?.label ?? id;
}

