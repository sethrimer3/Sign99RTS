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
  /** Binary min-heap (by coreDistance, then index) of gone polygons touching attached geometry. */
  private frontier: number[] = [];
  private inFrontier = new Set<number>();
  private frontierDirty = true;

  /** False until a body has been attached; until then `coreIntegrity` carries no meaning. */
  coreInitialized = false;
  coreIntegrity: number = 0;
  maxCoreIntegrity: number = 0;
  connectedMass: number = 0;

  constructor(private design: () => ProceduralShipDefinition | null, readonly visualScale = 1.4) {}

  get coreIntegrityFrac(): number {
    return this.maxCoreIntegrity > 0 ? this.coreIntegrity / this.maxCoreIntegrity : 1;
  }

  /** Only ever true once a body has been attached and the core has actually been breached. */
  get coreDestroyed(): boolean {
    return this.coreInitialized && this.coreIntegrity <= 0;
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
    this.frontier.length = 0; this.inFrontier.clear(); this.frontierDirty = true;
    this.definition = null; this.geometry = null;
    this.coreInitialized = false;
    this.coreIntegrity = 0; this.maxCoreIntegrity = 0; this.connectedMass = 0;
  }

  get removedIndices(): readonly number[] { return this.order; }
  
  snapshot(): HullSnapshot | undefined {
    if (this.order.length || (this.maxCoreIntegrity > 0 && this.coreIntegrity < this.maxCoreIntegrity)) {
      return { removed: [...this.order], coreIntegrityFrac: this.coreIntegrityFrac };
    }
    return undefined;
  }

  /** Attach a body so the core budget is known. Safe (and idempotent) to call at any time. */
  attach(body: HullBody): void {
    this.ensure();
    this.initCore(body);
  }

  private initCore(body: HullBody) {
    const budget = body.maxHealth * 0.25;
    if (!this.coreInitialized) {
      this.coreInitialized = true;
      this.maxCoreIntegrity = budget;
      this.coreIntegrity = budget;
      if (this.geometry) {
        this.connectedMass = this.geometry.totalMass;
      }
    } else if (this.maxCoreIntegrity !== budget) {
      // Ships are attached at spawn but max HP moves with research; keep the
      // core budget proportional so upgrades never resurrect or kill a core.
      const frac = this.coreIntegrityFrac;
      this.maxCoreIntegrity = budget;
      this.coreIntegrity = budget * frac;
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
         this.frontierDirty = true;
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
          this.frontierDirty = true;
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
        this.frontierDirty = true;
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

  /**
   * Regrow shed polygons from the core outward: always the gone polygon with the
   * smallest `coreDistance` among those touching still-attached geometry, so nothing
   * ever reappears floating free of the hull.
   *
   * `restoreComponents = false` tops up HP/core only (used when the ship has not
   * researched the structural-repair upgrade); HP is then capped by the mass that
   * is still connected, so a gutted hull cannot heal past its structural ceiling.
   */
  repair(body: HullBody, amount: number, restoreComponents = true): void {
    if (amount <= 0 || this.coreDestroyed) return;
    const geo = this.ensure();
    if (!geo) return;
    this.initCore(body);

    let massToRestore = (amount / body.maxHealth) * geo.totalMass;
    let restoredMass = 0;

    if (restoreComponents) {
      this.rebuildFrontierIfDirty(geo);
      while (massToRestore > 0 && this.gone.size > 0) {
        const bestCandidate = this.popFrontier(geo);
        if (bestCandidate === -1) break;

        this.gone.delete(bestCandidate);
        // Neighbours of a restored polygon are now adjacent to attached geometry.
        for (const n of geo.polygons[bestCandidate].neighbors) {
          if (this.gone.has(n)) this.pushFrontier(geo, n);
        }

        const restoredArea = geo.polygons[bestCandidate].area;
        massToRestore -= restoredArea;
        restoredMass += restoredArea;
        this.dirty = true;
      }
    }

    if (restoredMass > 0) {
      // Compact the removal order once per call instead of splicing per polygon.
      let write = 0;
      for (let read = 0; read < this.order.length; read++) {
        const idx = this.order[read];
        if (this.gone.has(idx)) this.order[write++] = idx;
      }
      this.order.length = write;
      this.recalculateConnectivity(geo, { kind: 'bullet', x: body.position.x, y: body.position.y, dx: 0, dy: 0 });
      body.health = body.maxHealth * (this.connectedMass / geo.totalMass);
    } else if (!restoreComponents) {
      const ceiling = body.maxHealth * (this.gone.size > 0 ? this.connectedMass / geo.totalMass : 1);
      body.health = Math.min(ceiling, body.health + amount);
    }

    if (massToRestore > 0 && this.coreIntegrity < this.maxCoreIntegrity) {
      this.coreIntegrity = Math.min(this.maxCoreIntegrity, this.coreIntegrity + (massToRestore / geo.totalMass) * body.maxHealth);
    }
  }

  private rebuildFrontierIfDirty(geo: ShipGeometry): void {
    if (!this.frontierDirty) return;
    this.frontierDirty = false;
    this.frontier.length = 0;
    this.inFrontier.clear();
    for (const idx of this.gone) {
      for (const n of geo.polygons[idx].neighbors) {
        if (!this.gone.has(n)) { this.pushFrontier(geo, idx); break; }
      }
    }
  }

  /** Ordering key: core-outward, ties broken by polygon index so LAN peers agree. */
  private frontierBefore(geo: ShipGeometry, a: number, b: number): boolean {
    const da = geo.polygons[a].coreDistance, db = geo.polygons[b].coreDistance;
    return da !== db ? da < db : a < b;
  }

  private pushFrontier(geo: ShipGeometry, idx: number): void {
    if (this.inFrontier.has(idx)) return;
    this.inFrontier.add(idx);
    const heap = this.frontier;
    let i = heap.length;
    heap.push(idx);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.frontierBefore(geo, heap[i], heap[parent])) break;
      const t = heap[i]; heap[i] = heap[parent]; heap[parent] = t;
      i = parent;
    }
  }

  private popFrontier(geo: ShipGeometry): number {
    const heap = this.frontier;
    while (heap.length > 0) {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let best = i;
          if (l < heap.length && this.frontierBefore(geo, heap[l], heap[best])) best = l;
          if (r < heap.length && this.frontierBefore(geo, heap[r], heap[best])) best = r;
          if (best === i) break;
          const t = heap[i]; heap[i] = heap[best]; heap[best] = t;
          i = best;
        }
      }
      this.inFrontier.delete(top);
      if (this.gone.has(top)) return top;
    }
    return -1;
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
    this.frontierDirty = true;
    
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
