/**
 * Visuals for the Bright Matter network (see src/bright.ts).
 *
 * Draws a single smooth, glowing line connecting every Particle Accelerator
 * that is directly linked to the Command Post, plus fast glowing particles
 * with long trails traveling along that line — a visible, literal read of
 * "exotic matter flowing in from the accelerators."
 *
 * Also draws the "spline loop": an invisible closed racetrack looping
 * clockwise through every Bright Accelerator a team owns (independent of
 * whether they're conduit-linked), with a river of glowing particles
 * flowing around it — see the "River flow" section below for how that
 * current is simulated.
 */

import { Vec2 } from './math.js';
import { Camera } from './camera.js';
import { Colors, colorToCSS } from './colors.js';
import { Team, EntityType } from './entities.js';
import type { GameState } from './gamestate.js';
import { computeBrightLoop } from './bright.js';

/** Catmull-Rom spline through `points`, `segmentsPerSpan` subdivisions between each pair. */
function smoothPath(points: Vec2[], segmentsPerSpan: number = 10): Vec2[] {
  if (points.length < 2) return points.slice();
  const out: Vec2[] = [];
  const get = (i: number): Vec2 => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i++) {
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
  out.push(points[points.length - 1].clone());
  return out;
}

function pathLengthOf(points: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += points[i].distanceTo(points[i - 1]);
  return len;
}

/** Point at fractional arc-length `frac` (0..1) along `points`, by cumulative distance. */
function pointAtFrac(points: Vec2[], cumLen: number[], totalLen: number, frac: number): Vec2 {
  if (totalLen <= 0 || points.length === 0) return points[0] ?? new Vec2(0, 0);
  const target = ((frac % 1) + 1) % 1 * totalLen;
  let lo = 0, hi = cumLen.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumLen[mid] < target) lo = mid + 1; else hi = mid;
  }
  const i = Math.max(1, lo);
  const segLen = cumLen[i] - cumLen[i - 1];
  const t = segLen > 0 ? (target - cumLen[i - 1]) / segLen : 0;
  const a = points[i - 1], b = points[i];
  return new Vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
}

const PARTICLES_PER_LINK = 3;
const PARTICLE_SPEED_WORLD_PER_SEC = 90;
const TRAIL_SAMPLES = 10;
const TRAIL_SPACING_FRAC = 0.012;

