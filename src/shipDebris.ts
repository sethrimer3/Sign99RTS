/** Shed ship components flying away as debris. Mirrors ParticleSystem's conventions —
 *  same pooling, same quality/adaptive scale handling, same update/draw lifecycle — but
 *  keeps its own pool because a debris piece is a rotating polygon referencing shared
 *  geometry, not a dot, and widening Particle to carry that would bloat every particle. */

import { Vec2 } from './math.js';
import { Camera } from './camera.js';
import type { Color } from './colors.js';
import { getShadeRamp, getComponentPath, getShipGeometry } from './proceduralShips.js';
import type { ProceduralShipDefinition, ShipGeometry } from './proceduralShips.js';

/** Hard global cap; oldest is evicted first so a large battle cannot explode. */
const POOL_SIZE = 320;
/** Wreckage drifts for this long before fading, shortened as the field fills up. */
const LIFE_MIN = 15;
const LIFE_MAX = 30;
/** Seconds of fade at the end of a piece's life. */
const FADE_TIME = 2.5;
/** Vacuum drift: a touch of damping reads better than none. */
const DRIFT_DAMPING = 0.06;
/** Collision work is staggered across this many frames. */
const COLLIDE_PHASES = 4;

/** Minimal shape a debris collider must expose — deliberately structural so this module
 *  does not depend on Entity and cannot be tempted to mutate gameplay state. */
export interface DebrisCollider {
  position: { x: number; y: number };
  radius: number;
}
/** Broadphase hook. The caller fills `out` with nearby ships/buildings and returns it. */
export type DebrisColliderQuery = (x: number, y: number, radius: number, out: DebrisCollider[]) => DebrisCollider[];
/** Optional hook letting drifting wreckage stir the space-dust field. */
export type DebrisFluidSink = (x: number, y: number, vx: number, vy: number, color: Color) => void;

interface DebrisPiece {
  active: boolean;
  geometry: ShipGeometry | null;
  isRect?: boolean;
  w?: number;
  h?: number;
  index: number;
  x: number; y: number;
  vx: number; vy: number;
  angle: number;
  spin: number;
  scale: number;
  life: number;
  maxLife: number;
  radius: number;
  phase: number;
  shade: number;
  accent: boolean;
  color: Color | null;
  /** Monotonic stamp so the oldest piece is recycled when the pool is full. */
  stamp: number;
}

function createPiece(): DebrisPiece {
  return {
    active: false, geometry: null, isRect: false, w: 0, h: 0, index: 0, x: 0, y: 0, vx: 0, vy: 0,
    angle: 0, spin: 0, scale: 1, life: 0, maxLife: 1, radius: 1, phase: 0, shade: 0.5,
    accent: false, color: null, stamp: 0,
  };
}

export class ShipDebrisSystem {
  private pool: DebrisPiece[] = Array.from({ length: POOL_SIZE }, createPiece);
  private activeIndices: number[] = [];
  private freeStack: number[] = Array.from({ length: POOL_SIZE }, (_, i) => POOL_SIZE - 1 - i);
  private _particleScale = 1;
  private _performanceScale = 1;
  private stamp = 0;
  private frame = 0;
  private colliderQuery: DebrisColliderQuery | null = null;
  private fluidSink: DebrisFluidSink | null = null;
  private scratch: DebrisCollider[] = [];

  /** Reuse the game's existing entity broadphase rather than inventing one. */
  setColliderQuery(query: DebrisColliderQuery | null): void { this.colliderQuery = query; }
  setFluidSink(sink: DebrisFluidSink | null): void { this.fluidSink = sink; }

  /** Collision checks performed on the last update — for perf reporting. */
  collisionChecks = 0;

  activeCount = 0;
  drawnCount = 0;
  readonly poolCapacity = POOL_SIZE;

  setParticleScale(scale: number): void { this._particleScale = Math.max(0.1, Math.min(1, scale)); }
  setAdaptiveScale(scale: number): void { this._performanceScale = Math.max(0.2, Math.min(1, scale)); }
  private get _effectiveScale(): number { return this._particleScale * this._performanceScale; }

  private acquire(): DebrisPiece {
    let idx = this.freeStack.pop();
    if (idx === undefined) {
      // Pool full: evict the oldest active piece.
      let oldestAt = 0;
      let oldest = Infinity;
      for (let i = 0; i < this.activeIndices.length; i++) {
        const st = this.pool[this.activeIndices[i]].stamp;
        if (st < oldest) { oldest = st; oldestAt = i; }
      }
      idx = this.activeIndices[oldestAt];
      this.activeIndices.splice(oldestAt, 1);
    }
    this.activeIndices.push(idx);
    const piece = this.pool[idx];
    piece.active = true;
    piece.stamp = ++this.stamp;
    return piece;
  }

