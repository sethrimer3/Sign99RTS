/** Radar system for Sign99 — edge indicators and full-screen overlay */

import { Vec2, clamp } from './math.js';
import { Camera } from './camera.js';
import { Colors, colorToCSS, Color } from './colors.js';
import { Entity, Team, EntityType, ShipGroup } from './entities.js';
import { GameState } from './gamestate.js';
import type { ShipCommandGroup, WaypointMarker } from './gameRender.js';

const EDGE_MARGIN = 20;
const INDICATOR_MIN_SIZE = 4;
const INDICATOR_MAX_SIZE = 10;
const RADAR_RANGE = 4000;

const GROUP_COLORS: Record<ShipGroup, Color> = {
  [ShipGroup.Red]: Colors.redgroup,
  [ShipGroup.Green]: Colors.greengroup,
  [ShipGroup.Blue]: Colors.bluegroup,
};

const RADAR_BACKGROUND = 'rgba(1, 18, 7, 0.84)';
const RADAR_FRIENDLY_FILL = 'rgba(184, 255, 184, 0.86)';
const RADAR_FRIENDLY_STROKE = 'rgba(0, 210, 82, 0.98)';
const RADAR_ENEMY_FILL = 'rgba(255, 185, 185, 0.86)';
const RADAR_ENEMY_STROKE = 'rgba(205, 12, 34, 0.98)';
const RADAR_PLAYER_FILL = 'rgba(208, 255, 208, 0.96)';
const RADAR_PLAYER_STROKE = 'rgba(0, 255, 112, 1)';
const RADAR_EDGE_GLOW = 'rgba(150, 255, 184, 0.35)';

// ---------------------------------------------------------------------------
// Edge Indicators (always active)
// ---------------------------------------------------------------------------

/** Clamp a world-space entity position to the screen edge for off-screen indicators. */
function clampToEdge(
  screenPos: Vec2,
  screenW: number,
  screenH: number,
): { x: number; y: number; offScreen: boolean } {
  const margin = EDGE_MARGIN;
  const onScreen =
    screenPos.x >= margin &&
    screenPos.x <= screenW - margin &&
    screenPos.y >= margin &&
    screenPos.y <= screenH - margin;

  if (onScreen) return { x: screenPos.x, y: screenPos.y, offScreen: false };

  return {
    x: clamp(screenPos.x, margin, screenW - margin),
    y: clamp(screenPos.y, margin, screenH - margin),
    offScreen: true,
  };
}

