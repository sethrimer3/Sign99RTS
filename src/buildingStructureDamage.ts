import { Vec2 } from './math.js';
import type { HullImpact } from './shipHullDamage.js';
import type { ShipDebrisSystem } from './shipDebris.js';
import type { Color } from './colors.js';
import { GRID_CELL_SIZE } from './grid.js';

export interface BuildingStructureBody {
  id: number;
  position: Vec2;
  footprintCells: number; // e.g., 2 for a 2x2 building
  health: number;
  maxHealth: number;
  synonymousVisualKind?: string | null;
}

export interface BSPLeaf {
  index: number;
  x: number; y: number; // Center relative to building center
  w: number; h: number;
  area: number;
  neighbors: number[];
  rootDistance: number;
  isCore: boolean;
  coreIndex: number; // 0: TL, 1: TR, 2: BL, 3: BR, -1: none
}

export interface BSPGeometry {
  leaves: BSPLeaf[];
  totalMass: number;
  rootIndices: number[];
  footprintCells: number;
  seed: number;
}

export const BUILDING_STRUCTURAL_COLLAPSE_FRACTION = 0.10;
export const BUILDING_CORE_INTEGRITY_FRACTION = 0.10;
export const BUILDING_CORE_CRITICAL_MASS_FRACTION = 0.075;

export interface BuildingStructureSnapshot {
  removed: number[];
  coreIntegrityFrac: [number, number, number, number];
  seed: number;
}

// Simple seeded random to match ship logic
function seededRandom(seed: number) {
  let t = seed += 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function rectsOverlap(x1: number, y1: number, w1: number, h1: number, x2: number, y2: number, w2: number, h2: number, margin = 0.1) {
  return Math.abs(x1 - x2) * 2 <= (w1 + w2) + margin && Math.abs(y1 - y2) * 2 <= (h1 + h2) + margin;
}

function generateBSPGeometry(footprintCells: number, seed: number): BSPGeometry {
  const worldSide = footprintCells * GRID_CELL_SIZE;
  const half = worldSide * 0.5;
  const leaves: BSPLeaf[] = [];
  
  // Decide target count.
  const maxLeaves = footprintCells <= 1 ? 8 : (footprintCells <= 2 ? 24 : 48);

  const rects = [{x: 0, y: 0, w: worldSide, h: worldSide, depth: 0}];
  
  let rngSeed = seed;
  const rand = () => seededRandom(rngSeed++);
  
  while (rects.length < maxLeaves) {
    let biggestIdx = -1;
    let biggestArea = -1;
    for (let i = 0; i < rects.length; i++) {
      const area = rects[i].w * rects[i].h;
      if (area > biggestArea) {
        biggestArea = area;
        biggestIdx = i;
      }
    }
    
    if (biggestIdx === -1) break;
    const r = rects[biggestIdx];
    
    // Stop if too small
    if (r.w < GRID_CELL_SIZE * 0.3 || r.h < GRID_CELL_SIZE * 0.3) {
      if (rects.length >= 8) break; // Ensure at least some splits
    }
    
    rects.splice(biggestIdx, 1);
    
    const splitHoriz = r.h > r.w * 1.2 ? true : (r.w > r.h * 1.2 ? false : rand() > 0.5);
    const splitRatio = 0.3 + rand() * 0.4;
    
    if (splitHoriz) { // Split along Y
      const h1 = r.h * splitRatio;
      const h2 = r.h - h1;
      rects.push({x: r.x, y: r.y - r.h/2 + h1/2, w: r.w, h: h1, depth: r.depth + 1});
      rects.push({x: r.x, y: r.y + r.h/2 - h2/2, w: r.w, h: h2, depth: r.depth + 1});
    } else { // Split along X
      const w1 = r.w * splitRatio;
      const w2 = r.w - w1;
      rects.push({x: r.x - r.w/2 + w1/2, y: r.y, w: w1, h: r.h, depth: r.depth + 1});
      rects.push({x: r.x + r.w/2 - w2/2, y: r.y, w: w2, h: r.h, depth: r.depth + 1});
    }
  }

  let totalMass = 0;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    let coreIndex = -1;
    const coreMargin = worldSide * 0.25;
    const isTop = r.y < -half + coreMargin;
    const isBot = r.y > half - coreMargin;
    const isLeft = r.x < -half + coreMargin;
    const isRight = r.x > half - coreMargin;
    if (isTop && isLeft) coreIndex = 0;
    else if (isTop && isRight) coreIndex = 1;
    else if (isBot && isLeft) coreIndex = 2;
    else if (isBot && isRight) coreIndex = 3;

    leaves.push({
      index: i,
      x: r.x, y: r.y,
      w: r.w, h: r.h,
      area: r.w * r.h,
      neighbors: [],
      rootDistance: 999,
      isCore: coreIndex !== -1,
      coreIndex: coreIndex,
    });
    totalMass += r.w * r.h;
  }
  
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j];
      if (rectsOverlap(a.x, a.y, a.w, a.h, b.x, b.y, b.w, b.h, 1.0)) {
        a.neighbors.push(j);
        b.neighbors.push(i);
      }
    }
  }

  const rootIndices: number[] = [];
  const centerThresh = worldSide * 0.2;
  for (let i = 0; i < leaves.length; i++) {
    if (rectsOverlap(leaves[i].x, leaves[i].y, leaves[i].w, leaves[i].h, 0, 0, centerThresh, centerThresh)) {
      rootIndices.push(i);
    }
  }
  if (rootIndices.length === 0) {
    let closest = 0;
    let minDist = 999999;
    for (let i = 0; i < leaves.length; i++) {
      const d = leaves[i].x * leaves[i].x + leaves[i].y * leaves[i].y;
      if (d < minDist) {
        minDist = d;
        closest = i;
      }
    }
    rootIndices.push(closest);
  }

  const q = [...rootIndices];
  for (const r of rootIndices) leaves[r].rootDistance = 0;
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    const d = leaves[cur].rootDistance;
    for (const n of leaves[cur].neighbors) {
      if (leaves[n].rootDistance > d + 1) {
        leaves[n].rootDistance = d + 1;
        q.push(n);
      }
    }
  }

  return { leaves, totalMass, rootIndices, footprintCells, seed };
}

