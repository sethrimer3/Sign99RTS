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
import { isLegacyGraphics } from './graphicsmode.js';

/** Side length of one grid cell in world units. */
export const GRID_CELL_SIZE = 26 / 3;

// --- Cached conduit solar-glare gradients ----------------------------------
//
// Cells are tiny (GRID_CELL_SIZE ~= 8.67 world units), so a mid-size base can
// have hundreds of conduit tiles on screen at once. drawConduitPanel used to
// call ctx.createLinearGradient() for every energized, sun-aligned tile every
// frame. The gradient's shape only depends on panelSize (same for every tile
// at a given zoom) and glareAlpha (bucketed below), so it's cached in LOCAL
// (0,0)-origin coordinates and reused via a canvas translate — gradient
// coordinates resolve against the CTM at fill time, not creation time.
const GLARE_GRAD_CACHE_CAP = 96;
const glareGradCache = new Map<string, CanvasGradient>();

function getGlareGradient(ctx: CanvasRenderingContext2D, panelSize: number, glareAlpha: number): CanvasGradient {
  const key = `${Math.round(panelSize)}_${Math.round(glareAlpha * 1000)}`;
  let g = glareGradCache.get(key);
  if (!g) {
    g = ctx.createLinearGradient(0, panelSize, panelSize, 0);
    g.addColorStop(0, `rgba(168, 236, 255, ${glareAlpha * 0.14})`);
    g.addColorStop(0.42, `rgba(230, 252, 255, ${glareAlpha})`);
    g.addColorStop(1, `rgba(255, 255, 255, ${glareAlpha * 0.08})`);
    if (glareGradCache.size >= GLARE_GRAD_CACHE_CAP) {
      const oldest = glareGradCache.keys().next().value;
      if (oldest !== undefined) glareGradCache.delete(oldest);
    }
    glareGradCache.set(key, g);
  }
  return g;
}

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

  /**
   * Coarse spatial index over `conduits`, bucketed into CHUNK_SIZE x CHUNK_SIZE
   * cell chunks, so the render path can iterate only the conduits near the
   * camera instead of every conduit on the map (`conduits` itself has no
   * cheap way to answer "which of these are near (x,y)" — cells are tiny, so
   * a built-out base can hold thousands of entries). Kept in sync by every
   * mutator below; `eachConduit()` / gameplay logic still walks the flat map.
   */
  private static readonly CHUNK_SIZE = 12;
  private conduitChunks = new Map<string, Map<string, CellCoord>>();

  private static chunkKeyFor(cx: number, cy: number): string {
    return `${Math.floor(cx / WorldGrid.CHUNK_SIZE)},${Math.floor(cy / WorldGrid.CHUNK_SIZE)}`;
  }

  private indexAddConduit(cx: number, cy: number): void {
    const ck = WorldGrid.chunkKeyFor(cx, cy);
    let bucket = this.conduitChunks.get(ck);
    if (!bucket) { bucket = new Map(); this.conduitChunks.set(ck, bucket); }
    bucket.set(cellKey(cx, cy), { cx, cy });
  }

  private indexRemoveConduit(cx: number, cy: number): void {
    const ck = WorldGrid.chunkKeyFor(cx, cy);
    const bucket = this.conduitChunks.get(ck);
    if (!bucket) return;
    bucket.delete(cellKey(cx, cy));
    if (bucket.size === 0) this.conduitChunks.delete(ck);
  }

  /**
   * Iterate conduits whose chunk overlaps the given cell-space rect. Coarser
   * than the rect itself (whole chunks), so callers still bounds-check each
   * yielded cell. Order is not guaranteed.
   */
  *conduitsNear(cxMin: number, cxMax: number, cyMin: number, cyMax: number): IterableIterator<{ cx: number; cy: number; team: Team }> {
    const chunkMinX = Math.floor(cxMin / WorldGrid.CHUNK_SIZE);
    const chunkMaxX = Math.floor(cxMax / WorldGrid.CHUNK_SIZE);
    const chunkMinY = Math.floor(cyMin / WorldGrid.CHUNK_SIZE);
    const chunkMaxY = Math.floor(cyMax / WorldGrid.CHUNK_SIZE);
    for (let chy = chunkMinY; chy <= chunkMaxY; chy++) {
      for (let chx = chunkMinX; chx <= chunkMaxX; chx++) {
        const bucket = this.conduitChunks.get(`${chx},${chy}`);
        if (!bucket) continue;
        for (const { cx, cy } of bucket.values()) {
          const entry = this.conduits.get(cellKey(cx, cy));
          if (entry) yield { cx, cy, team: entry.team };
        }
      }
    }
  }

  // -- Conduit accessors ----------------------------------------------------

  hasConduit(cx: number, cy: number): boolean {
    return this.conduits.has(cellKey(cx, cy));
  }

  conduitTeam(cx: number, cy: number): Team | null {
    return this.conduits.get(cellKey(cx, cy))?.team ?? null;
  }

  addConduit(cx: number, cy: number, team: Team): void {
    this.conduits.set(cellKey(cx, cy), { team, hp: 2 });
    this.indexAddConduit(cx, cy);
  }

  damageConduit(cx: number, cy: number, amount: number = 1): boolean {
    const key = cellKey(cx, cy);
    const entry = this.conduits.get(key);
    if (!entry) return false;
    entry.hp -= amount;
    if (entry.hp <= 0) {
      this.conduits.delete(key);
      this.indexRemoveConduit(cx, cy);
      return true;
    }
    return false;
  }

  removeConduit(cx: number, cy: number): void {
    this.conduits.delete(cellKey(cx, cy));
    this.indexRemoveConduit(cx, cy);
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

    for (const { cx, cy, team } of this.conduitsNear(cxMin, cxMax, cyMin, cyMax)) {
      if (dotsDrawn >= MAX_DOTS) break;
      if (cx < cxMin || cx > cxMax || cy < cyMin || cy > cyMax) continue;
      const energized = isEnergized ? isEnergized(cx, cy, team) : true;
      if (!energized) continue;

      // Each conduit cell gets a unique offset so pulses don't all align.
      const cellOffset = hash01(cx, cy, 0xf5c4d8);

      const flowDir = getFlowDir ? getFlowDir(cx, cy, team) : null;
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
        const color = team === Team.Player
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
        const color = team === Team.Player
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
    this.indexAddConduit(cx, cy);
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
   * @param revealCenter World-space centre (typically the player) that the
   *                  build-menu grid reveal expands out from / shrinks into.
   * @param revealRadius World-space radius of the reveal circle. 0 = off.
   *                  Ignored entirely in Legacy Graphics mode.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    screenW: number,
    screenH: number,
    time: number = 0,
    isEnergized?: (cx: number, cy: number, team: Team) => boolean,
    conduitShimmer: boolean = true,
    revealCenter?: Vec2,
    revealRadius: number = 0,
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
    // In non-Legacy Graphics mode the grid is only ever shown via the
    // build-menu reveal below (block 3), not unconditionally.
    const gridLineWidth = isLegacyGraphics() ? 1 : 1.5;
    if (isLegacyGraphics() && camera.zoom >= 1.25) {
      ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.08);
      ctx.lineWidth = gridLineWidth;
      ctx.beginPath();
      this.traceGridLines(ctx, camera, cxMin, cxMax, cyMin, cyMax);
      ctx.stroke();
    }

    // 3. Build-menu grid reveal — an expanding/shrinking circle of grid
    // lines centred on the player, independent of zoom level. Skipped in
    // Legacy Graphics mode so the original zoom-gated look is preserved.
    if (!isLegacyGraphics() && revealCenter && revealRadius > 0.5) {
      const centerScreen = camera.worldToScreen(revealCenter);
      const screenRadius = revealRadius * camera.zoom;
      ctx.save();
      ctx.beginPath();
      ctx.arc(centerScreen.x, centerScreen.y, screenRadius, 0, Math.PI * 2);
      ctx.clip();
      const gradient = ctx.createRadialGradient(
        centerScreen.x, centerScreen.y, 0,
        centerScreen.x, centerScreen.y, screenRadius,
      );
      gradient.addColorStop(0, colorToCSS(Colors.radar_gridlines, 0.34));
      gradient.addColorStop(0.7, colorToCSS(Colors.radar_gridlines, 0.22));
      gradient.addColorStop(1, colorToCSS(Colors.radar_gridlines, 0));
      ctx.strokeStyle = gradient;
      ctx.lineWidth = gridLineWidth;
      ctx.beginPath();
      this.traceGridLines(ctx, camera, cxMin, cxMax, cyMin, cyMax);
      ctx.stroke();
      this.drawGridSheen(ctx, camera, cxMin, cxMax, cyMin, cyMax, time);
      ctx.restore();
    }
  }

  /**
   * Faint traveling glints that slide along grid lines and fade in/out —
   * a much subtler cousin of the conduit panels' solar-glare reflections.
   * Only called in non-Legacy Graphics mode.
   */
  private drawGridSheen(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    cxMin: number,
    cxMax: number,
    cyMin: number,
    cyMax: number,
    time: number,
  ): void {
    const SHEEN_LEN_FRAC = 0.22;
    const SHEEN_SPEED = 0.16;
    const ACTIVE_FRAC = 0.5;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1.5;

    for (let cx = cxMin; cx <= cxMax + 1; cx++) {
      const seed = hash01(cx, 0, 0x3c6ef35f);
      const phase = (time * SHEEN_SPEED + seed) % 1.0;
      if (phase > ACTIVE_FRAC) continue;
      const travel = phase / ACTIVE_FRAC;
      const alpha = Math.sin(travel * Math.PI) * 0.16 * (0.4 + seed * 0.6);
      if (alpha < 0.01) continue;
      const wx = cx * GRID_CELL_SIZE;
      const a = camera.worldToScreen(new Vec2(wx, cyMin * GRID_CELL_SIZE));
      const b = camera.worldToScreen(new Vec2(wx, (cyMax + 1) * GRID_CELL_SIZE));
      const segY = a.y + (b.y - a.y) * travel;
      const halfLen = Math.abs(b.y - a.y) * SHEEN_LEN_FRAC * 0.5;
      const grad = ctx.createLinearGradient(a.x, segY - halfLen, a.x, segY + halfLen);
      grad.addColorStop(0, `rgba(220,245,255,0)`);
      grad.addColorStop(0.5, `rgba(220,245,255,${alpha})`);
      grad.addColorStop(1, `rgba(220,245,255,0)`);
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(a.x, segY - halfLen);
      ctx.lineTo(a.x, segY + halfLen);
      ctx.stroke();
    }

    for (let cy = cyMin; cy <= cyMax + 1; cy++) {
      const seed = hash01(0, cy, 0x2545f491);
      const phase = (time * SHEEN_SPEED + seed) % 1.0;
      if (phase > ACTIVE_FRAC) continue;
      const travel = phase / ACTIVE_FRAC;
      const alpha = Math.sin(travel * Math.PI) * 0.16 * (0.4 + seed * 0.6);
      if (alpha < 0.01) continue;
      const wy = cy * GRID_CELL_SIZE;
      const a = camera.worldToScreen(new Vec2(cxMin * GRID_CELL_SIZE, wy));
      const b = camera.worldToScreen(new Vec2((cxMax + 1) * GRID_CELL_SIZE, wy));
      const segX = a.x + (b.x - a.x) * travel;
      const halfLen = Math.abs(b.x - a.x) * SHEEN_LEN_FRAC * 0.5;
      const grad = ctx.createLinearGradient(segX - halfLen, a.y, segX + halfLen, a.y);
      grad.addColorStop(0, `rgba(220,245,255,0)`);
      grad.addColorStop(0.5, `rgba(220,245,255,${alpha})`);
      grad.addColorStop(1, `rgba(220,245,255,0)`);
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(segX - halfLen, a.y);
      ctx.lineTo(segX + halfLen, a.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  /** Appends vertical/horizontal grid-line segments for the visible cell range to the current path. */
  private traceGridLines(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    cxMin: number,
    cxMax: number,
    cyMin: number,
    cyMax: number,
  ): void {
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
        ctx.save();
        ctx.translate(panelX, panelY);
        ctx.fillStyle = getGlareGradient(ctx, panelSize, glareAlpha);
        ctx.fillRect(0, 0, panelSize, panelSize);
        ctx.restore();

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

