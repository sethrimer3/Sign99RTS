/** Entry point for Sign99 */

import { Game } from './game.js';
import { loadGameFonts, loadFontSettings } from './fonts.js';
import { applyThemeColors, loadThemeSettings } from './theme.js';
import { loadSpaceThemeSettings } from './spaceTheme.js';
import { installTextOutline } from './textoutline.js';

document.addEventListener('DOMContentLoaded', async () => {
  loadFontSettings();
  loadThemeSettings();
  applyThemeColors();
  loadSpaceThemeSettings();
  await loadGameFonts();
  installTextOutline();
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  if (!canvas) {
    throw new Error('Canvas element #game not found');
  }
  const game = new Game(canvas);
  game.start();
});