function drawCircleIndicator(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  filled: boolean = false,
): void {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function drawRotatingT(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  time: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(time * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // Horizontal bar
  ctx.moveTo(-size, -size * 0.5);
  ctx.lineTo(size, -size * 0.5);
  // Vertical stem
  ctx.moveTo(0, -size * 0.5);
  ctx.lineTo(0, size);
  ctx.stroke();
  ctx.restore();
}

/**
 * PR7: yellow warning triangle with a central exclamation mark, used for
 * "enemy is building near you" alerts. Drawn at (x, y) world space.
 */
function drawWarningTriangle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size, size * 0.8);
  ctx.lineTo(-size, size * 0.8);
  ctx.closePath();
  ctx.stroke();
  // Exclamation: a vertical bar plus a dot.
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.45);
  ctx.lineTo(0, size * 0.25);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, size * 0.5, 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawRadarSquare(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  fill: string,
  stroke: string,
): void {
  const half = size * 0.5;
  ctx.save();
  ctx.shadowColor = stroke;
  ctx.shadowBlur = 8;
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.rect(x - half, y - half, size, size);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawRadarCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  fill: string,
  stroke: string,
): void {
  ctx.save();
  ctx.shadowColor = stroke;
  ctx.shadowBlur = 8;
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawRadarShipTriangle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  angle: number,
  fill: string,
  stroke: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.shadowColor = stroke;
  ctx.shadowBlur = 8;
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.72, size * 0.62);
  ctx.lineTo(-size * 0.48, 0);
  ctx.lineTo(-size * 0.72, -size * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function velocityAngle(entity: Entity): number {
  return entity.velocity.length() > 1 ? Math.atan2(entity.velocity.y, entity.velocity.x) : entity.angle;
}

function drawRadarHalo(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
): void {
  const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
  glow.addColorStop(0, color);
  glow.addColorStop(0.35, color);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawRadarFrame(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  screenW: number,
  screenH: number,
  time: number,
): void {
  const gridColor = colorToCSS(Colors.radar_gridlines, 0.28);
  const pulse = 0.5 + 0.5 * Math.sin(time * 2.2);

  const bg = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.max(screenW, screenH) * 0.62);
  bg.addColorStop(0, 'rgba(8, 42, 18, 0.78)');
  bg.addColorStop(0.56, RADAR_BACKGROUND);
  bg.addColorStop(1, 'rgba(0, 4, 3, 0.94)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, screenW, screenH);

  ctx.save();
  ctx.translate(centerX, centerY);

  const dishGlow = ctx.createRadialGradient(0, 0, radius * 0.1, 0, 0, radius * 1.08);
  dishGlow.addColorStop(0, 'rgba(120, 255, 162, 0.05)');
  dishGlow.addColorStop(0.72, 'rgba(68, 182, 94, 0.03)');
  dishGlow.addColorStop(1, RADAR_EDGE_GLOW);
  ctx.fillStyle = dishGlow;
  ctx.beginPath();
  ctx.arc(0, 0, radius * 1.08, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.18);
  ctx.lineWidth = 1;
  for (let i = 0; i < 24; i++) {
    const a = i * Math.PI / 12;
    const inner = i % 3 === 0 ? radius * 0.12 : radius * 0.72;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
    ctx.stroke();
  }

  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 0.7;
  const gridStep = 1000;
  for (let r = gridStep; r <= RADAR_RANGE; r += gridStep) {
    const rr = r * radius / RADAR_RANGE;
    ctx.beginPath();
    ctx.arc(0, 0, rr, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.62 + pulse * 0.18);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.48);
  ctx.lineWidth = 1;
  for (let i = 0; i < 72; i++) {
    const a = i * Math.PI / 36;
    const tick = i % 6 === 0 ? 12 : 6;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * (radius - tick), Math.sin(a) * (radius - tick));
    ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
    ctx.stroke();
  }

  ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.42);
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(-radius, 0);
  ctx.lineTo(radius, 0);
  ctx.moveTo(0, -radius);
  ctx.lineTo(0, radius);
  ctx.stroke();

  const sweepAngle = -time * 1.65;
  const sweep = ctx.createConicGradient(sweepAngle, 0, 0);
  sweep.addColorStop(0, 'rgba(170, 255, 190, 0)');
  sweep.addColorStop(0.03, 'rgba(170, 255, 190, 0.18)');
  sweep.addColorStop(0.08, 'rgba(170, 255, 190, 0.06)');
  sweep.addColorStop(0.16, 'rgba(170, 255, 190, 0)');
  sweep.addColorStop(1, 'rgba(170, 255, 190, 0)');
  ctx.fillStyle = sweep;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, 0.2);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(sweepAngle) * radius, Math.sin(sweepAngle) * radius);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = 'rgba(190,255,205,0.035)';
  for (let y = 0; y < screenH; y += 4) {
    ctx.fillRect(0, y, screenW, 1);
  }
}

export function radarScreenToWorld(
  screenPos: Vec2,
  playerPos: Vec2,
  screenW: number,
  screenH: number,
): Vec2 | null {
  const centerX = screenW * 0.5;
  const centerY = screenH * 0.5;
  const radarRadius = Math.min(screenW, screenH) * 0.45;
  const dx = screenPos.x - centerX;
  const dy = screenPos.y - centerY;
  if (dx * dx + dy * dy > radarRadius * radarRadius) return null;
  const scale = radarRadius / RADAR_RANGE;
  return new Vec2(playerPos.x + dx / scale, playerPos.y + dy / scale);
}

function drawRadarWaypointMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  group: ShipCommandGroup,
  marker: WaypointMarker,
  time: number,
): void {
  const moveCommand = marker.kind === 'move';
  const color = moveCommand ? Colors.radar_friendly_status : group === 'all' ? Colors.alert2 : GROUP_COLORS[group];
  const label = moveCommand ? '+' : group === 'all' ? 'A' : `${group + 1}`;
  const pulse = 0.5 + 0.5 * Math.sin(time * 4.4 + (group === 'all' ? 1.7 : group));
  const radius = 9 + pulse * 3;

  ctx.save();
  ctx.translate(x, y);
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowColor = colorToCSS(color, 0.8);
  ctx.shadowBlur = 12;
  ctx.strokeStyle = colorToCSS(color, 0.34);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, radius * 1.16, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = colorToCSS(color, 0.86);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(0, -radius);
  ctx.lineTo(radius * 0.72, 0);
  ctx.lineTo(0, radius);
  ctx.lineTo(-radius * 0.72, 0);
  ctx.closePath();
  ctx.stroke();

  ctx.fillStyle = colorToCSS(color, 0.2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = colorToCSS(color, 0.58);
  ctx.stroke();

  ctx.strokeStyle = colorToCSS(color, 0.7);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI * 0.5;
    const sx = Math.cos(a);
    const sy = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(sx * radius * 1.26, sy * radius * 1.26);
    ctx.lineTo(sx * radius * 1.54, sy * radius * 1.54);
    ctx.stroke();
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowBlur = 0;
  ctx.font = 'bold 12px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.96)';
  ctx.strokeText(label, 0, 0);
  ctx.fillStyle = colorToCSS(color, 1);
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

export function drawEdgeIndicators(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  state: GameState,
  screenW: number,
  screenH: number,
): void {
  const time = state.gameTime;

  // Player command post
  const playerCP = state.getPlayerCommandPost();
  if (playerCP) {
    const sp = camera.worldToScreen(playerCP.position);
    const edge = clampToEdge(sp, screenW, screenH);
    if (edge.offScreen) {
      drawCircleIndicator(
        ctx,
        edge.x,
        edge.y,
        INDICATOR_MAX_SIZE,
        colorToCSS(Colors.radar_friendly_status),
      );
    }
  }

  // Enemy command post
  const enemyCP = state.getEnemyCommandPost();
  if (enemyCP) {
    const sp = camera.worldToScreen(enemyCP.position);
    const edge = clampToEdge(sp, screenW, screenH);
    if (edge.offScreen) {
      drawCircleIndicator(
        ctx,
        edge.x,
        edge.y,
        INDICATOR_MAX_SIZE,
        colorToCSS(Colors.radar_enemy_status),
      );
    }
  }

  // Player buildings (small green circles)
  for (const b of state.buildings) {
    if (!b.alive || b.team !== Team.Player || b.type === EntityType.CommandPost)
      continue;
    const sp = camera.worldToScreen(b.position);
    const edge = clampToEdge(sp, screenW, screenH);
    if (edge.offScreen) {
      drawCircleIndicator(
        ctx,
        edge.x,
        edge.y,
        INDICATOR_MIN_SIZE,
        colorToCSS(Colors.radar_friendly_status, 0.7),
      );
    }
  }

  // Entities under attack (flashing red)
  for (const id of state.recentlyDamaged) {
    const entity = state.getEntityById(id);
    if (!entity || entity.team !== Team.Player) continue;
    const sp = camera.worldToScreen(entity.position);
    const edge = clampToEdge(sp, screenW, screenH);
    if (edge.offScreen) {
      const flash = Math.sin(time * 12) > 0;
      if (flash) {
        drawCircleIndicator(
          ctx,
          edge.x,
          edge.y,
          INDICATOR_MAX_SIZE - 2,
          colorToCSS(Colors.alert1),
          true,
        );
      }
    }
  }

  // Fighter group targets (rotating T at edge)
  const groupTargets: Array<Vec2 | null> = [null, null, null];
  for (const f of state.fighters) {
    if (!f.alive || f.docked || f.team !== Team.Player || f.order !== 'attack' || !f.targetPos) continue;
    if (!groupTargets[f.group]) groupTargets[f.group] = f.targetPos;
  }
  for (const group of [ShipGroup.Red, ShipGroup.Green, ShipGroup.Blue]) {
    const targetPos = groupTargets[group];
    if (!targetPos) continue;

    const sp = camera.worldToScreen(targetPos);
    const edge = clampToEdge(sp, screenW, screenH);
    if (edge.offScreen) {
      drawRotatingT(
        ctx,
        edge.x,
        edge.y,
        INDICATOR_MIN_SIZE + 2,
        colorToCSS(GROUP_COLORS[group]),
        time,
      );
    }
  }

  // PR7: AI warning markers — flashing yellow exclamation at the screen
  // edge for each recent enemy construction within 8s. If the construction
  // is on-screen we drop a transient marker at the world position so the
  // player can see *where* it appeared.
  const WARNING_LIFETIME = 8;
  const cutoff = state.gameTime - WARNING_LIFETIME;
  // Drop expired warnings (mutates the array in place).
  for (let i = state.recentEnemyConstructions.length - 1; i >= 0; i--) {
    if (state.recentEnemyConstructions[i].time < cutoff) {
      state.recentEnemyConstructions.splice(i, 1);
    }
  }
  for (const w of state.recentEnemyConstructions) {
    const age = state.gameTime - w.time;
    const flash = Math.sin(time * 8) > 0;
    if (!flash) continue;
    const alpha = Math.max(0, 1 - age / WARNING_LIFETIME);
    const sp = camera.worldToScreen(w.pos);
    const edge = clampToEdge(sp, screenW, screenH);
    if (edge.offScreen) {
      drawWarningTriangle(
        ctx,
        edge.x,
        edge.y,
        INDICATOR_MAX_SIZE,
        colorToCSS(Colors.alert2, alpha),
      );
    } else {
      // On-screen marker — small triangle above the construction.
      drawWarningTriangle(
        ctx,
        sp.x,
        sp.y - 22,
        INDICATOR_MIN_SIZE + 2,
        colorToCSS(Colors.alert2, alpha),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Full-screen radar overlay (hold W)
// ---------------------------------------------------------------------------

export function drawRadarOverlay(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  screenW: number,
  screenH: number,
  waypointMarkers?: Map<ShipCommandGroup, WaypointMarker>,
): void {
  const centerX = screenW * 0.5;
  const centerY = screenH * 0.5;
  const radarRadius = Math.min(screenW, screenH) * 0.45;
  const scale = radarRadius / RADAR_RANGE;

  const gridStep = 1000;
  drawRadarFrame(ctx, centerX, centerY, radarRadius, screenW, screenH, state.gameTime);

  const playerPos = state.player.position;

  // Draw player at center
  drawRadarHalo(ctx, centerX, centerY, 15, colorToCSS(Colors.radar_friendly_status, 0.22));
  drawRadarShipTriangle(
    ctx,
    centerX,
    centerY,
    5,
    velocityAngle(state.player),
    RADAR_PLAYER_FILL,
    RADAR_PLAYER_STROKE,
  );

  // Buildings
  for (const b of state.buildings) {
    if (!b.alive || (b.team !== Team.Player && b.team !== Team.Enemy)) continue;
    const dx = (b.position.x - playerPos.x) * scale;
    const dy = (b.position.y - playerPos.y) * scale;
    if (dx * dx + dy * dy > radarRadius * radarRadius) continue;
    const rx = centerX + dx;
    const ry = centerY + dy;

    const friendly = b.team === Team.Player;
    const fill = friendly ? RADAR_FRIENDLY_FILL : RADAR_ENEMY_FILL;
    const stroke = friendly ? RADAR_FRIENDLY_STROKE : RADAR_ENEMY_STROKE;
    drawRadarHalo(ctx, rx, ry, friendly ? 10 : 12, friendly ? colorToCSS(Colors.radar_friendly_status, 0.12) : colorToCSS(Colors.radar_enemy_status, 0.16));
    if (b.type === EntityType.CommandPost) {
      drawRadarCircle(ctx, rx, ry, 4.5, fill, stroke);
    } else {
      drawRadarSquare(ctx, rx, ry, 4.5, fill, stroke);
    }
  }

  // Ships. Friendly ships use pale green so red group never reads as hostile.
  for (const ship of state.playerShips.values()) {
    if (!ship.alive || ship === state.player || (ship.team !== Team.Player && ship.team !== Team.Enemy)) continue;
    const dx = (ship.position.x - playerPos.x) * scale;
    const dy = (ship.position.y - playerPos.y) * scale;
    if (dx * dx + dy * dy > radarRadius * radarRadius) continue;
    const rx = centerX + dx;
    const ry = centerY + dy;

    const friendly = ship.team === Team.Player;
    drawRadarHalo(ctx, rx, ry, friendly ? 9 : 11, friendly ? colorToCSS(Colors.radar_friendly_status, 0.12) : colorToCSS(Colors.radar_enemy_status, 0.18));
    drawRadarShipTriangle(
      ctx,
      rx,
      ry,
      4.6,
      velocityAngle(ship),
      friendly ? RADAR_FRIENDLY_FILL : RADAR_ENEMY_FILL,
      friendly ? RADAR_FRIENDLY_STROKE : RADAR_ENEMY_STROKE,
    );
  }

  // Fighters.
  for (const f of state.fighters) {
    if (!f.alive || f.docked || (f.team !== Team.Player && f.team !== Team.Enemy)) continue;
    const dx = (f.position.x - playerPos.x) * scale;
    const dy = (f.position.y - playerPos.y) * scale;
    if (dx * dx + dy * dy > radarRadius * radarRadius) continue;
    const rx = centerX + dx;
    const ry = centerY + dy;

    const friendly = f.team === Team.Player;
    drawRadarHalo(ctx, rx, ry, friendly ? 7 : 9, friendly ? colorToCSS(Colors.radar_friendly_status, 0.10) : colorToCSS(Colors.radar_enemy_status, 0.16));
    drawRadarShipTriangle(
      ctx,
      rx,
      ry,
      3.4,
      velocityAngle(f),
      friendly ? RADAR_FRIENDLY_FILL : RADAR_ENEMY_FILL,
      friendly ? RADAR_FRIENDLY_STROKE : RADAR_ENEMY_STROKE,
    );
  }

  if (waypointMarkers) {
    const drawOrder: ShipCommandGroup[] = [ShipGroup.Red, ShipGroup.Green, ShipGroup.Blue, 'all'];
    for (const group of drawOrder) {
      const marker = waypointMarkers.get(group);
      if (!marker) continue;
      if (marker.kind === 'follow') continue; // transient burst on the player ship
      const dx = (marker.pos.x - playerPos.x) * scale;
      const dy = (marker.pos.y - playerPos.y) * scale;
      if (dx * dx + dy * dy > radarRadius * radarRadius) continue;
      drawRadarWaypointMarker(ctx, centerX + dx, centerY + dy, group, marker, state.gameTime);
    }
  }

  // Distance label
  ctx.font = '10px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
  ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.6);
  ctx.textAlign = 'left';
  for (let r = gridStep; r <= RADAR_RANGE; r += gridStep) {
    ctx.fillText(`${r}`, centerX + r * scale + 2, centerY - 2);
  }
}
