/**
 * Bright Matter network for Sign99.
 *
 * Bright Matter is a secondary, rarer resource produced by Particle
 * Accelerator buildings. Unlike the power grid (src/power.ts), only the
 * Command Post counts as a source here — a Power Generator does not supply
 * enough energy to seed a Bright link, so accelerators wired only to a
 * generator produce nothing.
 *
 * Model
 * -----
 *  • BFS floods outward from the team's Command Post cells across that
 *    team's conduit graph (the same conduits used for power).
 *  • A Particle Accelerator is "linked" iff a cell it (or its footprint)
 *    borders is reached by the flood.
 *  • Each linked accelerator's path length is its BFS distance (in conduit
 *    cells) back to the Command Post. Bright income scales with the sum of
 *    every linked accelerator's path length — longer conduit runs, and more
 *    of them, yield more Bright.
 *  • The BFS parent chain is retained so callers (rendering) can walk the
 *    exact cell-by-cell route from the Command Post out to each
 *    accelerator, for drawing a smooth glowing path.
 */

import { Team, EntityType, type BrightLinkState } from './entities.js';
import type { GameState } from './gamestate.js';
import { cellKey, cellCenter } from './grid.js';
import { Vec2 } from './math.js';
import type { BuildingBase } from './building.js';
import { footprintForBuilding } from './buildingfootprint.js';
import { isSynonymousFaction } from './confluence.js';
import { buildingFootprintOrigin } from './buildingCollision.js';
import { BRIGHT_GAIN_PER_LOOP_LENGTH } from './constants.js';

export interface BrightAcceleratorLink {
  building: BuildingBase;
  pathLength: number;
  /** World-space centers of every conduit cell from the Command Post out to this accelerator, in order. */
  path: Vec2[];
}

export interface BrightSnapshot {
  /** Linked accelerators per team, for income and rendering. */
  linksByTeam: Map<Team, BrightAcceleratorLink[]>;
  /** Sum of pathLength across every linked accelerator, per team. */
  totalPathLengthByTeam: Map<Team, number>;
}

export class BrightGraph {
  private dirty = true;
  private snapshot: BrightSnapshot = {
    linksByTeam: new Map(),
    totalPathLengthByTeam: new Map(),
  };

  /** Mark the graph as needing a recompute. Called alongside PowerGraph.markDirty(). */
  markDirty(): void {
    this.dirty = true;
  }

  current(): BrightSnapshot {
    return this.snapshot;
  }

  /** Sum of connected accelerator path lengths for `team` (0 if none). */
  totalPathLength(team: Team): number {
    return this.snapshot.totalPathLengthByTeam.get(team) ?? 0;
  }