export class BuildingStructureDamage {
  private geo: BSPGeometry | null = null;
  public removedIndices: number[] = [];
  public connectedMass: number = 0;
  public coreIntegrity: [number, number, number, number] = [1, 1, 1, 1];
  
  public pendingDetached: { indices: number[], hit: HullImpact | null }[] = [];
  
  private dirtyRender: boolean = true;
  private cachedPath: Path2D | null = null;
  private appliedSeed?: number;

  constructor(private seedFallback: number) {}

  public ensure(body: BuildingStructureBody): BSPGeometry {
    if (this.geo && this.geo.footprintCells === body.footprintCells) return this.geo;
      if (this.geo && this.geo.footprintCells !== body.footprintCells) this.appliedSeed = undefined;
    const seed = this.appliedSeed ?? (this.seedFallback ^ (body.footprintCells * 1234567));
    this.geo = generateBSPGeometry(body.footprintCells, seed);
    
    
    this.removedIndices = [];
    this.coreIntegrity = [1, 1, 1, 1];
    this.connectedMass = this.geo.totalMass;
    this.dirtyRender = true;
    return this.geo;
  }

  public get geometry(): BSPGeometry | null {
    return this.geo;
  }

  public renderMesh(body: BuildingStructureBody): Path2D | null {
    const geo = this.ensure(body);
    if (!this.dirtyRender && this.cachedPath) return this.cachedPath;
    
    if (typeof Path2D === 'undefined') return null;

    this.cachedPath = new Path2D();
    const gone = new Set(this.removedIndices);
    for (let i = 0; i < geo.leaves.length; i++) {
      if (gone.has(i)) continue;
      const r = geo.leaves[i];
      this.cachedPath.rect(r.x - r.w/2 - 0.5, r.y - r.h/2 - 0.5, r.w + 1.0, r.h + 1.0);
    }
    
    this.dirtyRender = false;
    return this.cachedPath;
  }

  public syncHP(body: BuildingStructureBody) {
    if (!this.geo) return;
    body.health = body.maxHealth * (this.connectedMass / this.geo.totalMass);
  }

