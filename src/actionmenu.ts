/**
 * Phase-2 hold-to-open radial menus for Sign99.
 *
 * Three menus, each opened by holding a key:
 *   Z -> Ship       (ship stats, upgrades, and weapon selection)
 *   X → Research    (all non-researched items from RESEARCH_COST table)
 *
 * Each menu draws a radial of items centred on the player's screen position.
 * The item closest in angle to the mouse cursor is highlighted.
 * LMB confirms, releasing the hold key closes, RMB goes back one level or closes.
 */

import { Vec2 } from './math.js';
import { Camera } from './camera.js';
import { Colors, colorToCSS } from './colors.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { GameState } from './gamestate.js';
import { ShipGroup, TacticalOrder, Team } from './entities.js';
import { RESEARCH_COST, CONDUIT_COST, ACTIVE_RESEARCH_ITEMS, COMMANDPOST_BUILD_RADIUS, POWERGENERATOR_COVERAGE_RADIUS } from './constants.js';
import { SHIP_WEAPON_OPTIONS, type ShipWeaponId, SHIP_HP_MAX_LEVEL, SHIP_SPEED_ENERGY_MAX_LEVEL, SHIP_SHIELD_MAX_LEVEL } from './ship.js';
import { worldToCell, cellKey, cellCenter, footprintCenter, footprintOrigin, GRID_CELL_SIZE } from './grid.js';
import { defsByTier, BuildDef, getBuildDef } from './builddefs.js';
import { drawDecodedText } from './decodeText.js';
import { isConfluenceFaction, isSynonymousFaction, CONFLUENCE_PLACEMENT_DISTANCE, CONFLUENCE_PLACEMENT_TOLERANCE, CONFLUENCE_BASE_RADIUS } from './confluence.js';
import { MENU_CANVAS_FONT } from './fonts.js';
import { SYNONYMOUS_BUILD_COST, SYNONYMOUS_CURRENCY_SYMBOL } from './synonymous.js';

/** Radius (px) from the menu centre at which items are placed. */
const ITEM_RADIUS = 110;

/** Radius (px) of each item circle. */
const ITEM_CIRCLE_R = 40;
const UI_CYAN = 'rgba(118,242,255,';
const UI_GOLD = 'rgba(255,218,116,';
const UI_PANEL_DARK = 'rgba(2,10,22,';

// ---------------------------------------------------------------------------
// Description tooltip box
// ---------------------------------------------------------------------------

const DESC_BOX_W = 220;
const DESC_BOX_GAP = 10;
const DESC_BOX_PAD_X = 10;
const DESC_BOX_PAD_Y = 8;
const DESC_BOX_LINE_H = 16;
const DESC_BOX_FONT = '13px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';

/**
 * Short descriptions shown in the tooltip box for each research item.
 * Building-unlock research items fall back to the BuildDef description.
 */
const RESEARCH_DESCRIPTIONS: Record<string, string> = {
  shipHp1:              'Increases max HP by 25% (of base). Level 1 of 4.',
  shipHp2:              'Increases max HP by 25% (of base). Level 2 of 4.',
  shipHp3:              'Increases max HP by 25% (of base). Level 3 of 4.',
  shipHp4:              'Increases max HP by 25% (of base). Level 4 of 4 — maximum, +100% total.',
  shipSpeedEnergy1:     'Boosts speed, energy regen, and fire rate by 25% (of base). Level 1 of 4.',
  shipSpeedEnergy2:     'Boosts speed, energy regen, and fire rate by 25% (of base). Level 2 of 4.',
  shipSpeedEnergy3:     'Boosts speed, energy regen, and fire rate by 25% (of base). Level 3 of 4.',
  shipSpeedEnergy4:     'Boosts speed, energy regen, and fire rate by 25% (of base). Level 4 of 4 — maximum, +100% total.',
  shipShield1:          'Unlocks a rechargeable shield equal to 25% of max HP. Regenerates 5s after taking no damage. Level 1 of 2.',
  shipShield2:          'Increases shield capacity to 50% of max HP. Level 2 of 2 — maximum.',
  shipDash:             'Shift tap burns 25% energy to dash forward with a bright trail.',
  synonymousPierce:     'Harmonic tunneling lets shots phase through multiple targets.',
  synonymousSpeed:      'Enhances drone cohesion and overall movement speed.',
  synonymousFireSpeed1: 'Speeds up pulse fire rate. Level 1 of 4.',
  synonymousFireSpeed2: 'Speeds up pulse fire rate. Level 2 of 4.',
  synonymousFireSpeed3: 'Speeds up pulse fire rate. Level 3 of 4.',
  synonymousFireSpeed4: 'Speeds up pulse fire rate. Level 4 of 4 — maximum.',
  synonymousVitality:   'Distributes total health evenly across all active drones.',
  weaponGatling:        'Unlocks the Gatling Cannon: rapid fire at close range.',
  weaponLaser:          'Unlocks the Laser: slow-firing beam that pierces all targets.',
  weaponGuidedMissile:  'Unlocks the Guided Missile: steerable heavy explosive.',
  weaponCannon:         'Unlocks Cannon V.2 with improved homing shells.',
  missileturret:        'Unlocks construction of Missile turrets. Guided-missile defense.',
  synonymousminelayer:  'Unlocks construction of Mine Layer turrets.',
  exciterturret:        'Unlocks construction of Prism turrets. Sustained-beam defense.',
  massdriverturret:     'Unlocks construction of Singularity turrets. First blast drags in nearby ships.',
  regenturret:          'Unlocks construction of Repair turrets. Heals nearby structures.',
  advancedRegenTurrets: 'Repair turrets rebuild destroyed conduits for free.',
  bomberyard:           'Unlocks construction of Bomber Yards for nova bombers.',
  advancedFighters:     'Improves fighter ships with enhanced stats and combat AI.',
};

function wrapDescriptionText(ctx: CanvasRenderingContext2D, text: string): string[] {
  const maxW = DESC_BOX_W - DESC_BOX_PAD_X * 2;
  ctx.save();
  ctx.font = DESC_BOX_FONT;
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  ctx.restore();
  return lines;
}

/**
 * Draw a description tooltip box to the right of a menu panel.
 * @param panelRightX - the right edge of the menu panel (pixels)
 * @param itemCenterY - vertical centre of the highlighted item (pixels)
 */
function drawDescriptionBox(
  ctx: CanvasRenderingContext2D,
  description: string,
  panelRightX: number,
  itemCenterY: number,
  screenW: number,
  screenH: number,
): void {
  const x = panelRightX + DESC_BOX_GAP;
  if (x + DESC_BOX_W > screenW - 8) return;
  const lines = wrapDescriptionText(ctx, description);
  if (lines.length === 0) return;
  const boxH = lines.length * DESC_BOX_LINE_H + DESC_BOX_PAD_Y * 2;
  const y = Math.max(8, Math.min(screenH - boxH - 8, itemCenterY - boxH / 2));
  ctx.save();
  fillMenuPanel(ctx, x, y, DESC_BOX_W, boxH);
  ctx.font = DESC_BOX_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = colorToCSS(Colors.general_building, 0.85);
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x + DESC_BOX_PAD_X, y + DESC_BOX_PAD_Y + i * DESC_BOX_LINE_H);
  }
  ctx.restore();
}

function fillMenuPanel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const grad = ctx.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, 'rgba(4,18,31,0.86)');
  grad.addColorStop(0.55, 'rgba(8,34,48,0.78)');
  grad.addColorStop(1, 'rgba(2,8,18,0.92)');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = `${UI_CYAN}0.42)`;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.strokeStyle = `${UI_GOLD}0.24)`;
  ctx.beginPath();
  ctx.moveTo(x + 10, y + h - 0.5);
  ctx.lineTo(x + Math.min(w * 0.45, 118), y + h - 0.5);
  ctx.moveTo(x + w - Math.min(w * 0.34, 96), y + 0.5);
  ctx.lineTo(x + w - 10, y + 0.5);
  ctx.stroke();
}

function drawMenuBanner(
  ctx: CanvasRenderingContext2D,
  screenW: number,
  y: number,
  primary: string,
  secondary: string,
  openedAt: number,
): void {
  const w = Math.min(screenW - 32, 760);
  const x = screenW * 0.5 - w * 0.5;
  fillMenuPanel(ctx, x, y, w, 68);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '20px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
  ctx.fillStyle = colorToCSS(Colors.radar_friendly_status, 0.9);
  drawDecodedText(ctx, primary, screenW * 0.5, y + 7, 20, openedAt, 'center');
  ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
  ctx.fillStyle = colorToCSS(Colors.general_building, 0.68);
  drawDecodedText(ctx, secondary, screenW * 0.5, y + 34, 15, openedAt, 'center');
  ctx.restore();
}