  /**
   * Spawn the components a ship just shed. `hit` biases the outward direction so debris
   * flies away from the blow; each piece also inherits its own offset from the centre.
   */
  emitShedComponents(
    def: ProceduralShipDefinition, indices: number[], center: Vec2, rotation: number,
    scale: number, color: Color, hit: Vec2 | null, rng: () => number,
  ): void {
    if (indices.length === 0) return;
    const geo = getShipGeometry(def);
    const budget = Math.max(1, Math.round(indices.length * this._effectiveScale));
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    let hx = 0, hy = 0;
    if (hit) {
      hx = center.x - hit.x; hy = center.y - hit.y;
      const h = Math.hypot(hx, hy) || 1;
      hx /= h; hy /= h;
    }
    for (let i = 0; i < budget; i++) {
      const poly = geo.polygons[indices[i]];
      if (!poly) continue;
      // Ship-local centroid -> world.
      const lx = poly.cx * scale, ly = poly.cy * scale;
      const wx = center.x + lx * cos - ly * sin;
      const wy = center.y + lx * sin + ly * cos;
      let ox = wx - center.x, oy = wy - center.y;
      const ol = Math.hypot(ox, oy) || 1;
      ox /= ol; oy /= ol;
      const speed = 26 + rng() * 52;
      // Field pressure: the fuller the pool, the shorter new wreckage lasts, so a big
      // battle ages out gracefully instead of slamming into the hard cap.
      const fill = this.activeIndices.length / POOL_SIZE;
      const lifeScale = 1 - 0.72 * fill * fill;
      const piece = this.acquire();
      piece.geometry = geo;
      piece.index = poly.index;
      piece.x = wx; piece.y = wy;
      piece.vx = (ox * 0.75 + hx * 0.55) * speed;
      piece.vy = (oy * 0.75 + hy * 0.55) * speed;
      piece.angle = rotation;
      piece.spin = (rng() - 0.5) * 5.5;
      piece.scale = scale;
      piece.maxLife = (LIFE_MIN + rng() * (LIFE_MAX - LIFE_MIN)) * lifeScale;
      piece.life = piece.maxLife;
      piece.radius = Math.max(0.5, poly.feature * scale);
      piece.phase = (this.frame + i) % COLLIDE_PHASES;
      piece.shade = poly.shade;
      piece.accent = poly.accent;
      piece.color = color;
    }
    this.activeCount = this.activeIndices.length;
  }

  /** Impart impulse to wreckage near a weapon impact. Called from the existing hit path. */
  pushFrom(x: number, y: number, radius: number, strength: number): void {
    if (this.activeIndices.length === 0) return;
    const r2 = radius * radius;
    for (let i = 0; i < this.activeIndices.length; i++) {
      const piece = this.pool[this.activeIndices[i]];
      const dx = piece.x - x, dy = piece.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const falloff = 1 - d / radius;
      const push = strength * falloff / Math.max(0.6, piece.radius * 0.35);
      piece.vx += (dx / d) * push;
      piece.vy += (dy / d) * push;
      piece.spin += (Math.random() - 0.5) * falloff * 3;
    }
  }

  emitBuildingDebris(
    geo: any, indices: number[],
    center: Vec2, color: Color, hit: Vec2 | null,
    rng: () => number
  ): void {
    const budget = Math.max(1, Math.round(indices.length * this._effectiveScale));
    if (budget < 1) return;
    let hx = 0, hy = 0;
    if (hit) {
      hx = center.x - hit.x; hy = center.y - hit.y;
      const hl = Math.hypot(hx, hy) || 1;
      hx /= hl; hy /= hl;
    }
    for (let i = 0; i < budget; i++) {
      const leaf = geo.leaves[indices[i]];
      if (!leaf) continue;
      const wx = center.x + leaf.x;
      const wy = center.y + leaf.y;
      let ox = wx - center.x, oy = wy - center.y;
      const ol = Math.hypot(ox, oy) || 1;
      ox /= ol; oy /= ol;
      const speed = 26 + rng() * 52;
      const fill = this.activeIndices.length / POOL_SIZE;
      const lifeScale = 1 - 0.72 * fill * fill;
      const piece = this.acquire();
      piece.geometry = null;
      piece.isRect = true;
      piece.w = leaf.w; piece.h = leaf.h;
      piece.x = wx; piece.y = wy;
      piece.vx = (ox * 0.75 + hx * 0.55) * speed;
      piece.vy = (oy * 0.75 + hy * 0.55) * speed;
      piece.angle = 0;
      piece.spin = (rng() - 0.5) * 5.5;
      piece.scale = 1;
      piece.maxLife = (LIFE_MIN + rng() * (LIFE_MAX - LIFE_MIN)) * lifeScale;
      piece.life = piece.maxLife;
      piece.radius = Math.hypot(leaf.w, leaf.h) * 0.5;
      piece.phase = rng() * Math.PI * 2;
      piece.shade = rng();
      piece.accent = rng() > 0.85;
      piece.color = color;
    }
  }

