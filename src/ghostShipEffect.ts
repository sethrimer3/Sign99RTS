/** Dead-player "spirit ship": a crystalline fractal organism made of triangular fragments.
 *
 *  Two independent scales:
 *   - the SPINE: a single continuously-advancing growth point that follows the ghost's real
 *     movement while a slowly drifting curvature bends its heading, so the macro path glides
 *     between near-straight runs, gentle arcs and broad or tight spirals over time.
 *   - the FRACTAL: at every spine node a small recursive cluster of triangles buds outward
 *     from a root triangle into shrinking, rotated children (Sierpinski/Julia-tendril style),
 *     giving the organism its crystalline texture without ever drawing an isolated spiral arm.
 *
 *  The ghost never translates a built mesh: every fragment stores immutable world-space
 *  vertices at birth and only its colour/alpha changes afterward (white -> faction colour ->
 *  black -> transparent). Apparent motion is creation at the front and dissolution at the rear.
 *
 *  Mirrors ShipDebrisSystem's conventions: a fixed pool, a hard active cap, quality/adaptive
 *  scaling, no allocation in the inner draw loop, and no gameplay side effects. Purely visual —
 *  the authoritative ghost position lives in PlayerRespawnRuntime and is only read here. */

import { Vec2 } from './math.js';
import { Camera } from './camera.js';
import { GlowLayer } from './glowlayer.js';
import type { Color } from './colors.js';
import { seededRandom } from './proceduralShips.js';

/** Hard cap on live triangles; the ring overwrites the oldest slot when full. */
export const GHOST_FRAGMENT_CAP = 640;
/** White -> faction "cooling" duration is drawn uniformly from this range per fragment. */
export const GHOST_COOL_MIN = 1.0;
export const GHOST_COOL_MAX = 4.0;
/** Seconds a fragment holds its faction colour before the tail phase, at low pool pressure. */
const HOLD_MAX = 2.6;
const HOLD_MIN = 0.35;
/** Seconds of faction -> black -> transparent dissolution at the tail. */
const DISSOLVE_TIME = 2.4;
/** Alpha ease-in so fragments do not pop on. */
const FADE_IN_TIME = 0.06;
/** Head must travel this far (world units, scaled by ship radius / 22) between spine nodes.
 *  Kept small and well under a cluster's own radius so consecutive clusters heavily overlap
 *  and read as one continuous filament rather than a string of separate nodes. */
const EMIT_SPACING_BASE = 16;
/** Spacing grows past this rate so a fast ghost does not flood the pool; this affects emission
 *  density only — recursion depth is governed by quality/pool pressure, not speed. */
const MAX_NODES_PER_SECOND = 46;
/** Emission is bounded per update so a hitch cannot dump the whole ring in one frame. */
const MAX_NODES_PER_UPDATE = 9;
/** Newest fragments still in their bright phase get a glow halo, capped for budget. */
const MAX_GLOW_FRAGMENTS = 18;
/** Curvature (rad per world-unit travelled) eases toward its target over this time constant. */
const CURVATURE_SMOOTH_TAU = 2.5;
/** The spine heading is gently drawn back toward the real anchor at this rate (1/s) so the
 *  organism can never permanently detach into an orbit — curvature still dominates locally. */
const HEADING_CORRECTION_RATE = 1.6;
/** Hard leash: the growth head is pulled back within this many ship-radii of the real anchor.
 *  Kept tight (a small fraction of the hull) so the newest, brightest geometry always sits on
 *  top of the player's actual position instead of drifting into a visible orbit around it. */
const LEASH_MAX_RADIUS_MULT = 1.35;

const WHITE: Color = { r: 255, g: 255, b: 255, intensity: 1 };

/** Recursion depth of a spine node's fractal cluster for a given density scale. */
export function ghostRecursionLevels(densityScale: number): number {
  if (densityScale >= 0.85) return 4;
  if (densityScale >= 0.5) return 2;
  return 1;
}

/** Triangle budget for one spine node's recursive cluster at a given recursion depth. Spread
 *  over more, smaller triangles than a flat split would give so the cluster reads as fine
 *  filamentary texture rather than a few dominant shards. */