export function drawBrightPaths(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  state: GameState,
  time: number,
): void {
  const snapshot = state.bright.current();
  for (const [team, links] of snapshot.linksByTeam) {
    if (links.length === 0) continue;
    const color = team === Team.Player ? Colors.bright_matter : { r: 255, g: 150, b: 220, intensity: 1.0 };

    for (const link of links) {
      if (link.path.length < 2) continue;
      const smooth = smoothPath(link.path);
      const cum: number[] = [0];
      for (let i = 1; i < smooth.length; i++) cum.push(cum[i - 1] + smooth[i].distanceTo(smooth[i - 1]));
      const totalLen = cum[cum.length - 1];
      if (totalLen <= 0) continue;

      // Smooth glowing line.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < smooth.length; i++) {
        const s = camera.worldToScreen(smooth[i]);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      }
      ctx.strokeStyle = colorToCSS(color, 0.10);
      ctx.lineWidth = 6 * camera.zoom;
      ctx.stroke();
      ctx.strokeStyle = colorToCSS(color, 0.55);
      ctx.lineWidth = 2 * camera.zoom;
      ctx.stroke();
      ctx.restore();

      // Traveling glowing particles with fading trails.
      const speedFrac = PARTICLE_SPEED_WORLD_PER_SEC / totalLen;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let p = 0; p < PARTICLES_PER_LINK; p++) {
        const headFrac = time * speedFrac + p / PARTICLES_PER_LINK;
        for (let tIdx = 0; tIdx < TRAIL_SAMPLES; tIdx++) {
          const frac = headFrac - tIdx * TRAIL_SPACING_FRAC;
          const worldPos = pointAtFrac(smooth, cum, totalLen, frac);
          const screenPos = camera.worldToScreen(worldPos);
          const trailT = 1 - tIdx / TRAIL_SAMPLES;
          const alpha = 0.6 * trailT * trailT;
          const r = (tIdx === 0 ? 3.2 : 1.6 * trailT + 0.4) * camera.zoom;
          ctx.fillStyle = colorToCSS(color, alpha);
          ctx.beginPath();
          ctx.arc(screenPos.x, screenPos.y, Math.max(0.5, r), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------------------
// River flow: the spline loop is only the *channel* — a corridor of some
// width around it. Bright particles inside that channel don't all share one
// lane at one speed; they're advected like an incompressible, inviscid 2D
// fluid (the Euler equations: dv/dt = -(v.grad)v - grad(p)/rho, div(v) = 0).
//
// Rather than solving pressure on a grid, we use the standard stream-function
// trick that satisfies incompressibility for free: any velocity field
// v = (d(psi)/dy, -d(psi)/dx) has div(v) == 0 exactly, for any scalar
// potential psi. `curlFlow` below is the curl of a small sum of moving
// sinusoidal potentials, giving swirling, divergence-free eddies. That eddy
// field is added to a mean downstream current (the loop's tangent), and
// particle position is stepped forward with plain forward (explicit) Euler
// integration each frame — pos += v * dt — so the whole thing is a small
// hand-rolled 2D Euler-fluid particle advection.
// ---------------------------------------------------------------------------

const RIVER_PARTICLE_COUNT = 160;
const RIVER_BASE_SPEED_WORLD_PER_SEC = 150;
const RIVER_HALF_WIDTH = 30;
const RIVER_SPRING_K = 1.4;
const RIVER_TURBULENCE_ALONG = 1.0;
const RIVER_TURBULENCE_ACROSS = 1.0;
const RIVER_TRAIL_LENGTH = 5;
const RIVER_MAX_DT = 0.1;

interface RiverParticle {
  /** Arc-length position along the loop centerline, wraps at totalLen. */
  s: number;
  /** Signed lateral offset from the centerline, in world units. */
  n: number;
  speedMul: number;
  seed: number;
  trail: Vec2[];
}

interface RiverState {
  particles: RiverParticle[];
  lastTime: number;
}

const riverStateByTeam = new Map<Team, RiverState>();

/** Curl of a small sum of moving sinusoidal potentials — divergence-free by construction. */
function curlFlow(x: number, y: number, t: number, seed: number): Vec2 {
  const f1 = 0.018, w1 = 0.7, a1 = 1;
  const f2 = 0.041, w2 = -1.1, a2 = 0.6;
  const p1 = seed * 13.1, p2 = seed * 7.7 + 2.3;

  // psi = a1*sin(x*f1 + t*w1 + p1)*cos(y*f1 + p1) + a2*cos(x*f2 + p2)*sin(y*f2 - t*w2 + p2)
  const dPsiDy =
    a1 * Math.sin(x * f1 + t * w1 + p1) * (-f1 * Math.sin(y * f1 + p1)) +
    a2 * Math.cos(x * f2 + p2) * (f2 * Math.cos(y * f2 - t * w2 + p2));
  const dPsiDx =
    a1 * (f1 * Math.cos(x * f1 + t * w1 + p1)) * Math.cos(y * f1 + p1) +
    a2 * (-f2 * Math.sin(x * f2 + p2)) * Math.sin(y * f2 - t * w2 + p2);

  return new Vec2(dPsiDy, -dPsiDx);
}

function makeRiverParticle(totalLen: number, index: number, count: number): RiverParticle {
  const seed = Math.random() * 1000;
  return {
    s: (index / count) * totalLen,
    n: (Math.random() * 2 - 1) * RIVER_HALF_WIDTH,
    speedMul: 0.55 + Math.random() * 1.0,
    seed,
    trail: [],
  };
}

/**
 * Draws the invisible spline-loop racetrack connecting every Bright
 * Accelerator a team owns (see computeBrightLoop in bright.ts — the same
 * loop that determines Bright income) as an organic river of glowing
 * particles of varying width, speed, and lateral drift flowing clockwise
 * around it. The channel itself is never stroked — only the current inside
 * it is visible. Requires at least 2 accelerators, matching the income
 * requirement.
 */
export function drawBrightAcceleratorLoop(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  state: GameState,
  time: number,
): void {
  const acceleratorsByTeam = new Map<Team, Vec2[]>();
  for (const b of state.buildings) {
    if (!b.alive || b.type !== EntityType.ParticleAccelerator) continue;
    let arr = acceleratorsByTeam.get(b.team);
    if (arr === undefined) {
      arr = [];
      acceleratorsByTeam.set(b.team, arr);
    }
    arr.push(b.position);
  }

  for (const [team, riverState] of riverStateByTeam) {
    if (!acceleratorsByTeam.has(team) || (acceleratorsByTeam.get(team)?.length ?? 0) < 2) {
      riverStateByTeam.delete(team);
    }
  }

  for (const [team, positions] of acceleratorsByTeam) {
    if (positions.length < 2) continue;
    const color = team === Team.Player ? Colors.bright_matter : { r: 255, g: 150, b: 220, intensity: 1.0 };

    const loop = computeBrightLoop(positions);
    if (loop === null) continue;
    const smooth = loop.points;
    const cum: number[] = [0];
    for (let i = 1; i < smooth.length; i++) cum.push(cum[i - 1] + smooth[i].distanceTo(smooth[i - 1]));
    const totalLen = cum[cum.length - 1];
    if (totalLen <= 0) continue;

    let riverState = riverStateByTeam.get(team);
    if (riverState === undefined) {
      const particles: RiverParticle[] = [];
      for (let p = 0; p < RIVER_PARTICLE_COUNT; p++) particles.push(makeRiverParticle(totalLen, p, RIVER_PARTICLE_COUNT));
      riverState = { particles, lastTime: time };
      riverStateByTeam.set(team, riverState);
    }
    const dt = Math.max(0, Math.min(RIVER_MAX_DT, time - riverState.lastTime));
    riverState.lastTime = time;

    const tangentEps = Math.max(1e-4, 4 / totalLen);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const particle of riverState.particles) {
      const frac = particle.s / totalLen;
      const center = pointAtFrac(smooth, cum, totalLen, frac);
      const ahead = pointAtFrac(smooth, cum, totalLen, frac + tangentEps);
      let tx = ahead.x - center.x, ty = ahead.y - center.y;
      const tLen = Math.hypot(tx, ty) || 1;
      tx /= tLen; ty /= tLen;
      const nx = -ty, ny = tx;

      const worldX = center.x + nx * particle.n;
      const worldY = center.y + ny * particle.n;

      const eddy = curlFlow(worldX, worldY, time, particle.seed);
      const widthFrac = particle.n / RIVER_HALF_WIDTH;
      const channelProfile = 1 - 0.35 * widthFrac * widthFrac;
      const meanSpeed = RIVER_BASE_SPEED_WORLD_PER_SEC * particle.speedMul * channelProfile;

      const dsdt = meanSpeed + (eddy.x * tx + eddy.y * ty) * RIVER_TURBULENCE_ALONG;
      const dndt = (eddy.x * nx + eddy.y * ny) * RIVER_TURBULENCE_ACROSS - RIVER_SPRING_K * particle.n;

      // Forward (explicit) Euler step: pos += v * dt.
      particle.s = ((particle.s + dsdt * dt) % totalLen + totalLen) % totalLen;
      particle.n = Math.max(-RIVER_HALF_WIDTH * 1.6, Math.min(RIVER_HALF_WIDTH * 1.6, particle.n + dndt * dt));

      const screenPos = camera.worldToScreen(new Vec2(worldX, worldY));
      particle.trail.push(new Vec2(screenPos.x, screenPos.y));
      if (particle.trail.length > RIVER_TRAIL_LENGTH) particle.trail.shift();

      for (let i = 0; i < particle.trail.length; i++) {
        const trailT = (i + 1) / particle.trail.length;
        const pos = particle.trail[i];
        const alpha = 0.5 * trailT * trailT;
        const r = (trailT * 1.6 + 0.3) * camera.zoom;
        ctx.fillStyle = colorToCSS(color, alpha);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, Math.max(0.5, r), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