  update(dt: number): void {
    this.frame++;
    this.collisionChecks = 0;
    for (let i = this.activeIndices.length - 1; i >= 0; i--) {
      const poolIndex = this.activeIndices[i];
      const piece = this.pool[poolIndex];
      piece.life -= dt;
      if (piece.life <= 0) {
        piece.active = false;
        piece.geometry = null;
        this.activeIndices.splice(i, 1);
        this.freeStack.push(poolIndex);
        continue;
      }
      piece.x += piece.vx * dt;
      piece.y += piece.vy * dt;
      const damp = 1 - DRIFT_DAMPING * dt;
      piece.vx *= damp;
      piece.vy *= damp;
      piece.angle += piece.spin * dt;
      piece.spin *= 1 - 0.25 * dt;

      // Bounce off ships and buildings. Staggered across COLLIDE_PHASES frames so the
      // broadphase cost is a quarter of the naive per-piece-per-frame figure. Debris is
      // never tested against debris — that is the quadratic case and it is not wanted.
      if (this.colliderQuery && (this.frame % COLLIDE_PHASES) === piece.phase) {
        const near = this.colliderQuery(piece.x, piece.y, piece.radius, this.scratch);
        this.collisionChecks += near.length;
        for (let c = 0; c < near.length; c++) {
          const ent = near[c];
          const dx = piece.x - ent.position.x;
          const dy = piece.y - ent.position.y;
          const minD = ent.radius + piece.radius;
          const d2 = dx * dx + dy * dy;
          if (d2 >= minD * minD || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          const nx = dx / d, ny = dy / d;
          // Push out and reflect. Only the debris piece is modified — the entity is
          // read-only here, so nothing gameplay-visible changes.
          piece.x = ent.position.x + nx * minD;
          piece.y = ent.position.y + ny * minD;
          const along = piece.vx * nx + piece.vy * ny;
          if (along < 0) {
            piece.vx -= 1.55 * along * nx;
            piece.vy -= 1.55 * along * ny;
            piece.spin += (piece.vx * ny - piece.vy * nx) * 0.012;
          }
          break;
        }
      }

      // Stir the space dust in the wreckage's wake — cheap, and only in this direction:
      // having every piece SAMPLE the fluid field per frame would be the expensive one.
      if (this.fluidSink && piece.color && (this.frame % 8) === (piece.phase * 2)) {
        const sp = piece.vx * piece.vx + piece.vy * piece.vy;
        if (sp > 90) this.fluidSink(piece.x, piece.y, piece.vx * 0.28, piece.vy * 0.28, piece.color);
      }
    }
    this.activeCount = this.activeIndices.length;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    this.drawnCount = 0;
    if (this.activeIndices.length === 0) return;
    for (let i = 0; i < this.activeIndices.length; i++) {
      const piece = this.pool[this.activeIndices[i]];
      if (!piece.color) continue;
      if (!piece.geometry && !piece.isRect) continue;
      const screen = camera.worldToScreen(new Vec2(piece.x, piece.y));
      if (screen.x < -60 || screen.y < -60 || screen.x > camera.screenW + 60 || screen.y > camera.screenH + 60) continue;
      
      const drawScale = camera.zoom * piece.scale;
      ctx.save();
      ctx.globalAlpha = Math.min(1, piece.life / Math.min(FADE_TIME, piece.maxLife));
      ctx.translate(screen.x, screen.y);
      ctx.rotate(piece.angle);
      ctx.scale(drawScale, drawScale);
      
      if (piece.isRect) {
        // Simple shade ramp for rects based on color
        const baseC = piece.color;
        const shadeFactor = 0.5 + 0.5 * piece.shade;
        const fillC = piece.accent ? 
           `rgb(${Math.min(255, baseC.r * 1.5)}, ${Math.min(255, baseC.g * 1.5)}, ${Math.min(255, baseC.b * 1.5)})` :
           `rgb(${baseC.r * shadeFactor}, ${baseC.g * shadeFactor}, ${baseC.b * shadeFactor})`;
        ctx.fillStyle = fillC;
        ctx.fillRect(-piece.w! / 2, -piece.h! / 2, piece.w!, piece.h!);
      } else {
        const geo = piece.geometry!;
        const ramp = getShadeRamp(piece.color, geo.shadeBands, geo.hueSpread, geo.accentHueShift);
        const band = Math.max(0, Math.min(geo.shadeBands - 1, Math.round(piece.shade * (geo.shadeBands - 1))));
        ctx.fillStyle = piece.accent ? ramp.accents[band] : ramp.fills[band];
        ctx.fill(getComponentPath(geo, piece.index));
      }
      ctx.restore();
      this.drawnCount++;
    }
    ctx.globalAlpha = 1;
  }

  clear(): void {
    for (const index of this.activeIndices) {
      this.pool[index].active = false;
      this.pool[index].geometry = null;
      this.pool[index].color = null;
    }
    this.activeIndices.length = 0;
    this.freeStack = Array.from({ length: POOL_SIZE }, (_, i) => POOL_SIZE - 1 - i);
    this.activeCount = 0;
    this.drawnCount = 0;
    this.collisionChecks = 0;
  }
}