function drawMenuRow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  active: boolean,
  disabled: boolean = false,
): void {
  const grad = ctx.createLinearGradient(x, y, x + w, y);
  if (disabled) {
    grad.addColorStop(0, `${UI_PANEL_DARK}0.42)`);
    grad.addColorStop(1, 'rgba(14,26,34,0.26)');
  } else if (active) {
    grad.addColorStop(0, `${UI_CYAN}0.26)`);
    grad.addColorStop(0.62, 'rgba(30,86,76,0.34)');
    grad.addColorStop(1, `${UI_GOLD}0.12)`);
  } else {
    grad.addColorStop(0, `${UI_PANEL_DARK}0.66)`);
    grad.addColorStop(1, 'rgba(8,32,44,0.54)');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = disabled
    ? colorToCSS(Colors.radar_gridlines, 0.20)
    : active
      ? `${UI_CYAN}0.82)`
      : colorToCSS(Colors.radar_gridlines, 0.36);
  ctx.lineWidth = active ? 1.5 : 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  if (active) {
    ctx.fillStyle = `${UI_GOLD}0.78)`;
    ctx.fillRect(x, y + 5, 2, h - 10);
  }
}

function drawMenuOrb(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  active: boolean,
  disabled: boolean,
): void {
  const grad = ctx.createRadialGradient(x - radius * 0.28, y - radius * 0.34, radius * 0.12, x, y, radius);
  if (disabled) {
    grad.addColorStop(0, colorToCSS(Colors.radar_gridlines, 0.18));
    grad.addColorStop(1, 'rgba(2,10,18,0.70)');
  } else if (active) {
    grad.addColorStop(0, 'rgba(255,255,240,0.50)');
    grad.addColorStop(0.38, `${UI_CYAN}0.36)`);
    grad.addColorStop(1, 'rgba(10,46,40,0.82)');
  } else {
    grad.addColorStop(0, 'rgba(154,240,255,0.16)');
    grad.addColorStop(1, 'rgba(4,18,31,0.76)');
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = disabled
    ? colorToCSS(Colors.radar_gridlines, 0.24)
    : active
      ? `${UI_CYAN}0.94)`
      : colorToCSS(Colors.radar_gridlines, 0.42);
  ctx.lineWidth = active ? 2 : 1;
  ctx.stroke();
}

/**
 * Minimum distance (px) from the menu centre before any item is considered
 * hovered. Prevents an accidental click when the cursor is right on the ship.
 */
const MIN_SELECT_DIST = 32;

// ---------------------------------------------------------------------------
// Public types (kept compatible with game.ts's handleActionResult)
// ---------------------------------------------------------------------------

export type MenuResult =
  | { action: 'none' }
  | { action: 'build'; buildingType: string; cell?: { cx: number; cy: number } }
  | { action: 'order'; group: ShipGroup | 'all'; order: string }
  | { action: 'research'; item: string }
  | { action: 'cancelResearch'; item: string; queueIndex: number };

// Re-export kept for convenience so callers don't need to know the origin
// of TacticalOrder; remove this if the dependency becomes confusing.
export { TacticalOrder };

// ---------------------------------------------------------------------------
// Radial item data
// ---------------------------------------------------------------------------

interface RadialItem {
  /** Display label; '\n' splits into multiple lines inside the circle. */
  label: string;
  /** Small secondary line (e.g. "$120"). */
  sublabel?: string;
  /** Grayed-out; click is ignored. */
  disabled?: boolean;
  /** Drill into sub-menu on confirm. */
  children?: RadialItem[];
  /** Leaf: place a building of this type. */
  buildingType?: string;
  /** Leaf: issue a tactical order to this group. */
  orderGroup?: ShipGroup | 'all';
  tacticalOrder?: TacticalOrder;
  /** Leaf: start researching this item. */
  researchItem?: string;
  /** Informational disabled entry that never emits a menu result. */
  infoOnly?: boolean;
  /** Hide from the live-filtered item list when false. */
  condition?: (state: GameState) => boolean;
}

const RESEARCH_LABELS: Record<string, string> = {
  shipHp1: 'HP I',
  shipHp2: 'HP II',
  shipHp3: 'HP III',
  shipHp4: 'HP IV',
  shipSpeedEnergy1: 'Speed +\nEnergy I',
  shipSpeedEnergy2: 'Speed +\nEnergy II',
  shipSpeedEnergy3: 'Speed +\nEnergy III',
  shipSpeedEnergy4: 'Speed +\nEnergy IV',
  shipShield1: 'Shield I',
  shipShield2: 'Shield II',
  shipDash: 'Dash',
  synonymousPierce: 'Harmonic\nTunneling',
  synonymousSpeed: 'Cohesion\nDrive',
  synonymousFireSpeed1: 'Pulse\nSynchrony I',
  synonymousFireSpeed2: 'Pulse\nSynchrony II',
  synonymousFireSpeed3: 'Pulse\nSynchrony III',
  synonymousFireSpeed4: 'Pulse\nSynchrony IV',
  synonymousVitality: 'Distributed\nVitality',
  weaponGatling: 'Gatling',
  weaponLaser: 'Laser',
  weaponGuidedMissile: 'Guided\nMissile',
  weaponCannon: 'Cannon V.2',
  missileturret: 'Missile',
  gatlingturret: 'Gatling',
  synonymousminelayer: 'Mine\nLayer',
  exciterturret: 'Prism',
  massdriverturret: 'Singularity',
  regenturret: 'Repair',
  advancedRegenTurrets: 'Advanced\nRepair',
  bomberyard: 'Bomber\nYard',
  swarmyard: 'Swarm\nYard',
  advancedFighters: 'Advanced\nFighters',
};

export function researchDisplayName(key: string): string {
  return (RESEARCH_LABELS[key] ?? key).replace(/\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Angle helpers
// ---------------------------------------------------------------------------

/** Angle (radians) for item i out of n, starting from the top (−π/2) clockwise. */
function itemAngle(i: number, n: number): number {
  return -Math.PI / 2 + (Math.PI * 2 / n) * i;
}

/**
 * Return the index of the item whose angle is closest to the mouse direction
 * from the menu centre, or −1 if the cursor is within MIN_SELECT_DIST.
 */
function getHoveredIndex(items: RadialItem[], centre: Vec2, mouse: Vec2): number {
  const dx = mouse.x - centre.x;
  const dy = mouse.y - centre.y;
  if (Math.hypot(dx, dy) < MIN_SELECT_DIST) return -1;
  const mouseAngle = Math.atan2(dy, dx);
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < items.length; i++) {
    let diff = mouseAngle - itemAngle(i, items.length);
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const abs = Math.abs(diff);
    if (abs < bestDiff) { bestDiff = abs; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Menu data builders
// ---------------------------------------------------------------------------

/** Convert a BuildDef to a RadialItem, gating affordability against `state`. */
function defToRadialItem(def: BuildDef, state: GameState): RadialItem {
  const cost = buildCostForState(def.key, def.cost, state);
  const label = isPlayerSynonymous(state) && def.key === 'bomberyard' ? 'Nova\nBombers' : def.radialLabel ?? def.label;
  return {
    label,
    sublabel: formatCost(cost, state),
    buildingType: def.key,
    disabled: !canAffordAmount(cost, state),
  };
}

function isPlayerSynonymous(state: GameState): boolean {
  return isSynonymousFaction(state.factionByTeam, Team.Player);
}

function buildCostForState(key: string, fallback: number, state: GameState): number {
  if (isPlayerSynonymous(state)) return SYNONYMOUS_BUILD_COST[key] ?? 0;
  const def = getBuildDef(key);
  return def ? state.getBuildCost(def, Team.Player) : fallback;
}

function formatCost(amount: number, state: GameState): string {
  return isPlayerSynonymous(state) ? `${amount} ${SYNONYMOUS_CURRENCY_SYMBOL}` : `$${amount}`;
}

function canAffordAmount(amount: number, state: GameState): boolean {
  return isPlayerSynonymous(state) ? state.synonymous.canSpend(Team.Player, amount) : state.resources >= amount;
}

function usesSynonymousSymbol(text: string): boolean {
  return text.includes(SYNONYMOUS_CURRENCY_SYMBOL);
}

function isBuildDefAvailable(def: BuildDef, state: GameState): boolean {
  return !def.researchKey || state.researchedItems.has(def.researchKey);
}

function placementRangeForBuildDef(def: BuildDef): number {
  switch (def.key) {
    case 'gatlingturret':
      return 560;
    case 'missileturret':
      return 400;
    case 'exciterturret':
      return 720;
    case 'massdriverturret':
      return 500;
    case 'tetherturret':
      return 420;
    case 'regenturret':
      return 300;
    case 'commandpost':
      return COMMANDPOST_BUILD_RADIUS;
    case 'powergenerator':
      return POWERGENERATOR_COVERAGE_RADIUS;
    default:
      return 0;
  }
}

/**
 * Building keys available to The Synonymous faction.
 * All others are Terran-only (conduit-powered structures).
 */
const SYNONYMOUS_BUILD_KEYS = new Set([
  'commandpost',
  'factory',
  'researchlab',
  'powergenerator',
  'wall',
  'gatlingturret',
  'missileturret',
  'synonymousminelayer',
  'exciterturret',
  'massdriverturret',
  'regenturret',
  'tetherturret',
  'fighteryard',
  'bomberyard',
]);

function isBuildDefForFaction(def: BuildDef, state: GameState): boolean {
  if (isSynonymousFaction(state.factionByTeam, Team.Player)) {
    return SYNONYMOUS_BUILD_KEYS.has(def.key);
  }
  if (def.key === 'synonymousminelayer') return false;
  return true;
}

function buildGeneralItems(state: GameState): RadialItem[] {
  const items: RadialItem[] = [];
  for (const def of defsByTier('structure')) {
    if (!isBuildDefForFaction(def, state)) continue;
    // Hidden defs (e.g. command post) are only revealed when the player has
    // no command post — they own that placement slot.
    if (def.hidden) {
      if (def.key === 'commandpost' && !state.getPlayerCommandPost() && state.player.alive) {
        items.push(defToRadialItem(def, state));
      }
      continue;
    }
    if (isBuildDefAvailable(def, state)) items.push(defToRadialItem(def, state));
  }
  return items;
}

function buildTurretItems(state: GameState): RadialItem[] {
  return defsByTier('turret')
    .filter((d) => isBuildDefForFaction(d, state) && isBuildDefAvailable(d, state))
    .map((d) => defToRadialItem(d, state));
}

function buildYardItems(state: GameState): RadialItem[] {
  return defsByTier('yard')
    .filter((d) => isBuildDefForFaction(d, state) && isBuildDefAvailable(d, state))
    .map((d) => defToRadialItem(d, state));
}

function availableBuildDefs(state: GameState): BuildDef[] {
  return [
    ...defsByTier('structure'),
    ...defsByTier('turret'),
    ...defsByTier('yard'),
  ].filter((def) => {
    if (!isBuildDefForFaction(def, state)) return false;
    if (def.hidden) return def.key === 'commandpost' && !state.getPlayerCommandPost() && state.player.alive;
    return isBuildDefAvailable(def, state);
  });
}

function buildBuildRoot(state: GameState): RadialItem[] {
  return [
    { label: 'Structures', children: buildGeneralItems(state) },
    { label: 'Turrets',            children: buildTurretItems(state)   },
    { label: 'Yards',              children: buildYardItems(state)     },
  ];
}

function buildResearchRoot(state: GameState): RadialItem[] {
  const makeResearchItem = (key: string): RadialItem | null => {
    if (state.researchedItems.has(key)) return null;
    if (state.researchProgress.item === key) return null;
    if (state.researchQueue.includes(key)) return null;
    if (!(ACTIVE_RESEARCH_ITEMS as readonly string[]).includes(key)) return null;
    if (key === 'advancedRegenTurrets' && !state.researchedItems.has('regenturret')) return null;
    const researchKey = key as keyof typeof RESEARCH_COST;
    return {
      label: isPlayerSynonymous(state) && key === 'bomberyard' ? 'Nova\nBombers' : RESEARCH_LABELS[key] ?? key,
      sublabel: formatCost(RESEARCH_COST[researchKey], state),
      researchItem: key,
      disabled: !canAffordAmount(RESEARCH_COST[researchKey], state),
    };
  };
  const category = (label: string, keys: string[], extras: RadialItem[] = []): RadialItem | null => {
    const researchChildren = keys.map((key) => makeResearchItem(key)).filter((item): item is RadialItem => item !== null);
    if (researchChildren.length === 0) return null;
    const children = [
      ...extras,
      ...researchChildren,
    ];
    return { label, children };
  };
  const visibleCategories = (items: Array<RadialItem | null>): RadialItem[] => {
    const categories = items.filter((item): item is RadialItem => item !== null);
    return categories.length > 0
      ? categories
      : [{ label: 'ALL RESEARCH COMPLETE', disabled: true, infoOnly: true }];
  };
  if (isPlayerSynonymous(state)) {
    const nextFireSpeed = `synonymousFireSpeed${Math.min(4, state.player.synonymousFireSpeedLevel + 1)}`;
    return visibleCategories([
      category('Main Ship', ['synonymousSpeed', 'synonymousVitality']),
      category('Weapons', ['synonymousPierce', nextFireSpeed]),
      category('Fighters', ['advancedFighters', 'bomberyard', 'swarmyard']),
      category('Defensive Turrets', ['synonymousminelayer', 'exciterturret', 'massdriverturret', 'regenturret']),
    ]);
  }
  const nextHp = `shipHp${Math.min(SHIP_HP_MAX_LEVEL, state.player.hpLevel + 1)}`;
  const nextSpeedEnergy = `shipSpeedEnergy${Math.min(SHIP_SPEED_ENERGY_MAX_LEVEL, state.player.speedEnergyLevel + 1)}`;
  const nextShield = `shipShield${Math.min(SHIP_SHIELD_MAX_LEVEL, state.player.shieldLevel + 1)}`;
  return visibleCategories([
    category('Defensive Turrets', ['missileturret', 'exciterturret', 'massdriverturret', 'regenturret', 'advancedRegenTurrets']),
    category('Main Ship', [nextHp, nextSpeedEnergy, nextShield, 'shipDash']),
    category('Fighters', ['advancedFighters', 'bomberyard', 'swarmyard']),
    category('Weapons', ['weaponCannon', 'weaponGatling', 'weaponLaser', 'weaponGuidedMissile'], [
      { label: 'Cannon', sublabel: 'Ready', disabled: true, infoOnly: true },
    ]),
  ]);
}

function buildGroupOrders(group: ShipGroup): RadialItem[] {
  return [
    { label: 'Protect\nBase',   tacticalOrder: TacticalOrder.ProtectBase,  orderGroup: group },
    { label: 'Set\nWaypoint',   tacticalOrder: TacticalOrder.SetWaypoint,  orderGroup: group },
    { label: 'Follow\nPlayer',  tacticalOrder: TacticalOrder.FollowPlayer, orderGroup: group },
    { label: 'Dock',            tacticalOrder: TacticalOrder.Dock,         orderGroup: group },
  ];
}

function buildAllOrders(): RadialItem[] {
  return [
    { label: 'Protect\nBase',   tacticalOrder: TacticalOrder.ProtectBase,  orderGroup: 'all' },
    { label: 'Set\nWaypoint',   tacticalOrder: TacticalOrder.SetWaypoint,  orderGroup: 'all' },
    { label: 'Follow\nPlayer',  tacticalOrder: TacticalOrder.FollowPlayer, orderGroup: 'all' },
    { label: 'Dock',            tacticalOrder: TacticalOrder.Dock,         orderGroup: 'all' },
  ];
}

function buildCommandRoot(_state: GameState): RadialItem[] {
  return [
    { label: '1',   children: buildGroupOrders(ShipGroup.Red)   },
    { label: '2',   children: buildGroupOrders(ShipGroup.Green) },
    { label: '3',   children: buildGroupOrders(ShipGroup.Blue)  },
    { label: '4',   children: buildAllOrders() },
  ];
}

function gridLineCells(from: { cx: number; cy: number }, to: { cx: number; cy: number }): Array<{ cx: number; cy: number }> {
  const cells: Array<{ cx: number; cy: number }> = [];
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  let lastKey = '';
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = Math.round(from.cx + dx * t);
    const cy = Math.round(from.cy + dy * t);
    const key = cellKey(cx, cy);
    if (key === lastKey) continue;
    lastKey = key;
    cells.push({ cx, cy });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// HoldMenu — one instance per hold key
// ---------------------------------------------------------------------------

class HoldMenu {
  open = false;

  private stack: RadialItem[][] = [];
  private centre: Vec2 = new Vec2(0, 0);
  private hoveredIdx = -1;

  constructor(
    private readonly holdKey: string,
    private readonly rootFactory: (state: GameState) => RadialItem[],
    private readonly title: string,
  ) {}

  private currentItems(state: GameState): RadialItem[] {
    const raw = this.stack[this.stack.length - 1] ?? [];
    return raw.filter((i) => !i.condition || i.condition(state));
  }

  update(state: GameState, camera: Camera): MenuResult {
    // Hold key opens/keeps open; release closes. Input normalization means
    // the Shift-shifted variant is handled automatically.
    const keyDown = Input.isDown(this.holdKey);
    if (keyDown && !this.open) {
      this.open = true;
      this.stack = [this.rootFactory(state)];
      Audio.playSound('menucursor');
    } else if (!keyDown && this.open) {
      this.open = false;
      this.stack = [];
    }

    if (!this.open) return { action: 'none' };

    // Cache the player's screen position for draw().
    this.centre = camera.worldToScreen(state.player.position);

    // RMB → go back one level or close.
    if (Input.mouse2Pressed) {
      Input.consumeMouseButton(2);
      if (this.stack.length > 1) {
        this.stack.pop();
        Audio.playSound('menucursor');
      } else {
        this.open = false;
        this.stack = [];
      }
      return { action: 'none' };
    }

    const items = this.currentItems(state);
    this.hoveredIdx = items.length > 0
      ? getHoveredIndex(items, this.centre, Input.mousePos)
      : -1;

    // LMB confirm (only on fresh press, not hold).
    if (Input.mousePressed && this.hoveredIdx >= 0) {
      const item = items[this.hoveredIdx];
      if (!item.disabled) {
        Input.consumeMouseButton(0);
        return this.confirm(item, state);
      }
    }

    return { action: 'none' };
  }

  private confirm(item: RadialItem, state: GameState): MenuResult {
    Audio.playSound('menuselection');

    if (item.children && item.children.length > 0) {
      const filtered = item.children.filter((i) => !i.condition || i.condition(state));
      if (filtered.length > 0) this.stack.push(filtered);
      return { action: 'none' };
    }

    // Leaf — close the menu and emit the result.
    this.open = false;
    this.stack = [];

    if (item.buildingType) {
      return { action: 'build', buildingType: item.buildingType };
    }
    if (item.orderGroup !== undefined && item.tacticalOrder !== undefined) {
      return { action: 'order', group: item.orderGroup, order: item.tacticalOrder };
    }
    if (item.researchItem) {
      return { action: 'research', item: item.researchItem };
    }
    return { action: 'none' };
  }

  // -----------------------------------------------------------------------
  // Drawing
  // -----------------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, state: GameState): void {
    if (!this.open) return;

    const items = this.currentItems(state);
    const cx = this.centre.x;
    const cy = this.centre.y;

    // Central hub disc.
    drawMenuOrb(ctx, cx, cy, 30, true, false);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = colorToCSS(Colors.general_building, 0.9);
    ctx.fillText(this.title, cx, cy - (this.stack.length > 1 ? 7 : 0));
    if (this.stack.length > 1) {
      ctx.font = '8px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.55);
      ctx.fillText('RMB=back', cx, cy + 9);
    }

    if (items.length === 0) {
      ctx.font = '10px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.55);
      ctx.fillText('(nothing available)', cx, cy - 75);
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const angle = itemAngle(i, items.length);
      const ix = cx + Math.cos(angle) * ITEM_RADIUS;
      const iy = cy + Math.sin(angle) * ITEM_RADIUS;
      const hovered = i === this.hoveredIdx;

      // Connector line.
      const connector = ctx.createLinearGradient(cx, cy, ix, iy);
      connector.addColorStop(0, `${UI_CYAN}${hovered ? 0.34 : 0.14})`);
      connector.addColorStop(1, `${UI_GOLD}${hovered ? 0.30 : 0.08})`);
      ctx.strokeStyle = connector;
      ctx.lineWidth = hovered ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ix, iy);
      ctx.stroke();

      // Item circle.
      drawMenuOrb(ctx, ix, iy, ITEM_CIRCLE_R, hovered, !!item.disabled);

      // Label (split on '\n').
      ctx.font = '10px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = item.disabled
        ? colorToCSS(Colors.radar_gridlines, 0.35)
        : hovered
          ? colorToCSS(Colors.radar_friendly_status)
          : colorToCSS(Colors.general_building, 0.9);

      const lines = item.label.split('\n');
      const lineH = 11;
      const hasSubLabel = !!item.sublabel;
      // Shift label up slightly when there's a cost sublabel below it.
      const blockTop = hasSubLabel
        ? iy - (lines.length * lineH) / 2 - 5
        : iy - (lines.length * lineH) / 2 + lineH / 2;
      for (let l = 0; l < lines.length; l++) {
        ctx.fillText(lines[l], ix, blockTop + l * lineH);
      }

      if (item.sublabel) {
        ctx.font = usesSynonymousSymbol(item.sublabel) ? `9px ${MENU_CANVAS_FONT}` : '9px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
        ctx.fillStyle = item.disabled
          ? colorToCSS(Colors.radar_gridlines, 0.3)
          : hovered
            ? colorToCSS(Colors.radar_friendly_status, 0.75)
            : colorToCSS(Colors.factory_detail, 0.9);
        ctx.fillText(item.sublabel, ix, blockTop + lines.length * lineH + 2);
      }

      // Sub-menu arrow indicator.
      if (item.children && item.children.length > 0) {
        ctx.font = '10px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
        ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.6);
        ctx.fillText('▸', ix + ITEM_CIRCLE_R - 13, iy - ITEM_CIRCLE_R + 15);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PaintMenu — Q-hold conduit paint mode (PR3)
// ---------------------------------------------------------------------------

/**
 * Hold Q to enter conduit paint mode. While active:
 *   - The cell under the mouse cursor is highlighted.
 *   - LMB (or LMB-drag) paints player conduits.
 *   - RMB (or RMB-drag) erases conduits.
 *   - Releasing Q exits paint mode.
 *
 * Paint mode sets `ActionMenu.placementMode = true` so primary fire is
 * suppressed by `Game.updatePlayerFiring()`.
 *
 * Painting is rate-limited to one cell change per (cell, drag) so a single
 * LMB-press can paint a row by dragging without the same cell being touched
 * dozens of times per second.
 */
class PaintMenu {
  open = false;

  /** Cells already touched during the current drag, to avoid spamming Audio. */
  private touchedThisDrag = new Set<string>();
  /** Whether LMB or RMB started the current drag. */
  private dragMode: 'paint' | 'erase' | null = null;

  /**
   * Run paint-mode logic. Returns true if the menu is currently active.
   * Caller is responsible for calling `Input.consumeMouseButton` on the
   * frame the drag begins so the click doesn't fire a special / weapon.
   */
  update(state: GameState, camera: Camera): boolean {
    const keyDown = Input.isDown('q');
    if (keyDown && !this.open) {
      this.open = true;
      this.touchedThisDrag.clear();
      this.dragMode = null;
    } else if (!keyDown && this.open) {
      this.open = false;
      this.touchedThisDrag.clear();
      this.dragMode = null;
      return false;
    }
    if (!this.open) return false;

    // Determine current paint/erase state.
    // Note: fire is already suppressed via placementMode=true, so we do NOT
    // consume the mouse buttons here — doing so would clear mouseDown before
    // the hold-detection block below, preventing any paint from registering.
    if (Input.mousePressed) {
      this.dragMode = 'paint';
      this.touchedThisDrag.clear();
    } else if (Input.mouse2Pressed) {
      this.dragMode = 'erase';
      this.touchedThisDrag.clear();
    }

    if (Input.mouseDown) {
      this.dragMode = 'paint';
    } else if (Input.mouse2Down) {
      this.dragMode = 'erase';
    } else {
      this.dragMode = null;
      this.touchedThisDrag.clear();
    }

    if (this.dragMode !== null) {
      const worldPos = camera.screenToWorld(Input.mousePos);
      const { cx, cy } = worldToCell(worldPos);
      const key = cellKey(cx, cy);
      if (!this.touchedThisDrag.has(key)) {
        this.touchedThisDrag.add(key);
        if (this.dragMode === 'paint') {
          if (!state.grid.hasConduit(cx, cy) && !state.grid.hasPendingConduit(cx, cy)) {
            if (state.resources >= CONDUIT_COST) {
              state.resources -= CONDUIT_COST;
              state.grid.queueConduit(cx, cy, Team.Player);
            }
          }
        } else if (this.dragMode === 'erase') {
          if (state.eraseBlueprintAt(worldPos, Team.Player)) {
            Audio.playSound('menucursor');
            return true;
          }
          if (state.grid.conduitTeam(cx, cy) === Team.Player) {
            state.grid.removeConduit(cx, cy);
            state.power.markDirty();
            Audio.playSound('menucursor');
          }
        }
      }
    }

    return true;
  }

  /** Highlight the cell currently under the mouse cursor. */
  draw(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    camera: Camera,
    screenW: number,
    _screenH: number,
  ): void {
    if (!this.open) return;
    const worldPos = camera.screenToWorld(Input.mousePos);
    const cell = worldToCell(worldPos);
    const mode: 'paint' | 'erase' = this.dragMode === 'erase' ? 'erase' : 'paint';
    state.grid.drawPaintCursor(ctx, camera, cell, mode);

    // Top-of-screen hint banner.
    ctx.font = '12px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colorToCSS(Colors.radar_friendly_status, 0.85);
    ctx.fillText(
      `[Q] Conduit Paint  •  LMB paint ($${CONDUIT_COST}/cell)  •  RMB erase  •  release Q to exit`,
      screenW * 0.5,
      24,
    );
    // Conduit count for feedback.
    ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = colorToCSS(Colors.general_building, 0.6);
    ctx.fillText(
      `conduits: ${state.grid.conduitCount()}  •  queued: ${state.grid.pendingConduitCount()}  •  cell ${cell.cx},${cell.cy}  •  resources: $${Math.floor(state.resources)}`,
      screenW * 0.5,
      40,
    );
  }
}

class LeftHoldMenu {
  open = false;

  private stack: RadialItem[][] = [];
  private path: string[] = [];
  private selectedIdx = 0;
  private hoveredIdx = -1;
  private openedAt = 0;
  private readonly rowRects: Array<{ index: number; x: number; y: number; w: number; h: number }> = [];
  private readonly queueRects: Array<{ index: number; item: string; x: number; y: number; w: number; h: number }> = [];

  constructor(
    private readonly holdKey: string,
    private readonly rootFactory: (state: GameState) => RadialItem[],
    private readonly title: string,
    private readonly showResearchQueue: boolean = false,
  ) {}

  private currentItems(state: GameState): RadialItem[] {
    const raw = this.stack[this.stack.length - 1] ?? [];
    return raw.filter((i) => !i.condition || i.condition(state));
  }

  update(state: GameState, _camera: Camera): MenuResult {
    const keyDown = Input.isDown(this.holdKey);
    if (keyDown && !this.open) {
      this.open = true;
      this.stack = [this.rootFactory(state)];
      this.path = [];
      this.selectedIdx = 0;
      this.openedAt = performance.now() * 0.001;
      Audio.playSound('menucursor');
    } else if (!keyDown && this.open) {
      this.open = false;
      this.stack = [];
      this.path = [];
    }
    if (!this.open) return { action: 'none' };
    this.refreshStack(state);

    if (Input.mouse2Pressed) {
      Input.consumeMouseButton(2);
      if (this.stack.length > 1) {
        this.stack.pop();
        this.path.pop();
        this.selectedIdx = 0;
        Audio.playSound('menucursor');
      } else {
        this.open = false;
        this.stack = [];
        this.path = [];
      }
      return { action: 'none' };
    }

    const items = this.currentItems(state);
    this.normalizeSelectedIndex(items);
    if (Input.mouse3Pressed && items.length > 0) {
      Input.consumeMouseButton(1);
      this.selectedIdx = this.firstSelectableIndex(items);
      Audio.playSound('menucursor', 0.22);
      return { action: 'none' };
    }
    if (Input.wheelDelta !== 0 && items.length > 0) {
      this.selectedIdx = this.nextSelectableIndex(items, this.selectedIdx, Input.wheelDelta > 0 ? 1 : -1);
      Audio.playSound('menucursor', 0.22);
    }

    this.hoveredIdx = -1;
    for (const rect of this.rowRects) {
      if (
        Input.mousePos.x >= rect.x && Input.mousePos.x <= rect.x + rect.w &&
        Input.mousePos.y >= rect.y && Input.mousePos.y <= rect.y + rect.h
      ) {
        this.hoveredIdx = rect.index;
        this.selectedIdx = rect.index;
        break;
      }
    }

    if (Input.mousePressed) {
      if (this.showResearchQueue) {
        for (const rect of this.queueRects) {
          if (
            Input.mousePos.x >= rect.x && Input.mousePos.x <= rect.x + rect.w &&
            Input.mousePos.y >= rect.y && Input.mousePos.y <= rect.y + rect.h
          ) {
            Input.consumeMouseButton(0);
            Audio.playSound('menuselection');
            return { action: 'cancelResearch', item: rect.item, queueIndex: rect.index };
          }
        }
      }
      const index = this.hoveredIdx >= 0 ? this.hoveredIdx : this.selectedIdx;
      const item = items[index];
      if (item && !item.disabled) {
        Input.consumeMouseButton(0);
        return this.confirm(item, state);
      }
    }
    return { action: 'none' };
  }

  private confirm(item: RadialItem, state: GameState): MenuResult {
    Audio.playSound('menuselection');
    if (item.children && item.children.length > 0) {
      const filtered = item.children.filter((i) => !i.condition || i.condition(state));
      if (filtered.length > 0) {
        this.stack.push(filtered);
        this.path.push(item.label);
        this.selectedIdx = 0;
      }
      return { action: 'none' };
    }
    this.open = false;
    this.stack = [];
    this.path = [];
    if (item.buildingType) return { action: 'build', buildingType: item.buildingType };
    if (item.orderGroup !== undefined && item.tacticalOrder !== undefined) {
      return { action: 'order', group: item.orderGroup, order: item.tacticalOrder };
    }
    if (item.researchItem) return { action: 'research', item: item.researchItem };
    return { action: 'none' };
  }

  private refreshStack(state: GameState): void {
    const stack: RadialItem[][] = [this.rootFactory(state)];
    const refreshedPath: string[] = [];
    let level = stack[0];
    for (const label of this.path) {
      const parent = level.find((item) => item.label === label && item.children);
      const children = parent?.children?.filter((i) => !i.condition || i.condition(state));
      if (!children || children.length === 0) break;
      stack.push(children);
      refreshedPath.push(label);
      level = children;
    }
    this.stack = stack;
    this.path = refreshedPath;
  }

  draw(ctx: CanvasRenderingContext2D, state: GameState, screenW: number = 800, screenH: number = 600): void {
    if (!this.open) return;
    const items = this.currentItems(state);
    this.normalizeSelectedIndex(items);
    this.rowRects.length = 0;
    this.queueRects.length = 0;

    const x = 12;
    const y = 96;
    const w = 345;
    const rowH = 51;
    const gap = 9;
    const headerH = 63;
    const panelH = headerH + Math.max(1, items.length) * (rowH + gap) + 14;

    ctx.save();
    fillMenuPanel(ctx, x, y, w, panelH);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '21px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = colorToCSS(Colors.general_building, 0.95);
    drawDecodedText(ctx, this.title, x + 18, y + 34, 21, this.openedAt);
    if (this.stack.length > 1) {
      ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.55);
      ctx.fillText('RMB back', x + w - 104, y + 22);
    }

    if (items.length === 0) {
      ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.55);
      ctx.fillText('(nothing available)', x + 12, y + headerH);
      ctx.restore();
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const rowY = y + headerH + i * (rowH + gap);
      const active = i === this.selectedIdx || i === this.hoveredIdx;
      this.rowRects.push({ index: i, x: x + 10, y: rowY, w: w - 20, h: rowH });
      drawMenuRow(ctx, x + 10, rowY, w - 20, rowH, active, !!item.disabled);
      ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = item.disabled
        ? colorToCSS(item.infoOnly ? Colors.radar_gridlines : Colors.alert1, item.infoOnly ? 0.55 : 0.9)
        : active
          ? colorToCSS(Colors.radar_friendly_status)
          : colorToCSS(Colors.general_building, 0.9);
      drawDecodedText(ctx, item.label.replace(/\n/g, ' '), x + 20, rowY + rowH * 0.5, 15, this.openedAt);
      ctx.textAlign = 'right';
      if (item.sublabel) {
        ctx.font = usesSynonymousSymbol(item.sublabel) ? `18px ${MENU_CANVAS_FONT}` : '18px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
        ctx.fillStyle = item.disabled
          ? colorToCSS(item.infoOnly ? Colors.radar_gridlines : Colors.alert1, item.infoOnly ? 0.55 : 0.9)
          : active
            ? colorToCSS(Colors.radar_friendly_status, 1)
            : colorToCSS(Colors.radar_friendly_status, 0.9);
        ctx.fillText(item.sublabel, x + w - 20, rowY + rowH * 0.5);
      } else if (item.children && item.children.length > 0) {
        ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.6);
        ctx.fillText('>', x + w - 20, rowY + rowH * 0.5);
      }
    }
    ctx.restore();

    // Description tooltip: show for hovered/selected leaf item
    const activeIdx = this.hoveredIdx >= 0 ? this.hoveredIdx : this.selectedIdx;
    if (activeIdx >= 0 && activeIdx < items.length) {
      const item = items[activeIdx];
      let description: string | undefined;
      if (item.researchItem) {
        description = RESEARCH_DESCRIPTIONS[item.researchItem]
          ?? getBuildDef(item.researchItem)?.description;
      } else if (item.buildingType) {
        description = getBuildDef(item.buildingType)?.description;
      }
      if (description) {
        const rect = this.rowRects.find((r) => r.index === activeIdx);
        if (rect) {
          drawDescriptionBox(ctx, description, x + w, rect.y + rect.h / 2, screenW, screenH);
        }
      }
    }

    if (this.showResearchQueue) this.drawResearchQueue(ctx, state, x, y + panelH + 8, w);
  }

  private drawResearchQueue(ctx: CanvasRenderingContext2D, state: GameState, x: number, y: number, w: number): void {
    const rowH = 42;
    const gap = 8;
    const shown = [
      ...(state.researchProgress.item ? [{ item: state.researchProgress.item, active: true }] : []),
      ...state.researchQueue.map((item) => ({ item, active: false })),
    ];
    const panelH = 56 + Math.max(1, shown.length) * (rowH + gap) + 12;
    ctx.save();
    fillMenuPanel(ctx, x, y, w, panelH);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colorToCSS(Colors.alert2, 0.86);
    drawDecodedText(ctx, 'Research Queue', x + 12, y + 20, 20, this.openedAt);

    if (shown.length === 0) {
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.55);
      drawDecodedText(ctx, 'No queued research', x + 12, y + 52, 15, this.openedAt);
      ctx.restore();
      return;
    }

    for (let i = 0; i < shown.length; i++) {
      const entry = shown[i];
      const rowY = y + 54 + i * (rowH + gap);
      const hovered = Input.mousePos.x >= x + 10 && Input.mousePos.x <= x + w - 10 &&
        Input.mousePos.y >= rowY && Input.mousePos.y <= rowY + rowH;
      if (!entry.active) this.queueRects.push({ index: i - (state.researchProgress.item ? 1 : 0), item: entry.item, x: x + 10, y: rowY, w: w - 20, h: rowH });
      drawMenuRow(ctx, x + 10, rowY, w - 20, rowH, hovered && !entry.active, false);
      ctx.fillStyle = colorToCSS(Colors.general_building, 0.88);
      const queueNumber = state.researchProgress.item ? i : i + 1;
      const prefix = entry.active ? 'Now' : `${queueNumber}.`;
      drawDecodedText(ctx, `${prefix} ${researchDisplayName(entry.item)}`, x + 18, rowY + rowH * 0.5, 15, this.openedAt);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.62);
      ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      ctx.fillText(entry.active ? 'active' : 'cancel', x + w - 18, rowY + rowH * 0.5);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }
    ctx.restore();
  }

  private normalizeSelectedIndex(items: RadialItem[]): void {
    if (items.length === 0) {
      this.selectedIdx = 0;
      return;
    }
    if (this.selectedIdx >= items.length) this.selectedIdx = items.length - 1;
    if (items[this.selectedIdx]?.disabled) {
      this.selectedIdx = this.nextSelectableIndex(items, this.selectedIdx, 1);
    }
  }

  private nextSelectableIndex(items: RadialItem[], start: number, dir: number): number {
    let idx = start;
    for (let i = 0; i < items.length; i++) {
      idx = (idx + dir + items.length) % items.length;
      if (!items[idx]?.disabled) return idx;
    }
    return start;
  }

  private firstSelectableIndex(items: RadialItem[]): number {
    for (let i = 0; i < items.length; i++) {
      if (!items[i]?.disabled) return i;
    }
    return 0;
  }
}

class ShipMenu {
  open = false;
  private openedAt = 0;
  private readonly weaponRects: Array<{ id: ShipWeaponId; x: number; y: number; w: number; h: number }> = [];
  private readonly wheelRects: Array<{ id: ShipWeaponId; x: number; y: number; r: number }> = [];
  private panelRect: { x: number; y: number; w: number; h: number } | null = null;

  update(state: GameState, camera: Camera): boolean {
    const keyDown = Input.isDown('z');
    if (keyDown && !this.open) {
      this.open = true;
      this.openedAt = performance.now() * 0.001;
      Audio.playSound('menucursor');
    } else if (!keyDown && this.open) {
      this.open = false;
      return false;
    }
    if (!this.open) return false;

    if (Input.wheelDelta !== 0) {
      // Prevent weapon switching during gatling overheat / overdrive lockdown
      if (state.player.canSwitchWeapon()) {
        state.player.cyclePrimaryWeapon(Input.wheelDelta > 0 ? 1 : -1, (id) => this.weaponUnlocked(state, id));
        Audio.playSound('menucursor', 0.22);
      }
    }

    if (Input.mouse3Pressed) {
      Input.consumeMouseButton(1);
      if (state.player.canSwitchWeapon()) {
        state.player.selectFirstUnlockedWeapon((id) => this.weaponUnlocked(state, id));
        Audio.playSound('menucursor', 0.22);
      }
      return true;
    }

    if (Input.mousePressed) {
      let handled = false;
      for (const option of this.wheelRects) {
        if (Math.hypot(Input.mousePos.x - option.x, Input.mousePos.y - option.y) <= option.r) {
          this.selectWeapon(state, option.id);
          handled = true;
          break;
        }
      }
      for (const rect of this.weaponRects) {
        if (handled) break;
        if (
          Input.mousePos.x >= rect.x && Input.mousePos.x <= rect.x + rect.w &&
          Input.mousePos.y >= rect.y && Input.mousePos.y <= rect.y + rect.h
        ) {
          if (this.weaponUnlocked(state, rect.id) && state.player.canSwitchWeapon()) {
            this.selectWeapon(state, rect.id);
          } else {
            Audio.playSound('menucursor');
          }
          handled = true;
          break;
        }
      }
      // A click anywhere in game space chooses the wheel option nearest the
      // click's direction from the ship. The information panel is excluded so
      // its non-weapon rows remain inert.
      if (!handled && !this.pointInPanel(Input.mousePos.x, Input.mousePos.y)) {
        const options = this.unlockedWeapons(state);
        const shipScreen = camera.worldToScreen(state.player.position);
        if (options.length > 0 && Math.hypot(Input.mousePos.x - shipScreen.x, Input.mousePos.y - shipScreen.y) > 1) {
          const clickAngle = Math.atan2(Input.mousePos.y - shipScreen.y, Input.mousePos.x - shipScreen.x);
          let closest = options[0];
          let closestDelta = Infinity;
          for (let i = 0; i < options.length; i++) {
            const optionAngle = -Math.PI / 2 + i * Math.PI * 2 / options.length;
            const delta = Math.abs(Math.atan2(Math.sin(clickAngle - optionAngle), Math.cos(clickAngle - optionAngle)));
            if (delta < closestDelta) {
              closest = options[i];
              closestDelta = delta;
            }
          }
          this.selectWeapon(state, closest.id);
          handled = true;
        }
      }
      if (handled) Input.consumeMouseButton(0);
    }

    return true;
  }

  draw(ctx: CanvasRenderingContext2D, state: GameState, camera: Camera, screenW: number, screenH: number): void {
    if (!this.open) return;
    this.weaponRects.length = 0;
    this.wheelRects.length = 0;
    const panelW = Math.min(360, Math.max(300, screenW - 24));
    const x = 12;
    const panelH = Math.min(screenH - 150, Math.max(440, screenH - 190));
    const y = Math.max(10, Math.min(48, (screenH - panelH) * 0.5 - 18));
    this.panelRect = { x, y, w: panelW, h: panelH };
    this.drawWeaponWheel(ctx, state, camera);
    ctx.save();
    fillMenuPanel(ctx, x, y, panelW, panelH);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '20px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = colorToCSS(Colors.general_building, 0.95);
    drawDecodedText(ctx, '[Z] Ship', x + 12, y + 12, 20, this.openedAt);

    const ship = state.player;
    const statsY = y + 48;
    const shieldText = ship.shieldUnlocked
      ? `${Math.ceil(ship.shield)}/${ship.maxShield}`
      : 'offline';
    const stats = [
      `HP ${Math.ceil(ship.health)}/${ship.maxHealth}`,
      `Shield ${shieldText}`,
      `Speed ${Math.round(ship.maxSpeed)}`,
      `Energy ${Math.floor(ship.battery)}/${ship.maxBattery}`,
      `Energy Regen ${ship.baseBatteryRegenRate.toFixed(1)}/s`,
      `Fire Speed x${(1 / ship.fireCooldownMultiplier).toFixed(2)}`,
      isPlayerSynonymous(state)
        ? `Nanobots ${state.synonymous.getUnallocatedCount(Team.Player)} ${SYNONYMOUS_CURRENCY_SYMBOL}`
        : `Resources $${Math.floor(state.resources)}`,
    ];
    ctx.font = '16px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    for (let i = 0; i < stats.length; i++) {
      const sy = statsY + i * 18;
      drawMenuRow(ctx, x + 10, sy - 2, panelW - 20, 16, false, false);
      ctx.fillStyle = colorToCSS(Colors.general_building, 0.86);
      drawDecodedText(ctx, stats[i], x + 18, sy, 16, this.openedAt);
    }

    const upgradeY = statsY + stats.length * 18 + 12;
    ctx.font = '18px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = colorToCSS(Colors.alert2, 0.85);
    drawDecodedText(ctx, 'Upgrades', x + 12, upgradeY, 18, this.openedAt);
    const upgrades = [
      ...(isPlayerSynonymous(state)
        ? [
            ['Harmonic Tunneling', 'synonymousPierce'],
            ['Cohesion Drive', 'synonymousSpeed'],
            [`Pulse Synchrony ${ship.synonymousFireSpeedLevel}/4`, 'synonymousFireSpeed1'],
            ['Distributed Vitality', 'synonymousVitality'],
          ]
        : [
            [`HP ${ship.hpLevel}/${SHIP_HP_MAX_LEVEL}`, 'shipHp1'],
            [`Speed + Energy + Fire Speed ${ship.speedEnergyLevel}/${SHIP_SPEED_ENERGY_MAX_LEVEL}`, 'shipSpeedEnergy1'],
            [`Shield Aura ${ship.shieldLevel}/${SHIP_SHIELD_MAX_LEVEL}`, 'shipShield1'],
            ['Dash', 'shipDash'],
          ]),
    ] as Array<[string, string]>;
    const unlockedUpgrades = upgrades.filter(([, key]) => state.researchedItems.has(key));
    ctx.font = '16px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    if (unlockedUpgrades.length === 0) {
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.7);
      drawDecodedText(ctx, 'No upgrades unlocked', x + 12, upgradeY + 26, 16, this.openedAt);
    } else {
      for (let i = 0; i < unlockedUpgrades.length; i++) {
        const [label] = unlockedUpgrades[i];
        const uy = upgradeY + 24 + i * 17;
        drawMenuRow(ctx, x + 10, uy - 1, panelW - 20, 15, false, false);
        ctx.fillStyle = colorToCSS(Colors.radar_friendly_status, 0.9);
        drawDecodedText(ctx, label, x + 18, uy, 16, this.openedAt);
      }
    }

    const weaponsY = upgradeY + 38 + Math.max(1, unlockedUpgrades.length) * 17;
    ctx.font = '18px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = colorToCSS(Colors.alert2, 0.85);
    drawDecodedText(ctx, 'Weapons', x + 12, weaponsY, 18, this.openedAt);
    const factionWeapons = SHIP_WEAPON_OPTIONS.filter((w) =>
      isPlayerSynonymous(state) ? w.id === 'synonymousLaser' : w.id !== 'synonymousLaser',
    );
    const rowH = Math.max(30, Math.min(52, (y + panelH - weaponsY - 46) / factionWeapons.length - 4));
    for (let i = 0; i < factionWeapons.length; i++) {
      const weapon = factionWeapons[i];
      const wy = weaponsY + 20 + i * (rowH + 4);
      const selected = ship.primaryWeaponId === weapon.id;
      const unlocked = this.weaponUnlocked(state, weapon.id);
      this.weaponRects.push({ id: weapon.id, x: x + 10, y: wy, w: panelW - 20, h: rowH });
      drawMenuRow(ctx, x + 10, wy, panelW - 20, rowH, selected, !unlocked);
      ctx.font = '16px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      ctx.fillStyle = unlocked ? colorToCSS(Colors.general_building, 0.95) : colorToCSS(Colors.radar_gridlines, 0.48);
      drawDecodedText(ctx, weapon.label, x + 20, wy + 7, 16, this.openedAt);
      if (rowH >= 42) {
        ctx.font = '14px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
        ctx.fillStyle = unlocked ? colorToCSS(Colors.radar_gridlines, 0.78) : colorToCSS(Colors.radar_gridlines, 0.44);
        drawDecodedText(ctx, unlocked ? weapon.description : 'Research required', x + 20, wy + 29, 14, this.openedAt);
      }
    }

    ctx.font = '14px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.7);
    drawDecodedText(ctx, 'click or mouse wheel changes weapon', x + panelW * 0.5, y + panelH - 18, 14, this.openedAt, 'center');
    ctx.restore();

    // Description tooltip: show for hovered or selected weapon
    let descWeapon = factionWeapons.find((w) => w.id === ship.primaryWeaponId);
    let descRect = this.weaponRects.find((r) => r.id === ship.primaryWeaponId);
    for (const rect of this.weaponRects) {
      if (
        Input.mousePos.x >= rect.x && Input.mousePos.x <= rect.x + rect.w &&
        Input.mousePos.y >= rect.y && Input.mousePos.y <= rect.y + rect.h
      ) {
        descWeapon = factionWeapons.find((w) => w.id === rect.id);
        descRect = rect;
        break;
      }
    }
    if (descWeapon && descRect) {
      drawDescriptionBox(ctx, descWeapon.description, x + panelW, descRect.y + descRect.h / 2, screenW, screenH);
    }
  }

  private weaponUnlocked(state: GameState, id: ShipWeaponId): boolean {
    if (isPlayerSynonymous(state)) return id === 'synonymousLaser';
    if (id === 'synonymousLaser') return false;
    const weapon = SHIP_WEAPON_OPTIONS.find((item) => item.id === id);
    return !weapon?.researchKey || state.researchedItems.has(weapon.researchKey);
  }

  private unlockedWeapons(state: GameState): typeof SHIP_WEAPON_OPTIONS[number][] {
    return SHIP_WEAPON_OPTIONS
      .filter((weapon) => this.weaponUnlocked(state, weapon.id))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  private pointInPanel(x: number, y: number): boolean {
    const panel = this.panelRect;
    return !!panel && x >= panel.x && x <= panel.x + panel.w && y >= panel.y && y <= panel.y + panel.h;
  }

  private selectWeapon(state: GameState, id: ShipWeaponId): void {
    if (state.player.canSwitchWeapon()) {
      state.player.selectPrimaryWeapon(id);
      Audio.playSound('menuselection');
    } else {
      Audio.playSound('menucursor');
    }
  }

  private drawWeaponWheel(ctx: CanvasRenderingContext2D, state: GameState, camera: Camera): void {
    const options = this.unlockedWeapons(state);
    if (options.length === 0) return;
    const center = camera.worldToScreen(state.player.position);
    const radius = 112;
    const optionRadius = 30;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < options.length; i++) {
      const weapon = options[i];
      const angle = -Math.PI / 2 + i * Math.PI * 2 / options.length;
      const x = center.x + Math.cos(angle) * radius;
      const y = center.y + Math.sin(angle) * radius;
      const selected = state.player.primaryWeaponId === weapon.id;
      this.wheelRects.push({ id: weapon.id, x, y, r: optionRadius });

      ctx.beginPath();
      ctx.moveTo(center.x + Math.cos(angle) * 42, center.y + Math.sin(angle) * 42);
      ctx.lineTo(x - Math.cos(angle) * optionRadius, y - Math.sin(angle) * optionRadius);
      ctx.strokeStyle = selected ? UI_GOLD + '0.64)' : UI_CYAN + '0.24)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, optionRadius, 0, Math.PI * 2);
      ctx.fillStyle = selected ? UI_GOLD + '0.25)' : UI_PANEL_DARK + '0.88)';
      ctx.strokeStyle = selected ? UI_GOLD + '0.96)' : UI_CYAN + '0.72)';
      ctx.fill();
      ctx.stroke();
      this.drawWeaponStubIcon(ctx, state, weapon.id, x, y - 4);
      ctx.font = '11px "Poiret One", "Segoe UI", sans-serif';
      ctx.fillStyle = selected ? UI_GOLD + '1)' : UI_CYAN + '0.95)';
      const label = weapon.id === 'cannon'
        ? (state.researchedItems.has('weaponCannon') ? 'Cannon V2' : 'Cannon V1')
        : weapon.label;
      ctx.fillText(label, x, y + 17);
    }
    ctx.restore();
  }

  private drawWeaponStubIcon(ctx: CanvasRenderingContext2D, state: GameState, id: ShipWeaponId, x: number, y: number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = UI_CYAN + '0.95)';
    ctx.fillStyle = UI_CYAN + '0.26)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (id === 'cannon') {
      const v2 = state.researchedItems.has('weaponCannon');
      ctx.rect(-10, -5, 13, 10);
      ctx.moveTo(3, 0); ctx.lineTo(13, 0);
      if (v2) { ctx.moveTo(-7, -8); ctx.lineTo(8, -8); ctx.lineTo(12, -4); }
    } else if (id === 'gatling') {
      ctx.rect(-10, -5, 9, 10);
      for (let n = -1; n <= 1; n++) { ctx.moveTo(-1, n * 4); ctx.lineTo(13, n * 4); }
    } else if (id === 'guidedmissile') {
      ctx.moveTo(-12, 5); ctx.lineTo(7, -7); ctx.lineTo(13, 0); ctx.lineTo(7, 7); ctx.closePath();
    } else {
      ctx.moveTo(-13, 0); ctx.lineTo(13, 0);
      ctx.moveTo(-7, -5); ctx.lineTo(7, 5);
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

type QuickPaletteItem =
  | { type: 'header'; label: string }
  | { type: 'conduit'; label: string; cost: number }
  | { type: 'shape'; label: string; cost: number }
  | { type: 'building'; def: BuildDef };

class QuickBuildMenu {
  open = false;
  private openedAt = 0;

  private touchedThisDrag = new Set<string>();
  private buildingDragCells = new Set<string>();
  private buildingDragStartCell: { cx: number; cy: number } | null = null;
  private dragMode: 'paint' | 'erase' | null = null;
  private lastDragCell: { cx: number; cy: number } | null = null;
  private shapeDrawing = false;
  private selectedIndex = 0;
  private readonly iconRects: Array<{ index: number; x: number; y: number; w: number; h: number }> = [];

  cancel(): void {
    this.open = false;
    this.touchedThisDrag.clear();
    this.buildingDragCells.clear();
    this.buildingDragStartCell = null;
    this.dragMode = null;
    this.lastDragCell = null;
    this.shapeDrawing = false;
  }

  private conduitBrushCells(cx: number, cy: number): Array<{ cx: number; cy: number }> {
    return [
      { cx, cy },
      { cx: cx + 1, cy },
      { cx, cy: cy + 1 },
      { cx: cx + 1, cy: cy + 1 },
    ];
  }

  private buildingDragLineCells(
    from: { cx: number; cy: number },
    to: { cx: number; cy: number },
    def: BuildDef,
  ): Array<{ cx: number; cy: number }> {
    const dx = to.cx - from.cx;
    const dy = to.cy - from.cy;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const distance = horizontal ? dx : dy;
    const dir = Math.sign(distance);
    if (dir === 0) return [from];

    const gapCells = def.key === 'wall' ? 0 : 1;
    const stride = Math.max(1, def.footprintCells + gapCells);
    const count = Math.floor(Math.abs(distance) / stride);
    const cells: Array<{ cx: number; cy: number }> = [];
    for (let i = 0; i <= count; i++) {
      cells.push(horizontal
        ? { cx: from.cx + dir * stride * i, cy: from.cy }
        : { cx: from.cx, cy: from.cy + dir * stride * i });
    }
    return cells;
  }

  update(state: GameState, camera: Camera): MenuResult {
    if (!state.player.alive) {
      this.cancel();
      return { action: 'none' };
    }
    const keyDown = Input.isDown('q');
    if (keyDown && !this.open) {
      this.open = true;
      this.openedAt = performance.now() * 0.001;
      this.selectedIndex = 0;
      this.touchedThisDrag.clear();
      this.buildingDragCells.clear();
      this.buildingDragStartCell = null;
      this.dragMode = null;
      this.lastDragCell = null;
      this.shapeDrawing = false;
    } else if (!keyDown && this.open) {
      this.open = false;
      this.touchedThisDrag.clear();
      this.buildingDragCells.clear();
      this.buildingDragStartCell = null;
      this.dragMode = null;
      this.lastDragCell = null;
      this.shapeDrawing = false;
      return { action: 'none' };
    }
    if (!this.open) return { action: 'none' };

    const palette = this.paletteItems(state);
    this.normalizeSelectedIndex(palette);
    if (Input.mouse3Pressed && palette.length > 0) {
      Input.consumeMouseButton(1);
      this.selectedIndex = this.firstSelectableIndex(palette);
      Audio.playSound('menucursor', 0.22);
      return { action: 'none' };
    }
    if (Input.wheelDelta !== 0 && palette.length > 0) {
      const dir = Input.wheelDelta > 0 ? 1 : -1;
      this.selectedIndex = this.nextSelectableIndex(palette, this.selectedIndex, dir);
      Audio.playSound('menucursor', 0.22);
    }

    if (Input.mousePressed) {
      for (const r of this.iconRects) {
        if (
          Input.mousePos.x >= r.x && Input.mousePos.x <= r.x + r.w &&
          Input.mousePos.y >= r.y && Input.mousePos.y <= r.y + r.h
        ) {
          if (palette[r.index]?.type !== 'header') this.selectedIndex = r.index;
          Input.consumeMouseButton(0);
          Audio.playSound('menucursor');
          return { action: 'none' };
        }
      }
    }

    const selected = palette[this.selectedIndex];

    if (Input.mouse2Pressed && selected?.type !== 'shape') {
      this.touchedThisDrag.clear();
      this.buildingDragCells.clear();
      this.buildingDragStartCell = null;
      this.dragMode = 'erase';
      this.lastDragCell = null;
    }

    if (selected?.type !== 'shape' && (Input.mouse2Down || this.dragMode === 'erase')) {
      if (Input.mouse2Down) {
        this.dragMode = 'erase';
        const worldPos = camera.screenToWorld(Input.mousePos);
        const currentCell = worldToCell(worldPos);
        const dragCells = this.lastDragCell ? gridLineCells(this.lastDragCell, currentCell) : [currentCell];
        this.lastDragCell = currentCell;
        let soldAny = false;
        for (const dragCell of dragCells) {
          const key = cellKey(dragCell.cx, dragCell.cy);
          if (this.touchedThisDrag.has(key)) continue;
          this.touchedThisDrag.add(key);
          const cellWorld = new Vec2(
            (dragCell.cx + 0.5) * GRID_CELL_SIZE,
            (dragCell.cy + 0.5) * GRID_CELL_SIZE,
          );
          if (state.sellAtGridCell(cellWorld, Team.Player)) soldAny = true;
        }
        if (soldAny) Audio.playSound('menucursor', 0.22);
      } else {
        this.dragMode = null;
        this.touchedThisDrag.clear();
        this.lastDragCell = null;
      }
      return { action: 'none' };
    }

    if (selected?.type === 'building') {
      this.shapeDrawing = false;
      this.dragMode = null;
      this.touchedThisDrag.clear();
      if (!Input.mouseDown) {
        this.buildingDragCells.clear();
        this.buildingDragStartCell = null;
        this.lastDragCell = null;
        return { action: 'none' };
      }
      const worldPos = camera.screenToWorld(Input.mousePos);
      const cell = worldToCell(worldPos);
      if (!this.buildingDragStartCell) this.buildingDragStartCell = cell;
      const cells = this.buildingDragLineCells(this.buildingDragStartCell, cell, selected.def);
      this.lastDragCell = cell;
      for (const candidate of cells) {
        const origin = footprintOrigin(candidate.cx, candidate.cy, selected.def.footprintCells);
        const key = `${selected.def.key}:${origin.cx},${origin.cy}`;
        if (this.buildingDragCells.has(key)) continue;
        this.buildingDragCells.add(key);
        const status = state.getPlacementStatus(selected.def, candidate.cx, candidate.cy, Team.Player);
        if (status.valid) return { action: 'build', buildingType: selected.def.key, cell: candidate };
      }
      return { action: 'none' };
    }

    if (selected?.type === 'shape') {
      const worldPos = camera.screenToWorld(Input.mousePos);
      this.dragMode = Input.mouse2Down ? 'erase' : null;
      if (Input.mousePressed) {
        state.synonymous.beginShapeStroke(Team.Player, worldPos, state.gameTime);
        this.shapeDrawing = true;
      }
      if (Input.mouseDown) {
        if (!this.shapeDrawing) state.synonymous.beginShapeStroke(Team.Player, worldPos, state.gameTime);
        this.shapeDrawing = true;
        state.synonymous.addShapePoint(Team.Player, worldPos, state.gameTime);
      } else {
        this.shapeDrawing = false;
      }
      if (Input.mouse2Down) {
        state.synonymous.eraseShapeAt(Team.Player, worldPos, state.gameTime);
      }
      return { action: 'none' };
    }

    if (Input.mousePressed) {
      this.dragMode = 'paint';
      this.touchedThisDrag.clear();
      this.buildingDragCells.clear();
      this.lastDragCell = null;
    }

    if (Input.mouseDown) {
      this.dragMode = 'paint';
    } else {
      this.dragMode = null;
      this.touchedThisDrag.clear();
      this.lastDragCell = null;
    }

    if (this.dragMode !== null) {
      const worldPos = camera.screenToWorld(Input.mousePos);
      const { cx, cy } = worldToCell(worldPos);
      const currentCell = { cx, cy };
      const dragCells = this.lastDragCell ? gridLineCells(this.lastDragCell, currentCell) : [currentCell];
      this.lastDragCell = currentCell;
      for (const dragCell of dragCells) {
      const key = cellKey(dragCell.cx, dragCell.cy);
      if (this.touchedThisDrag.has(key)) continue;
        this.touchedThisDrag.add(key);
        const brush = this.conduitBrushCells(dragCell.cx, dragCell.cy);
        if (this.dragMode === 'paint') {
          for (const cell of brush) {
            if (!state.isConduitPlacementCellClear(cell.cx, cell.cy).valid) continue;
            if (state.resources >= CONDUIT_COST) {
              state.resources -= CONDUIT_COST;
              state.grid.queueConduit(cell.cx, cell.cy, Team.Player);
            }
          }
        }
      }
    }

    return { action: 'none' };
  }

  private paletteItems(state: GameState): QuickPaletteItem[] {
    const defs = availableBuildDefs(state);
    const byKey = new Map(defs.map((def) => [def.key, def]));
    const items: QuickPaletteItem[] = [];
    const addBuilding = (key: string) => {
      const def = byKey.get(key);
      if (def) items.push({ type: 'building', def });
    };

    items.push({ type: 'header', label: 'Structures' });
    addBuilding('commandpost');
    if (isSynonymousFaction(state.factionByTeam, Team.Player)) {
      items.push({ type: 'shape', label: 'Shape', cost: 0 });
    } else if (!isConfluenceFaction(state.factionByTeam, Team.Player)) {
      items.push({ type: 'conduit', label: 'Conduit', cost: CONDUIT_COST });
    }
    addBuilding('powergenerator');
    addBuilding('wall');
    addBuilding('factory');
    addBuilding('researchlab');

    items.push({ type: 'header', label: 'Turrets' });
    for (const def of defs.filter((def) => def.tier === 'turret')) {
      items.push({ type: 'building', def });
    }

    items.push({ type: 'header', label: 'Yards' });
    for (const def of defs.filter((def) => def.tier === 'yard')) {
      items.push({ type: 'building', def });
    }
    return items;
  }

  private normalizeSelectedIndex(palette: QuickPaletteItem[]): void {
    if (palette.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    if (this.selectedIndex >= palette.length) this.selectedIndex = palette.length - 1;
    if (palette[this.selectedIndex]?.type === 'header') {
      this.selectedIndex = this.nextSelectableIndex(palette, this.selectedIndex, 1);
    }
  }

  private nextSelectableIndex(palette: QuickPaletteItem[], start: number, dir: number): number {
    if (palette.length === 0) return 0;
    let idx = start;
    for (let i = 0; i < palette.length; i++) {
      idx = (idx + dir + palette.length) % palette.length;
      if (palette[idx]?.type !== 'header') return idx;
    }
    return start;
  }

  private firstSelectableIndex(palette: QuickPaletteItem[]): number {
    for (let i = 0; i < palette.length; i++) {
      if (palette[i]?.type !== 'header') return i;
    }
    return 0;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    camera: Camera,
    screenW: number,
    screenH: number,
  ): void {
    if (!this.open) return;
    const palette = this.paletteItems(state);
    this.normalizeSelectedIndex(palette);
    const worldPos = camera.screenToWorld(Input.mousePos);
    const cell = worldToCell(worldPos);
    const selected = palette[this.selectedIndex];

    if (this.dragMode === 'erase') {
      this.drawEraseCellCursor(ctx, camera, cell);
    } else if (selected?.type === 'building') {
      this.drawBuildingFootprintCursor(ctx, state, camera, cell, selected.def);
    } else if (selected?.type === 'conduit') {
      this.drawConduitBrushCursor(ctx, camera, cell, 'paint');
    }
    if (isSynonymousFaction(state.factionByTeam, Team.Player)) {
      state.synonymous.drawShapeTrails(ctx, camera, Team.Player, state.gameTime);
      if (selected?.type === 'shape' && Input.mouse2Down) this.drawShapeEraseCursor(ctx, camera, worldPos);
    }
    this.drawPalette(ctx, state, palette, screenW, screenH);

    const primaryHint = selected?.type === 'shape'
      ? '[Q] Synonymous Shape - hold LMB to draw swarm trails - hold RMB to erase'
      : selected?.type === 'building'
        ? '[Q] Quick Build - wheel/click selects - LMB places - RMB deletes building - release Q to exit'
        : `[Q] Quick Build - Conduit 2x2 brush $${CONDUIT_COST}/cell - LMB paint - RMB erase - wheel/click selects`;
    const secondaryHint =
      isSynonymousFaction(state.factionByTeam, Team.Player)
        ? `nanobots: ${state.synonymous.getUnallocatedCount(Team.Player)} ${SYNONYMOUS_CURRENCY_SYMBOL} / ${state.synonymous.totalDroneCount(Team.Player)} total - cell ${cell.cx},${cell.cy}`
        : `conduits: ${state.grid.conduitCount()} - queued: ${state.grid.pendingConduitCount()} - cell ${cell.cx},${cell.cy} - resources: $${Math.floor(state.resources)}`;
    drawMenuBanner(ctx, screenW, 18, primaryHint, secondaryHint, this.openedAt);
  }

  private drawConduitBrushCursor(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    cell: { cx: number; cy: number },
    mode: 'paint' | 'erase',
  ): void {
    const topLeft = camera.worldToScreen(cellCenter(cell.cx, cell.cy));
    const cellPx = GRID_CELL_SIZE * camera.zoom;
    const color =
      mode === 'paint'
        ? colorToCSS(Colors.radar_friendly_status, 0.85)
        : colorToCSS(Colors.alert1, 0.85);
    ctx.strokeStyle = color;
    ctx.fillStyle = mode === 'paint'
      ? colorToCSS(Colors.radar_friendly_status, 0.12)
      : colorToCSS(Colors.alert1, 0.10);
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(topLeft.x - cellPx / 2, topLeft.y - cellPx / 2, cellPx * 2, cellPx * 2);
    ctx.strokeRect(topLeft.x - cellPx / 2, topLeft.y - cellPx / 2, cellPx * 2, cellPx * 2);
    ctx.setLineDash([]);
  }

  private drawEraseCellCursor(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    cell: { cx: number; cy: number },
  ): void {
    const screen = camera.worldToScreen(cellCenter(cell.cx, cell.cy));
    const cellPx = GRID_CELL_SIZE * camera.zoom;
    ctx.fillStyle = colorToCSS(Colors.alert1, 0.10);
    ctx.strokeStyle = colorToCSS(Colors.alert1, 0.9);
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(screen.x - cellPx / 2, screen.y - cellPx / 2, cellPx, cellPx);
    ctx.strokeRect(screen.x - cellPx / 2, screen.y - cellPx / 2, cellPx, cellPx);
    ctx.setLineDash([]);
  }

  private drawBuildingFootprintCursor(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    camera: Camera,
    cell: { cx: number; cy: number },
    def: BuildDef,
  ): void {
    const center = footprintCenter(cell.cx, cell.cy, def.footprintCells);
    const screen = camera.worldToScreen(center);
    const sizePx = def.footprintCells * GRID_CELL_SIZE * camera.zoom;
    const status = state.getPlacementStatus(def, cell.cx, cell.cy, Team.Player);
    if (isConfluenceFaction(state.factionByTeam, Team.Player)) {
      const circles = state.territoryCirclesByTeam.get(Team.Player) ?? [];
      for (const c of circles) {
        const cc = camera.worldToScreen(new Vec2(c.x, c.y));
        const minR = (c.radius + CONFLUENCE_PLACEMENT_DISTANCE - CONFLUENCE_PLACEMENT_TOLERANCE) * camera.zoom;
        const maxR = (c.radius + CONFLUENCE_PLACEMENT_DISTANCE + CONFLUENCE_PLACEMENT_TOLERANCE) * camera.zoom;
        ctx.fillStyle = 'rgba(120,255,245,0.08)';
        ctx.beginPath(); ctx.arc(cc.x, cc.y, maxR, 0, Math.PI * 2); ctx.arc(cc.x, cc.y, minR, 0, Math.PI * 2, true); ctx.fill();
        ctx.strokeStyle = 'rgba(120,255,245,0.22)'; ctx.beginPath(); ctx.arc(cc.x, cc.y, maxR, 0, Math.PI * 2); ctx.stroke();
      }
      let parent = null as any;
      let best = Infinity;
      for (const c of circles) { const d=Math.hypot(center.x-c.x, center.y-c.y)-c.radius; const ad=Math.abs(d-CONFLUENCE_PLACEMENT_DISTANCE); if(ad<best){best=ad; parent=c;} }
      if (parent) {
        const p = camera.worldToScreen(new Vec2(parent.x, parent.y));
        ctx.strokeStyle = status.valid ? 'rgba(120,255,245,0.45)' : 'rgba(255,90,90,0.45)';
        ctx.setLineDash([5,4]); ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(screen.x,screen.y); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.strokeStyle = 'rgba(120,255,245,0.25)'; ctx.beginPath(); ctx.arc(screen.x, screen.y, CONFLUENCE_BASE_RADIUS*camera.zoom, 0, Math.PI*2); ctx.stroke();
    }
    const color = status.valid
      ? colorToCSS(Colors.radar_friendly_status, 0.9)
      : colorToCSS(Colors.alert1, 0.9);

    ctx.fillStyle = status.valid
      ? colorToCSS(Colors.radar_friendly_status, 0.18)
      : colorToCSS(Colors.alert1, 0.12);
    ctx.fillRect(screen.x - sizePx / 2, screen.y - sizePx / 2, sizePx, sizePx);

    // Invalid placement: diagonal cross-hatch overlay
    if (!status.valid) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(screen.x - sizePx / 2, screen.y - sizePx / 2, sizePx, sizePx);
      ctx.clip();
      ctx.strokeStyle = colorToCSS(Colors.alert1, 0.20);
      ctx.lineWidth = 1;
      ctx.beginPath();
      const stride = Math.max(8, sizePx / 8);
      for (let d = -sizePx; d <= sizePx * 2; d += stride) {
        ctx.moveTo(screen.x - sizePx / 2 + d, screen.y - sizePx / 2);
        ctx.lineTo(screen.x - sizePx / 2 + d - sizePx, screen.y + sizePx / 2);
        ctx.moveTo(screen.x - sizePx / 2 + d, screen.y - sizePx / 2);
        ctx.lineTo(screen.x - sizePx / 2 + d + sizePx, screen.y + sizePx / 2);
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(screen.x - sizePx / 2, screen.y - sizePx / 2, sizePx, sizePx);
    ctx.setLineDash([]);

    // Pulsing influence/weapon-range ring for buildings that expose one.
    const placementRange = placementRangeForBuildDef(def);
    if (placementRange > 0) {
      const t = performance.now() * 0.001;
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
      const ringR = placementRange * camera.zoom;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = status.valid
        ? colorToCSS(Colors.radar_friendly_status, 0.13 + pulse * 0.11)
        : colorToCSS(Colors.alert1, 0.10 + pulse * 0.08);
      ctx.lineWidth = def.tier === 'turret' ? 1.25 : 1;
      ctx.setLineDash(def.tier === 'turret' ? [12, 7] : [9, 7]);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    ctx.font = '10px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = color;
    const buildLabel = isPlayerSynonymous(state) && def.key === 'bomberyard' ? 'Nova Bombers' : def.label;
    ctx.fillText(`${buildLabel} ${def.footprintCells}x${def.footprintCells}`, screen.x, screen.y - sizePx / 2 - 4);
    if (!status.valid) {
      ctx.font = '20px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(status.reason, screen.x, screen.y + sizePx / 2 + 4);
    }
  }

  private drawShapeEraseCursor(ctx: CanvasRenderingContext2D, camera: Camera, worldPos: Vec2): void {
    const screen = camera.worldToScreen(worldPos);
    const radius = GRID_CELL_SIZE * 1.8 * camera.zoom;
    ctx.save();
    ctx.strokeStyle = colorToCSS(Colors.alert1, 0.9);
    ctx.fillStyle = colorToCSS(Colors.alert1, 0.08);
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawPalette(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    palette: QuickPaletteItem[],
    screenW: number,
    screenH: number,
  ): void {
    this.iconRects.length = 0;
    const x = 12;
    const y0 = 68;
    const w = 231;
    const itemH = 39;
    const headerH = 28;
    const gap = 5;
    ctx.save();
    const contentH = palette.reduce((sum, item) => sum + (item.type === 'header' ? headerH : itemH) + gap, 0);
    const panelH = Math.max(1, contentH) + 12;
    fillMenuPanel(ctx, x - 8, y0 - 10, w + 16, panelH);
    ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let y = y0;
    for (let i = 0; i < palette.length; i++) {
      const item = palette[i];
      if (item.type === 'header') {
        ctx.fillStyle = colorToCSS(Colors.alert2, 0.85);
        drawDecodedText(ctx, item.label, x + 8, y + headerH * 0.56, 15, this.openedAt);
        y += headerH + gap;
        continue;
      }
      const selected = i === this.selectedIndex;
      const cost = item.type === 'conduit' || item.type === 'shape' ? item.cost : buildCostForState(item.def.key, item.def.cost, state);
      const label = item.type === 'conduit'
        ? item.label
        : item.type === 'shape'
          ? item.label
        : `${isPlayerSynonymous(state) && item.def.key === 'bomberyard' ? 'Nova Bombers' : item.def.label} ${item.def.footprintCells}x${item.def.footprintCells}`;
      this.iconRects.push({ index: i, x, y, w, h: itemH });
      drawMenuRow(ctx, x, y, w, itemH, selected, false);
      ctx.fillStyle = item.type === 'shape' || canAffordAmount(cost, state)
        ? colorToCSS(Colors.general_building, selected ? 1.0 : 0.82)
        : colorToCSS(Colors.alert1, 0.7);
      drawDecodedText(ctx, label, x + 8, y + itemH * 0.5, 15, this.openedAt);
      ctx.textAlign = 'right';
      const price = item.type === 'shape' ? 'free' : formatCost(cost, state);
      ctx.font = usesSynonymousSymbol(price) ? `15px ${MENU_CANVAS_FONT}` : '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      if (usesSynonymousSymbol(price)) ctx.fillText(price, x + w - 8, y + itemH * 0.5);
      else drawDecodedText(ctx, price, x + w - 8, y + itemH * 0.5, 15, this.openedAt, 'right');
      ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      y += itemH + gap;
    }
    ctx.restore();

    // Description tooltip for selected palette item
    const selectedRect = this.iconRects.find((r) => r.index === this.selectedIndex);
    if (selectedRect) {
      const selected = palette[this.selectedIndex];
      let description: string | undefined;
      if (selected?.type === 'building') {
        description = selected.def.description;
      } else if (selected?.type === 'conduit') {
        description = 'Connects buildings to your power network. LMB to paint cells, RMB to erase.';
      } else if (selected?.type === 'shape') {
        description = 'Synonymous swarm formation. LMB draws trails for free nanobots to cover; RMB erases trails.';
      }
      if (description) {
        const panelRightX = x - 8 + w + 16; // right edge of the palette panel
        drawDescriptionBox(ctx, description, panelRightX, selectedRect.y + selectedRect.h / 2, screenW, screenH);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ActionMenu — public façade, same shape as the original so game.ts is minimal
// ---------------------------------------------------------------------------

export class ActionMenu {
  private shipMenu     = new ShipMenu();
  private researchMenu = new LeftHoldMenu('x', buildResearchRoot, '[X] Research', true);
  private paintMenu    = new QuickBuildMenu();

  /** True when any of the four hold menus / paint mode is currently open. */
  open = false;

  /**
   * PR3: when the Q-hold paint mode is active, `placementMode` is true and
   * `placementType` is set to 'conduit'. Game.updatePlayerFiring() already
   * gates fire on `placementMode`, so the LMB used to paint won't fire.
   * Also true during pending building placement so LMB places the building
   * rather than firing a weapon.
   */
  placementMode = false;
  placementType: string | null = null;

  update(state: GameState, camera: Camera): MenuResult {
    // Paint mode runs first so it consumes mouse-down before radial menus see it.
    const paintResult = this.paintMenu.update(state, camera);
    const paintOpen = this.paintMenu.open;

    this.placementMode = paintOpen;
    this.placementType = paintOpen ? 'conduit' : null;

    // Radial menus are mutually exclusive with paint mode.
    let rr: MenuResult = { action: 'none' };
    let shipOpen = false;
    if (!paintOpen) {
      shipOpen = this.shipMenu.update(state, camera);
      rr = this.researchMenu.update(state, camera);
    }

    // Intercept build results — enter placement mode instead of placing immediately.
    this.open =
      paintOpen ||
      shipOpen ||
      this.researchMenu.open;

    if (paintResult.action !== 'none') return paintResult;
    if (rr.action !== 'none') return rr;
    return { action: 'none' };
  }

  draw(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    camera: Camera,
    screenW: number,
    screenH: number,
  ): void {
    this.shipMenu.draw(ctx, state, camera, screenW, screenH);
    this.researchMenu.draw(ctx, state, screenW, screenH);
    this.paintMenu.draw(ctx, state, camera, screenW, screenH);
  }

}

