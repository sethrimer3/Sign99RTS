/** Dead-player "spirit ship": a crystalline fractal organism made of triangular fragments.
 *
 *  The ghost never translates a built mesh. A propagating head (the spectator anchor plus
 *  a slowly varying procedural curl) leaves a world-space spine behind it; every spine node
 *  buds a small deterministic cluster of triangles that stay exactly where they were born
 *  and age through white -> faction colour -> black -> transparent. Apparent motion is
 *  creation at the front and dissolution at the rear.
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
/** Head must travel this far (world units, scaled by ship radius / 22) between spine nodes. */
const EMIT_SPACING_BASE = 20;
/** Spacing grows past this rate so a Shift-boosting ghost does not flood the pool; clusters
 *  also lose recursion depth with speed so the spine stays continuous rather than sparse. */
const MAX_NODES_PER_SECOND = 32;
/** Head speed (world units/s) at which clusters drop to their shallowest recursion. */
const SPEED_FOR_MIN_DEPTH = 500;
/** Emission is bounded per update so a hitch cannot dump the whole ring in one frame. */
const MAX_NODES_PER_UPDATE = 6;
/** Newest fragments still in their bright phase get a glow halo, capped for budget. */
const MAX_GLOW_FRAGMENTS = 18;

const WHITE: Color = { r: 255, g: 255, b: 255, intensity: 1 };

/** Number of recursion levels below the root triangle for a given density scale. */
export function ghostRecursionLevels(densityScale: number): number {
  if (densityScale >= 0.85) return 3;
  if (densityScale >= 0.5) return 2;
  return 1;
}

function smooth01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
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
  private curlPhase = 0;
  private distanceSinceEmit = 0;
  private nodeIndex = 0;
  private phaseA = 0;
  private phaseB = 0;
  private phaseC = 0;

  private _particleScale = 1;
  private _performanceScale = 1;
  private readonly scratch = new Vec2(0, 0);

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
    const rng = seededRandom(this.seed ^ 0x5bd1e995);
    this.phaseA = rng() * Math.PI * 2;
    this.phaseB = rng() * Math.PI * 2;
    this.phaseC = rng() * Math.PI * 2;
    this.curlPhase = rng() * Math.PI * 2;
    this.headAngle = facing;
    this.headX = x;
    this.headY = y;
    // Seed the structure immediately so death does not show an empty frame.
    this.emitNode(x, y, facing, ghostRecursionLevels(this.densityScale));
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

  /** Advance the organism. The anchor is the authoritative spectator position; the head
   *  curls around it with smoothly waxing/waning amplitude so the emitted spine alternates
   *  between straight runs, gentle arcs and tight spirals. Deterministic in (seed, dt). */
  update(dt: number, anchorX: number, anchorY: number, anchorFacing: number): void {
    if (!this.active || dt <= 0) return;
    this.time += dt;
    const t = this.time;

    // Low-frequency modulation: amplitude and angular rate each drift with a pair of
    // incommensurate sinusoids, so curvature wanes toward straight runs and waxes into loops.
    const ampWave = 0.5 + 0.5 * Math.sin(t * 0.37 + this.phaseA) * Math.cos(t * 0.19 + this.phaseB);
    const amplitude = this.radius * (0.12 + 2.8 * ampWave * ampWave);
    const rate = 1.4 + 4.2 * (0.5 + 0.5 * Math.sin(t * 0.29 + this.phaseC));
    this.curlPhase += rate * dt;

    const prevX = this.headX;
    const prevY = this.headY;
    this.headX = anchorX + Math.cos(this.curlPhase) * amplitude;
    this.headY = anchorY + Math.sin(this.curlPhase) * amplitude;

    const dx = this.headX - prevX;
    const dy = this.headY - prevY;
    const step = Math.hypot(dx, dy);
    if (step > 1e-4) this.headAngle = Math.atan2(dy, dx);
    else this.headAngle = anchorFacing;

    // Spatial emission: fixed spacing along the head path, widened at speed so the pool is
    // not flooded, and widened again under lower quality so density degrades gracefully.
    const speed = step / dt;
    const density = this.densityScale;
    let spacing = EMIT_SPACING_BASE * (this.radius / 22) / Math.max(0.35, density);
    spacing = Math.max(spacing, speed / MAX_NODES_PER_SECOND);
    const levels = ghostRecursionLevels(density * (1 - 0.75 * Math.min(1, speed / SPEED_FOR_MIN_DEPTH)));

    this.distanceSinceEmit += step;
    let emitted = 0;
    while (this.distanceSinceEmit >= spacing && emitted < MAX_NODES_PER_UPDATE) {
      this.distanceSinceEmit -= spacing;
      // Place the node back along the step so multiple nodes per frame stay evenly spaced.
      const back = step > 1e-4 ? this.distanceSinceEmit / step : 0;
      this.emitNode(this.headX - dx * back, this.headY - dy * back, this.headAngle, levels);
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

  /** Grow one fractal cluster at a spine node. Every parameter derives from the ship seed
   *  and the monotonic node index, so a replay of the same path grows identical geometry. */
  private emitNode(x: number, y: number, tangent: number, levels: number): void {
    const index = this.nodeIndex++;
    const rng = seededRandom((this.seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
    // Pool pressure shortens the hold phase of new fragments so a fast ghost ages out
    // gracefully instead of slamming into the ring cap (same idea as ShipDebrisSystem).
    const fill = this.activeCount / GHOST_FRAGMENT_CAP;
    const hold = HOLD_MIN + (HOLD_MAX - HOLD_MIN) * (1 - 0.85 * fill * fill);
    const rootSize = this.radius * (0.42 + rng() * 0.22);
    const rootAngle = tangent + (rng() - 0.5) * 0.9;
    this.bud(x, y, rootAngle, rootSize, levels, hold, true, rng);
  }

  /** Recursive Julia-like budding: the root sprouts a child from each base vertex; deeper
   *  generations bud from one side (occasionally both), twisting further each step so the
   *  cluster curls like a bulb chain. Roughly 3 / 6 / 9 triangles at 1 / 2 / 3 levels. */
  private bud(x: number, y: number, angle: number, size: number, levels: number, hold: number, root: boolean, rng: () => number): void {
    this.spawnTriangle(x, y, angle, size, hold, rng);
    if (levels <= 0) return;
    const twist = 0.55 + rng() * 0.75;
    const childSize = size * (0.5 + rng() * 0.16);
    const preferred = rng() < 0.5 ? -1 : 1;
    const both = root || rng() < 0.35;
    for (let side = -1; side <= 1; side += 2) {
      if (!both && side !== preferred) continue;
      const va = angle + side * 2.25;
      const vx = x + Math.cos(va) * size * 0.72;
      const vy = y + Math.sin(va) * size * 0.72;
      const ca = angle + side * twist + (rng() - 0.5) * 0.35;
      this.bud(vx + Math.cos(ca) * childSize * 0.45, vy + Math.sin(ca) * childSize * 0.45, ca, childSize, levels - 1, hold, false, rng);
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
        // Head bloom sits on the newest cluster rather than the raw anchor so it never
        // floats ahead of the geometry at speed.
        glow.circleWorld(camera, p, this.radius * 0.9, WHITE, 0.14);
        glow.circleWorld(camera, p, this.radius * 1.8, this.color, 0.05);
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
}