  private isCoreSupported(coreIndex: number): boolean {
    if (!this.geo) return false;
    const gone = new Set(this.removedIndices);
    for (const r of this.geo.leaves) {
      if (r.coreIndex === coreIndex && !gone.has(r.index)) return true;
    }
    return false;
  }

  private updateConnectivity(body: BuildingStructureBody, hit: HullImpact | null) {
    const geo = this.ensure(body);
    const gone = new Set(this.removedIndices);
    
    const rootSurviving = geo.rootIndices.filter(i => !gone.has(i));
    if (rootSurviving.length === 0) {
      const detached = [];
      for (let i = 0; i < geo.leaves.length; i++) {
        if (!gone.has(i)) detached.push(i);
      }
      if (detached.length > 0) {
        this.removedIndices.push(...detached);
        this.pendingDetached.push({ indices: detached, hit: hit ?? { kind: 'explosion', x: body.position.x, y: body.position.y, dx: 0, dy: 0 } });
      }
      this.connectedMass = 0;
      this.syncHP(body);
      return;
    }

    const connected = new Set<number>();
    const q = [...rootSurviving];
    for (const r of rootSurviving) connected.add(r);
    
    let head = 0;
    while (head < q.length) {
      const cur = q[head++];
      for (const n of geo.leaves[cur].neighbors) {
        if (!gone.has(n) && !connected.has(n)) {
          connected.add(n);
          q.push(n);
        }
      }
    }
    
    const detached = [];
    let newMass = 0;
    for (let i = 0; i < geo.leaves.length; i++) {
      if (gone.has(i)) continue;
      if (!connected.has(i)) {
        detached.push(i);
        this.removedIndices.push(i);
      } else {
        newMass += geo.leaves[i].area;
      }
    }
    
    this.connectedMass = newMass;
    
    if (detached.length > 0) {
      this.pendingDetached.push({ indices: detached, hit: hit ?? { kind: 'explosion', x: body.position.x, y: body.position.y, dx: 0, dy: 0 } });
    }

    for (let i = 0; i < 4; i++) {
      if (this.coreIntegrity[i] > 0 && !this.isCoreSupported(i)) {
        this.coreIntegrity[i] = 0;
      }
    }

    this.dirtyRender = true;
    this.syncHP(body);
  }

  public hit(body: BuildingStructureBody, damage: number, impact?: HullImpact) {
    if (!(damage > 0)) return;
    const geo = this.ensure(body);
    
    let massBudget = (damage / body.maxHealth) * geo.totalMass;
    const hit = impact ?? { kind: 'bullet', x: body.position.x, y: body.position.y, dx: 0, dy: 1 };
    
    const lx = hit.x - body.position.x;
    const ly = hit.y - body.position.y;
    
    const gone = new Set(this.removedIndices);
    
    const candidates = [];
    for (let i = 0; i < geo.leaves.length; i++) {
      if (gone.has(i)) continue;
      const r = geo.leaves[i];
      let score = 0;
      
      if (hit.kind === 'explosion') {
        const dx = r.x - lx;
        const dy = r.y - ly;
        const distSq = dx*dx + dy*dy;
        score = -distSq;
      } else {
        const dx = r.x - lx;
        const dy = r.y - ly;
        const dot = dx * hit.dx + dy * hit.dy;
        const projX = hit.dx * dot;
        const projY = hit.dy * dot;
        const perpX = dx - projX;
        const perpY = dy - projY;
        const perpDist = Math.sqrt(perpX*perpX + perpY*perpY);
        if (perpDist > Math.max(r.w, r.h) + (hit.radius || 0)) {
           score = -999999;
        } else {
           score = hit.kind === 'bullet' ? -dot : -perpDist;
        }
      }
      candidates.push({ index: i, score, leaf: r });
    }
    
    candidates.sort((a, b) => b.score - a.score);
    
    const shed = [];
    for (const c of candidates) {
      if (massBudget <= 0) break;
      if (c.score === -999999) break;
      
      massBudget -= c.leaf.area;
      shed.push(c.index);
      gone.add(c.index);
      this.removedIndices.push(c.index);
      
      if (c.leaf.isCore && c.leaf.coreIndex !== -1) {
        const ci = c.leaf.coreIndex;
        if (this.coreIntegrity[ci] > 0) {
           this.coreIntegrity[ci] = Math.max(0, this.coreIntegrity[ci] - 0.5);
           if (this.coreIntegrity[ci] === 0) {
             massBudget += BUILDING_CORE_CRITICAL_MASS_FRACTION * geo.totalMass;
           }
        }
      }
    }
    
    if (shed.length > 0) {
      this.pendingDetached.push({ indices: shed, hit: hit });
    }
    
    this.updateConnectivity(body, hit);
  }

