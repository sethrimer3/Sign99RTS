/**
 * Enemy strategic AI for Sign99 (PR6).
 *
 * Drives one enemy team:
 *   • Periodically (every TICK_INTERVAL_S) walks the heat map and tries to
 *     extend its conduit network *away from* its CommandPost in the safest
 *     direction. New conduits cost nothing for the AI (they'd need a
 *     resource economy hookup; PR6 keeps it simple — the AI grows its grid
 *     freely while the player must paint).
 *   • When the network is large enough, builds a Missile/Exciter turret at
 *     a network frontier cell that minimises the AI's own threat — i.e.
 *     where the player can't easily blow it up.
 *   • Tactical fighter dispatch: every fighter without an explicit target
 *     is sent to the highest-opportunity player asset cell.
 *
 * This is intentionally "minimum-viable": it gives enemy bases a sense of
 * agency (they spread, they fortify, they dispatch) without trying to be
 * a balanced opponent. Tuning lives in the constants at the top.
 */

import { Vec2 } from './math.js';
import { Team, EntityType } from './entities.js';
import type { GameState } from './gamestate.js';
import type { Camera } from './camera.js';
import { CommandPost } from './building.js';
import { GatlingTurret, MissileTurret, ExciterTurret, MassDriverTurret, TetherTurret } from './turret.js';
import { GRID_CELL_SIZE, cellCenter, cellKey } from './grid.js';
import { AIScore, cellOf } from './aiscore.js';

const TICK_INTERVAL_S = 2.5;
/** Max conduits this AI will paint, total. Caps cost. */
const MAX_AI_CONDUITS = 60;
/** Max turrets the AI will spawn. */
const MAX_AI_TURRETS = 6;

export class EnemyAI {
  readonly team: Team;
  private timer = 0;
  private score = new AIScore();
  /** Fighter dispatch cooldown, so we don't repath every tick. */
  private dispatchTimer = 0;

  constructor(team: Team) {
    this.team = team;
  }

  update(state: GameState, dt: number): void {
    this.timer -= dt;
    this.dispatchTimer -= dt;
    if (this.timer <= 0) {
      this.timer = TICK_INTERVAL_S;
      this.score.invalidate();
      this.expandNetwork(state);
      this.maybeBuildTurret(state);
    }
    if (this.dispatchTimer <= 0) {
      this.dispatchTimer = 1.0;
      this.dispatchFighters(state);
    }
  }

  // -- Network expansion ---------------------------------------------------

  /** All command posts of this team. */
  private myCommandPosts(state: GameState): CommandPost[] {
    return state.buildings.filter(
      (b) => b.alive && b.type === EntityType.CommandPost && b.team === this.team,
    ) as CommandPost[];
  }

  /** Total conduit count painted by this AI. */
  private myConduitCount(state: GameState): number {
    let n = 0;
    for (const c of state.grid.eachConduit()) {
      if (c.team === this.team) n++;
    }
    return n;
  }

  /**
   * Pick a frontier cell adjacent to an existing AI conduit (or to the CP
   * if none exist yet) that minimises threat, and paint it.
   */
  private expandNetwork(state: GameState): void {
    if (this.myConduitCount(state) >= MAX_AI_CONDUITS) return;

    const cps = this.myCommandPosts(state);
    if (cps.length === 0) return;

    // Build a set of frontier candidates: empty cells 4-adjacent to any
    // existing AI conduit OR the CP cell.
    const frontier: Array<{ cx: number; cy: number }> = [];
    const seen = new Set<string>();
    const consider = (cx: number, cy: number) => {
      const k = cellKey(cx, cy);
      if (seen.has(k)) return;
      if (state.grid.hasConduit(cx, cy)) return; // already painted
      seen.add(k);
      frontier.push({ cx, cy });
    };

    for (const cp of cps) {
      const c = cellOf(cp.position);
      consider(c.cx + 1, c.cy);
      consider(c.cx - 1, c.cy);
      consider(c.cx, c.cy + 1);
      consider(c.cx, c.cy - 1);
    }
    for (const c of state.grid.eachConduit()) {
      if (c.team !== this.team) continue;
      consider(c.cx + 1, c.cy);
      consider(c.cx - 1, c.cy);
      consider(c.cx, c.cy + 1);
      consider(c.cx, c.cy - 1);
    }
    if (frontier.length === 0) return;

    // Bias: among the safe candidates, prefer those *closer to the player*
    // so the network grows outward instead of inward.
    const playerPos = state.player.alive ? state.player.position : null;
    const ranked = frontier
      .map((f) => {
        const threat = this.score.threatAt(state, this.team, f.cx, f.cy);
        const wp = cellCenter(f.cx, f.cy);
        const distToPlayer = playerPos ? wp.distanceTo(playerPos) : 0;
        // Lower score = safer + closer to player. Threat dominates.
        return { f, key: threat * 4 + distToPlayer * 0.01 };
      })
      .sort((a, b) => a.key - b.key);

    const chosen = ranked[0].f;
    state.grid.addConduit(chosen.cx, chosen.cy, this.team);
    state.power.markDirty();
  }

  // -- Turret construction -------------------------------------------------