function fractalBudget(levels: number): number {
  if (levels >= 4) return 42;
  if (levels === 3) return 30;
  if (levels === 2) return 16;
  return 7;
}

function smooth01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class GhostShipEffect {
  // --- Fragment ring buffer (struct-of-arrays; a slot is live while age < life) ---
  private readonly ax = new Float32Array(GHOST_FRAGMENT_CAP);
  private readonly ay = new Float32Array(GHOST_FRAGMENT_CAP);
  private readonly bx = new Float32Array(GHOST_FRAGMENT_CAP);
  private readonly by = new Float32Array(GHOST_FRAGMENT_CAP);
  private readonly cx = new Float32Array(GHOST_FRAGMENT_CAP);
  private readonly cy = new Float32Array(GHOST_FRAGMENT_CAP);
  private readonly birth = new Float32Array(GHOST_FRAGMENT_CAP);
  private readonly cool = new Float32Array(GHOST_FRAGMENT_CAP);
  private readonly life = new Float32Array(GHOST_FRAGMENT_CAP);
  private readonly shade = new Float32Array(GHOST_FRAGMENT_CAP);
  private readonly size = new Float32Array(GHOST_FRAGMENT_CAP);
  /** Next slot to write; the ring wraps and overwrites the oldest fragment. */
  private writeIndex = 0;
  /** Slots that have ever been written (<= cap); slots beyond are untouched. */
  private written = 0;

  // --- Spine / head state ---
  private seed = 0;
  private radius = 22;
  private color: Color = WHITE;
  private time = 0;
  private headX = 0;
  private headY = 0;
  private headAngle = 0;
  /** Authoritative ghost position as of the last update() — the camera target. The visual head
   *  bloom locks onto this directly so the brightest material always sits on the real anchor. */
  private anchorX = 0;
  private anchorY = 0;
  private prevAnchorX = 0;
  private prevAnchorY = 0;
  private distanceSinceEmit = 0;
  private nodeIndex = 0;

  // Growth-path curvature: a slowly drifting turn-rate (rad per world-unit) built from three
  // incommensurate sinusoids, so the spine glides between straight runs and tight spirals.
  private spineHeading = 0;
  private curvature = 0;
  private curveScale = 1;
  private curvA = 0; private curvB = 0; private curvC = 0;
  private curvF1 = 0; private curvF2 = 0; private curvF3 = 0;
  private curvP1 = 0; private curvP2 = 0; private curvP3 = 0;

  // Ship-flavoured fractal parameters, deterministic per seed, so the organism reads as a
  // transformed version of that ship's own proportions rather than a generic effect.
  private branchAngleBase = 0.7;
  private shrinkBase = 0.66;
  private twoSidedChance = 0.35;
  private twistBias = 0.5;
  /** Remaining triangle budget for the fractal cluster currently being grown. */
  private budgetRemaining = 0;

  private _particleScale = 1;
  private _performanceScale = 1;
  private readonly scratch = new Vec2(0, 0);
  private readonly scratch2 = new Vec2(0, 0);

  /** True once reset() has been called and clear() has not. */
  active = false;
  activeCount = 0;
  drawnCount = 0;

  setParticleScale(scale: number): void { this._particleScale = Math.max(0.1, Math.min(1.2, scale)); }
  setAdaptiveScale(scale: number): void { this._performanceScale = Math.max(0.2, Math.min(1, scale)); }
  private get densityScale(): number { return Math.min(1, this._particleScale * this._performanceScale); }

  /** Begin a new ghost at the death position. `seed` should come from the ship design so
   *  the same design always grows the same organism. */
  reset(x: number, y: number, facing: number, seed: number, radius: number, color: Color): void {
    this.clear();
    this.active = true;
    this.seed = seed >>> 0;
    this.radius = Math.max(6, radius);
    this.color = color;

    const curveRng = seededRandom(this.seed ^ 0x27d4eb2f);
    this.curvA = 0.5 + curveRng() * 0.5;
    this.curvB = 0.3 + curveRng() * 0.4;
    this.curvC = 0.15 + curveRng() * 0.3;
    this.curvF1 = 0.05 + curveRng() * 0.05;
    this.curvF2 = 0.083 + curveRng() * 0.05;
    this.curvF3 = 0.131 + curveRng() * 0.05;
    this.curvP1 = curveRng() * Math.PI * 2;
    this.curvP2 = curveRng() * Math.PI * 2;
    this.curvP3 = curveRng() * Math.PI * 2;
    // Amplitude tuned so the tightest sustained spiral has a radius of a few ship-lengths.
    this.curveScale = 1 / (this.radius * 16);
    this.curvature = 0;

    // Borrow a few of the procedural ship's design tendencies (via the same seed) so the
    // spirit's branching reads as a transformed version of that hull rather than a generic FX.
    const flavorRng = seededRandom(this.seed ^ 0x2545f491);
    // Narrower angle/shrink ranges than a generic fractal so the organism stays a thin filament
    // with occasional accent branches, rather than a wide debris fan.
    this.branchAngleBase = 0.3 + flavorRng() * 0.35;
    this.shrinkBase = 0.62 + flavorRng() * 0.13;
    this.twoSidedChance = 0.16 + flavorRng() * 0.3;
    this.twistBias = flavorRng();

    this.spineHeading = facing;
    this.headAngle = facing;
    this.headX = x;
    this.headY = y;
    this.anchorX = x;
    this.anchorY = y;
    this.prevAnchorX = x;
    this.prevAnchorY = y;
    // Seed the structure immediately so death does not show an empty frame.
    this.emitNode(x, y, facing, ghostRecursionLevels(this.densityScale), EMIT_SPACING_BASE);
  }

  /** Drop all visual state. Used on respawn and runtime reset. */
  clear(): void {
    this.active = false;
    this.writeIndex = 0;
    this.written = 0;
    this.activeCount = 0;
    this.drawnCount = 0;
    this.time = 0;
    this.distanceSinceEmit = 0;
    this.nodeIndex = 0;
    this.life.fill(0);
  }

  /** Advance the organism. The anchor is the authoritative ghost position; the spine's heading
   *  curves away from it under a slowly drifting curvature and is gently leashed back so the
   *  head follows the ghost's real movement without ever settling into a fixed orbit around it.
   *  Deterministic in (seed, dt-sequence, anchor path). */
  update(dt: number, anchorX: number, anchorY: number, anchorFacing: number): void {
    if (!this.active || dt <= 0) return;
    this.time += dt;
    const t = this.time;
    this.anchorX = anchorX;
    this.anchorY = anchorY;

    // Low-frequency curvature: three incommensurate sinusoids sum to near-zero (straight runs)
    // or to sustained same-sign curvature (broad or tight spirals), smoothed so changes of
    // shape are gradual rather than a jump-cut.
    const curvatureTarget = this.curveScale * (
      this.curvA * Math.sin(t * this.curvF1 + this.curvP1) +
      this.curvB * Math.sin(t * this.curvF2 + this.curvP2) +
      this.curvC * Math.sin(t * this.curvF3 + this.curvP3)
    );
    this.curvature += (curvatureTarget - this.curvature) * Math.min(1, dt / CURVATURE_SMOOTH_TAU);

    const anchorDX = anchorX - this.prevAnchorX;
    const anchorDY = anchorY - this.prevAnchorY;
    this.prevAnchorX = anchorX;
    this.prevAnchorY = anchorY;
    const stepDist = Math.hypot(anchorDX, anchorDY);

    // heading += curvature * distanceTravelled: shape density stays stable across frame rate
    // and ghost speed because it is driven by distance, not elapsed time.
    this.spineHeading += this.curvature * stepDist;

    // Gently bend the heading back toward the real anchor so the organism stays attached to
    // the player's actual ghost rather than drifting into a permanent independent orbit.
    const toAX = anchorX - this.headX;
    const toAY = anchorY - this.headY;
    if (Math.hypot(toAX, toAY) > 1e-3) {
      const bearing = Math.atan2(toAY, toAX);
      this.spineHeading += wrapAngle(bearing - this.spineHeading) * Math.min(1, dt * HEADING_CORRECTION_RATE);
    }

    const prevHeadX = this.headX;
    const prevHeadY = this.headY;
    this.headX += Math.cos(this.spineHeading) * stepDist;
    this.headY += Math.sin(this.spineHeading) * stepDist;

    // Hard leash so a burst of curvature can never carry the head far from the true ghost.
    const leashMax = this.radius * LEASH_MAX_RADIUS_MULT;
    const nowDX = anchorX - this.headX;
    const nowDY = anchorY - this.headY;
    const nowDist = Math.hypot(nowDX, nowDY);
    if (nowDist > leashMax) {
      const pull = (nowDist - leashMax) / nowDist;
      this.headX += nowDX * pull;
      this.headY += nowDY * pull;
    }

    const hdx = this.headX - prevHeadX;
    const hdy = this.headY - prevHeadY;
    const headStep = Math.hypot(hdx, hdy);
    if (headStep > 1e-4) this.headAngle = Math.atan2(hdy, hdx);
    else this.headAngle = anchorFacing;

    // Spatial emission: fixed spacing along the head path, widened at speed so the pool is not
    // flooded, and widened again under lower quality so density degrades gracefully. Recursion
    // depth is driven by quality/pool pressure only — normal (and Shift) ghost speeds must not
    // flatten the fractal texture.
    const speed = stepDist / dt;
    const density = this.densityScale;
    let spacing = EMIT_SPACING_BASE * (this.radius / 22) / Math.max(0.35, density);
    spacing = Math.max(spacing, speed / MAX_NODES_PER_SECOND);
    const fillNow = this.activeCount / GHOST_FRAGMENT_CAP;
    const levels = fillNow > 0.85 ? Math.max(1, ghostRecursionLevels(density) - 1) : ghostRecursionLevels(density);

    this.distanceSinceEmit += headStep;
    let emitted = 0;
    while (this.distanceSinceEmit >= spacing && emitted < MAX_NODES_PER_UPDATE) {
      this.distanceSinceEmit -= spacing;
      // Place the node back along the step so multiple nodes per frame stay evenly spaced,
      // interpolating emission positions when the head travels far in a single update.
      const back = headStep > 1e-4 ? this.distanceSinceEmit / headStep : 0;
      this.emitNode(this.headX - hdx * back, this.headY - hdy * back, this.spineHeading, levels, spacing);
      emitted++;
    }
    if (emitted >= MAX_NODES_PER_UPDATE) this.distanceSinceEmit = 0;

    this.activeCount = this.countLive();
  }

  private countLive(): number {
    let n = 0;
    for (let i = 0; i < this.written; i++) {
      if (this.time - this.birth[i] < this.life[i]) n++;
    }
    return n;
  }

  /** Grow one recursive fractal cluster rooted at a spine node. Every parameter derives from
   *  the ship seed and the monotonic node index, so a replay of the same path grows identical
   *  geometry. The root size is tied to `spacing` (the gap the head just travelled) so
   *  neighbouring clusters always overlap — that overlap, not any single cluster, is what
   *  reads as one unbroken organism rather than a chain of separate ornaments. */
  private emitNode(x: number, y: number, tangent: number, levels: number, spacing: number): void {
    const index = this.nodeIndex++;
    const rng = seededRandom((this.seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
    // Pool pressure shortens the hold phase of new fragments so a fast ghost ages out
    // gracefully instead of slamming into the ring cap (same idea as ShipDebrisSystem).
    const fill = this.activeCount / GHOST_FRAGMENT_CAP;
    const hold = HOLD_MIN + (HOLD_MAX - HOLD_MIN) * (1 - 0.85 * fill * fill);
    // Small relative to the hull — many small triangles read as one fine fractal filament
    // rather than a few large shards — but wide enough that clusters overlap the next node,
    // since it's that overlap (not any single cluster) that reads as one continuous organism.
    const rootSize = Math.max(this.radius * 0.16, spacing * 0.95) * (0.85 + rng() * 0.3);
    const rootAngle = tangent + (rng() - 0.5) * 0.5;
    let budget = fractalBudget(levels);
    if (fill > 0.8) budget = Math.max(3, budget >> 1);
    this.budgetRemaining = budget;
    this.growFractal(x, y, rootAngle, rootSize, levels, hold, rng);
  }

  /** Recursively bud a shrinking, rotated child cluster from a parent triangle (Sierpinski /
   *  Julia-tendril style): children originate near the parent's leading edge so the cluster
   *  stays visually interlocked, sometimes branching one-sided and sometimes both ways. Bounded
   *  by a per-node triangle budget and a minimum size so recursion always terminates. */
  private growFractal(x: number, y: number, angle: number, size: number, depth: number, hold: number, rng: () => number): void {
    if (this.budgetRemaining <= 0) return;
    this.spawnTriangle(x, y, angle, size, hold, rng);
    this.budgetRemaining--;
    if (depth <= 0 || this.budgetRemaining <= 0 || size < this.radius * 0.045) return;

    const branchAngle = this.branchAngleBase + (rng() - 0.5) * 0.22;
    const bothSides = rng() < this.twoSidedChance;
    const shrink = this.shrinkBase + (rng() - 0.5) * 0.1;
    const first = rng() < this.twistBias ? 1 : -1;
    const dirs: number[] = bothSides ? [1, -1] : [first];
    // A small deterministic curl per depth level gives each tendril a subtle spiral twist
    // instead of every branch bending by exactly the same angle.
    const twist = (rng() - 0.5) * 0.16 * depth;
    for (const sign of dirs) {
      const childAngle = angle + sign * branchAngle + twist + (rng() - 0.5) * 0.1;
      const originDist = size * 0.72;
      const childX = x + Math.cos(angle) * originDist + Math.cos(childAngle) * size * 0.1;
      const childY = y + Math.sin(angle) * originDist + Math.sin(childAngle) * size * 0.1;
      this.growFractal(childX, childY, childAngle, size * shrink, depth - 1, hold, rng);
    }
  }

  private spawnTriangle(x: number, y: number, angle: number, size: number, hold: number, rng: () => number): void {
    const i = this.writeIndex;
    this.writeIndex = (i + 1) % GHOST_FRAGMENT_CAP;
    if (this.written < GHOST_FRAGMENT_CAP) this.written++;
    // Isosceles fragment pointing along `angle`; vertices are fixed for life.
    this.ax[i] = x + Math.cos(angle) * size;
    this.ay[i] = y + Math.sin(angle) * size;
    this.bx[i] = x + Math.cos(angle + 2.25) * size * 0.72;
    this.by[i] = y + Math.sin(angle + 2.25) * size * 0.72;
    this.cx[i] = x + Math.cos(angle - 2.25) * size * 0.72;
    this.cy[i] = y + Math.sin(angle - 2.25) * size * 0.72;
    this.birth[i] = this.time;
    this.cool[i] = GHOST_COOL_MIN + rng() * (GHOST_COOL_MAX - GHOST_COOL_MIN);
    this.life[i] = this.cool[i] + hold + DISSOLVE_TIME;
    this.shade[i] = rng();
    this.size[i] = size;
  }

  /** Base pass: filled triangles with source-over blending so the tail can truly go black. */
  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    this.drawnCount = 0;
    if (!this.active || this.written === 0) return;
    const margin = this.radius * 2 * camera.zoom;
    const w = camera.screenW + margin;
    const h = camera.screenH + margin;
    const base = this.color;
    const br = Math.min(255, base.r * base.intensity);
    const bg = Math.min(255, base.g * base.intensity);
    const bb = Math.min(255, base.b * base.intensity);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < this.written; i++) {
      const age = this.time - this.birth[i];
      const life = this.life[i];
      if (age < 0 || age >= life) continue;
      const sx = camera.screenX(this.ax[i]);
      const sy = camera.screenY(this.ay[i]);
      if (sx < -margin || sy < -margin || sx > w || sy > h) continue;

      // Per-fragment lifecycle: ease in, cool white -> shaded faction, hold, dissolve.
      const shadeMul = 0.62 + this.shade[i] * 0.55;
      const coolT = smooth01(age / this.cool[i]);
      let r = 255 + (br * shadeMul - 255) * coolT;
      let g = 255 + (bg * shadeMul - 255) * coolT;
      let b = 255 + (bb * shadeMul - 255) * coolT;
      const alpha = 0.96 * this.alphaAt(age, life);
      if (alpha <= 0.004) continue;
      const tailT = (age - (life - DISSOLVE_TIME)) / DISSOLVE_TIME;
      if (tailT > 0) {
        const dark = 1 - smooth01(tailT / 0.75);
        r *= dark; g *= dark; b *= dark;
      }
      ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(camera.screenX(this.bx[i]), camera.screenY(this.by[i]));
      ctx.lineTo(camera.screenX(this.cx[i]), camera.screenY(this.cy[i]));
      ctx.closePath();
      ctx.fill();
      this.drawnCount++;
    }
    ctx.restore();
  }

  /** Glow pass: halos on the newest, still-white fragments plus one at the head. The crisp
   *  triangle underneath establishes the shape, so a circle halo is all the bloom needs. */
  drawGlow(glow: GlowLayer, camera: Camera): void {
    if (!this.active || this.written === 0 || !glow.enabled) return;
    const p = this.scratch;
    // Walk backwards from the newest slot; fragments are written in age order.
    let halos = 0;
    for (let n = 0; n < this.written && halos < MAX_GLOW_FRAGMENTS; n++) {
      const i = (this.writeIndex - 1 - n + GHOST_FRAGMENT_CAP) % GHOST_FRAGMENT_CAP;
      const age = this.time - this.birth[i];
      const heat = 1 - age / (this.cool[i] * 0.6);
      if (heat <= 0) break;
      p.x = (this.ax[i] + this.bx[i] + this.cx[i]) / 3;
      p.y = (this.ay[i] + this.by[i] + this.cy[i]) / 3;
      if (n === 0) {
        // Head bloom sits directly on the authoritative anchor (the camera target), not the
        // newest triangle's centroid, so the brightest point always reads as "you are here"
        // even though the leash keeps that triangle only a hair away from it in practice.
        this.scratch2.x = this.anchorX;
        this.scratch2.y = this.anchorY;
        glow.circleWorld(camera, this.scratch2, this.radius * 0.65, WHITE, 0.18);
        glow.circleWorld(camera, this.scratch2, this.radius * 1.3, this.color, 0.06);
      }
      if (!camera.isOnScreen(p, this.size[i] * 3)) continue;
      glow.circleWorld(camera, p, this.size[i] * 1.25, WHITE, 0.12 * heat * smooth01(age / FADE_IN_TIME));
      halos++;
    }
  }

  /** Test/debug accessor: world-space vertices of a slot (a copy, never internal storage). */
  fragmentVertices(slot: number): [number, number, number, number, number, number] {
    return [this.ax[slot], this.ay[slot], this.bx[slot], this.by[slot], this.cx[slot], this.cy[slot]];
  }
  /** Test/debug accessor: cooling duration of a slot. */
  fragmentCoolDuration(slot: number): number { return this.cool[slot]; }
  /** Test/debug accessor: 0..1 alpha a slot would be drawn with at the current time. */
  fragmentAlpha(slot: number): number {
    return this.alphaAt(this.time - this.birth[slot], this.life[slot]);
  }

  /** Ease in over FADE_IN_TIME; ease out over the last part of the dissolve so colour
   *  reaches black before opacity reaches zero. */
  private alphaAt(age: number, life: number): number {
    if (age < 0 || age >= life) return 0;
    let alpha = smooth01(age / FADE_IN_TIME);
    const tailT = (age - (life - DISSOLVE_TIME)) / DISSOLVE_TIME;
    if (tailT > 0) alpha *= 1 - smooth01((tailT - 0.25) / 0.75);
    return alpha;
  }
  get writtenCount(): number { return this.written; }
  /** Test/debug accessor: distance from the growth head to the authoritative anchor, i.e. how
   *  far the newest geometry can visually stray from runtime.ghostPos / the camera target. */
  get headAnchorDistance(): number { return Math.hypot(this.headX - this.anchorX, this.headY - this.anchorY); }
}
