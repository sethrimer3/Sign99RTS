/**
 * Overlay and glow-layer drawing helpers extracted from game.ts.
 *
 * Most functions are stateless. drawScreenOverlays updates its mutable cache,
 * and drawBuildingHoverHitpoints retains per-building textbox fade values.
 */

import { Vec2 } from './math.js';
import { Input } from './input.js';
import { Camera } from './camera.js';
import { Colors, TextColors, colorToCSS } from './colors.js';
import { Team, EntityType } from './entities.js';
import type { GameState } from './gamestate.js';
import { BuildingBase, Wall } from './building.js';
import { TurretBase } from './turret.js';
import { FighterShip, BomberShip, SynonymousNovaBomberShip } from './fighter.js';
import { Laser, ChargedLaserBurst, GuidedMissile, BomberMissile, SwarmMissile, MassDriverBullet, GatlingBullet, GatlingTurretBullet } from './projectile.js';
import { GlowLayer } from './glowlayer.js';
import { footprintForBuilding, footprintForBuildingType } from './buildingfootprint.js';
import { SHIP_STATS, COMMANDPOST_BUILD_RADIUS, POWERGENERATOR_COVERAGE_RADIUS } from './constants.js';
import { GRID_CELL_SIZE } from './grid.js';
import { WORLD_WIDTH } from './constants.js';
import type { VisualQualityPreset } from './visualquality.js';
import { buildingBlocksShips, buildingFootprintOrigin } from './buildingCollision.js';
import { t } from './i18n.js';
import type { PlayerRespawnRuntime } from './respawnRuntime.js';
import type { GhostShipEffect } from './ghostShipEffect.js';

// ---------------------------------------------------------------------------
// Overlay cache — holds canvas gradients/patterns that are rebuilt only when
// the canvas dimensions change.
// ---------------------------------------------------------------------------

export interface OverlayCache {
  overlayW: number;
  overlayH: number;
  vignetteGradient: CanvasGradient | null;
  flashGradient: CanvasGradient | null;
  fringeGradientL: CanvasGradient | null;
  fringeGradientR: CanvasGradient | null;
  scanlinePattern: CanvasPattern | null;
}

