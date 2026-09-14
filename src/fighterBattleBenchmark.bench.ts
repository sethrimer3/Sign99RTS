/**
 * Fighter battle performance benchmark.
 *
 * NOT part of the normal `npm test` suite (see vitest.bench.config.ts — this
 * file's `.bench.ts` suffix deliberately doesn't match vitest.config.ts's
 * `*.test.ts` glob). Run it explicitly with `npm run bench:fighters`.
 *
 * Spawns two teams of N plain FighterShips each, rallied into one tight
 * cluster so they immediately brawl at close range, and runs the real
 * simulation loop (GameState.update + updateFighterWeaponFire) plus a full
 * draw pass over every living fighter every tick, recording each tick's
 * wall-clock cost. The battle ends the instant either side drops below 5
 * living fighters, and top/low/median/mean FPS are reported for that run.
 *
 * "FPS" here is 1000 / (ms to run one sim tick + one full render pass over
 * every alive fighter, via a no-op mock CanvasRenderingContext2D). There is
 * no real GPU/canvas rasterization in this headless harness, so this is a
 * proxy for pure JS execution cost — exactly the kind of cost the
 * fighter-*-perf rounds targeted (gradient/allocation hot paths, spatial
 * index query cost, per-tick AI scans), not a substitute for an actual
 * monitor-observed frame rate. Use it to compare *relative* cost across
 * fighter counts and across code changes, not as an absolute FPS claim.
 */

import { describe, test, expect, afterAll } from 'vitest';
import { GameState } from './gamestate.js';
import { FighterShip } from './fighter.js';
import { updateFighterWeaponFire } from './fighterCombat.js';
import { createSpaceFluid } from './spacefluid.js';
import { Camera } from './camera.js';
import { Vec2 } from './math.js';
import { Team, ShipGroup } from './entities.js';
import { DT } from './constants.js';

// ---------------------------------------------------------------------------
// Headless canvas/Path2D shims — this suite runs under vitest's `node`
// environment (no DOM), but the real draw path (FighterShip.draw ->
// drawProceduralShip -> renderFieryCore etc.) calls a fixed, enumerable set
// of CanvasRenderingContext2D methods and constructs Path2D objects. Every
// method below is a genuine no-op call site exercised by that path (grepped
// across fighter.ts/proceduralShips.ts/projectileTrail.ts/buildingCoreEffect
// .ts/warmGlow.ts/particles.ts/ringeffects.ts/shipDebris.ts), so the JS cost
// of *invoking* them is still measured even though nothing is actually
// rasterized.
// ---------------------------------------------------------------------------

class MockPath2D {
  rect(): void {}
  arc(): void {}
  arcTo(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  bezierCurveTo(): void {}
  quadraticCurveTo(): void {}
  ellipse(): void {}
}
(globalThis as unknown as { Path2D: unknown }).Path2D = MockPath2D;

function makeMockCtx(): CanvasRenderingContext2D {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  return {
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop,
    rect: noop, ellipse: noop, fill: noop, stroke: noop, fillRect: noop,
    strokeRect: noop, strokeText: noop, fillText: noop, clip: noop,
    drawImage: noop, setLineDash: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1, colorSpace: 'srgb' }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    canvas: { width: 1920, height: 1080 },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    globalAlpha: 1, globalCompositeOperation: 'source-over', shadowBlur: 0, shadowColor: '',
    font: '', textAlign: 'left', textBaseline: 'alphabetic', lineDashOffset: 0,
  } as unknown as CanvasRenderingContext2D;
}

// ---------------------------------------------------------------------------
// Battle harness
// ---------------------------------------------------------------------------

const ELIMINATION_THRESHOLD = 5;
const MAX_FRAMES = 20000;
/** Real wall-clock safety net per scenario, independent of vitest's own testTimeout. */
const MAX_WALL_CLOCK_MS = 5 * 60 * 1000;

interface BattleResult {
  label: string;
  perSide: number;
  frames: number;
  simSecondsElapsed: number;
  wallClockMs: number;
  outcome: 'A' | 'B' | 'frame-cap' | 'time-cap';
  aliveA: number;
  aliveB: number;
  fps: { top: number; low: number; median: number; mean: number };
  /** Cumulative ms spent in each phase across the whole battle, for a quick "where does the time go" breakdown. */
  phaseTotalsMs: { update: number; weaponFire: number; draw: number };
  /** Sub-breakdown of `update`, summed from GameState.perfStats (see gamestate.ts) each tick. */
  updateSubTotalsMs: { fighterUpdate: number; separation: number; spatialRebuild: number; collision: number };
}