  recompute(state: GameState): void {
    if (!this.dirty) return;
    this.dirty = false;

    // 1. Bucket conduit cells by team.
    const conduitCellsByTeam = new Map<Team, Map<string, { cx: number; cy: number }>>();
    for (const c of state.grid.eachConduit()) {
      let bucket = conduitCellsByTeam.get(c.team);
      if (bucket === undefined) {
        bucket = new Map();
        conduitCellsByTeam.set(c.team, bucket);
      }
      bucket.set(cellKey(c.cx, c.cy), { cx: c.cx, cy: c.cy });
    }

    // 2. Sources: Command Post cells only (not Power Generator).
    const sourceCells = new Map<Team, Array<{ cx: number; cy: number }>>();
    const accelerators = new Map<Team, BuildingBase[]>();
    for (const b of state.buildings) {
      if (!b.alive) continue;
      if (isSynonymousFaction(state.factionByTeam, b.team)) continue;
      if (b.type === EntityType.ParticleAccelerator) {
        let arr = accelerators.get(b.team);
        if (arr === undefined) {
          arr = [];
          accelerators.set(b.team, arr);
        }
        arr.push(b);
        continue;
      }
      if (b.type !== EntityType.CommandPost) continue;
      let arr = sourceCells.get(b.team);
      if (arr === undefined) {
        arr = [];
        sourceCells.set(b.team, arr);
      }
      const size = footprintForBuilding(b);
      const origin = buildingFootprintOrigin(b);
      for (let y = origin.cy; y < origin.cy + size; y++) {
        for (let x = origin.cx; x < origin.cx + size; x++) {
          arr.push({ cx: x, cy: y });
        }
      }
    }

    const linksByTeam = new Map<Team, BrightAcceleratorLink[]>();
    const totalPathLengthByTeam = new Map<Team, number>();

    for (const [team, accels] of accelerators) {
      // Clear stale link state up front; only accelerators reached below get updated.
      for (const acc of accels) {
        acc.brightLink = { connected: false, pathLength: 0 };
      }

      const sources = sourceCells.get(team);
      if (!sources || sources.length === 0) continue;
      const conduitMap = conduitCellsByTeam.get(team) ?? new Map();

      // BFS from Command Post cells across this team's conduits, tracking
      // distance and parent so we can reconstruct the route to each accelerator.
      const dist = new Map<string, number>();
      const parent = new Map<string, string | null>();
      const queue: Array<{ cx: number; cy: number }> = [];

      const seed = (cx: number, cy: number) => {
        const k = cellKey(cx, cy);
        if (!dist.has(k)) {
          dist.set(k, 0);
          parent.set(k, null);
          queue.push({ cx, cy });
        }
      };
      for (const s of sources) seed(s.cx, s.cy);

      for (let head = 0; head < queue.length; head++) {
        const cur = queue[head];
        const curKey = cellKey(cur.cx, cur.cy);
        const curDist = dist.get(curKey)!;
        const neighbours: Array<[number, number]> = [
          [cur.cx + 1, cur.cy], [cur.cx - 1, cur.cy],
          [cur.cx, cur.cy + 1], [cur.cx, cur.cy - 1],
        ];
        for (const [nx, ny] of neighbours) {
          const nk = cellKey(nx, ny);
          if (dist.has(nk)) continue;
          if (!conduitMap.has(nk)) continue;
          dist.set(nk, curDist + 1);
          parent.set(nk, curKey);
          queue.push({ cx: nx, cy: ny });
        }
      }

      const teamLinks: BrightAcceleratorLink[] = [];
      let teamTotal = 0;

      for (const acc of accels) {
        const size = footprintForBuilding(acc);
        const origin = buildingFootprintOrigin(acc);
        let bestKey: string | null = null;
        let bestDist = Infinity;
        for (let y = origin.cy - 1; y <= origin.cy + size; y++) {
          for (let x = origin.cx - 1; x <= origin.cx + size; x++) {
            const k = cellKey(x, y);
            const d = dist.get(k);
            if (d !== undefined && d < bestDist) {
              bestDist = d;
              bestKey = k;
            }
          }
        }
        if (bestKey === null) continue;

        // Walk the parent chain from bestKey back to the source, then reverse.
        const path: Vec2[] = [];
        let cur: string | null = bestKey;
        while (cur !== null) {
          const comma = cur.indexOf(',');
          const cx = Number(cur.slice(0, comma));
          const cy = Number(cur.slice(comma + 1));
          path.push(cellCenter(cx, cy));
          cur = parent.get(cur) ?? null;
        }
        path.reverse();
        path.push(acc.position.clone());

        const pathLength = bestDist + 1;
        acc.brightLink = { connected: true, pathLength };
        teamLinks.push({ building: acc, pathLength, path });
        teamTotal += pathLength;
      }

      linksByTeam.set(team, teamLinks);
      totalPathLengthByTeam.set(team, teamTotal);
    }

    this.snapshot = { linksByTeam, totalPathLengthByTeam };
  }
}

// ---------------------------------------------------------------------------
// Spline-loop racetrack: income model.
//
// Bright income no longer depends on the conduit BFS above — it depends on
// the "spline loop" racetrack that visually connects every Bright
// Accelerator a team owns (see brightPathRender.ts for the particle
// animation). At least 2 accelerators are required to form a loop and start
// earning; income scales with the loop's total length times
// (accelerator count - 1), rewarding placing more of them.
// ---------------------------------------------------------------------------

export interface BrightLoop {
  /** Smoothed closed polyline through every accelerator position (first point repeated at the end). */
  points: Vec2[];
  /** Total length of the loop, in world units. */
  length: number;
}

/**
 * Order points clockwise around their centroid, ascending by angle. World Y
 * increases downward, so ascending atan2(dy, dx) sweeps clockwise as drawn
 * on screen.
 */