export function createOverlayCache(): OverlayCache {
  return {
    overlayW: 0,
    overlayH: 0,
    vignetteGradient: null,
    flashGradient: null,
    fringeGradientL: null,
    fringeGradientR: null,
    scanlinePattern: null,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function speedGlowFactor(speed: number, maxSpeed: number): number {
  const normalized = maxSpeed > 0 ? Math.min(1, Math.max(0, speed / maxSpeed)) : 0;
  return 0.1 + normalized * 0.9;
}

function fighterMaxSpeed(fighter: FighterShip): number {
  return fighter instanceof BomberShip || fighter instanceof SynonymousNovaBomberShip
    ? SHIP_STATS.bomber.speed
    : SHIP_STATS.fighter.speed;
}

interface BuildingHealthTextFade {
  alpha: number;
  startAlpha: number;
  elapsed: number;
  directlyHovered: boolean;
}

const buildingHealthTextFades = new Map<number, BuildingHealthTextFade>();
const BUILDING_HEALTH_HOVER_ALPHA = 0.8;
const BUILDING_HEALTH_HOVER_FADE_SECONDS = 0.3;

// ---------------------------------------------------------------------------
// Public drawing functions
// ---------------------------------------------------------------------------

export function buildingEffectRange(building: BuildingBase): number {
  if (building instanceof TurretBase) return building.range;
  if (building.type === EntityType.CommandPost) return COMMANDPOST_BUILD_RADIUS;
  if (building.type === EntityType.PowerGenerator) return POWERGENERATOR_COVERAGE_RADIUS;
  return 0;
}

export function drawGhostSpectator(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  state: GameState,
  runtime: PlayerRespawnRuntime,
): void {
  if (state.player.alive || !runtime.ghostPos) return;
  runtime.ghostEffect.draw(ctx, camera);
}

export function drawLossOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  playerLoss: boolean,
): void {
  if (!playerLoss) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 42px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
  ctx.shadowColor = colorToCSS(Colors.alert1, 0.8);
  ctx.shadowBlur = 18;
  ctx.fillStyle = colorToCSS(Colors.alert1, 0.95);
  ctx.fillText(t('overlay.loss'), w * 0.5, 18);
  ctx.restore();
}

export function drawMergedShipBlockerOutlines(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  state: GameState,
): void {
  const blockers = state.buildings.filter((b) =>
    b.alive && b.buildProgress >= 1 && buildingBlocksShips(b),
  );
  if (blockers.length === 0) return;

  const cells = new Set<string>();
  const entries: Array<{ x: number; y: number; team: Team; shielded: boolean }> = [];
  for (const building of blockers) {
    const size = footprintForBuilding(building);
    const origin = buildingFootprintOrigin(building);
    const originX = origin.cx;
    const originY = origin.cy;
    for (let y = originY; y < originY + size; y++) {
      for (let x = originX; x < originX + size; x++) {
        cells.add(`${building.team}:${x},${y}`);
        entries.push({
          x,
          y,
          team: building.team,
          shielded: building instanceof Wall && building.maxShield > 0,
        });
      }
    }
  }

  const pulse = 0.6 + 0.4 * Math.sin(state.gameTime * 5);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'square';
  for (const e of entries) {
    const wx = e.x * GRID_CELL_SIZE;
    const wy = e.y * GRID_CELL_SIZE;
    const p1 = camera.worldToScreen(new Vec2(wx, wy));
    const p2 = camera.worldToScreen(new Vec2(wx + GRID_CELL_SIZE, wy + GRID_CELL_SIZE));
    const left = p1.x, top = p1.y, right = p2.x, bottom = p2.y;
    const color = e.shielded ? Colors.radar_friendly_status : Colors.powergenerator_detail;
    ctx.strokeStyle = colorToCSS(e.team === Team.Enemy ? Colors.enemyfire : color, 0.58 + pulse * 0.22);
    ctx.beginPath();
    if (!cells.has(`${e.team}:${e.x},${e.y - 1}`)) { ctx.moveTo(left, top); ctx.lineTo(right, top); }
    if (!cells.has(`${e.team}:${e.x + 1},${e.y}`)) { ctx.moveTo(right, top); ctx.lineTo(right, bottom); }
    if (!cells.has(`${e.team}:${e.x},${e.y + 1}`)) { ctx.moveTo(right, bottom); ctx.lineTo(left, bottom); }
    if (!cells.has(`${e.team}:${e.x - 1},${e.y}`)) { ctx.moveTo(left, bottom); ctx.lineTo(left, top); }
    ctx.stroke();
  }
  ctx.restore();
}

export function drawCommandModeOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  camera: Camera,
  state: GameState,
  commandSelectedFighters: Set<number>,
  commandSelectedTurrets: Set<number>,
  commandDragStart: Vec2 | null,
  commandDragCurrent: Vec2 | null,
): void {
  const active = Input.isDown('c');
  if (!active && commandSelectedFighters.size === 0 && commandSelectedTurrets.size === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const f of state.fighters) {
    if (!commandSelectedFighters.has(f.id) || !f.alive) continue;
    const p = camera.worldToScreen(f.position);
    const br = Math.max(10, f.radius * camera.zoom * 1.55);
    const arm = br * 0.44;
    ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, active ? 0.9 : 0.45);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    // top-left
    ctx.moveTo(p.x - br + arm, p.y - br); ctx.lineTo(p.x - br, p.y - br); ctx.lineTo(p.x - br, p.y - br + arm);
    // top-right
    ctx.moveTo(p.x + br - arm, p.y - br); ctx.lineTo(p.x + br, p.y - br); ctx.lineTo(p.x + br, p.y - br + arm);
    // bottom-left
    ctx.moveTo(p.x - br, p.y + br - arm); ctx.lineTo(p.x - br, p.y + br); ctx.lineTo(p.x - br + arm, p.y + br);
    // bottom-right
    ctx.moveTo(p.x + br, p.y + br - arm); ctx.lineTo(p.x + br, p.y + br); ctx.lineTo(p.x + br - arm, p.y + br);
    ctx.stroke();
  }
  for (const b of state.buildings) {
    if (!commandSelectedTurrets.has(b.id) || !b.alive || !(b instanceof TurretBase)) continue;
    const p = camera.worldToScreen(b.position);
    const s = footprintForBuilding(b) * GRID_CELL_SIZE * camera.zoom;
    ctx.strokeStyle = colorToCSS(Colors.alert2, active ? 0.9 : 0.45);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x - s * 0.58, p.y - s * 0.58, s * 1.16, s * 1.16);
    if (b.commandTarget?.alive) {
      const t = camera.worldToScreen(b.commandTarget.position);
      ctx.strokeStyle = colorToCSS(Colors.alert1, 0.42);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
    }
  }
  if (active && commandDragStart && commandDragCurrent) {
    const x = Math.min(commandDragStart.x, commandDragCurrent.x);
    const y = Math.min(commandDragStart.y, commandDragCurrent.y);
    const rw = Math.abs(commandDragStart.x - commandDragCurrent.x);
    const rh = Math.abs(commandDragStart.y - commandDragCurrent.y);
    ctx.globalCompositeOperation = 'source-over';
    // Semi-transparent fill
    ctx.fillStyle = colorToCSS(Colors.radar_friendly_status, 0.07);
    ctx.fillRect(x, y, rw, rh);
    // Corner brackets instead of a plain outline
    const arm = Math.min(rw * 0.25, rh * 0.25, 18);
    ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, 0.90);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    // Top-left
    ctx.moveTo(x + arm, y); ctx.lineTo(x, y); ctx.lineTo(x, y + arm);
    // Top-right
    ctx.moveTo(x + rw - arm, y); ctx.lineTo(x + rw, y); ctx.lineTo(x + rw, y + arm);
    // Bottom-left
    ctx.moveTo(x, y + rh - arm); ctx.lineTo(x, y + rh); ctx.lineTo(x + arm, y + rh);
    // Bottom-right
    ctx.moveTo(x + rw - arm, y + rh); ctx.lineTo(x + rw, y + rh); ctx.lineTo(x + rw, y + rh - arm);
    ctx.stroke();
    // Subtle dashed border connecting the brackets
    ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, 0.28);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, rw - 1), Math.max(0, rh - 1));
    ctx.setLineDash([]);
  }
  if (active) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = 'bold 15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colorToCSS(Colors.radar_friendly_status, 0.82);
    ctx.fillText(t('overlay.commandMode'), w * 0.5, 58);
  }
  ctx.restore();
}