function spawnTeam(state: GameState, n: number, team: Team, rally: Vec2, enemyRally: Vec2): void {
  // Tight cluster radius so the whole team starts already packed together —
  // a "close-up battle" rallied to one point, not a spread-out approach.
  const clusterRadius = Math.max(24, Math.sqrt(n) * 6);
  for (let i = 0; i < n; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * clusterRadius;
    const pos = new Vec2(rally.x + Math.cos(angle) * r, rally.y + Math.sin(angle) * r);
    const f = new FighterShip(pos, team, ShipGroup.Red, null);
    f.launch();
    f.order = 'attack';
    f.targetPos = enemyRally.clone();
    state.addEntity(f);
  }
}

function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid];
}

function runBattle(perSide: number): BattleResult {
  const label = `${perSide}v${perSide}`;

  // Player start is parked far from the battle so the auto-created player
  // ship never becomes a stray target/obstacle for either fighter team.
  const state = new GameState(new Vec2(1_000_000, 1_000_000));
  state.gameMode = 'playing'; // 'menu' makes update() a no-op; 'practice'/'vs_ai' skip non-player-team firing.

  const spaceFluid = createSpaceFluid();
  const camera = new Camera();
  camera.setScreenSize(1920, 1080);
  camera.position = new Vec2(0, 0);

  // Rally points close together so both teams start within (or just outside)
  // weapon range of each other and immediately brawl at close quarters.
  const rallyA = new Vec2(-100, 0);
  const rallyB = new Vec2(100, 0);

  spawnTeam(state, perSide, Team.Player1, rallyA, rallyB);
  spawnTeam(state, perSide, Team.Player2, rallyB, rallyA);

  const ctx = makeMockCtx();
  const frameTimesMs: number[] = [];
  let frame = 0;
  let aliveA = perSide;
  let aliveB = perSide;
  const phaseTotalsMs = { update: 0, weaponFire: 0, draw: 0 };
  const updateSubTotalsMs = { fighterUpdate: 0, separation: 0, spatialRebuild: 0, collision: 0 };
  const wallClockStart = performance.now();

  for (;;) {
    const t0 = performance.now();

    state.update(DT);
    const t1 = performance.now();
    updateFighterWeaponFire(state, spaceFluid);
    const t2 = performance.now();
    for (const f of state.fighters) f.draw(ctx, camera);
    const t3 = performance.now();

    phaseTotalsMs.update += t1 - t0;
    phaseTotalsMs.weaponFire += t2 - t1;
    phaseTotalsMs.draw += t3 - t2;
    updateSubTotalsMs.fighterUpdate += state.perfStats.fighterUpdateMs;
    updateSubTotalsMs.separation += state.perfStats.fighterSeparationMs;
    updateSubTotalsMs.spatialRebuild += state.perfStats.spatialRebuildMs;
    updateSubTotalsMs.collision += state.perfStats.projectileCollisionMs;
    frameTimesMs.push(t3 - t0);
    frame++;

    aliveA = 0;
    aliveB = 0;
    for (const f of state.fighters) {
      if (!f.alive) continue;
      if (f.team === Team.Player1) aliveA++;
      else if (f.team === Team.Player2) aliveB++;
    }

    if (aliveA < ELIMINATION_THRESHOLD || aliveB < ELIMINATION_THRESHOLD) break;
    if (frame >= MAX_FRAMES) break;
    if (performance.now() - wallClockStart >= MAX_WALL_CLOCK_MS) break;
  }

  const wallClockMs = performance.now() - wallClockStart;
  let outcome: BattleResult['outcome'];
  if (aliveA < ELIMINATION_THRESHOLD && aliveB >= ELIMINATION_THRESHOLD) outcome = 'B';
  else if (aliveB < ELIMINATION_THRESHOLD && aliveA >= ELIMINATION_THRESHOLD) outcome = 'A';
  else if (performance.now() - wallClockStart >= MAX_WALL_CLOCK_MS) outcome = 'time-cap';
  else outcome = 'frame-cap';

  const fpsValues = frameTimesMs.map((ms) => (ms > 0 ? 1000 / ms : Number.POSITIVE_INFINITY)).filter(Number.isFinite);
  const sorted = [...fpsValues].sort((a, b) => a - b);
  const fps = {
    top: sorted.length ? sorted[sorted.length - 1] : 0,
    low: sorted.length ? sorted[0] : 0,
    median: median(sorted),
    mean: fpsValues.length ? fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length : 0,
  };

  return { label, perSide, frames: frame, simSecondsElapsed: frame * DT, wallClockMs, outcome, aliveA, aliveB, fps, phaseTotalsMs, updateSubTotalsMs };
}

