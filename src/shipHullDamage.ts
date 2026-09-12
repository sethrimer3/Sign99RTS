import { bakeBuckets, getShipGeometry, seededRandom, shipDesignRadius, type ProceduralShipDefinition, type ShipGeometry, type ShipBucket } from './proceduralShips.js';
import { Vec2 } from './math.js';
import type { ShipDebrisSystem } from './shipDebris.js';
import type { Color } from './colors.js';

/** World-space trajectory; origin is a point on the shot line or the explosion centre. */
export interface HullImpact {
  kind: 'bullet' | 'laser' | 'explosion';
  x: number; y: number;
  dx: number; dy: number;
  radius?: number;
}
export interface HullBody {
  position: Vec2; angle: number; radius: number;
  health: number; maxHealth: number; alive: boolean;
}
export interface HullSnapshot { removed: number[]; coreIntegrityFrac?: number; }
type Mesh = { buckets: ShipBucket[]; silhouette: Path2D | null };

/** Structural damage model. HP is derived from connected hull mass. Core hits kill the ship. */
export class ShipHullDamage {
  private geometry: ShipGeometry | null = null;
  private definition: ProceduralShipDefinition | null = null;
  private gone = new Set<number>();
  private order: number[] = [];
  private pending: Array<{ indices: number[]; hit: HullImpact }> = [];
  private mesh: Mesh | null = null;
  private dirty = false;
  
  coreIntegrity: number = -1;
  maxCoreIntegrity: number = 0;
  connectedMass: number = 0;

  constructor(private design: () => ProceduralShipDefinition | null, readonly visualScale = 1.4) {}

  get coreIntegrityFrac(): number {
    return this.maxCoreIntegrity > 0 ? this.coreIntegrity / this.maxCoreIntegrity : 1;
  }

  private ensure(): ShipGeometry | null {
    const def = this.design();
    if (def !== this.definition) {
      this.reset();
      this.definition = def;
      this.geometry = def ? getShipGeometry(def) : null;
    }
    return this.geometry;
  }

  reset(): void {
    this.gone.clear(); this.order.length = 0; this.pending.length = 0;
    this.mesh = null; this.dirty = false;
    this.definition = null; this.geometry = null;
    this.coreIntegrity = -1; this.maxCoreIntegrity = 0; this.connectedMass = 0;
  }

  get removedIndices(): readonly number[] { return this.order; }
  
  snapshot(): HullSnapshot | undefined {
    if (this.order.length || (this.maxCoreIntegrity > 0 && this.coreIntegrity < this.maxCoreIntegrity)) {
      return { removed: [...this.order], coreIntegrityFrac: this.coreIntegrityFrac };
    }
    return undefined;
  }

  private initCore(body: HullBody) {
    if (this.coreIntegrity === -1) {
      this.maxCoreIntegrity = body.maxHealth * 0.25;
      this.coreIntegrity = this.maxCoreIntegrity;
      if (this.geometry) {
        this.connectedMass = this.geometry.totalMass;
      }
    }
  }

  hit(body: HullBody, damage: number, impact?: HullImpact): void {
    if (!(damage > 0)) return;
    const geo = this.ensure();
    if (!geo || !this.definition) return;
    this.initCore(body);

    let massBudget = (damage / body.maxHealth) * geo.totalMass;
    
    const hit = impact ?? { kind: 'bullet', x: body.position.x - Math.cos(body.angle) * body.radius * 2,
      y: body.position.y - Math.sin(body.angle) * body.radius * 2, dx: Math.cos(body.angle), dy: Math.sin(body.angle) };
    const scale = body.radius * this.visualScale / shipDesignRadius(this.definition);
    const cos = Math.cos(body.angle), sin = Math.sin(body.angle);
    const ox = hit.x - body.position.x, oy = hit.y - body.position.y;
    const sx = (ox * cos + oy * sin) / scale, sy = (-ox * sin + oy * cos) / scale;
    let dx = hit.kind === 'explosion' ? -sx : (hit.dx * cos + hit.dy * sin);
    let dy = hit.kind === 'explosion' ? -sy : (-hit.dx * sin + hit.dy * cos);
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
    const radius = shipDesignRadius(this.definition);
    const lane = Math.max(1, (hit.radius ?? 0) / scale, radius * (hit.kind === 'explosion' ? 0.45 : 0.07));
    const { front, back } = rankedComponents(geo, dx, dy, sx, sy, lane, radius);
    
    let fi = 0, bi = 0;
    const detached: number[] = [];
    let coreHit = false;

    while (massBudget > 0 && this.gone.size < geo.polyCount) {
      let i = detached.length;
      const exitTarget = hit.kind === 'laser' && i % 2 === 1;
      const list = exitTarget ? back : front;
      let at = exitTarget ? bi : fi;
      
      while (at < list.length && this.gone.has(list[at])) at++;
      
      if (at >= list.length) {
         if (hit.kind === 'laser') {
            if (exitTarget) { bi = list.length; } else { fi = list.length; }
            if (fi >= front.length && bi >= back.length) break;
            detached.push(-1); // dummy to flip the `i % 2` parity
            continue;
         } else {
            break;
         }
      }
      
      const index = list[at];
      if (exitTarget) bi = at + 1; else fi = at + 1;
      
      const poly = geo.polygons[index];
      if (poly.isCore) {
         this.coreIntegrity -= (massBudget / geo.totalMass) * body.maxHealth;
         coreHit = true;
         break; // Damage corridor hit the core, stop excavating
      } else {
         this.gone.add(index);
         this.order.push(index);
         detached.push(index);
         massBudget -= poly.area;
      }
    }

    const actualDetached = detached.filter(idx => idx >= 0);
    if (actualDetached.length > 0 || coreHit) {
      if (actualDetached.length > 0) {
        this.pending.push({ indices: actualDetached, hit });
      }
      this.recalculateConnectivity(geo, hit);
      this.dirty = true;
      body.health = body.maxHealth * (this.connectedMass / geo.totalMass);
    }
  }