export function drawBuildingHoverHitpoints(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  state: GameState,
  frameDt: number,
): void {
  const world = camera.screenToWorld(Input.mousePos);
  const fadeRadius = GRID_CELL_SIZE * 6;
  const maxOverlayAlpha = 0.3;
  const liveBuildingIds = new Set<number>();

  for (const b of state.buildings) {
    if (!b.alive) continue;
    liveBuildingIds.add(b.id);
    const d = Math.hypot(world.x - b.position.x, world.y - b.position.y);
    if (d > fadeRadius) {
      buildingHealthTextFades.delete(b.id);
      continue;
    }

    const hoverAlpha = maxOverlayAlpha * (1 - d / fadeRadius);
    const footprintHalfSize = footprintForBuilding(b) * GRID_CELL_SIZE * 0.5;
    const directlyHovered = Math.abs(world.x - b.position.x) <= footprintHalfSize
      && Math.abs(world.y - b.position.y) <= footprintHalfSize;
    const targetTextAlpha = directlyHovered ? BUILDING_HEALTH_HOVER_ALPHA : hoverAlpha;
    let fade = buildingHealthTextFades.get(b.id);
    if (!fade) {
      fade = { alpha: hoverAlpha, startAlpha: hoverAlpha, elapsed: 0, directlyHovered };
      buildingHealthTextFades.set(b.id, fade);
    } else if (fade.directlyHovered !== directlyHovered) {
      fade.startAlpha = fade.alpha;
      fade.elapsed = 0;
      fade.directlyHovered = directlyHovered;
    }
    fade.elapsed = Math.min(BUILDING_HEALTH_HOVER_FADE_SECONDS, fade.elapsed + Math.max(0, frameDt));
    const fadeProgress = fade.elapsed / BUILDING_HEALTH_HOVER_FADE_SECONDS;
    fade.alpha = fade.startAlpha + (targetTextAlpha - fade.startAlpha) * fadeProgress;
    const textAlpha = fade.alpha;
    const screen = camera.worldToScreen(b.position);
    const range = buildingEffectRange(b);
    const tint = b.team === Team.Player ? Colors.radar_friendly_status : Colors.enemyfire;

    // Warm outline around building base when hovered
    const warmColor = b.team === Team.Player ? Colors.building_glow_power : Colors.building_glow_shipyard;
    const baseSize = footprintForBuilding(b) * GRID_CELL_SIZE * camera.zoom;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = colorToCSS(warmColor, 0.45 * hoverAlpha);
    ctx.lineWidth = 2;
    ctx.strokeRect(screen.x - baseSize * 0.5, screen.y - baseSize * 0.5, baseSize, baseSize);
    ctx.restore();
    if (range > 0) {
      const radius = range * camera.zoom;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = colorToCSS(tint, 0.08 * hoverAlpha);
      ctx.strokeStyle = colorToCSS(tint, hoverAlpha);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    const text = `${Math.ceil(b.health)}/${Math.ceil(b.maxHealth)}`;
    const shieldText = b instanceof Wall && b.maxShield > 0
      ? `${Math.ceil(b.shield)}/${Math.ceil(b.maxShield)}`
      : '';
    ctx.save();
    ctx.font = 'bold 14px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const metrics = ctx.measureText(shieldText || text);
    const padX = 8;
    const boxW = metrics.width + padX * 2;
    const boxH = shieldText ? 38 : 22;
    const x = screen.x;
    const y = screen.y - b.radius * camera.zoom - 18;
    ctx.fillStyle = colorToCSS(Colors.friendly_background, textAlpha * 0.72);
    ctx.strokeStyle = colorToCSS(tint, textAlpha);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - boxW / 2, y - boxH / 2, boxW, boxH, 4);
    ctx.fill();
    ctx.stroke();
    if (shieldText) {
      ctx.fillStyle = colorToCSS(Colors.radar_friendly_status, textAlpha);
      ctx.fillText(shieldText, x, y - 8);
      ctx.fillStyle = colorToCSS(b.team === Team.Enemy ? Colors.enemyfire : Colors.general_building, textAlpha);
      ctx.fillText(text, x, y + 10);
    } else {
      ctx.fillStyle = colorToCSS(b.team === Team.Enemy ? Colors.enemyfire : Colors.general_building, textAlpha);
      ctx.fillText(text, x, y + 1);
    }
    ctx.restore();
  }

  for (const id of buildingHealthTextFades.keys()) {
    if (!liveBuildingIds.has(id)) buildingHealthTextFades.delete(id);
  }
}