function formatResult(r: BattleResult): string {
  const phaseTotal = r.phaseTotalsMs.update + r.phaseTotalsMs.weaponFire + r.phaseTotalsMs.draw;
  const pct = (ms: number) => (phaseTotal > 0 ? ((ms / phaseTotal) * 100).toFixed(0) : '0');
  const winnerText = r.outcome === 'A' || r.outcome === 'B'
    ? `Team ${r.outcome} wins`
    : r.outcome === 'frame-cap'
      ? `no winner (hit ${MAX_FRAMES}-frame safety cap)`
      : `no winner (hit ${MAX_WALL_CLOCK_MS / 1000}s wall-clock safety cap)`;
  return [
    `\n=== ${r.label} ===`,
    `  Outcome: ${winnerText} (A=${r.aliveA} alive, B=${r.aliveB} alive)`,
    `  Frames simulated: ${r.frames}  (${r.simSecondsElapsed.toFixed(1)}s sim time, ${(r.wallClockMs / 1000).toFixed(1)}s wall clock)`,
    `  FPS  top: ${r.fps.top.toFixed(1)}   low: ${r.fps.low.toFixed(1)}   median: ${r.fps.median.toFixed(1)}   mean: ${r.fps.mean.toFixed(1)}`,
    `  Phase breakdown: update ${r.phaseTotalsMs.update.toFixed(0)}ms (${pct(r.phaseTotalsMs.update)}%)   ` +
    `weaponFire ${r.phaseTotalsMs.weaponFire.toFixed(0)}ms (${pct(r.phaseTotalsMs.weaponFire)}%)   ` +
    `draw ${r.phaseTotalsMs.draw.toFixed(0)}ms (${pct(r.phaseTotalsMs.draw)}%)`,
    `  Within update: fighterUpdate(AI+nav+physics) ${r.updateSubTotalsMs.fighterUpdate.toFixed(0)}ms   ` +
    `separation ${r.updateSubTotalsMs.separation.toFixed(0)}ms   ` +
    `spatialRebuild(x3/tick) ${r.updateSubTotalsMs.spatialRebuild.toFixed(0)}ms   ` +
    `collision ${r.updateSubTotalsMs.collision.toFixed(0)}ms`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

// Override with e.g. `BENCH_SIZES=50,100 npm run bench:fighters` for a quick subset run.
// (process.env — this file is a Node-only benchmark, excluded from the main
// tsconfig like *.test.ts files, so @types/node isn't required project-wide.)
declare const process: { env: Record<string, string | undefined> };
const envSizes: number[] = (process.env.BENCH_SIZES ?? '')
  .split(',')
  .map((s: string) => Number(s.trim()))
  .filter((n: number) => Number.isFinite(n) && n > 0);
const SCENARIOS: number[] = envSizes.length > 0 ? envSizes : [50, 100, 150, 200, 300];

const results: BattleResult[] = [];

describe('Fighter battle FPS benchmark', () => {
  for (const perSide of SCENARIOS) {
    test(`${perSide}v${perSide} close-quarters battle`, () => {
      const result = runBattle(perSide);
      results.push(result);
      // eslint-disable-next-line no-console
      console.log(formatResult(result));

      // Sanity assertions, not the point of this file — a benchmark that
      // silently simulated zero frames or never engaged would be useless.
      expect(result.frames).toBeGreaterThan(0);
      expect(result.fps.mean).toBeGreaterThan(0);
    });
  }

  afterAll(() => {
    if (results.length === 0) return;
    const lines = [
      '\n\n=== Fighter battle benchmark summary ===',
      'Scenario   Frames   Outcome     FPS top    FPS low    FPS median  FPS mean',
    ];
    for (const r of results) {
      const outcomeText = r.outcome === 'A' || r.outcome === 'B' ? `Team ${r.outcome}` : r.outcome;
      lines.push(
        `${r.label.padEnd(10)} ${String(r.frames).padEnd(8)} ${outcomeText.padEnd(11)} ` +
        `${r.fps.top.toFixed(1).padEnd(10)} ${r.fps.low.toFixed(1).padEnd(10)} ${r.fps.median.toFixed(1).padEnd(11)} ${r.fps.mean.toFixed(1)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  });
});
