/** Shed ship components flying away as debris. Mirrors ParticleSystem's conventions —
 *  same pooling, same quality/adaptive scale handling, same update/draw lifecycle — but
 *  keeps its own pool because a debris piece is a rotating polygon referencing shared
 *  geometry, not a dot, and widening Particle to carry that would bloat every particle. */

import { Vec2 } from './math.js';
import { Camera } from './camera.js';
import type { Color } from './colors.js';
import { getShadeRamp, getComponentPath, getShipGeometry } from './proceduralShips.js';
import type { ProceduralShipDefinition } from './proceduralShips.js';

/** Hard global cap; oldest is evicted first so a large battle cannot explode. */
const POOL_SIZE = 320;

interface DebrisPiece {
  active: boolean;
  def: ProceduralShipDefinition | null;
  index: number;
  x: number; y: number;
  vx: number; vy: number;
  angle: number;
  spin: number;
  scale: number;
  life: number;
  maxLife: number;
  shade: number;
  accent: boolean;
  color: Color | null;
  /** Monotonic stamp so the oldest piece is recycled when the pool is full. */
  stamp: number;
}

function createPiece(): DebrisPiece {
  return {
    active: false, def: null, index: 0, x: 0, y: 0, vx: 0, vy: 0,
    angle: 0, spin: 0, scale: 1, life: 0, maxLife: 1, shade: 0.5,
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
      const piece = this.acquire();
      piece.def = def;
      piece.index = poly.index;
      piece.x = wx; piece.y = wy;
      piece.vx = (ox * 0.75 + hx * 0.55) * speed;
      piece.vy = (oy * 0.75 + hy * 0.55) * speed;
      piece.angle = rotation;
      piece.spin = (rng() - 0.5) * 5.5;
      piece.scale = scale;
      piece.maxLife = 0.85 + rng() * 0.75;
      piece.life = piece.maxLife;
      piece.shade = poly.shade;
      piece.accent = poly.accent;
      piece.color = color;
    }
  }

  update(dt: number): void {
    for (let i = this.activeIndices.length - 1; i >= 0; i--) {
      const poolIndex = this.activeIndices[i];
      const piece = this.pool[poolIndex];
      piece.life -= dt;
      if (piece.life <= 0) {
        piece.active = false;
        piece.def = null;
        this.activeIndices.splice(i, 1);
        this.freeStack.push(poolIndex);
        continue;
      }
      piece.x += piece.vx * dt;
      piece.y += piece.vy * dt;
      piece.vx *= 1 - 1.15 * dt;
      piece.vy *= 1 - 1.15 * dt;
      piece.angle += piece.spin * dt;
    }
    this.activeCount = this.activeIndices.length;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    this.drawnCount = 0;
    if (this.activeIndices.length === 0) return;
    for (let i = 0; i < this.activeIndices.length; i++) {
      const piece = this.pool[this.activeIndices[i]];
      if (!piece.def || !piece.color) continue;
      const geo = getShipGeometry(piece.def);
      const screen = camera.worldToScreen(new Vec2(piece.x, piece.y));
      if (screen.x < -60 || screen.y < -60 || screen.x > camera.screenW + 60 || screen.y > camera.screenH + 60) continue;
      const ramp = getShadeRamp(piece.color, geo.shadeBands, geo.hueSpread, geo.accentHueShift);
      const band = Math.max(0, Math.min(geo.shadeBands - 1, Math.round(piece.shade * (geo.shadeBands - 1))));
      const drawScale = camera.zoom * piece.scale;
      ctx.save();
      ctx.globalAlpha = Math.min(1, piece.life / piece.maxLife);
      ctx.translate(screen.x, screen.y);
      ctx.rotate(piece.angle);
      ctx.scale(drawScale, drawScale);
      ctx.fillStyle = piece.accent ? ramp.accents[band] : ramp.fills[band];
      ctx.fill(getComponentPath(geo, piece.index));
      ctx.restore();
      this.drawnCount++;
    }
    ctx.globalAlpha = 1;
  }

  clear(): void {
    for (let i = 0; i < this.activeIndices.length; i++) this.pool[this.activeIndices[i]].active = false;
    this.activeIndices.length = 0;
    this.freeStack = Array.from({ length: POOL_SIZE }, (_, i) => POOL_SIZE - 1 - i);
    this.activeCount = 0;
  }
}