  public repair(body: BuildingStructureBody, amount: number) {
    if (!(amount > 0)) return;
    const geo = this.ensure(body);
    
    let restoreMass = (amount / body.maxHealth) * geo.totalMass;
    const gone = new Set(this.removedIndices);
    if (gone.size === 0) return;
    
    const candidates = [];
    for (let i = 0; i < geo.leaves.length; i++) {
      if (!gone.has(i)) continue;
      const r = geo.leaves[i];
      let isAdjacent = false;
      if (geo.rootIndices.includes(i)) {
        isAdjacent = true;
      } else {
        for (const n of r.neighbors) {
          if (!gone.has(n)) {
            isAdjacent = true;
            break;
          }
        }
      }
      
      if (isAdjacent) {
        candidates.push({ index: i, leaf: r });
      }
    }
    
    candidates.sort((a, b) => a.leaf.rootDistance - b.leaf.rootDistance);
    
    let repairedAny = false;
    for (const c of candidates) {
      if (restoreMass <= 0) break;
      restoreMass -= c.leaf.area;
      gone.delete(c.index);
      repairedAny = true;
      
      if (c.leaf.isCore && c.leaf.coreIndex !== -1) {
        const ci = c.leaf.coreIndex;
        if (this.coreIntegrity[ci] < 1) {
          this.coreIntegrity[ci] = Math.min(1, this.coreIntegrity[ci] + 0.25);
        }
      }
    }
    
    if (repairedAny) {
      this.removedIndices = Array.from(gone);
      this.updateConnectivity(body, null);
    }
  }

  public flush(body: BuildingStructureBody, debris: ShipDebrisSystem, color: Color) {
    if (this.pendingDetached.length === 0) return;
    const geo = this.ensure(body);
    for (const event of this.pendingDetached) {
      const source = event.hit && event.hit.kind === 'explosion' ? new Vec2(event.hit.x, event.hit.y) : null;
      debris.emitBuildingDebris(geo, event.indices, body.position, color, source, (() => { let s = geo.seed ^ (event.indices[0] + 1) * 2654435761; return () => seededRandom(s++); })());
    }
    this.pendingDetached = [];
  }

  public collapseAll(body: BuildingStructureBody) {
    const geo = this.ensure(body);
    const gone = new Set(this.removedIndices);
    const detached = [];
    for (let i = 0; i < geo.leaves.length; i++) {
      if (!gone.has(i)) {
        detached.push(i);
      }
    }
    if (detached.length > 0) {
      this.removedIndices.push(...detached);
      this.pendingDetached.push({ indices: detached, hit: null });
    }
    this.connectedMass = 0;
    this.coreIntegrity = [0, 0, 0, 0];
    this.syncHP(body);
  }

  public snapshot(): BuildingStructureSnapshot {
    return {
      removed: [...this.removedIndices],
      coreIntegrityFrac: [...this.coreIntegrity],
      seed: this.appliedSeed ?? (this.seedFallback ^ ((this.geo?.footprintCells ?? 0) * 1234567)),
    };
  }

  public applySnapshot(snap: BuildingStructureSnapshot | undefined, body: BuildingStructureBody) {
    if (!snap) {
      this.removedIndices = [];
      this.coreIntegrity = [1, 1, 1, 1];
      this.dirtyRender = true;
      const geo = this.ensure(body);
      this.connectedMass = geo.totalMass;
      return;
    }
    this.appliedSeed = snap.seed;
    this.removedIndices = [...snap.removed];
    this.coreIntegrity = [...snap.coreIntegrityFrac];
    this.dirtyRender = true;
    
    const geo = this.ensure(body);
    const gone = new Set(this.removedIndices);
    let mass = 0;
    for (let i = 0; i < geo.leaves.length; i++) {
      if (!gone.has(i)) mass += geo.leaves[i].area;
    }
    this.connectedMass = mass;
    this.syncHP(body);
  }
}

