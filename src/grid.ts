/**
 * Universal world grid for Sign99.
 *
 * The grid is a coarse Cartesian decomposition of the world into square cells.
 * It backs:
 *
 *   - The conduit-paint system (Q-hold paint mode in actionmenu.ts).
 *   - Snap-to-grid building placement.
 *   - Power-network propagation.
 *   - Enemy-base conduit construction.
 *
 * Conduits are stored as a sparse `Set<string>` keyed by `cellKey(cx, cy)`.
 * Each cell remembers which team painted it so player and enemy networks
 * stay distinct.
 */

import { Vec2 } from './math.js';
import { Camera } from './camera.js';
import { Colors, colorToCSS } from './colors.js';
import { Team } from './entities.js';

/** Side length of one grid cell in world units. */
export const GRID_CELL_SIZE = 26 / 3;

/** Stable string key for a (cx, cy) cell coordinate. */
export function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export interface CellCoord {
  cx: number;
  cy: number;
}

/** Convert a world-space position to its containing cell coordinate. */
export function worldToCell(world: Vec2): CellCoord {
  return {
    cx: Math.floor(world.x / GRID_CELL_SIZE),
    cy: Math.floor(world.y / GRID_CELL_SIZE),
  };
}

/** Centre of the cell at (cx, cy) in world space. */
export function cellCenter(cx: number, cy: number): Vec2 {
  return new Vec2(
    (cx + 0.5) * GRID_CELL_SIZE,
    (cy + 0.5) * GRID_CELL_SIZE,
  );
}

export function footprintOrigin(cx: number, cy: number, footprintCells: number): CellCoord {
  return {
    cx: cx - Math.floor(footprintCells / 2),
    cy: cy - Math.floor(footprintCells / 2),
  };
}

export function footprintCenter(cx: number, cy: number, footprintCells: number): Vec2 {
  const origin = footprintOrigin(cx, cy, footprintCells);
  return new Vec2(
    (origin.cx + footprintCells / 2) * GRID_CELL_SIZE,
    (origin.cy + footprintCells / 2) * GRID_CELL_SIZE,
  );
}

/** True if cells (a) and (b) share an edge (4-neighbour adjacency). */
export function isAdjacent(a: CellCoord, b: CellCoord): boolean {
  const dx = Math.abs(a.cx - b.cx);
  const dy = Math.abs(a.cy - b.cy);
  return dx + dy === 1;
}