/** Projectile count above which bullet glow begins to be decimated. */
const BULLET_GLOW_DECIMATION_THRESHOLD = 80;

export function drawGlowLayer(
  glow: GlowLayer,
  camera: Camera,
  state: GameState,
  visualPreset: VisualQualityPreset,
  renderLoadScale: number = 1.0,
  ghost?: GhostShipEffect,
): void {
  if (!visualPreset.glowEnabled) return;

  // Compute adaptive glow budget — reduce lower-priority effects first
  // Max primitives scales with renderLoadScale (healthy=600, stressed=200)
  const maxGlowPrimitives = Math.round(200 + renderLoadScale * 400);
  glow.beginFrame(maxGlowPrimitives);

  // Priority 1: Explosion glows — always draw (high visual importance)
  for (const fire of state.explosionGlows) {
    if (!camera.isOnScreen(fire.center, fire.radius * 1.7)) continue;
    const t = 1 - fire.lifeSeconds / fire.totalSeconds;
    const fade = Math.max(0, 1 - t);
    const bloom = fire.intensity * fade;
    glow.circleWorld(camera, fire.center, fire.radius * 1.45, Colors.alert1, 0.12 * bloom);
    glow.circleWorld(camera, fire.center, fire.radius * 1.12, Colors.particles_ember, 0.18 * bloom);
    glow.circleWorld(camera, fire.center, fire.radius * 1.08, Colors.explosion, 0.22 * bloom);
    glow.circleWorld(camera, fire.center, fire.radius * 0.48, Colors.alert2, 0.28 * bloom);
    glow.circleWorld(camera, fire.center, Math.max(10, fire.radius * 0.18), Colors.particles_nova, 0.24 * bloom);
  }

  // Priority 2: Lasers and other major projectile glows
  for (const p of state.projectiles) {
    if (!p.alive || !camera.isOnScreen(p.position, 180)) continue;
    if (p instanceof Laser || p instanceof ChargedLaserBurst) {
      const target = p.targetPos;
      const color = p.team === Team.Player ? Colors.friendlyfire : Colors.enemyfire;
      const alpha = p instanceof ChargedLaserBurst ? 0.34 + p.chargeFraction * 0.2 : 0.22;
      const width = p instanceof ChargedLaserBurst ? 18 + p.chargeFraction * 22 : 10;
      glow.lineWorld(camera, p.position, target, color, alpha, width);
      glow.circleWorld(camera, target, p instanceof ChargedLaserBurst ? 18 : 8, Colors.particles_switch, alpha * 0.65);
    } else if (p instanceof GuidedMissile || p instanceof BomberMissile || p instanceof SwarmMissile) {
      const blastRadius = 'blastRadius' in p ? (p as { blastRadius: number }).blastRadius : 0;
      if (blastRadius > 0) {
        glow.circleWorld(camera, p.position, Math.min(34, blastRadius * 0.24), Colors.explosion, 0.10);
        glow.circleWorld(camera, p.position, Math.min(18, blastRadius * 0.12), Colors.alert2, 0.12);
      }
      const exhaust = p.position.add(new Vec2(Math.cos(p.angle + Math.PI) * p.radius, Math.sin(p.angle + Math.PI) * p.radius));
      glow.circleWorld(camera, exhaust, p.radius * 2.8, Colors.missile_trail, 0.22);
      glow.circleWorld(camera, exhaust, p.radius * 4.8, Colors.explosion, 0.09);
      glow.circleWorld(camera, exhaust, p.radius * 1.5, Colors.particles_nova, 0.15);
    } else {
      const blastRadius = 'blastRadius' in p ? (p as { blastRadius: number }).blastRadius : 0;
      if (blastRadius > 0) {
        glow.circleWorld(camera, p.position, Math.min(40, blastRadius * 0.32), Colors.explosion, 0.12);
        glow.circleWorld(camera, p.position, Math.min(20, blastRadius * 0.16), Colors.alert2, 0.14);
      }
    }
  }

  // Priority 3: Player ship glows (always draw — player experience critical)
  // The dead player's spirit ship is their avatar while spectating, so it shares this tier.
  if (ghost && !state.player.alive) ghost.drawGlow(glow, camera);
  for (const ship of state.playerShips.values()) {
    if (!ship.alive || !camera.isOnScreen(ship.position, 220)) continue;
    const r = ship.radius;
    if (ship.isBoosting || ship.gatlingOverdriveTimer > 0) {
      glow.circleWorld(camera, ship.position, r * 2.9, Colors.alert2, 0.11);
    }
    if (ship.gatlingOverheatTimer > 0) {
      glow.circleWorld(camera, ship.position, r * 3.1, Colors.alert1, 0.12);
    }
    if (ship.shieldUnlocked && ship.shield > 0) {
      glow.circleWorld(camera, ship.position, r * 1.8, Colors.radar_allied_status, 0.10, false, 5);
    }
    if (visualPreset.engineGlow) {
      const speedFactor = speedGlowFactor(Math.hypot(ship.velocity.x, ship.velocity.y), ship.effectiveMaxSpeed * 1.8);
      // Use warm orange/yellow for engine glow to match the warm thrust particles.
      const exhaustAlpha = (ship.isBoosting ? 0.30 : 0.18) * speedFactor;
      glow.circleWorld(camera, ship.position, r * 2.6 * speedFactor, Colors.thrust_warm_orange, exhaustAlpha);
      glow.circleWorld(camera, ship.position, r * 1.3, Colors.thrust_core_hot, exhaustAlpha * 0.38);
      if (ship.isBoosting) {
        // Extra outer bloom during overburn
        glow.circleWorld(camera, ship.position, r * 4.2 * speedFactor, Colors.thrust_burnt_orange, 0.10);
      }
    }
  }

  // Priority 4: Building glows — skip decorative glows when budget is stressed
  // Under load (renderLoadScale < 0.7), skip per-type ambient glows; always draw status glows
  const drawBuildingAmbient = renderLoadScale >= 0.65;
  for (const b of state.buildings) {
    if (!b.alive || b.buildProgress < 1 || !camera.isOnScreen(b.position, 180)) continue;
    const powered = b.type === EntityType.CommandPost || b.type === EntityType.PowerGenerator || b.powered;
    if (!powered) continue;
    const friendly = b.team === Team.Player;
    const color = friendly ? Colors.radar_friendly_status : Colors.enemyfire;
    const pulse = 0.75 + 0.25 * Math.sin(state.gameTime * 2.2 + b.id * 0.37);
    glow.circleWorld(camera, b.position, b.radius * 1.9, color, 0.035 * pulse);

    if (drawBuildingAmbient) {
      if (b.type === EntityType.PowerGenerator) {
        glow.circleWorld(camera, b.position, b.radius * 2.4, Colors.building_glow_power, 0.055 * pulse);
        glow.circleWorld(camera, b.position, b.radius * 1.2, Colors.building_glow_power, 0.10 * pulse);
      } else if (b.type === EntityType.ResearchLab) {
        glow.circleWorld(camera, b.position, b.radius * 2.0, Colors.building_glow_research, 0.042 * pulse);
      } else if (b.type === EntityType.Factory) {
        glow.circleWorld(camera, b.position, b.radius * 1.8, Colors.building_glow_factory, 0.048 * pulse);
      } else if (b.type === EntityType.FighterYard || b.type === EntityType.BomberYard || b.type === EntityType.SwarmYard) {
        glow.circleWorld(camera, b.position, b.radius * 2.1, Colors.building_glow_shipyard, 0.038 * pulse);
      } else if (b.type === EntityType.CommandPost) {
        glow.circleWorld(camera, b.position, b.radius * 2.8, color, 0.028 * pulse);
      }

      if (
        b.type === EntityType.GatlingTurret ||
        b.type === EntityType.MissileTurret ||
        b.type === EntityType.TimeBomb ||
        b.type === EntityType.ExciterTurret ||
        b.type === EntityType.MassDriverTurret ||
        b.type === EntityType.RegenTurret ||
        b.type === EntityType.TetherTurret
      ) {
        glow.circleWorld(camera, b.position, b.radius * 1.25, color, 0.045 * pulse, false, 2);
      }
    }
  }

  // Priority 5: Fighter engine glow — cap per-frame count based on load
  // Under load, skip far fighters; always draw near-screen fighters
  if (visualPreset.engineGlow) {
    // Max fighter engine glow draws: 60 healthy, fewer under stress
    const maxFighterGlow = Math.round(20 + renderLoadScale * 40);
    let fighterGlowDrawn = 0;
    for (const f of state.fighters) {
      if (!f.alive || f.docked || !camera.isOnScreen(f.position, 60)) continue;
      if (fighterGlowDrawn >= maxFighterGlow) break;
      const r = f.radius;
      const speed = Math.hypot(f.velocity.x, f.velocity.y);
      const speedFactor = speedGlowFactor(speed, fighterMaxSpeed(f));
      // Warm orange glow matches the warm exhaust particles emitted by fighters.
      glow.circleWorld(camera, f.position, r * 2.8 * speedFactor, Colors.thrust_warm_orange, 0.14 * speedFactor);
      glow.circleWorld(camera, f.position, r * 1.2, Colors.thrust_core_hot, 0.06 * speedFactor);
      fighterGlowDrawn++;
    }
  }

  // Priority 6: Bullet glow — decimate based on projectile count and load
  if (visualPreset.bulletGlow) {
    // Determine how many bullet glows to draw: full at low count, decimated at high count
    const projectileCount = state.projectiles.length;
    // At renderLoadScale=1 draw all; at 0.35 draw ~35%; also decimate for large bullet counts
    const bulletLoadFactor = renderLoadScale * Math.min(1, BULLET_GLOW_DECIMATION_THRESHOLD / Math.max(1, projectileCount));
    // Draw every Nth bullet based on load
    const drawEveryN = bulletLoadFactor >= 0.9 ? 1 : bulletLoadFactor >= 0.5 ? 2 : 3;
    let bulletIdx = 0;

    for (const p of state.projectiles) {
      if (!p.alive || !camera.isOnScreen(p.position, 26)) continue;
      if (p instanceof Laser || p instanceof ChargedLaserBurst) continue;
      if (p instanceof MassDriverBullet) continue;
      if (p instanceof GuidedMissile || p instanceof BomberMissile || p instanceof SwarmMissile) continue;

      bulletIdx++;
      if (bulletIdx % drawEveryN !== 0) continue;

      const lifeProgress = p.maxLifetime > 0 ? Math.min(1, Math.max(0, 1 - p.lifetime / p.maxLifetime)) : 1;
      if (lifeProgress <= 0.02) continue;

      let bulletColor: typeof Colors.friendlyfire;
      if (p instanceof GatlingBullet) {
        bulletColor = p.team === Team.Player ? Colors.bullet_player_gatling : Colors.bullet_enemy_gatling;
      } else if (p instanceof GatlingTurretBullet) {
        bulletColor = p.team === Team.Player ? Colors.bullet_player_turret : Colors.bullet_enemy_turret;
      } else {
        bulletColor = p.team === Team.Player ? Colors.bullet_player_cannon : Colors.bullet_enemy_cannon;
      }

      const speed = Math.hypot(p.velocity.x, p.velocity.y);
      const speedFactor = Math.min(1, speed / 520);
      const screen = camera.worldToScreen(p.position);
      const zoom = camera.zoom;
      const glowFactor = lifeProgress * lifeProgress;
      const trailLen = p.radius * (7.5 + speedFactor * 7.5) * zoom * glowFactor;
      const tail = new Vec2(
        screen.x - Math.cos(p.angle) * trailLen,
        screen.y - Math.sin(p.angle) * trailLen,
      );
      glow.lineScreen(tail, screen, bulletColor, (0.045 + speedFactor * 0.06) * glowFactor, p.radius * (2.8 + speedFactor * 1.5) * zoom * glowFactor);
      glow.circleScreen(screen, p.radius * (5.2 + speedFactor * 1.6) * zoom * glowFactor, bulletColor, (0.055 + speedFactor * 0.03) * glowFactor);
      glow.circleScreen(screen, p.radius * (2.1 + speedFactor * 0.4) * zoom * glowFactor, Colors.particles_switch, 0.06 * glowFactor);
    }
  }
}

