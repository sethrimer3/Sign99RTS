import { Camera } from './camera.js';
import { Colors, colorToCSS, type Color } from './colors.js';
import { EntityType, ShipGroup, Team } from './entities.js';
import type { GameState } from './gamestate.js';
import type { LanClient } from './lan/lanClient.js';
import { Vec2 } from './math.js';
import { recentCombatAimSamples } from './targeting.js';
import { getShipPathDebugStats } from './shippath.js';
import { renderBudget } from './renderBudget.js';
import type { VisualQuality } from './visualquality.js';
import { teamColor } from './teamutils.js';
import { isLegacyGraphics } from './graphicsmode.js';
import { renderLockward } from './lockwardEffect.js';
import { footprintForBuilding } from './buildingfootprint.js';
import { GRID_CELL_SIZE } from './grid.js';

export type ShipCommandGroup = ShipGroup | 'all';
export type WaypointMarker = { pos: Vec2; issuedAt: number; kind?: 'group' | 'move' };

const GROUP_COLORS: Record<ShipGroup, Color> = {
  [ShipGroup.Red]: Colors.redgroup,
  [ShipGroup.Green]: Colors.greengroup,
  [ShipGroup.Blue]: Colors.bluegroup,
};

export function drawWaypointMarkers(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  state: GameState,
  waypointMarkers: Map<ShipCommandGroup, WaypointMarker>,
): void {
  const drawOrder: ShipCommandGroup[] = [ShipGroup.Red, ShipGroup.Green, ShipGroup.Blue, 'all'];
  for (const group of drawOrder) {
    const marker = waypointMarkers.get(group);
    if (!marker) continue;
    const screen = camera.worldToScreen(marker.pos);
    const moveCommand = marker.kind === 'move';
    const color = moveCommand ? Colors.radar_friendly_status : group === 'all' ? Colors.alert2 : GROUP_COLORS[group];
    const label = moveCommand ? '+' : group === 'all' ? 'A' : `${group + 1}`;
    const legacy = isLegacyGraphics();
    const t = state.gameTime - marker.issuedAt;
    const phase = state.gameTime * 3.2 + (group === 'all' ? 1.8 : group);
    const pulse = 0.5 + 0.5 * Math.sin(phase);
    // Legacy markers breathe; the new lockward marker holds a steady size.
    const ring = Math.max(15, (18 + (legacy ? pulse * 5 : 0)) * camera.zoom);
    const lift = legacy ? Math.sin(state.gameTime * 1.7 + t) * 3 * camera.zoom : 0;
    const core = Math.max(5, 7 * camera.zoom);
    const tickInner = ring * 1.02;
    const tickOuter = ring * 1.34;

    ctx.save();
    ctx.translate(screen.x, screen.y + lift);
    ctx.globalCompositeOperation = 'lighter';

    const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, ring * 1.8);
    grad.addColorStop(0, colorToCSS(color, 0.26));
    grad.addColorStop(0.42, colorToCSS(color, 0.10));
    grad.addColorStop(1, colorToCSS(color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, ring * 1.8, 0, Math.PI * 2);
    ctx.fill();

    // Lockward-inspired layers: stacked translucent combination-lock wards that
    // each spin at their own random speed/direction, blink, and overlap.
    if (legacy) {
      for (let layer = 0; layer < 3; layer++) {
        const direction = layer === 1 ? -1 : 1;
        const rotation = state.gameTime * (0.34 + layer * 0.17) * direction + layer * 1.91;
        const blink = 0.42 + 0.38 * Math.sin(state.gameTime * (2.1 + layer * 0.73) + layer * 2.4);
        const wardRadius = ring * (0.72 + layer * 0.22);
        const wardCount = 5 + layer * 2;
        ctx.save();
        ctx.rotate(rotation);
        ctx.strokeStyle = colorToCSS(color, Math.max(0.12, blink));
        ctx.lineWidth = Math.max(1, (1.8 - layer * 0.3) * camera.zoom);
        ctx.beginPath();
        for (let i = 0; i < wardCount; i++) {
          const a = i * Math.PI * 2 / wardCount;
          const notch = i % 2 === 0 ? 0.58 : 0.77;
          ctx.moveTo(Math.cos(a) * wardRadius * notch, Math.sin(a) * wardRadius * notch);
          ctx.lineTo(Math.cos(a) * wardRadius, Math.sin(a) * wardRadius);
          ctx.arc(0, 0, wardRadius, a, a + Math.PI / wardCount * 0.62);
        }
        ctx.stroke();
        ctx.restore();
      }
    } else {
      const seed = (group === 'all' ? 97 : group + 1) * 31 + Math.floor(marker.issuedAt * 7) % 89;
      renderLockward(ctx, 0, 0, state.gameTime, seed, {
        color,
        radiusPx: ring * 1.7,
        opacity: 0.9,
        rings: 5,
      });
    }

    if (legacy) {
      // Four rotating ticks + a bottom stem — legacy marker only.
      ctx.strokeStyle = colorToCSS(color, 0.68);
      ctx.lineWidth = Math.max(1, 1.4 * camera.zoom);
      for (let i = 0; i < 4; i++) {
        const a = state.gameTime * -0.55 + i * Math.PI * 0.5;
        const sx = Math.cos(a);
        const sy = Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(sx * tickInner, sy * tickInner);
        ctx.lineTo(sx * tickOuter, sy * tickOuter);
        ctx.stroke();
      }

      ctx.strokeStyle = colorToCSS(color, 0.5);
      ctx.lineWidth = Math.max(1, 1 * camera.zoom);
      ctx.beginPath();
      ctx.moveTo(0, ring * 0.9);
      ctx.lineTo(0, ring * 1.58);
      ctx.stroke();
    }

    ctx.fillStyle = colorToCSS(color, 0.48);
    ctx.beginPath();
    ctx.arc(0, 0, core, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
    ctx.font = `bold ${Math.max(9, 12 * camera.zoom)}px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, 4 * camera.zoom);
    ctx.strokeStyle = 'rgba(0,0,0,0.96)';
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = colorToCSS(color, 1);
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }
}

export function drawDebugOverlay(ctx: CanvasRenderingContext2D, args: {
  screenW: number;
  state: GameState;
  lastFrameMs: number;
  fixedUpdateMs: number;
  renderMs: number;
  lanClient: LanClient | null;
  lanMySlot: number;
  lanLastSnapshotSeq: number;
  lanSnapshotSeq: number;
  lanAiDirectorCount: number;
  /** Current prediction error magnitude (px) for the local player ship. */
  lanPredictionError?: number;
  /** Number of crystal motes drawn last frame (0 if nebula disabled). */
  crystalMoteCount?: number;
  /** Current visual quality setting */
  visualQuality?: VisualQuality;
}): void {
  const { state } = args;
  const playerBuildings = state.buildings.filter((b) => b.alive && b.team === Team.Player);
  const enemyBuildings = state.buildings.filter((b) => b.alive && b.team === Team.Enemy);
  const powered = playerBuildings.filter((b) => b.buildProgress >= 1 && b.powered).length;
  const unpowered = playerBuildings.filter((b) => b.buildProgress >= 1 && !b.powered).length;
  const research = state.researchProgress.item
    ? `${state.researchProgress.item} ${Math.floor(
        (state.researchProgress.progress / Math.max(1, state.researchProgress.timeNeeded)) * 100,
      )}%`
    : 'none';
  const groups = [ShipGroup.Red, ShipGroup.Green, ShipGroup.Blue]
    .map((g) => `${g + 1} ${state.getFighterGroupCounts(Team.Player, g).total}`)
    .join(' / ');

  const lines = [
    `mode ${state.gameMode}  frame ${args.lastFrameMs.toFixed(1)}ms fixed ${args.fixedUpdateMs.toFixed(1)}ms render ${args.renderMs.toFixed(1)}ms`,
    `smoothed frame ${renderBudget.frameMs.toFixed(1)}ms render ${renderBudget.renderMs.toFixed(1)}ms | adaptScale ${renderBudget.renderLoadScale.toFixed(2)} quality ${args.visualQuality ?? '?'}`,
    `particles active ${renderBudget.activeParticles}/${renderBudget.particleCapacity} drawn ${renderBudget.drawnParticles} culled ${renderBudget.culledParticles} emitted ${renderBudget.emittedThisFrame}`,
    `glow drawn ${renderBudget.glowDrawn} skipped ${renderBudget.glowSkipped} | crystal motes ${renderBudget.crystalVisible}`,
    `projectiles ${state.projectiles.length}  fighters ${state.fighters.filter((f) => f.alive && !f.docked).length}/${state.fighters.length}  buildings ${state.buildings.filter((b) => b.alive).length}`,
    `resources ${Math.floor(state.resources)}  build ${state.selectedBuildType ?? 'none'}`,
    `ship hp ${Math.ceil(state.player.health)}/${state.player.maxHealth}  battery ${Math.floor(state.player.battery)}/${state.player.maxBattery}`,
    `buildings player ${playerBuildings.length} enemy ${enemyBuildings.length}`,
    `conduits ${state.grid.conduitCount()} pending ${state.grid.pendingConduitCount()}`,
    `power player ${powered} powered / ${unpowered} unpowered`,
    `research ${research}`,
    `fighters ${groups}`,
  ];

  const pathStats = getShipPathDebugStats();
  const perf = state.perfStats;
  const ai = state.aiDebug;
  if (ai) {
    const retreat = ai.retreatTarget ? `${Math.round(ai.retreatTarget.x)},${Math.round(ai.retreatTarget.y)}` : 'none';
    const cached = ai.cachedNavigationTarget ? `${Math.round(ai.cachedNavigationTarget.x)},${Math.round(ai.cachedNavigationTarget.y)}` : 'none';
    lines.push(`AI goal ${ai.goal}  hp ${(ai.healthFraction * 100).toFixed(0)}%`);
    lines.push(`AI retreat ${retreat}  adjusted ${ai.retreatTargetAdjusted ? 'yes' : 'no'}`);
    lines.push(`AI nav cache ${cached}`);
  }
  lines.push(`entities f ${state.fighters.filter((f) => f.alive && !f.docked).length}/${state.fighters.length} b ${enemyBuildings.length + playerBuildings.length} blockers ${pathStats.blockerCount} p ${state.projectiles.length}`);
  lines.push(`sim state ${perf.gameStateUpdateMs.toFixed(2)}ms practice ${perf.practiceUpdateMs.toFixed(2)}ms planners ${perf.practicePlannerMs.toFixed(2)}ms max ${perf.practicePlannerMaxMs.toFixed(2)}ms bases ${perf.activeEnemyBases}`);
  lines.push(`hotspots turret ${perf.turretAcquireMs.toFixed(2)}ms projectile ${perf.projectileCollisionMs.toFixed(2)}ms fighter combat ${perf.fighterCombatMs.toFixed(2)}ms separation ${perf.fighterSeparationMs.toFixed(2)}ms`);
  lines.push(`spatial q ${perf.spatial.queryCount} raw ${perf.spatial.rawCandidateCount} returned ${perf.spatial.returnedCount} cells ${perf.spatial.cellCount} indexed ${perf.spatial.insertedCount}`);
  lines.push(`ship paths frame ${pathStats.mobilePathMsThisFrame.toFixed(2)}ms r ${pathStats.resolvesThisFrame} A* ${pathStats.fullAStarThisFrame} reuse ${pathStats.cachedReusesThisFrame} shared ${pathStats.sharedPathUsesThisFrame} skip ${pathStats.skippedThisFrame}`);
  lines.push(`ship paths ${pathStats.resolvesPerSecond}/s  avg ${pathStats.avgMsLast60.toFixed(2)}ms max ${pathStats.maxMsLast60.toFixed(2)}ms`);
  lines.push(`ship path target adjusted ${pathStats.adjustedTargetLastSecond ? 'yes' : 'no'}`);
  if (args.crystalMoteCount !== undefined) {
    // Crystal motes also shown in the perf stats line above; no duplicate needed
  }

  const isLan = state.gameMode === 'lan_host' || state.gameMode === 'lan_client';
  if (isLan && args.lanClient) {
    const role = state.gameMode === 'lan_host' ? 'host' : 'client';
    lines.push(`LAN ${role}  slot ${args.lanMySlot + 1}  ping ${args.lanClient.pingMs}ms`);
    if (state.gameMode === 'lan_client') {
      const age = args.lanClient.lastSnapshotAt > 0
        ? Math.round(performance.now() - args.lanClient.lastSnapshotAt)
        : -1;
      const seqStr = args.lanLastSnapshotSeq >= 0 ? `seq ${args.lanLastSnapshotSeq}` : 'no snapshot';
      lines.push(`snapshot ${seqStr}  age ${age >= 0 ? age + 'ms' : 'n/a'}`);
      if (age > 3000) lines.push('WARNING: No snapshot for >3s');
      const predErr = args.lanPredictionError ?? 0;
      if (predErr > 0) lines.push(`prediction error ${Math.round(predErr)}px`);
    }
    if (state.gameMode === 'lan_host') {
      lines.push(`snap seq ${args.lanSnapshotSeq}  AI dirs ${args.lanAiDirectorCount}`);
    }
  }

  ctx.save();
  ctx.font = '11px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const width = 440;
  const height = lines.length * 15 + 12;
  const x = args.screenW - width - 10;
  const y = 10;
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.55);
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  for (let i = 0; i < lines.length; i++) {
    const isWarning = lines[i].startsWith('WARNING');
    ctx.fillStyle = isWarning
      ? colorToCSS(Colors.alert2, 0.95)
      : colorToCSS(Colors.general_building, 0.9);
    ctx.fillText(lines[i], x + 8, y + 7 + i * 15);
  }
  ctx.restore();
}

export function drawCombatTargetingDebug(ctx: CanvasRenderingContext2D, camera: Camera, state: GameState): void {
  const samples = recentCombatAimSamples(state.gameTime);
  if (samples.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const sample of samples) {
    const age = Math.max(0, state.gameTime - sample.createdAt);
    const alpha = Math.max(0, 1 - age / 2);
    if (alpha <= 0) continue;
    const shooter = camera.worldToScreen(sample.shooter);
    const target = camera.worldToScreen(sample.target);
    const aim = camera.worldToScreen(sample.aimPoint);
    const spawn = camera.worldToScreen(sample.spawn);
    const velEnd = camera.worldToScreen(sample.target.add(sample.targetVelocity.scale(0.35)));

    ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.24 * alpha);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(shooter.x, shooter.y, sample.range * camera.zoom, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = colorToCSS(Colors.alert1, 0.42 * alpha);
    ctx.beginPath();
    ctx.moveTo(shooter.x, shooter.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();

    ctx.strokeStyle = sample.interceptValid
      ? colorToCSS(Colors.friendly_status, 0.74 * alpha)
      : colorToCSS(Colors.alert2, 0.64 * alpha);
    ctx.beginPath();
    ctx.moveTo(spawn.x, spawn.y);
    ctx.lineTo(aim.x, aim.y);
    ctx.stroke();

    ctx.fillStyle = colorToCSS(Colors.particles_switch, 0.9 * alpha);
    ctx.beginPath();
    ctx.arc(spawn.x, spawn.y, Math.max(2, 3 * camera.zoom), 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = sample.interceptValid
      ? colorToCSS(Colors.friendly_status, 0.95 * alpha)
      : colorToCSS(Colors.alert2, 0.9 * alpha);
    ctx.beginPath();
    ctx.arc(aim.x, aim.y, Math.max(2, 4 * camera.zoom), 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = colorToCSS(Colors.particles_switch, 0.42 * alpha);
    ctx.beginPath();
    ctx.moveTo(target.x, target.y);
    ctx.lineTo(velEnd.x, velEnd.y);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawConfluenceTerritory(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  state: GameState,
  territoryPulseTime: number,
): void {
  const circles = state.territoryCirclesByTeam.get(Team.Player) ?? [];
  for (const c of circles) {
    const sc = camera.worldToScreen(new Vec2(c.x, c.y));
    const rr = c.radius * camera.zoom;
    const grad = ctx.createRadialGradient(sc.x, sc.y, rr * 0.2, sc.x, sc.y, rr);
    grad.addColorStop(0, 'rgba(80,230,220,0.16)');
    grad.addColorStop(1, 'rgba(80,230,220,0.03)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(sc.x, sc.y, rr, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(120,255,245,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sc.x, sc.y, rr, 0, Math.PI * 2); ctx.stroke();

    const innerR = rr * 0.78;
    const rotAngle = territoryPulseTime * 0.22;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.setLineDash([14, 10]);
    ctx.lineDashOffset = -rotAngle * 80;
    ctx.strokeStyle = 'rgba(80,255,240,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(sc.x, sc.y, innerR, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const pulsePeriod = 3.2;
    const phaseOffset = (c.x * 0.007 + c.y * 0.013) % pulsePeriod;
    const pulseT = ((territoryPulseTime + phaseOffset) % pulsePeriod) / pulsePeriod;
    if (pulseT < 0.55) {
      const pulseR = rr * (1 + pulseT * 0.28);
      const pulseAlpha = (1 - pulseT / 0.55) * 0.28;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(80,255,240,${pulseAlpha.toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sc.x, sc.y, pulseR, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------------------
// Base territory glow
// ---------------------------------------------------------------------------

/**
 * Minimum world-unit radius for the base glow gradient even when a base has
 * very few buildings.
 */
const BASE_GLOW_MIN_RADIUS = 420;

/**
 * How much the gradient radius grows per additional alive building beyond the
 * CommandPost (world units per building).
 */
const BASE_GLOW_GROWTH_PER_BUILDING = 55;

/**
 * Extra padding (world units) added beyond the furthest building from the
 * centre.  This creates a soft halo beyond the physical footprint.
 */
const BASE_GLOW_EXTENT_PADDING = 280;

/**
 * Maximum opacity at the gradient centre (keep very faint so the background
 * remains dark overall).
 */
const BASE_GLOW_CENTER_ALPHA = 0.13;

/**
 * Alpha factor at 40% radius — halfway between centre and mid-fade.
 * Kept as a named constant for clarity.
 */
const BASE_GLOW_MID_ALPHA_FACTOR = 0.5;

/**
 * Alpha factor at 75% radius — near the outer edge of the gradient.
 */
const BASE_GLOW_OUTER_ALPHA_FACTOR = 0.12;

/**
 * Draws soft, faint team-coloured radial gradients around each team's base.
 * Called before the starfield so the colour tints the stars naturally.
 *
 * The gradient radius grows as the base expands with more structures.
 */
export function drawBaseTerritoryGlow(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  state: GameState,
  screenW: number,
  screenH: number,
): void {
  // Collect per-team data in one pass: focal centre (CommandPost preferred),
  // cumulative sum for centroid fallback, building count, and max extent.
  const teamData = new Map<Team, {
    sumX: number; sumY: number;  // cumulative sum for centroid fallback
    cx: number; cy: number;      // resolved focal centre (set after first pass)
    maxDist: number;
    count: number;
    commandPostX: number | null;
    commandPostY: number | null;
  }>();

  for (const b of state.buildings) {
    if (!b.alive || b.team === Team.Neutral) continue;
    const t = b.team;
    if (!teamData.has(t)) {
      teamData.set(t, { sumX: 0, sumY: 0, cx: 0, cy: 0, maxDist: 0, count: 0, commandPostX: null, commandPostY: null });
    }
    const d = teamData.get(t)!;
    d.sumX += b.position.x;
    d.sumY += b.position.y;
    d.count++;
    if (b.type === EntityType.CommandPost) {
      d.commandPostX = b.position.x;
      d.commandPostY = b.position.y;
    }
  }

  // Resolve focal centres: CommandPost takes priority; fall back to centroid.
  for (const [, d] of teamData) {
    if (d.commandPostX !== null) {
      d.cx = d.commandPostX;
      d.cy = d.commandPostY!;
    } else {
      d.cx = d.sumX / d.count;
      d.cy = d.sumY / d.count;
    }
  }

  // Second pass: compute max building distance from the focal centre.
  for (const b of state.buildings) {
    if (!b.alive || b.team === Team.Neutral) continue;
    const d = teamData.get(b.team);
    if (!d) continue;
    const dx = b.position.x - d.cx;
    const dy = b.position.y - d.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > d.maxDist) d.maxDist = dist;
  }

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  for (const [team, d] of teamData) {
    const color = teamColor(team);
    const r = color.r * color.intensity;
    const g = color.g * color.intensity;
    const b = color.b * color.intensity;

    // World-space radius: at least MIN, grows with building count and physical extent.
    const worldRadius = Math.max(
      BASE_GLOW_MIN_RADIUS,
      d.maxDist + BASE_GLOW_EXTENT_PADDING + (d.count - 1) * BASE_GLOW_GROWTH_PER_BUILDING,
    );

    // Convert to screen space.
    const sx = camera.screenX(d.cx);
    const sy = camera.screenY(d.cy);
    const screenRadius = worldRadius * camera.zoom;

    // Cull gradient entirely when the centre is very far off screen.
    if (
      sx < -screenRadius || sx > screenW + screenRadius ||
      sy < -screenRadius || sy > screenH + screenRadius
    ) continue;

    const ri = Math.round(r);
    const gi = Math.round(g);
    const bi = Math.round(b);
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, screenRadius);
    grad.addColorStop(0.00, `rgba(${ri},${gi},${bi},${BASE_GLOW_CENTER_ALPHA})`);
    grad.addColorStop(0.40, `rgba(${ri},${gi},${bi},${(BASE_GLOW_CENTER_ALPHA * BASE_GLOW_MID_ALPHA_FACTOR).toFixed(3)})`);
    grad.addColorStop(0.75, `rgba(${ri},${gi},${bi},${(BASE_GLOW_CENTER_ALPHA * BASE_GLOW_OUTER_ALPHA_FACTOR).toFixed(3)})`);
    grad.addColorStop(1.00, `rgba(${ri},${gi},${bi},0)`);

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sx, sy, screenRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Lockward effect that wraps each team's Command Post (main base). Same
 * translucent, independently-spinning ward stack as the waypoint markers,
 * scaled up to frame the building. Legacy Graphics disables it.
 */
export function drawBaseLockwardEffect(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  state: GameState,
): void {
  if (isLegacyGraphics()) return;
  for (const b of state.buildings) {
    if (!b.alive || b.type !== EntityType.CommandPost || b.team === Team.Neutral) continue;
    // Effect radius = distance from the structure centre to one of its corners.
    const worldRadius = (footprintForBuilding(b) * GRID_CELL_SIZE * Math.SQRT2) / 2;
    if (!camera.isOnScreen(b.position, worldRadius + 60)) continue;
    const screen = camera.worldToScreen(b.position);
    const radiusPx = worldRadius * camera.zoom;
    renderLockward(ctx, screen.x, screen.y, state.gameTime, (b.team + 1) * 37 + 5, {
      color: teamColor(b.team),
      radiusPx,
      opacity: 0.5,
      rings: 6,
    });
  }
}