function hash01(cx: number, cy: number, salt: number): number {
  let h = Math.imul(cx | 0, 374761393) ^ Math.imul(cy | 0, 668265263) ^ salt;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

function sheenBand(value: number, width: number): number {
  const wrapped = value - Math.floor(value);
  const dist = Math.abs(wrapped - 0.5);
  return Math.max(0, 1 - dist / width);
}

// ---------------------------------------------------------------------------
// WorldGrid
// ---------------------------------------------------------------------------

export class WorldGrid {
  /** All conduit cells, keyed by cellKey(); value = owner and remaining HP. */
  private conduits = new Map<string, { team: Team; hp: number }>();
  /**
   * Conduits queued for construction (player-painted, not yet active).
   * Built one per 0.5 s from the existing network outward.
   */
  private pendingConduits = new Map<string, { cx: number; cy: number; team: Team }>();

  // -- Conduit accessors ----------------------------------------------------

  hasConduit(cx: number, cy: number): boolean {
    return this.conduits.has(cellKey(cx, cy));
  }

  conduitTeam(cx: number, cy: number): Team | null {
    return this.conduits.get(cellKey(cx, cy))?.team ?? null;
  }

  addConduit(cx: number, cy: number, team: Team): void {
    this.conduits.set(cellKey(cx, cy), { team, hp: 2 });
  }

  damageConduit(cx: number, cy: number, amount: number = 1): boolean {
    const key = cellKey(cx, cy);
    const entry = this.conduits.get(key);
    if (!entry) return false;
    entry.hp -= amount;
    if (entry.hp <= 0) {
      this.conduits.delete(key);
      return true;
    }
    return false;
  }

  removeConduit(cx: number, cy: number): void {
    this.conduits.delete(cellKey(cx, cy));
    // Also cancel any pending cell at the same location.
    this.pendingConduits.delete(cellKey(cx, cy));
  }

  /** Number of placed conduits — useful for debug/HUD. */
  conduitCount(): number {
    return this.conduits.size;
  }

  /** Iterate every (coord, team) pair. */
  *eachConduit(): IterableIterator<{ cx: number; cy: number; team: Team }> {
    for (const [k, entry] of this.conduits) {
      const [sx, sy] = k.split(',');
      yield { cx: parseInt(sx, 10), cy: parseInt(sy, 10), team: entry.team };
    }
  }

  /**
   * Draw traveling energy-pulse dots along energized conduits.
   * Only called in High graphics mode (conduitPulseEnabled).
   * Renders a hard-capped number of animated circles per frame.
   * When `getFlowDir` is supplied, dots travel in BFS flow direction
   * (source → leaf buildings) instead of appearing at random positions.
   */
  drawConduitPulses(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    screenW: number,
    screenH: number,
    time: number,
    isEnergized?: (cx: number, cy: number, team: Team) => boolean,
    getFlowDir?: (cx: number, cy: number, team: Team) => { dx: number; dy: number } | null,
  ): void {
    // Visible cell range
    const tl = camera.screenToWorld(new Vec2(0, 0));
    const br = camera.screenToWorld(new Vec2(screenW, screenH));
    const cxMin = Math.floor(tl.x / GRID_CELL_SIZE) - 1;
    const cxMax = Math.floor(br.x / GRID_CELL_SIZE) + 1;
    const cyMin = Math.floor(tl.y / GRID_CELL_SIZE) - 1;
    const cyMax = Math.floor(br.y / GRID_CELL_SIZE) + 1;
    const cellPx = GRID_CELL_SIZE * camera.zoom;
    const dotR = Math.max(1.5, cellPx * 0.12);
    // Hard cap on dots drawn per frame
    const MAX_DOTS = 80;
    let dotsDrawn = 0;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const [key, entry] of this.conduits) {
      if (dotsDrawn >= MAX_DOTS) break;
      const comma = key.indexOf(',');
      const cx = Number(key.slice(0, comma));
      const cy = Number(key.slice(comma + 1));
      if (cx < cxMin || cx > cxMax || cy < cyMin || cy > cyMax) continue;
      const energized = isEnergized ? isEnergized(cx, cy, entry.team) : true;
      if (!energized) continue;

      // Each conduit cell gets a unique offset so pulses don't all align.
      const cellOffset = hash01(cx, cy, 0xf5c4d8);

      const flowDir = getFlowDir ? getFlowDir(cx, cy, entry.team) : null;
      if (flowDir) {
        // Directional animation: dot travels FROM the upstream edge of the
        // cell TOWARD the downstream edge (in the energy flow direction).
        // phase: 0 → 1 cycling with time. Window = [0, 0.45).
        const phase = ((time * 0.70 + cellOffset) % 1.0);
        if (phase > 0.45) continue;
        const tAcross = phase / 0.45; // 0 = entering cell, 1 = leaving cell
        const dotAlpha = Math.sin(tAcross * Math.PI) * 0.55 * (0.7 + cellOffset * 0.3);
        if (dotAlpha < 0.02) continue;
        // Position: dot travels 90% of the cell width so it stays clearly
        // within bounds; the remaining 10% provides a small visual margin.
        const FLOW_TRAVEL_SCALE = 0.90;
        const offset = (tAcross - 0.5) * cellPx * FLOW_TRAVEL_SCALE;
        const c = camera.worldToScreen(cellCenter(cx, cy));
        const color = entry.team === Team.Player
          ? `rgba(140,240,255,${dotAlpha})`
          : `rgba(255,160,80,${dotAlpha})`;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(c.x + flowDir.dx * offset, c.y + flowDir.dy * offset, dotR, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Fallback: pulse appears at center of cell (source-adjacent / undirected)
        const phase = ((time * 0.65 + cellOffset) % 1.0);
        if (phase > 0.15) continue;
        const dotAlpha = Math.max(0, 0.55 - phase * 3.5) * (0.7 + cellOffset * 0.3);
        if (dotAlpha < 0.02) continue;
        const c = camera.worldToScreen(cellCenter(cx, cy));
        const color = entry.team === Team.Player
          ? `rgba(140,240,255,${dotAlpha})`
          : `rgba(255,160,80,${dotAlpha})`;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(c.x, c.y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
      dotsDrawn++;
    }

    ctx.restore();
  }

  // -- Pending conduit queue -------------------------------------------------

  /**
   * Add (cx, cy) to the pending-build queue for `team`. Does nothing if the
   * cell already has a conduit or is already queued.
   */
  queueConduit(cx: number, cy: number, team: Team): void {
    const key = cellKey(cx, cy);
    if (!this.conduits.has(key) && !this.pendingConduits.has(key)) {
      this.pendingConduits.set(key, { cx, cy, team });
    }
  }

  hasPendingConduit(cx: number, cy: number): boolean {
    return this.pendingConduits.has(cellKey(cx, cy));
  }

  pendingConduitTeam(cx: number, cy: number): Team | null {
    return this.pendingConduits.get(cellKey(cx, cy))?.team ?? null;
  }

  pendingConduitCount(): number {
    return this.pendingConduits.size;
  }

  /**
   * Promote (cx, cy) from pending → active conduit.
   * Returns true if the pending entry existed.
   */
  promotePendingConduit(cx: number, cy: number): boolean {
    const key = cellKey(cx, cy);
    const entry = this.pendingConduits.get(key);
    if (!entry) return false;
    this.pendingConduits.delete(key);
    this.conduits.set(key, { team: entry.team, hp: 2 });
    return true;
  }

  /** Iterate all pending (not yet built) conduit cells. */
  *eachPendingConduit(): IterableIterator<{ cx: number; cy: number; team: Team }> {
    for (const entry of this.pendingConduits.values()) {
      yield entry;
    }
  }

  /** Cancel every not-yet-built conduit owned by a team. Returns the number removed. */
  cancelPendingConduits(team: Team): number {
    let removed = 0;
    for (const [key, entry] of this.pendingConduits) {
      if (entry.team !== team) continue;
      this.pendingConduits.delete(key);
      removed++;
    }
    return removed;
  }

  /** True if (cx,cy) is a conduit OR has at least one 4-adjacent conduit. */
  isOnOrAdjacentToConduit(cx: number, cy: number, team?: Team): boolean {
    const probe = (kx: number, ky: number): boolean => {
      const owner = this.conduits.get(cellKey(kx, ky));
      if (owner === undefined) return false;
      return team === undefined || owner.team === team;
    };
    return (
      probe(cx, cy) ||
      probe(cx + 1, cy) ||
      probe(cx - 1, cy) ||
      probe(cx, cy + 1) ||
      probe(cx, cy - 1)
    );
  }

  // -- Drawing --------------------------------------------------------------

  /**
   * Render the grid: faint grid lines for cells visible on screen, plus
   * filled conduit tiles coloured by their owning team. Energized player
   * conduits get a brighter outline pulse driven by `time`.
   *
   * @param time      Accumulated game time, used to drive the pulse.
   * @param isEnergized Optional predicate (cx, cy, team) → boolean. When the
   *                  predicate returns true, the conduit is rendered with
   *                  the energized colour ramp. Falls back to "always
   *                  energized" so callers that don't know about the power
   *                  graph still get a usable visual.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    screenW: number,
    screenH: number,
    time: number = 0,
    isEnergized?: (cx: number, cy: number, team: Team) => boolean,
    conduitShimmer: boolean = true,
  ): void {
    // Visible cell range (inclusive). Pad by one cell for line continuity.
    const tl = camera.screenToWorld(new Vec2(0, 0));
    const br = camera.screenToWorld(new Vec2(screenW, screenH));
    const cxMin = Math.floor(tl.x / GRID_CELL_SIZE) - 1;
    const cxMax = Math.floor(br.x / GRID_CELL_SIZE) + 1;
    const cyMin = Math.floor(tl.y / GRID_CELL_SIZE) - 1;
    const cyMax = Math.floor(br.y / GRID_CELL_SIZE) + 1;

    // 1. Conduit fills first. Iterate sparse conduit maps directly; scanning
    // every visible cell is too expensive now that cells are much smaller.
    const cellPx = GRID_CELL_SIZE * camera.zoom;
    const pulse = 0.5 + 0.5 * Math.sin(time * 2);
    for (const [key, entry] of this.conduits) {
        const comma = key.indexOf(',');
        const cx = Number(key.slice(0, comma));
        const cy = Number(key.slice(comma + 1));
        if (cx < cxMin || cx > cxMax || cy < cyMin || cy > cyMax) continue;
        const c = camera.worldToScreen(cellCenter(cx, cy));
        const energized = isEnergized ? isEnergized(cx, cy, entry.team) : true;
        this.drawConduitPanel(ctx, c.x, c.y, cellPx, cx, cy, entry.team, energized, time, pulse, conduitShimmer);

        // Inner glow square for friendly conduits — only for energized
    }

    // 1b. Pending conduits — drawn as a faint dashed outline so the player
    //     can see where conduits are queued but not yet built.
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    for (const { cx, cy } of this.pendingConduits.values()) {
      if (cx < cxMin || cx > cxMax || cy < cyMin || cy > cyMax) continue;
      const c = camera.worldToScreen(cellCenter(cx, cy));
      const phase = Math.sin(time * 5.5 + hash01(cx, cy, 0xb17d) * Math.PI * 2);
      ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, 0.24 + (conduitShimmer ? phase * 0.04 + 0.08 : 0));
      ctx.strokeRect(c.x - cellPx / 2 + 1, c.y - cellPx / 2 + 1, cellPx - 2, cellPx - 2);
    }
    ctx.setLineDash([]);

    // 2. Grid lines — only drawn when sufficiently zoomed in to avoid clutter.
    if (camera.zoom >= 1.25) {
      ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.08);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let cx = cxMin; cx <= cxMax + 1; cx++) {
        const wx = cx * GRID_CELL_SIZE;
        const a = camera.worldToScreen(new Vec2(wx, cyMin * GRID_CELL_SIZE));
        const b = camera.worldToScreen(new Vec2(wx, (cyMax + 1) * GRID_CELL_SIZE));
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      for (let cy = cyMin; cy <= cyMax + 1; cy++) {
        const wy = cy * GRID_CELL_SIZE;
        const a = camera.worldToScreen(new Vec2(cxMin * GRID_CELL_SIZE, wy));
        const b = camera.worldToScreen(new Vec2((cxMax + 1) * GRID_CELL_SIZE, wy));
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }
  }

  private drawConduitPanel(
    ctx: CanvasRenderingContext2D,
    screenX: number,
    screenY: number,
    cellPx: number,
    cx: number,
    cy: number,
    team: Team,
    energized: boolean,
    time: number,
    pulse: number,
    conduitShimmer: boolean,
  ): void {
    const x = screenX - cellPx / 2;
    const y = screenY - cellPx / 2;
    const inset = Math.max(0.4, Math.min(1.2, cellPx * 0.08));
    const panelX = x + inset;
    const panelY = y + inset;
    const panelSize = Math.max(1, cellPx - inset * 2);
    const tilt = hash01(cx, cy, 0x51f15e);
    const glint = hash01(cx, cy, 0x9e3779);
    const wave = conduitShimmer ? sheenBand(cx * 0.031 + cy * 0.047 - time * 0.32 + tilt * 0.18, 0.13) : 0;
    const localFlash = Math.pow(wave, 2.8) * (0.65 + glint * 0.35);

    // Very subtle directional "sun" reflection and tiny lens ghosts when a
    // conduit panel passes through the screen-space glint corridor.
    const sunX = ctx.canvas.width * 0.84;
    const sunY = ctx.canvas.height * 0.16;
    const toSunX = screenX - sunX;
    const toSunY = screenY - sunY;
    const sunDist = Math.hypot(toSunX, toSunY);
    const sunFalloff = Math.max(0, 1 - sunDist / (Math.min(ctx.canvas.width, ctx.canvas.height) * 0.72));
    const alignment = Math.max(0, (toSunX * -0.78 + toSunY * 0.62) / Math.max(1, sunDist));
    const solarGlare = conduitShimmer ? Math.pow(sunFalloff, 2.1) * Math.pow(alignment, 2.7) : 0;

    if (team === Team.Player) {
      const baseA = energized ? 0.42 + tilt * 0.10 : 0.16 + tilt * 0.05;
      ctx.fillStyle = `rgba(${Math.floor(6 + tilt * 18)}, ${Math.floor(80 + tilt * 50)}, ${Math.floor(112 + tilt * 80)}, ${baseA})`;
      ctx.fillRect(panelX, panelY, panelSize, panelSize);

      const blueSheen = energized ? 0.16 + pulse * 0.08 : 0.05;
      ctx.fillStyle = `rgba(150, 235, 255, ${blueSheen * (0.35 + tilt)})`;
      ctx.fillRect(panelX, panelY, panelSize, Math.max(1, panelSize * (0.28 + tilt * 0.16)));

      if (energized && localFlash > 0.01) {
        ctx.fillStyle = `rgba(235, 255, 255, ${0.10 + localFlash * 0.42})`;
        const stripeW = Math.max(1, panelSize * (0.22 + tilt * 0.18));
        const offset = (tilt - 0.5) * panelSize * 0.45;
        ctx.beginPath();
        ctx.moveTo(panelX + offset, panelY + panelSize);
        ctx.lineTo(panelX + offset + stripeW, panelY + panelSize);
        ctx.lineTo(panelX + offset + panelSize, panelY);
        ctx.lineTo(panelX + offset + panelSize - stripeW, panelY);
        ctx.closePath();
        ctx.fill();
      }

      if (energized && solarGlare > 0.002) {
        const glareAlpha = 0.012 + solarGlare * 0.095;
        const glare = ctx.createLinearGradient(panelX, panelY + panelSize, panelX + panelSize, panelY);
        glare.addColorStop(0, `rgba(168, 236, 255, ${glareAlpha * 0.14})`);
        glare.addColorStop(0.42, `rgba(230, 252, 255, ${glareAlpha})`);
        glare.addColorStop(1, `rgba(255, 255, 255, ${glareAlpha * 0.08})`);
        ctx.fillStyle = glare;
        ctx.fillRect(panelX, panelY, panelSize, panelSize);

        const ghostAlpha = Math.min(0.07, solarGlare * 0.06);
        const ghostR1 = Math.max(0.8, panelSize * (0.085 + tilt * 0.04));
        const ghostR2 = ghostR1 * 0.52;
        ctx.fillStyle = `rgba(205, 245, 255, ${ghostAlpha})`;
        ctx.beginPath();
        ctx.arc(panelX + panelSize * 0.74, panelY + panelSize * 0.22, ghostR1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255, 255, 255, ${ghostAlpha * 0.85})`;
        ctx.beginPath();
        ctx.arc(panelX + panelSize * 0.67, panelY + panelSize * 0.30, ghostR2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.strokeStyle = energized
        ? `rgba(180, 255, 255, ${0.28 + pulse * 0.16 + localFlash * 0.25})`
        : 'rgba(70, 120, 130, 0.28)';
      ctx.lineWidth = 1;
      ctx.strokeRect(panelX + 0.5, panelY + 0.5, Math.max(0, panelSize - 1), Math.max(0, panelSize - 1));
    } else {
      const baseA = energized ? 0.32 + tilt * 0.08 : 0.12 + tilt * 0.04;
      ctx.fillStyle = `rgba(${Math.floor(112 + tilt * 70)}, ${Math.floor(14 + tilt * 12)}, ${Math.floor(24 + tilt * 24)}, ${baseA})`;
      ctx.fillRect(panelX, panelY, panelSize, panelSize);
      if (energized && localFlash > 0.02) {
        ctx.fillStyle = `rgba(255, 210, 200, ${0.08 + localFlash * 0.25})`;
        ctx.fillRect(panelX, panelY, panelSize, Math.max(1, panelSize * 0.35));
      }
      ctx.strokeStyle = energized
        ? `rgba(255, 150, 140, ${0.22 + pulse * 0.12})`
        : 'rgba(130, 60, 60, 0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(panelX + 0.5, panelY + 0.5, Math.max(0, panelSize - 1), Math.max(0, panelSize - 1));
    }
  }

  /**
   * Draw a paint cursor highlighting the cell the mouse is currently over.
   * `mode` controls the colour (paint = friendly green, erase = red).
   */
  drawPaintCursor(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    cell: CellCoord,
    mode: 'paint' | 'erase',
  ): void {
    const c = camera.worldToScreen(cellCenter(cell.cx, cell.cy));
    const cellPx = GRID_CELL_SIZE * camera.zoom;
    const color =
      mode === 'paint'
        ? colorToCSS(Colors.radar_friendly_status, 0.85)
        : colorToCSS(Colors.alert1, 0.85);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(c.x - cellPx / 2, c.y - cellPx / 2, cellPx, cellPx);
    ctx.setLineDash([]);
  }
}