function orderClockwise(points: Vec2[]): Vec2[] {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return points
    .slice()
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

/** Catmull-Rom spline through a closed loop of `points` (wraps around), `segmentsPerSpan` subdivisions between each pair. Requires at least 3 points. */
function smoothLoopPath(points: Vec2[], segmentsPerSpan: number = 14): Vec2[] {
  const n = points.length;
  const out: Vec2[] = [];
  const get = (i: number): Vec2 => points[((i % n) + n) % n];
  for (let i = 0; i < n; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let s = 0; s < segmentsPerSpan; s++) {
      const t = s / segmentsPerSpan;
      const t2 = t * t, t3 = t2 * t;
      const x = 0.5 * (
        2 * p1.x + (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      );
      const y = 0.5 * (
        2 * p1.y + (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      );
      out.push(new Vec2(x, y));
    }
  }
  out.push(out[0].clone());
  return out;
}

/**
 * A rounded "stadium" racetrack around the segment between two accelerators
 * — two semicircular caps joined by straight sides — so exactly 2
 * accelerators already form a real, non-degenerate loop rather than a
 * back-and-forth line.
 */
function stadiumLoop(a: Vec2, b: Vec2, segments: number = 24): Vec2[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist, uy = dy / dist;
  const px = -uy, py = ux; // perpendicular to a->b
  const r = Math.max(24, Math.min(70, dist * 0.28));
  const thetaPerp = Math.atan2(py, px);

  const points: Vec2[] = [];
  points.push(new Vec2(a.x + px * r, a.y + py * r));
  points.push(new Vec2(b.x + px * r, b.y + py * r));
  for (let i = 1; i <= segments; i++) {
    const t = thetaPerp - (Math.PI * i) / segments;
    points.push(new Vec2(b.x + Math.cos(t) * r, b.y + Math.sin(t) * r));
  }
  points.push(new Vec2(a.x - px * r, a.y - py * r));
  for (let i = 1; i <= segments; i++) {
    const t = thetaPerp - Math.PI - (Math.PI * i) / segments;
    points.push(new Vec2(a.x + Math.cos(t) * r, a.y + Math.sin(t) * r));
  }
  return points;
}

/**
 * Compute the spline-loop racetrack through `positions`. Returns null with
 * fewer than 2 positions (no loop possible). Exactly 2 positions produce a
 * rounded stadium loop; 3 or more produce a Catmull-Rom loop through the
 * positions ordered clockwise around their centroid.
 */
export function computeBrightLoop(positions: Vec2[]): BrightLoop | null {
  if (positions.length < 2) return null;
  const points = positions.length === 2
    ? stadiumLoop(positions[0], positions[1])
    : smoothLoopPath(orderClockwise(positions));
  let length = 0;
  for (let i = 1; i < points.length; i++) length += points[i].distanceTo(points[i - 1]);
  if (length <= 0) return null;
  return { points, length };
}

/** Every alive, non-synonymous Bright Accelerator position owned by `team`. */
export function brightAcceleratorPositions(state: GameState, team: Team): Vec2[] {
  const positions: Vec2[] = [];
  for (const b of state.buildings) {
    if (!b.alive || b.type !== EntityType.ParticleAccelerator) continue;
    if (b.team !== team) continue;
    if (isSynonymousFaction(state.factionByTeam, b.team)) continue;
    positions.push(b.position);
  }
  return positions;
}

/** Bright income per second for a set of accelerator positions: loop length x (count - 1). */
export function brightIncomeForPositions(positions: Vec2[]): number {
  if (positions.length < 2) return 0;
  const loop = computeBrightLoop(positions);
  if (loop === null) return 0;
  return BRIGHT_GAIN_PER_LOOP_LENGTH * loop.length * (positions.length - 1);
}

/**
 * Bright income delta if a new accelerator were placed at `candidatePos` for
 * `team`, compared to its current income. Used to preview the addition to
 * income per second before the player commits to a placement.
 */
export function previewBrightIncomeDelta(state: GameState, team: Team, candidatePos: Vec2): number {
  const positions = brightAcceleratorPositions(state, team);
  const currentIncome = brightIncomeForPositions(positions);
  const newIncome = brightIncomeForPositions([...positions, candidatePos]);
  return newIncome - currentIncome;
}