  private recalculateConnectivity(geo: ShipGeometry, hit: HullImpact): void {
    if (this.coreIntegrity <= 0) {
      const detached: number[] = [];
      for (const poly of geo.polygons) {
        if (!this.gone.has(poly.index)) {
          this.gone.add(poly.index);
          detached.push(poly.index);
        }
      }
      this.connectedMass = 0;
      if (detached.length > 0) {
        this.pending.push({ indices: detached, hit });
      }
      return;
    }

    const queue = [...geo.coreIndices];
    const reachable = new Set(geo.coreIndices);
    let connectedMass = 0;
    
    while (queue.length > 0) {
      const curr = queue.shift()!;
      connectedMass += geo.polygons[curr].area;
      for (const neighbor of geo.polygons[curr].neighbors) {
        if (!this.gone.has(neighbor) && !reachable.has(neighbor)) {
          reachable.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    
    const disconnected: number[] = [];
    for (const poly of geo.polygons) {
      if (!this.gone.has(poly.index) && !reachable.has(poly.index) && !poly.isCore) {
        this.gone.add(poly.index);
        disconnected.push(poly.index);
      }
    }
    
    if (disconnected.length > 0) {
      this.pending.push({ indices: disconnected, hit });
    }
    this.connectedMass = connectedMass;

    // Structural collapse rule
    if (this.connectedMass < geo.totalMass * 0.1 && this.coreIntegrity > 0) {
      this.coreIntegrity = 0;
      this.recalculateConnectivity(geo, hit);
    }
  }

  repair(body: HullBody, amount: number): void {
    if (amount <= 0 || this.coreIntegrity <= 0) return;
    const geo = this.ensure();
    if (!geo) return;
    this.initCore(body);

    let massToRestore = (amount / body.maxHealth) * geo.totalMass;
    let restoredMass = 0;

    while (massToRestore > 0 && this.gone.size > 0) {
      let bestCandidate = -1;
      let bestDist = Infinity;
      for (const idx of this.gone) {
        const poly = geo.polygons[idx];
        let adjacent = false;
        for (const n of poly.neighbors) {
          if (!this.gone.has(n)) { adjacent = true; break; }
        }
        if (adjacent && poly.coreDistance < bestDist) {
          bestDist = poly.coreDistance;
          bestCandidate = idx;
        }
      }
      if (bestCandidate === -1) break;
      
      this.gone.delete(bestCandidate);
      const orderIdx = this.order.indexOf(bestCandidate);
      if (orderIdx >= 0) this.order.splice(orderIdx, 1);

      const restoredArea = geo.polygons[bestCandidate].area;
      massToRestore -= restoredArea;
      restoredMass += restoredArea;
      this.dirty = true;
    }

    if (restoredMass > 0) {
      this.recalculateConnectivity(geo, { kind: 'bullet', x: body.position.x, y: body.position.y, dx: 0, dy: 0 });
      body.health = body.maxHealth * (this.connectedMass / geo.totalMass);
    }
    
    if (massToRestore > 0 && this.coreIntegrity < this.maxCoreIntegrity) {
      this.coreIntegrity = Math.min(this.maxCoreIntegrity, this.coreIntegrity + (massToRestore / geo.totalMass) * body.maxHealth);
    }
  }

  applySnapshot(snapshot: HullSnapshot | undefined, body: HullBody, emit = true): void {
    const geo = this.ensure();
    if (!geo) return;
    this.initCore(body);
    const seen = new Set<number>();
    const next = (snapshot?.removed ?? []).slice(0, geo.polyCount).filter(i => {
      if (!Number.isInteger(i) || i < 0 || i >= geo.polyCount || seen.has(i)) return false;
      seen.add(i); return true;
    });
    if (next.length === this.order.length && next.every((v, i) => v === this.order[i]) && snapshot?.coreIntegrityFrac === this.coreIntegrityFrac) return;
    
    const added = next.filter(i => !this.gone.has(i));
    this.order = next; 
    this.gone = new Set(next); 
    this.dirty = true;
    
    if (snapshot?.coreIntegrityFrac !== undefined) {
      this.coreIntegrity = this.maxCoreIntegrity * snapshot.coreIntegrityFrac;
    } else {
      this.coreIntegrity = this.maxCoreIntegrity;
    }

    this.recalculateConnectivity(geo, { kind: 'bullet', x: body.position.x, y: body.position.y, dx: 0, dy: 0 });
    body.health = body.maxHealth * (this.connectedMass / geo.totalMass);
    
    if (emit && added.length) {
      this.pending.push({ indices: added, hit: { kind: 'bullet', x: body.position.x, y: body.position.y, dx: 0, dy: 0 } });
    }
  }

  flush(body: HullBody, debris: ShipDebrisSystem | null, color: Color): void {
    if (debris && this.definition) {
      const scale = body.radius * this.visualScale / shipDesignRadius(this.definition);
      for (const event of this.pending) {
        const source = event.hit.kind === 'explosion' ? new Vec2(event.hit.x, event.hit.y) : null;
        debris.emitShedComponents(this.definition, event.indices, body.position, body.angle, scale, color, source,
          seededRandom(this.definition.seed ^ (event.indices[0] + 1) * 2654435761));
      }
    }
    this.pending.length = 0;
  }

  renderMesh(): Mesh | null {
    const geo = this.ensure();
    if (!geo || this.gone.size === 0) return null;
    if (this.dirty || !this.mesh) {
      const buckets = bakeBuckets(geo.polygons.filter(p => !this.gone.has(p.index)), geo.shadeBands);
      const silhouette = typeof Path2D === 'undefined' ? null : new Path2D();
      for (const b of buckets) if (b.path) silhouette?.addPath(b.path);
      this.mesh = { buckets, silhouette };
      this.dirty = false;
    }
    return this.mesh;
  }
}

// Rankings are shared by the entire fleet, with bounded direction/offset bins. Repeated
// fire along the same corridor only walks these indices; it does not sort 480 triangles.
const rankingCache = new WeakMap<ShipGeometry, Map<string, { front: Uint16Array; back: Uint16Array }>>();
function rankedComponents(geo: ShipGeometry, dx: number, dy: number, sx: number, sy: number, lane: number, radius: number) {
  const angleBin = Math.round(Math.atan2(dy, dx) * 64 / (Math.PI * 2));
  const angle = angleBin * Math.PI * 2 / 64;
  dx = Math.cos(angle); dy = Math.sin(angle);
  const offsetBin = Math.round((-sx * dy + sy * dx) * 16 / radius);
  const widthBin = Math.max(1, Math.ceil(lane * 32 / radius));
  const key = `${angleBin}:${offsetBin}:${widthBin}`;
  let cache = rankingCache.get(geo);
  if (!cache) { cache = new Map(); rankingCache.set(geo, cache); }
  const cached = cache.get(key);
  if (cached) return cached;
  const offset = offsetBin * radius / 16;
  const width = widthBin * radius / 32;
  const ranked = geo.polygons.map(p => {
    const along = p.cx * dx + p.cy * dy;
    const across = Math.abs(-p.cx * dy + p.cy * dx - offset);
    const off = Math.max(0, across - p.feature * 0.5 - width);
    const core = (1 - p.peripheral) * radius * 0.12;
    return { index: p.index, front: along + off * 8 + core, back: -along + off * 8 + core };
  });
  const front = Uint16Array.from(ranked.sort((a, b) => a.front - b.front || a.index - b.index).map(p => p.index));
  const back = Uint16Array.from(ranked.sort((a, b) => a.back - b.back || a.index - b.index).map(p => p.index));
  const result = { front, back };
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}
