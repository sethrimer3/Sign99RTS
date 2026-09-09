/**
 * Graph-based power network for Sign99.
 *
 * Replaces the previous radius-based power check (`updateBuildingPower`) with
 * a connected-component walk over the conduit graph plus the buildings that
 * occupy or border conduit cells.
 *
 * Model
 * -----
 *  • Each building occupies the grid cell containing its position.
 *  • A `PowerGenerator` or `CommandPost` is a *source*. Its cell, plus every
 *    4-adjacent cell, is treated as energized regardless of conduits.
 *  • Conduits owned by a team form an undirected graph by 4-adjacency.
 *    Any conduit cell that is adjacent to a source cell is energized; energy
 *    propagates along same-team conduits via flood-fill.
 *  • A non-source building is `powered` iff its containing cell is in the
 *    energized set OR is adjacent to it.
 *
 * The graph is recomputed whenever the dirty flag is set, which happens on
 * any building add/remove or conduit edit. Because the player's footprint
 * is small (tens to low hundreds of cells), a fresh BFS each tick is cheap;
 * the dirty flag avoids redundant work between events.
 */

import { Team, EntityType } from './entities.js';
import type { GameState } from './gamestate.js';
import { cellKey } from './grid.js';
import type { BuildingBase } from './building.js';
import { footprintForBuilding } from './buildingfootprint.js';
import { isSynonymousFaction } from './confluence.js';
import { buildingFootprintOrigin } from './buildingCollision.js';

/** Per-team energized cell set. Keys are `cellKey(cx, cy)`. */
export interface PowerSnapshot {
  energized: Map<Team, Set<string>>;
  /** True if the player's network has at least one live source. */
  playerHasSource: boolean;
  /** Total live player conduit cells in the energized set (for HUD). */
  playerEnergizedCount: number;
}

export class PowerGraph {
  private dirty = true;
  private snapshot: PowerSnapshot = {
    energized: new Map(),
    playerHasSource: false,
    playerEnergizedCount: 0,
  };
  /** Per-team BFS flow direction per conduit cell (points FROM source TOWARD leaf). */
  private flowDirs: Map<Team, Map<string, { dx: number; dy: number }>> = new Map();

  /** Mark the graph as needing a recompute. Called on any building/conduit change. */
  markDirty(): void {
    this.dirty = true;
  }

  /** Most recent snapshot (or a stale one if {@link markDirty} hasn't fired). */
  current(): PowerSnapshot {
    return this.snapshot;
  }

  /** True if the cell at (cx, cy) is in the energized set for `team`. */
  isCellEnergized(team: Team, cx: number, cy: number): boolean {
    const set = this.snapshot.energized.get(team);
    return set !== undefined && set.has(cellKey(cx, cy));
  }

  /**
   * BFS flow direction at (cx, cy) for `team`: the unit step that energy
   * travels along this conduit cell (FROM source TOWARD leaf buildings).
   * Returns null for source-adjacent cells or cells not in the flow tree.
   */
  getFlowDir(team: Team, cx: number, cy: number): { dx: number; dy: number } | null {
    return this.flowDirs.get(team)?.get(cellKey(cx, cy)) ?? null;
  }