  private myTurretCount(state: GameState): number {
    let n = 0;
    for (const b of state.buildings) {
      if (!b.alive || b.team !== this.team) continue;
      if (
        b.type === EntityType.MissileTurret ||
        b.type === EntityType.GatlingTurret ||
        b.type === EntityType.ExciterTurret ||
        b.type === EntityType.MassDriverTurret ||
        b.type === EntityType.TetherTurret
      ) n++;
    }
    return n;
  }

  /** Build at most one new turret on a safe frontier cell, if eligible. */
  private maybeBuildTurret(state: GameState): void {
    if (this.myTurretCount(state) >= MAX_AI_TURRETS) return;
    if (this.myConduitCount(state) < 6) return; // need some footprint first

    // Candidate placement cells: any AI conduit cell that does not already
    // have a building on it.
    const occupied = new Set<string>();
    for (const b of state.buildings) {
      if (!b.alive) continue;
      const c = cellOf(b.position);
      occupied.add(cellKey(c.cx, c.cy));
    }
    const candidates: Array<{ cx: number; cy: number }> = [];
    for (const c of state.grid.eachConduit()) {
      if (c.team !== this.team) continue;
      if (occupied.has(cellKey(c.cx, c.cy))) continue;
      candidates.push({ cx: c.cx, cy: c.cy });
    }
    if (candidates.length === 0) return;

    // For a *defensive* turret we want LOW threat (player turrets can't
    // reach it). For an offensive turret we'd want HIGH opportunity. Mix:
    // pick the candidate with the lowest threat that's still in the half
    // of the list closest to the player.
    const safe = this.score.bestSafeCell(state, this.team, candidates);
    if (!safe) return;

    const pos = cellCenter(safe.cx, safe.cy);
    // Cycle turret types so a base doesn't end up all-missile.
    const turretCount = this.myTurretCount(state);
    const types = [GatlingTurret, MissileTurret, ExciterTurret, MassDriverTurret, TetherTurret];
    const TurretClass = types[turretCount % types.length];
    const turret = new TurretClass(pos, this.team);
    turret.buildProgress = 0; // visible construction
    state.addEntity(turret);
    state.recentEnemyConstructions.push({ pos: pos.clone(), time: state.gameTime });
  }

  // -- Tactical fighter dispatch ------------------------------------------

  /** Send idle/order-less fighters toward the highest-opportunity target. */
  private dispatchFighters(state: GameState): void {
    const myFighters = state.fighters.filter(
      (f) => f.alive && f.team === this.team && !f.docked,
    );
    if (myFighters.length === 0) return;

    // Candidate target cells: every player building's cell.
    const candidates: Array<{ cx: number; cy: number; pos: Vec2 }> = [];
    for (const b of state.buildings) {
      if (!b.alive) continue;
      if (b.team === this.team || b.team === Team.Neutral) continue;
      const c = cellOf(b.position);
      candidates.push({ cx: c.cx, cy: c.cy, pos: b.position.clone() });
    }
    if (candidates.length === 0) return;

    const scored = candidates
      .map((c) => {
        const opportunity = this.score.bestAttackTarget(state, this.team, [c])?.score ?? 0;
        let route = 0;
        for (const f of myFighters.slice(0, Math.min(4, myFighters.length))) {
          route += state.scoreShipRoute(f.position, c.pos, f.team, f.radius, 2);
        }
        route /= Math.max(1, Math.min(4, myFighters.length));
        return { target: c, score: opportunity * 130 - route };
      })
      .sort((a, b) => b.score - a.score);
    const target = scored[0]?.target;
    if (!target) return;

    for (const f of myFighters) {
      // Only override fighters that don't already have a fresh target.
      if (f.order === 'attack' && f.targetPos) {
        // Drop stale targets (target dead / very far from old target).
        const dist = f.targetPos.distanceTo(target.pos);
        if (dist < GRID_CELL_SIZE * 4) continue;
      }
      f.order = 'attack';
      f.targetPos = target.pos.clone();
    }
  }

  // -- Helpers used by callers --------------------------------------------

  /** Has the AI's command post been destroyed (game-over check). */
  isDefeated(state: GameState): boolean {
    return this.myCommandPosts(state).length === 0;
  }

  /** Render a translucent debug threat map near the player's screen. */
  drawDebugOverlay(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    camera: Camera,
    screenW: number,
    screenH: number,
  ): void {
    const tl = camera.screenToWorld(new Vec2(0, 0));
    const br = camera.screenToWorld(new Vec2(screenW, screenH));
    const cxMin = Math.floor(tl.x / GRID_CELL_SIZE);
    const cxMax = Math.floor(br.x / GRID_CELL_SIZE);
    const cyMin = Math.floor(tl.y / GRID_CELL_SIZE);
    const cyMax = Math.floor(br.y / GRID_CELL_SIZE);
    const cellPx = GRID_CELL_SIZE * camera.zoom;
    for (let cy = cyMin; cy <= cyMax; cy++) {
      for (let cx = cxMin; cx <= cxMax; cx++) {
        const t = this.score.threatAt(state, this.team, cx, cy);
        if (t < 1) continue;
        const a = Math.min(0.5, t / 80);
        const c = camera.worldToScreen(cellCenter(cx, cy));
        ctx.fillStyle = `rgba(255, 80, 0, ${a.toFixed(3)})`;
        ctx.fillRect(c.x - cellPx / 2, c.y - cellPx / 2, cellPx, cellPx);
      }
    }
  }
}

