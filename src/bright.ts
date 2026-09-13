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