  /**
   * Recompute energized cells (per team) and update each building's
   * `powered` flag. Idempotent; cheap when dirty flag is clear.
   */
  recompute(state: GameState): void {
    if (!this.dirty) {
      // Clean frames keep cached powered flags. GameState marks this dirty
      // when a source finishes construction or topology changes.
      return;
    }
    this.dirty = false;

    // 1. Bucket all conduit cells by team for O(1) adjacency tests.
    const conduitCellsByTeam = new Map<Team, Map<string, { cx: number; cy: number }>>();
    for (const c of state.grid.eachConduit()) {
      let bucket = conduitCellsByTeam.get(c.team);
      if (bucket === undefined) {
        bucket = new Map();
        conduitCellsByTeam.set(c.team, bucket);
      }
      bucket.set(cellKey(c.cx, c.cy), { cx: c.cx, cy: c.cy });
    }

    // 2. Sources: CommandPost + PowerGenerator cells, by team.
    const sourceCells = new Map<Team, Array<{ cx: number; cy: number }>>();
    for (const b of state.buildings) {
      if (!b.alive) continue;
      if (isSynonymousFaction(state.factionByTeam, b.team)) {
        b.powered = true;
        continue;
      }
      if (
        b.type !== EntityType.CommandPost &&
        b.type !== EntityType.PowerGenerator
      ) {
        continue;
      }
      // PR5: a generator that is still under construction does not yet
      // supply power. Command posts never block here — they always supply.
      if (b.type === EntityType.PowerGenerator && b.buildProgress < 1) continue;
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

    // 3. BFS per team.
    // Reusable direction objects for the 4 cardinal directions to avoid
    // allocating a new object for every conduit cell discovered.
    const DIR_RIGHT = { dx: 1, dy: 0 };
    const DIR_LEFT  = { dx: -1, dy: 0 };
    const DIR_DOWN  = { dx: 0, dy: 1 };
    const DIR_UP    = { dx: 0, dy: -1 };
    const energized = new Map<Team, Set<string>>();
    const newFlowDirs = new Map<Team, Map<string, { dx: number; dy: number }>>();
    for (const [team, sources] of sourceCells) {
      const conduitMap = conduitCellsByTeam.get(team) ?? new Map();
      const visited = new Set<string>();
      const queue: Array<{ cx: number; cy: number }> = [];
      const teamFlowDirs = new Map<string, { dx: number; dy: number }>();

      // Seed: source cells and their 4-neighbours (so an adjacent conduit
      // immediately bordering a generator gets energized even without the
      // generator itself being a conduit).
      const seed = (cx: number, cy: number) => {
        const k = cellKey(cx, cy);
        if (!visited.has(k)) {
          visited.add(k);
          queue.push({ cx, cy });
        }
      };
      for (const s of sources) {
        seed(s.cx, s.cy);
        seed(s.cx + 1, s.cy);
        seed(s.cx - 1, s.cy);
        seed(s.cx, s.cy + 1);
        seed(s.cx, s.cy - 1);
      }

      // Flood through team-owned conduits, recording BFS parent direction
      // (points FROM source TOWARD the cell, i.e. energy flow direction).
      for (let head = 0; head < queue.length; head++) {
        const cur = queue[head];
        visitConduitNeighbour(cur.cx + 1, cur.cy, DIR_RIGHT);
        visitConduitNeighbour(cur.cx - 1, cur.cy, DIR_LEFT);
        visitConduitNeighbour(cur.cx, cur.cy + 1, DIR_DOWN);
        visitConduitNeighbour(cur.cx, cur.cy - 1, DIR_UP);
      }

      energized.set(team, visited);
      newFlowDirs.set(team, teamFlowDirs);

      function visitConduitNeighbour(nx: number, ny: number, dir: { dx: number; dy: number }): void {
        const nk = cellKey(nx, ny);
        if (visited.has(nk)) return;
        if (!conduitMap.has(nk)) return;
        visited.add(nk);
        teamFlowDirs.set(nk, dir);
        queue.push({ cx: nx, cy: ny });
      }
    }
    this.flowDirs = newFlowDirs;

    // 4. Snapshot stats for HUD.
    const playerSet = energized.get(Team.Player);
    this.snapshot = {
      energized,
      playerHasSource: (sourceCells.get(Team.Player)?.length ?? 0) > 0,
      playerEnergizedCount: playerSet?.size ?? 0,
    };

    this.applyBuildingPower(state);
  }

  /** Set each building's `powered` flag based on the current snapshot.
   *  Detects power-loss transitions and emits a blackout ripple at any
   *  enemy building that just went dark, giving the player visible
   *  confirmation that severing a conduit had an effect. */
  private applyBuildingPower(state: GameState): void {
    for (const b of state.buildings) {
      if (!b.alive) continue;
      const wasPowered = b.powered;
      if (isSynonymousFaction(state.factionByTeam, b.team)) {
        b.powered = true;
        continue;
      }
      // Sources self-power. Shipyards are NOT self-powered any more —
      // they must connect to the conduit network like every other
      // consumer. This lets builder-grown enemy bases be cut off by
      // the player attacking conduits or generators, and applies the
      // same rule symmetrically to the player's network.
      if (
        b.type === EntityType.CommandPost ||
        b.type === EntityType.PowerGenerator ||
        b.type === EntityType.Wall
      ) {
        b.powered = true;
      } else {
        b.powered = this.buildingIsEnergized(b);
      }
      // Power-loss transition: emit blackout ripple. Only do this for
      // *enemy* buildings — losing power on a player building is the
      // player's own doing and doesn't need the same alert visual.
      if (wasPowered && !b.powered && b.team === Team.Enemy) {
        state.ringEffects.spawnBlackout(b.position, 6, 70, 0.8, 1.0);
      }
    }
  }

  private buildingIsEnergized(b: BuildingBase): boolean {
    const set = this.snapshot.energized.get(b.team);
    if (!set || set.size === 0) return false;
    const size = footprintForBuilding(b);
    const origin = buildingFootprintOrigin(b);
    for (let y = origin.cy - 1; y <= origin.cy + size; y++) {
      for (let x = origin.cx - 1; x <= origin.cx + size; x++) {
        if (set.has(cellKey(x, y))) return true;
      }
    }
    return false;
    // Cell or any 4-neighbour energized → powered.
  }
}