export function drawScreenOverlays(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  camera: Camera,
  visualPreset: VisualQualityPreset,
  damageFlashTimer: number,
  cache: OverlayCache,
): void {
  if (cache.overlayW !== w || cache.overlayH !== h || !cache.vignetteGradient) {
    cache.overlayW = w;
    cache.overlayH = h;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const outerR = Math.hypot(cx, cy);
    cache.vignetteGradient = ctx.createRadialGradient(cx, cy, outerR * 0.54, cx, cy, outerR);
    cache.vignetteGradient.addColorStop(0.0, 'rgba(0,0,0,0)');
    cache.vignetteGradient.addColorStop(1.0, 'rgba(0,0,0,0.42)');

    // Flash gradient — cached at full alpha; actual alpha applied via globalAlpha.
    cache.flashGradient = ctx.createRadialGradient(cx, cy, outerR * 0.35, cx, cy, outerR * 1.05);
    cache.flashGradient.addColorStop(0, 'rgba(255,0,0,0)');
    cache.flashGradient.addColorStop(1, 'rgba(255,0,0,1)');

    // Color-fringe gradients — cached since they are static strips.
    const fringeW = Math.round(w * 0.12);
    cache.fringeGradientL = ctx.createLinearGradient(0, 0, fringeW, 0);
    cache.fringeGradientL.addColorStop(0, 'rgba(255,30,0,0.055)');
    cache.fringeGradientL.addColorStop(1, 'rgba(255,30,0,0)');
    cache.fringeGradientR = ctx.createLinearGradient(w, 0, w - fringeW, 0);
    cache.fringeGradientR.addColorStop(0, 'rgba(0,60,255,0.045)');
    cache.fringeGradientR.addColorStop(1, 'rgba(0,60,255,0)');
  }

  const territory = Math.max(-1, Math.min(1, camera.position.x / (WORLD_WIDTH * 0.42)));
  ctx.save();
  ctx.fillStyle = territory >= 0
    ? `rgba(255,70,34,${0.018 + territory * 0.022})`
    : `rgba(50,190,210,${0.018 + -territory * 0.018})`;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = cache.vignetteGradient!;
  ctx.fillRect(0, 0, w, h);

  // Damage flash — red vignette that fades quickly after the player is hit.
  if (damageFlashTimer > 0 && cache.flashGradient) {
    const flashAlpha = Math.min(1, damageFlashTimer / 0.35) * 0.38;
    ctx.globalAlpha = flashAlpha;
    ctx.fillStyle = cache.flashGradient;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  // Color fringe — subtle lens-distortion color split at the screen edges.
  if (visualPreset.colorFringe && cache.fringeGradientL && cache.fringeGradientR) {
    const fringeW = Math.round(w * 0.12);
    ctx.fillStyle = cache.fringeGradientL;
    ctx.fillRect(0, 0, fringeW, h);
    ctx.fillStyle = cache.fringeGradientR;
    ctx.fillRect(w - fringeW, 0, fringeW, h);
  }

  if (visualPreset.scanlines) {
    if (!cache.scanlinePattern) {
      const p = document.createElement('canvas');
      p.width = 1;
      p.height = 4;
      const pctx = p.getContext('2d')!;
      pctx.fillStyle = 'rgba(255,255,255,0.035)';
      pctx.fillRect(0, 0, 1, 1);
      cache.scanlinePattern = ctx.createPattern(p, 'repeat');
    }
    if (cache.scanlinePattern) {
      ctx.fillStyle = cache.scanlinePattern;
      ctx.fillRect(0, 0, w, h);
    }
  }
  ctx.restore();
}
