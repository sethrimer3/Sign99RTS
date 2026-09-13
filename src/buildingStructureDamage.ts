import { Vec2 } from './math.js';
import type { HullImpact } from './shipHullDamage.js';
import type { ShipDebrisSystem } from './shipDebris.js';
import type { Color } from './colors.js';
import { GRID_CELL_SIZE } from './grid.js';
import { footprintForBuildingType } from './buildingfootprint.js';
import type { EntityType } from './entities.js';

export interface BuildingStructureBody {
  id: number;
  type: EntityType;
  position: Vec2;
  /**
   * Optional instance override used by compact research nodes. Ordinary
   * buildings derive their footprint from their entity type.
   */
  footprintCells?: number | null;
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

/** A corner weak-point hitbox in building-local coordinates (center-relative), matching the visible fiery node. */
export interface CoreRegion { x: number; y: number; w: number; h: number; }

export interface BSPGeometry {
  leaves: BSPLeaf[];
  totalMass: number;
  rootIndices: number[];
  footprintCells: number;
  seed: number;
  coreRegions: [CoreRegion, CoreRegion, CoreRegion, CoreRegion];
}

export const BUILDING_STRUCTURAL_COLLAPSE_FRACTION = 0.10;
export const BUILDING_CORE_INTEGRITY_FRACTION = 0.10;
export const BUILDING_CORE_CRITICAL_MASS_FRACTION = 0.075;

export interface BuildingStructureSnapshot {
  removed: number[];
  coreIntegrityFrac: [number, number, number, number];
  /** Whether each core's one-time localized critical structural burst has already fired. Optional for older snapshots. */
  coreCriticalFired?: [boolean, boolean, boolean, boolean];
  seed: number;
}

// Simple seeded random to match ship logic
function seededRandom(seed: number) {
  let t = seed += 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Loose containment/proximity test — used for root seeding only, not structural adjacency. */
function rectsOverlap(x1: number, y1: number, w1: number, h1: number, x2: number, y2: number, w2: number, h2: number, margin = 0.1) {
  return Math.abs(x1 - x2) * 2 <= (w1 + w2) + margin && Math.abs(y1 - y2) * 2 <= (h1 + h2) + margin;
}

/** Strict positive-area rectangle overlap (no touching-only false positive) — used for core-region tagging. */
function rectsOverlapStrict(x1: number, y1: number, w1: number, h1: number, x2: number, y2: number, w2: number, h2: number) {
  const eps = 1e-6;
  return Math.abs(x1 - x2) * 2 < (w1 + w2) - eps && Math.abs(y1 - y2) * 2 < (h1 + h2) - eps;
}

/**
 * The world-space edge length of one corner core node, shared by gameplay
 * (core hitboxes) and rendering (buildingCoreEffect mask) so they can never
 * drift apart. Mirrors the previous inline formula in building.ts.
 */
export function buildingCoreNodeSize(worldSide: number): number {
  return Math.min(worldSide * 0.45, GRID_CELL_SIZE);
}

function computeCoreRegions(worldSide: number): [CoreRegion, CoreRegion, CoreRegion, CoreRegion] {
  const half = worldSide * 0.5;
  const n = buildingCoreNodeSize(worldSide);
  const inset = half - n / 2;
  return [
    { x: -inset, y: -inset, w: n, h: n }, // TL
    { x: inset, y: -inset, w: n, h: n },  // TR
    { x: -inset, y: inset, w: n, h: n },  // BL
    { x: inset, y: inset, w: n, h: n },   // BR
  ];
}

/** Minimum shared-edge length (as a fraction of the smaller leaf's own edge) to count as real structural adjacency. */
const ADJACENCY_MIN_OVERLAP_FRAC = 0.02;
const ADJACENCY_EDGE_EPS = 1e-3;

/**
 * Exact edge adjacency for BSP rectangles: two leaves are structural
 * neighbors only when they share a real, positive-length edge segment
 * (a vertical edge with overlapping vertical extent, or a horizontal edge
 * with overlapping horizontal extent). Corner-only contact — where the
 * shared extent collapses to a single point — is explicitly rejected.
 */
export function leavesAdjacent(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  const aL = a.x - a.w / 2, aR = a.x + a.w / 2, aT = a.y - a.h / 2, aB = a.y + a.h / 2;
  const bL = b.x - b.w / 2, bR = b.x + b.w / 2, bT = b.y - b.h / 2, bB = b.y + b.h / 2;
  const minOverlap = Math.min(a.w, a.h, b.w, b.h) * ADJACENCY_MIN_OVERLAP_FRAC;

  // Shared vertical edge (a's right against b's left, or vice versa).
  if (Math.abs(aR - bL) < ADJACENCY_EDGE_EPS || Math.abs(bR - aL) < ADJACENCY_EDGE_EPS) {
    const lo = Math.max(aT, bT), hi = Math.min(aB, bB);
    if (hi - lo > minOverlap) return true;
  }
  // Shared horizontal edge (a's bottom against b's top, or vice versa).
  if (Math.abs(aB - bT) < ADJACENCY_EDGE_EPS || Math.abs(bB - aT) < ADJACENCY_EDGE_EPS) {
    const lo = Math.max(aL, bL), hi = Math.min(aR, bR);
    if (hi - lo > minOverlap) return true;
  }
  return false;
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

  const coreRegions = computeCoreRegions(worldSide);

  let totalMass = 0;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    let coreIndex = -1;
    for (let ci = 0; ci < 4; ci++) {
      const reg = coreRegions[ci];
      if (rectsOverlapStrict(r.x, r.y, r.w, r.h, reg.x, reg.y, reg.w, reg.h)) {
        coreIndex = ci;
        break;
      }
    }

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
      if (leavesAdjacent(a, b)) {
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

  return { leaves, totalMass, rootIndices, footprintCells, seed, coreRegions };
}

interface DirectionalCandidate {
  index: number;
  leaf: BSPLeaf;
  along: number;
  perpDist: number;
}

export class BuildingStructureDamage {
  private geo: BSPGeometry | null = null;
  public removedIndices: number[] = [];
  public connectedMass: number = 0;

  /** Actual remaining HP-equivalent for each of the 4 corner cores (not a fraction). */
  private coreIntegrityHP: [number, number, number, number] = [0, 0, 0, 0];
  /** Whether each core's structural support (BSP material overlapping its region, connected to the root) is intact. */
  private coreSupported: [boolean, boolean, boolean, boolean] = [true, true, true, true];
  /** Whether each core's one-time localized critical structural burst has already fired. */
  private coreCriticalFired: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  private lastMaxHealth = 0;

  public pendingDetached: { indices: number[], hit: HullImpact | null }[] = [];

  private dirtyRender: boolean = true;
  private cachedPath: Path2D | null = null;
  private appliedSeed?: number;

  constructor(private seedFallback: number) {}

  private get coreMaxIntegrityHP(): number {
    return this.lastMaxHealth * BUILDING_CORE_INTEGRITY_FRACTION;
  }

  /** 0..1 fraction per core for rendering/UI/snapshots. Zero whenever a core is unsupported, regardless of remaining integrity. */
  public get coreIntegrity(): [number, number, number, number] {
    const maxHP = this.coreMaxIntegrityHP;
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      if (!this.coreSupported[i] || maxHP <= 0) { out[i] = 0; continue; }
      out[i] = Math.max(0, Math.min(1, this.coreIntegrityHP[i] / maxHP));
    }
    return out;
  }

  public ensure(body: BuildingStructureBody): BSPGeometry {
    const cells = body.footprintCells ?? footprintForBuildingType(body.type);
    this.lastMaxHealth = body.maxHealth;
    if (this.geo && this.geo.footprintCells === cells) return this.geo;
      if (this.geo && this.geo.footprintCells !== cells) this.appliedSeed = undefined;
    const seed = this.appliedSeed ?? (this.seedFallback ^ (cells * 1234567));
    this.geo = generateBSPGeometry(cells, seed);


    this.removedIndices = [];
    this.coreIntegrityHP = [this.coreMaxIntegrityHP, this.coreMaxIntegrityHP, this.coreMaxIntegrityHP, this.coreMaxIntegrityHP];
    this.coreSupported = [true, true, true, true];
    this.coreCriticalFired = [false, false, false, false];
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

  /** True once connected structure has collapsed to nothing, or down to the catastrophic-failure threshold. */
  public isCollapsed(): boolean {
    if (!this.geo || this.geo.totalMass <= 0) return false;
    return this.connectedMass <= 0 || (this.connectedMass / this.geo.totalMass) <= BUILDING_STRUCTURAL_COLLAPSE_FRACTION;
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
      for (let i = 0; i < 4; i++) this.coreSupported[i] = false;
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

    // A core is "supported" only when at least one surviving leaf overlapping
    // its exact region is still part of the connected structure (not merely
    // un-removed but floating in its own detached island — `gone` above
    // already absorbed any newly-detached island via the push loop, so
    // isCoreSupported's fresh removedIndices read is accurate here).
    for (let i = 0; i < 4; i++) {
      this.coreSupported[i] = this.isCoreSupported(i);
    }

    this.dirtyRender = true;
    this.syncHP(body);
  }

  /** Normalizes a HullImpact's raw trajectory vector, with a deterministic center-seeking fallback for zero-length vectors. */
  private static normalizedDirection(hit: HullImpact, lx: number, ly: number): { dirX: number; dirY: number } {
    let dirX = hit.dx;
    let dirY = hit.dy;
    const dirLen = Math.hypot(dirX, dirY);
    if (dirLen > 1e-6) {
      dirX /= dirLen;
      dirY /= dirLen;
    } else {
      const fallbackLen = Math.hypot(lx, ly);
      if (fallbackLen > 1e-6) {
        dirX = -lx / fallbackLen;
        dirY = -ly / fallbackLen;
      } else {
        dirX = 1;
        dirY = 0;
      }
    }
    return { dirX, dirY };
  }

  /** Which core regions (0-3) the hit's corridor/point actually overlaps, independent of BSP leaf selection. */
  private hitCoreIndices(hit: HullImpact, lx: number, ly: number, dirX: number, dirY: number): number[] {
    const geo = this.geo;
    if (!geo) return [];
    const out: number[] = [];
    for (let ci = 0; ci < 4; ci++) {
      const reg = geo.coreRegions[ci];
      const dx = reg.x - lx;
      const dy = reg.y - ly;
      if (hit.kind === 'explosion') {
        const dist = Math.hypot(dx, dy);
        const reach = Math.max(reg.w, reg.h) * 0.5 + (hit.radius || 0);
        if (dist <= reach) out.push(ci);
        continue;
      }
      const along = dx * dirX + dy * dirY;
      const perpX = dx - dirX * along;
      const perpY = dy - dirY * along;
      const perpDist = Math.hypot(perpX, perpY);
      const corridorWidth = Math.max(reg.w, reg.h) * 0.5 + (hit.radius || 0);
      if (perpDist <= corridorWidth) out.push(ci);
    }
    return out;
  }

  /** Removes surviving leaves nearest the given core's region until massBudget is exhausted. Returns the removed indices. */
  private applyCoreCriticalBurst(geo: BSPGeometry, gone: Set<number>, coreIndex: number, massBudget: number): number[] {
    const region = geo.coreRegions[coreIndex];
    const candidates: { index: number; leaf: BSPLeaf; distSq: number }[] = [];
    for (let i = 0; i < geo.leaves.length; i++) {
      if (gone.has(i)) continue;
      const r = geo.leaves[i];
      const dx = r.x - region.x, dy = r.y - region.y;
      candidates.push({ index: i, leaf: r, distSq: dx * dx + dy * dy });
    }
    // Deterministic: nearest to the destroyed core first, ties broken by index.
    candidates.sort((a, b) => a.distSq - b.distSq || a.index - b.index);

    const shed: number[] = [];
    let budget = massBudget;
    for (const c of candidates) {
      if (budget <= 0) break;
      budget -= c.leaf.area;
      shed.push(c.index);
      gone.add(c.index);
    }
    return shed;
  }

  public hit(body: BuildingStructureBody, damage: number, impact?: HullImpact) {
    if (!(damage > 0)) return;
    const geo = this.ensure(body);

    let massBudget = (damage / body.maxHealth) * geo.totalMass;
    const hit = impact ?? { kind: 'bullet', x: body.position.x, y: body.position.y, dx: 0, dy: 1 };

    const lx = hit.x - body.position.x;
    const ly = hit.y - body.position.y;

    // hit.dx/dy are a raw world-space trajectory vector (bullet velocity, laser
    // beam displacement, etc.) and must not be assumed to already be a unit
    // vector — normalize before any dot-product/projection/corridor math.
    const { dirX, dirY } = BuildingStructureDamage.normalizedDirection(hit, lx, ly);

    const gone = new Set(this.removedIndices);
    const shed: number[] = [];

    // --- Core weak-point damage: independent of which BSP leaf(s) get shed. ---
    // Core hitboxes are the exact visible corner regions, not "whichever BSP
    // leaf happens to be near the corner" — a hit only touches a core when its
    // corridor/point genuinely overlaps that region.
    const hitCores = this.hitCoreIndices(hit, lx, ly, dirX, dirY);
    for (const ci of hitCores) {
      const maxHP = this.coreMaxIntegrityHP;
      if (maxHP <= 0 || !this.coreSupported[ci]) continue;
      const before = this.coreIntegrityHP[ci];
      if (before <= 0) continue;
      const after = Math.max(0, before - damage);
      this.coreIntegrityHP[ci] = after;
      if (after <= 0 && !this.coreCriticalFired[ci]) {
        this.coreCriticalFired[ci] = true;
        const burst = this.applyCoreCriticalBurst(geo, gone, ci, BUILDING_CORE_CRITICAL_MASS_FRACTION * geo.totalMass);
        for (const idx of burst) { shed.push(idx); this.removedIndices.push(idx); }
      }
    }

    if (hit.kind === 'explosion') {
      const candidates: { index: number; leaf: BSPLeaf; score: number }[] = [];
      for (let i = 0; i < geo.leaves.length; i++) {
        if (gone.has(i)) continue;
        const r = geo.leaves[i];
        const dx = r.x - lx, dy = r.y - ly;
        candidates.push({ index: i, leaf: r, score: -(dx * dx + dy * dy) });
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const c of candidates) {
        if (massBudget <= 0) break;
        massBudget -= c.leaf.area;
        shed.push(c.index);
        gone.add(c.index);
        this.removedIndices.push(c.index);
      }
    } else {
      // Collect every surviving leaf whose footprint actually falls inside the
      // shot corridor (perpendicular distance <= its own half-size + beam
      // radius + a small forgiveness margin), tagged with its along-ray
      // position so bullets can pick the outermost surviving panel and lasers
      // can damage both the entry and exit sides of the corridor.
      const candidates: DirectionalCandidate[] = [];
      for (let i = 0; i < geo.leaves.length; i++) {
        if (gone.has(i)) continue;
        const r = geo.leaves[i];
        const dx = r.x - lx, dy = r.y - ly;
        const along = dx * dirX + dy * dirY;
        const perpX = dx - dirX * along;
        const perpY = dy - dirY * along;
        const perpDist = Math.hypot(perpX, perpY);
        const corridorWidth = Math.max(r.w, r.h) * 0.5 + (hit.radius || 0) + GRID_CELL_SIZE * 0.5;
        if (perpDist > corridorWidth) continue;
        candidates.push({ index: i, leaf: r, along, perpDist });
      }

      if (hit.kind === 'laser') {
        // Entry side: nearest along the incoming ray first. Exit side: farthest
        // along the ray first. Alternate consumption so a strong beam visibly
        // carves material from both faces instead of only the entry surface.
        const entry = candidates.slice().sort((a, b) => a.along - b.along || a.perpDist - b.perpDist);
        const exit = candidates.slice().sort((a, b) => b.along - a.along || a.perpDist - b.perpDist);
        const taken = new Set<number>();
        let ei = 0, xi = 0;
        let wantEntry = true;
        while (massBudget > 0) {
          while (ei < entry.length && taken.has(entry[ei].index)) ei++;
          while (xi < exit.length && taken.has(exit[xi].index)) xi++;
          if (ei >= entry.length && xi >= exit.length) break;
          let picked: DirectionalCandidate | null = null;
          if (wantEntry && ei < entry.length) picked = entry[ei];
          else if (!wantEntry && xi < exit.length) picked = exit[xi];
          else picked = ei < entry.length ? entry[ei] : exit[xi];
          wantEntry = !wantEntry;
          if (!picked) break;
          taken.add(picked.index);
          massBudget -= picked.leaf.area;
          shed.push(picked.index);
          gone.add(picked.index);
          this.removedIndices.push(picked.index);
        }
      } else {
        // Bullets: single-sided excavation from the outermost surviving panel
        // along the incoming direction inward.
        candidates.sort((a, b) => a.along - b.along || a.perpDist - b.perpDist);
        for (const c of candidates) {
          if (massBudget <= 0) break;
          massBudget -= c.leaf.area;
          shed.push(c.index);
          gone.add(c.index);
          this.removedIndices.push(c.index);
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
        const maxHP = this.coreMaxIntegrityHP;
        // Restore integrity in proportion to the actual mass-equivalent HP of
        // the specific leaf just rebuilt, rather than a fixed increment — a
        // small hairline crack and a large corner slab restore differently.
        const restoredHP = (c.leaf.area / geo.totalMass) * body.maxHealth;
        this.coreIntegrityHP[ci] = Math.min(maxHP, this.coreIntegrityHP[ci] + restoredHP);
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
    this.coreIntegrityHP = [0, 0, 0, 0];
    this.coreSupported = [false, false, false, false];
    this.syncHP(body);
  }

  public snapshot(): BuildingStructureSnapshot {
    return {
      removed: [...this.removedIndices],
      coreIntegrityFrac: this.coreIntegrity,
      coreCriticalFired: [...this.coreCriticalFired],
      seed: this.appliedSeed ?? (this.seedFallback ^ ((this.geo?.footprintCells ?? 0) * 1234567)),
    };
  }

  public applySnapshot(snap: BuildingStructureSnapshot | undefined, body: BuildingStructureBody) {
    if (!snap) {
      this.appliedSeed = undefined;
      const geo = this.ensure(body);
      this.removedIndices = [];
      this.coreIntegrityHP = [this.coreMaxIntegrityHP, this.coreMaxIntegrityHP, this.coreMaxIntegrityHP, this.coreMaxIntegrityHP];
      this.coreSupported = [true, true, true, true];
      this.coreCriticalFired = [false, false, false, false];
      this.dirtyRender = true;
      this.connectedMass = geo.totalMass;
      return;
    }

    this.appliedSeed = snap.seed;
    const geo = this.ensure(body);

    this.removedIndices = [...snap.removed];
    const maxHP = this.coreMaxIntegrityHP;
    this.coreIntegrityHP = snap.coreIntegrityFrac.map(f => f * maxHP) as [number, number, number, number];
    this.coreCriticalFired = snap.coreCriticalFired ? [...snap.coreCriticalFired] : [false, false, false, false];
    this.dirtyRender = true;

    const gone = new Set(this.removedIndices);
    let mass = 0;
    for (let i = 0; i < geo.leaves.length; i++) {
      if (!gone.has(i)) mass += geo.leaves[i].area;
    }
    this.connectedMass = mass;
    for (let i = 0; i < 4; i++) this.coreSupported[i] = this.isCoreSupported(i);
    this.syncHP(body);
  }
}
