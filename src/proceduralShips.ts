/** Procedural spaceship generation — Sierpinski-style structural subdivision plus
 *  Mandelbrot-style bulb budding, baked into flat shaded Path2D buckets.
 *  Ship-local space: +x = forward (nose), y = lateral. Everything is mirrored across y = 0. */

import { Vec2 } from './math.js';
import { Camera } from './camera.js';
import type { Color } from './colors.js';
import { renderFieryCore } from './buildingCoreEffect.js';
import { isLegacyGraphics } from './graphicsmode.js';

// ---------------------------------------------------------------------------
// Seeded deterministic PRNG (mulberry32). Math.random() is only ever used to
// *pick* a new seed value, never to drive geometry.
// ---------------------------------------------------------------------------

export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStringToSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface ProceduralShipParams {
  // Planform
  length: number;          // fore-aft extent in world units
  spanToLength: number;    // span / length. < 1 = long//dart, > 1 = wide/manta
  tipSweep: number;        // wingtip station along the length, 0 = at the tail
  tailNotch: number;       // tail notch station along the length
  // Sierpinski structure
  structureDepth: number;  // gasket recursion depth
  gasketBias: number;      // 0.5 = classic midpoint; off-centre warps the lattice
  // Mandelbrot budding
  budCount: number;        // buds per outer edge
  budScale: number;        // largest bud radius as a fraction of its edge length
  budFalloff: number;      // 1/n^p size law; ~2 gives Mandelbrot's bulb chain
  budTwist: number;        // extra radians of rotation per bud index (spiral curl)
  budDepth: number;        // bud-on-bud recursion
  budEmbed: number;        // how far the bud sits off its edge (1 = tangent)
  // Wings and fins
  wingPairs: number;       // distinct, separated wing groups (a 2nd reads as a canard)
  wingElements: number;    // abutting elements within one group — one feathered surface
  wingStation: number;     // where the aft-most wing group starts along the leading edge
  wingGroupGap: number;    // clear gap between distinct groups, fraction of the edge
  wingSweep: number;       // sweep-back of the wing tip, fraction of length
  wingChord: number;       // root chord of one element, fraction of the leading edge
  wingSpan: number;        // wing extension beyond the hull, fraction of LENGTH
  wingRake: number;        // 0 = tip rakes aft, 1 = tip reaches forward toward the nose
  wingDetail: number;      // gasket recursion depth applied to each wing
  wingBuds: number;        // bulb chain along each wing's leading edge
  wingSerration: number;   // stepped/serrated trailing edge
  finCount: number;
  finLength: number;       // fraction of length
  finSpread: number;       // lateral spread of the fin fan, fraction of span
  // Shading
  shadeBands: number;
  shadeDepthMix: number;   // 0 = purely the smooth spatial field, 1 = purely recursion depth
  hueSpread: number;       // degrees of hue drift across the ramp
  accentHueShift: number;  // 150 = the hue-derived default accent; slides it from there
  accentAmount: number;    // 0..1, how much accent geometry is emitted
  coreSize: number;        // accent core radius, fraction of length
  // Misc
  asymmetry: number;       // controlled shared perturbation of the mirrored half
  lineThickness: number;   // silhouette hairline, screen px (0 = no stroke)
  glowAmount: number;      // single additive rim stroke, no shadowBlur
}

export const DEFAULT_PARAMS: ProceduralShipParams = {
  length: 120,
  spanToLength: 0.66,
  tipSweep: 0.30,
  tailNotch: 0.20,
  structureDepth: 3,
  gasketBias: 0.5,
  budCount: 4,
  budScale: 0.2,
  budFalloff: 2.0,
  budTwist: 0.28,
  budDepth: 1,
  budEmbed: 0.55,
  wingPairs: 1,
  wingElements: 2,
  wingStation: 0.34,
  wingGroupGap: 0.1,
  wingSweep: 0.16,
  wingChord: 0.2,
  wingSpan: 0.3,
  wingRake: 0.35,
  wingDetail: 3,
  wingBuds: 2,
  wingSerration: 0.45,
  finCount: 2,
  finLength: 0.2,
  finSpread: 0.3,
  shadeBands: 8,
  shadeDepthMix: 0.3,
  hueSpread: 34,
  accentHueShift: 150,
  accentAmount: 0.7,
  coreSize: 0.05,
  asymmetry: 0,
  lineThickness: 0,
  glowAmount: 0.18,
};

/** Cheap-to-serialize definition of a ship design: what it *is*, not runtime state. */
export interface ProceduralShipDefinition {
  seed: number;
  params: ProceduralShipParams;
}

// ---------------------------------------------------------------------------
// Geometry generation
// ---------------------------------------------------------------------------

/** Hard cap on emitted polygons so no slider combination produces a pathological ship. */
export const MAX_POLYGONS = 480;

export interface ShipPolygon {
  pts: number[];      // flat [x0,y0,x1,y1,...] in ship-local units
  depth: number;      // paint order; higher paints later
  shade: number;      // 0..1 before quantization
  accent: boolean;
  feature: number;    // characteristic size in ship-local units, for LOD
  /** Stable component id — index into ShipGeometry.polygons. */
  index: number;
  /** 0 = spine/core/nose, 1 = outermost tip. Drives the shed order. */
  peripheral: number;
  /** >0 = detaches as one unit with its group (a whole wing element, a fin, a bulb
   *  chain). 0 = sheds individually. Gives "that ship lost a wing" over confetti. */
  group: number;
  cx: number;
  cy: number;
  area: number;
  isCore: boolean;
  neighbors: number[];
  coreDistance: number;
}

export interface ShipBucket {
  depth: number;
  shadeIndex: number;
  accent: boolean;
  path: Path2D | null;
  /** Smallest feature in this bucket; the bucket is skipped when it is sub-pixel. */
  minFeature: number;
  polyCount: number;
}

export interface ShipGeometry {
  polygons: ShipPolygon[];
  buckets: ShipBucket[];
  silhouette: Path2D | null;
  outline: Vec2[];
  shadeBands: number;
  hueSpread: number;
  accentHueShift: number;
  boundingBox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Debug scaffolding. */
  gasketEdges: number[][];
  budAnchors: { x: number; y: number; r: number }[];
  polyCount: number;
  bucketCount: number;
  /** Component indices in the order they detach: peripheral tips first, core last. */
  shedOrder: number[];
  /** Lazily baked bucket sets per damage stage; slot 0 is always `buckets`. */
  stageBuckets: (ShipBucket[] | undefined)[];
  stageSilhouettes: (Path2D | null | undefined)[];
  /** Lazily baked one-Path2D-per-component, shared by every debris instance. */
  componentPaths: Path2D[] | null;
  totalMass: number;
  coreIndices: number[];
  corePath: Path2D | null;
  /**
   * Polygon indices of the engine module carried at the back-middle of each wing
   * group, one entry per wing pair, aft-most pair first, at most
   * {@link MAX_ENGINE_MODULES}. A pair whose polygons are all shed has lost its
   * engine. Empty for wingless designs, which therefore never lose thrust.
   */
  engineModules: number[][];
}

/** Two wings = one module, four wings = two. Matches the two ship speed tiers. */
export const MAX_ENGINE_MODULES = 2;

type P = { x: number; y: number };

function lerpP(a: P, b: P, t: number): P {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function polyArea(pts: number[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const j = (i + 2) % pts.length;
    area += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return Math.abs(area) * 0.5;
}

function polyFeature(pts: number[]): number {
  return Math.sqrt(polyArea(pts)) || 0.0001;
}

function centroidX(pts: number[]): number {
  let sx = 0;
  const n = pts.length / 2;
  for (let i = 0; i < pts.length; i += 2) sx += pts[i];
  return sx / n;
}
function centroidY(pts: number[]): number {
  let sy = 0;
  const n = pts.length / 2;
  for (let i = 1; i < pts.length; i += 2) sy += pts[i];
  return sy / n;
}

class Emitter {
  polys: ShipPolygon[] = [];
  constructor(
    private noseX: number,
    private halfSpan: number,
    private L: number,
    private depthMix: number,
    private asym: number,
  ) {}

  /** Components emitted while this is non-zero detach together. */
  group = 0;

  /** Per-feature quota so the cap is shared out rather than won first-come-first-served. */
  private limit = MAX_POLYGONS;
  setQuota(n: number): void { this.limit = Math.min(MAX_POLYGONS, this.polys.length + Math.max(0, n)); }
  get count(): number { return this.polys.length; }
  get full(): boolean { return this.polys.length + 2 > this.limit; }

  /** Shade is primarily a smooth spatial field — bright along the spine and toward the
   *  nose, darkening aft and outboard — so quantizing it yields bands that flow across
   *  the whole form. Recursion depth only perturbs it (shadeDepthMix). */
  shadeFor(pts: number[], target: number): number {
    const aft = Math.min(1, Math.max(0, (this.noseX - centroidX(pts)) / (this.L * 1.02)));
    const out = Math.min(1, Math.abs(centroidY(pts)) / (this.halfSpan + 1e-6));
    const spatial = 1 - (0.54 * Math.pow(aft, 0.85) + 0.4 * Math.pow(out, 1.1));
    return Math.min(1, Math.max(0, this.depthMix * target + (1 - this.depthMix) * spatial));
  }

  /** Emit a right-half polygon and its mirror. */
  emit(pts: number[], depth: number, target: number, accent = false, isCore = false): void {
    if (this.full) return;
    const shade = this.shadeFor(pts, target);
    const feature = polyFeature(pts);
    const area = polyArea(pts);
    this.polys.push({ pts, depth, shade, accent, feature, index: this.polys.length, peripheral: 0, group: this.group, cx: centroidX(pts), cy: centroidY(pts), area, isCore, neighbors: [], coreDistance: 0 });
    const m = new Array<number>(pts.length);
    const k = 1 - this.asym;
    for (let i = 0; i < pts.length; i += 2) { m[i] = pts[i]; m[i + 1] = -pts[i + 1] * k; }
    const mArea = polyArea(m);
    this.polys.push({ pts: m, depth, shade, accent, feature, index: this.polys.length, peripheral: 0, group: this.group, cx: centroidX(m), cy: centroidY(m), area: mArea, isCore, neighbors: [], coreDistance: 0 });
  }

  /** Emit a polygon that already straddles the symmetry axis. */
  emitSym(pts: number[], depth: number, target: number, accent = false, isCore = false): void {
    if (this.polys.length + 1 > this.limit) return;
    this.polys.push({ pts, depth, shade: this.shadeFor(pts, target), accent, feature: polyFeature(pts), index: this.polys.length, peripheral: 0, group: this.group, cx: centroidX(pts), cy: centroidY(pts), area: polyArea(pts), isCore, neighbors: [], coreDistance: 0 });
  }
}

function pointToSegmentDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const l2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
  if (l2 === 0) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  let t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2;
  t = Math.max(0, Math.min(1, t));
  const projx = ax + t * (bx - ax);
  const projy = ay + t * (by - ay);
  return (px - projx) * (px - projx) + (py - projy) * (py - projy);
}

function polygonsAdjacent(pts1: number[], pts2: number[], threshold: number): boolean {
  const t2 = threshold * threshold;
  for (let i = 0; i < pts1.length; i += 2) {
    const px = pts1[i], py = pts1[i+1];
    for (let j = 0; j < pts2.length; j += 2) {
      const jNext = (j + 2) % pts2.length;
      if (pointToSegmentDistSq(px, py, pts2[j], pts2[j+1], pts2[jNext], pts2[jNext+1]) <= t2) return true;
    }
  }
  for (let i = 0; i < pts2.length; i += 2) {
    const px = pts2[i], py = pts2[i+1];
    for (let j = 0; j < pts1.length; j += 2) {
      const jNext = (j + 2) % pts1.length;
      if (pointToSegmentDistSq(px, py, pts1[j], pts1[j+1], pts1[jNext], pts1[jNext+1]) <= t2) return true;
    }
  }
  return false;
}

function convexHull(pts: number[][]): number[][] {
  if (pts.length < 3) return pts;
  const s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: number[][] = [];
  for (const pt of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: number[][] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const pt = s[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function triPts(a: P, b: P, c: P): number[] {
  return [a.x, a.y, b.x, b.y, c.x, c.y];
}

/** Shrink about the centroid so sibling tiles leave a hairline of the parent's darker
 *  shade between them — that gap is what makes the lattice read as structure. */
function insetTri(a: P, b: P, c: P, k: number): number[] {
  const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3;
  return [
    cx + (a.x - cx) * k, cy + (a.y - cy) * k,
    cx + (b.x - cx) * k, cy + (b.y - cy) * k,
    cx + (c.x - cx) * k, cy + (c.y - cy) * k,
  ];
}

/** Classic gasket step with a generalized midpoint: each level's three corner
 *  children are kept and painted over their parent, so the dropped centres survive
 *  as visible bands of the parent's shade. */
function gasket(
  em: Emitter, a: P, b: P, c: P, depth: number, maxDepth: number, bias: number,
  edges: number[][] | null, inset: number, depthBase = 0, shadeLo = 0.02, shadeHi = 0.95,
): void {
  const t = maxDepth === 0 ? 1 : depth / maxDepth;
  em.emit(depth === 0 ? triPts(a, b, c) : insetTri(a, b, c, inset), depthBase + depth, shadeLo + (shadeHi - shadeLo) * t);
  if (depth >= maxDepth || em.full) return;
  const ab = lerpP(a, b, bias);
  const bc = lerpP(b, c, bias);
  const ca = lerpP(c, a, bias);
  if (edges && depth < 2) edges.push([ab.x, ab.y, bc.x, bc.y, ca.x, ca.y]);
  gasket(em, a, ab, ca, depth + 1, maxDepth, bias, edges, inset, depthBase, shadeLo, shadeHi);
  gasket(em, ab, b, bc, depth + 1, maxDepth, bias, edges, inset, depthBase, shadeLo, shadeHi);
  gasket(em, ca, bc, c, depth + 1, maxDepth, bias, edges, inset, depthBase, shadeLo, shadeHi);
}

/** A bulb is a small arrowhead in the hull's own angular language, nose pointing out
 *  along `rot`. Real Mandelbrot bulbs are encrusted with their own filigree, so these
 *  get gasket-subdivided too and read as self-similar craft rather than bubbles. */
function budTri(cx: number, cy: number, r: number, rot: number): [P, P, P] {
  const co = Math.cos(rot), si = Math.sin(rot);
  const at = (lx: number, ly: number): P => ({ x: cx + lx * co - ly * si, y: cy + lx * si + ly * co });
  return [at(r * 1.02, 0), at(-r * 0.72, r * 1.0), at(-r * 0.72, -r * 1.0)];
}

/** Bulbs budding on a parent bulb's rim — the self-similar step that makes the chain
 *  read as Mandelbrot rather than as beads on a string. */
function budChildren(
  em: Emitter, cx: number, cy: number, r: number, rot: number, count: number,
  depthBase: number, level: number, bias: number, p: ProceduralShipParams,
): void {
  if (level > Math.round(p.budDepth) || count < 1 || em.full) return;
  for (let j = 0; j < Math.min(2, count); j++) {
    if (em.full) return;
    const rc = (r * 0.46) / Math.pow(j + 1, p.budFalloff * 0.5);
    if (rc < p.length * 0.01) return;
    const ang = rot + (j - (count - 1) * 0.5) * (0.8 + p.budTwist * 0.6) + p.budTwist;
    const px = cx + Math.cos(ang) * (r * 0.8 + rc * 0.55);
    const py = cy + Math.sin(ang) * (r * 0.8 + rc * 0.55);
    const [ba, bb, bc] = budTri(px, py, rc, ang);
    gasket(em, ba, bb, bc, 0, 1, bias, null, 0.93, depthBase + 2, 0.42, 0.78);
    budChildren(em, px, py, rc, ang, Math.max(1, count - 1), depthBase, level + 1, bias, p);
  }
}

/** Bud sizes follow r_n = scale * edgeLen / (n+1)^falloff — the 1/n^p law is what makes
 *  Mandelbrot's bulb chains read the way they do — and are packed tangent to each other. */
function budChain(
  em: Emitter, A: P, B: P, inside: P, count: number, scale: number,
  depthBase: number, bias: number, p: ProceduralShipParams, anchors: { x: number; y: number; r: number }[],
): void {
  const ex = B.x - A.x, ey = B.y - A.y;
  const len = Math.hypot(ex, ey);
  if (len < p.length * 0.03 || count < 1) return;
  const ux = ex / len, uy = ey / len;
  let nx = uy, ny = -ux;
  if ((inside.x - A.x) * nx + (inside.y - A.y) * ny > 0) { nx = -nx; ny = -ny; }

  let cursor = len * 0.04;
  for (let n = 0; n < count; n++) {
    if (em.full) return;
    const r = (scale * len) / Math.pow(n + 1, p.budFalloff * 0.55);
    if (r < p.length * 0.012) return;
    cursor += r;
    if (cursor > len * 0.99) return;
    const px = A.x + ux * cursor + nx * r * p.budEmbed * 0.45;
    const py = A.y + uy * cursor + ny * r * p.budEmbed * 0.45;
    const rot = Math.atan2(ny, nx) + p.budTwist * n;
    const [ba, bb, bc] = budTri(px, py, r, rot);
    const levels = n < 2 && r > p.length * 0.05 ? 2 : 1;
    gasket(em, ba, bb, bc, 0, levels, bias, null, 0.94, depthBase, 0.34, 0.86);
    // Accent rides the bulb's own nose, never a whole bulb: keeps the warm contrast
    // to a few percent of the area.
    if (n >= 1 && n <= 2 && p.accentAmount > 0.35) {
      const nose = budTri(px + Math.cos(rot) * r * 0.72, py + Math.sin(rot) * r * 0.72, r * 0.3, rot);
      em.emit(triPts(nose[0], nose[1], nose[2]), depthBase + 3, 0.88, true);
    }
    anchors.push({ x: px, y: py, r });
    budChildren(em, px, py, r, rot, Math.max(1, count - 2), depthBase + 4, 1, bias, p);
    cursor += r * 0.92;
  }
}


/** One wing element: the hull's gasket rule, a stepped trailing edge, and its own bulb
 *  chain along the leading edge, so a wing is as rewarding to look at as the hull core. */
function emitWing(
  em: Emitter, rootA: P, rootB: P, tipF: P, bias: number, levels: number,
  depthBase: number, p: ProceduralShipParams, anchors: { x: number; y: number; r: number }[],
  outermost: boolean,
): void {
  gasket(em, rootA, rootB, tipF, 0, levels, bias, null, 0.94, depthBase, 0.52, 0.98);
  const inner: P = { x: (rootA.x + rootB.x + tipF.x) / 3, y: (rootA.y + rootB.y + tipF.y) / 3 };

  const steps = Math.round(p.wingSerration * 5);
  if (steps > 0) {
    const depth = p.wingSerration * 0.05 * p.length;
    for (let i = 0; i < steps; i++) {
      if (em.full) break;
      const a = lerpP(rootB, tipF, i / steps);
      const b = lerpP(rootB, tipF, (i + 1) / steps);
      const mid = lerpP(a, b, 0.5);
      let sx = -(b.y - a.y), sy = b.x - a.x;
      const len = Math.hypot(sx, sy) || 1;
      sx /= len; sy /= len;
      // Point the step inward: an outward spike would open a gap of background between
      // every pair of teeth and shred the silhouette.
      if ((inner.x - mid.x) * sx + (inner.y - mid.y) * sy < 0) { sx = -sx; sy = -sy; }
      em.emit(triPts(a, b, { x: mid.x + sx * depth, y: mid.y + sy * depth }), depthBase + levels + 1, 0.9 - i * 0.06);
    }
  }

  // Only the outermost element of a group carries a bulb chain; chains on every element
  // overlap each other and read as debris rather than a row of studs.
  const buds = outermost ? Math.round(p.wingBuds) : 0;
  if (buds > 0) {
    const wp: ProceduralShipParams = { ...p, budTwist: p.budTwist * 0.2, budEmbed: 0.3, budDepth: 0 };
    budChain(em, tipF, rootA, inner, buds, p.budScale * 0.55, depthBase + levels + 2, bias, wp, anchors);
  }
}

/** Polygons a full mirrored gasket recursion to `depth` emits: 2 * (3^(d+1)-1)/2. */
function gasketCost(depth: number): number {
  return Math.pow(3, depth + 1) - 1;
}

/** Deepest recursion that fits in `budget`, so a starved feature loses subdivision
 *  levels instead of vanishing entirely. */
function affordableDepth(want: number, budget: number): number {
  let d = Math.max(0, Math.round(want));
  while (d > 0 && gasketCost(d) > budget) d--;
  return d;
}

/** Build full geometry for a design. Pure function of (seed, params) — cache the result. */
export function generateShipGeometry(def: ProceduralShipDefinition): ShipGeometry {
  const p = def.params;
  const rng = seededRandom(def.seed);
  const L = Math.max(10, p.length);
  const span = L * Math.max(0.1, p.spanToLength);
  const maxDepth = Math.round(Math.min(4, Math.max(0, p.structureDepth)));

  // Seeded, symmetric jitter of the planform stations so seeds differ without breaking symmetry.
  const jTip = (rng() - 0.5) * 0.06;
  const jNotch = (rng() - 0.5) * 0.05;
  const jBias = (rng() - 0.5) * 0.06;

  const N: P = { x: L * 0.5, y: 0 };
  const W: P = { x: -L * 0.5 + (p.tipSweep + jTip) * L, y: span * 0.5 };
  const T: P = { x: -L * 0.5 + (p.tailNotch + jNotch) * L, y: 0 };

  const wingOut = Math.round(p.wingPairs) > 0 ? p.wingSpan * span * 0.6 : 0;
  const em = new Emitter(N.x, span * 0.5 + wingOut, L, p.shadeDepthMix, Math.min(0.4, p.asymmetry));
  const edges: number[][] = [];
  const anchors: { x: number; y: number; r: number }[] = [];

  const bias = Math.min(0.92, Math.max(0.08, p.gasketBias + jBias));

  // Share the polygon cap out in proportion to what each feature asks for, then let a
  // feature spend its allocation on as many subdivision levels as it can afford. Leftover
  // from a feature that rounded down cascades to the next.
  const wingPairs = Math.round(Math.max(0, Math.min(3, p.wingPairs)));
  const wantWingDetail = Math.round(Math.max(0, Math.min(3, p.wingDetail)));
  const wingElements = Math.round(Math.max(1, Math.min(3, p.wingElements)));
  const finCount = Math.round(Math.max(0, Math.min(4, p.finCount)));
  const budCount = Math.round(Math.max(0, p.budCount));
  const budLevels = Math.round(Math.max(0, p.budDepth));

  const ACCENT_RESERVE = 8;
  const finCost = finCount * 2;
  const pool = Math.max(24, MAX_POLYGONS - ACCENT_RESERVE - finCost);
  const hullReq = gasketCost(maxDepth);
  const wingUnits = wingPairs * wingElements;
  const wingReq = wingUnits * (gasketCost(wantWingDetail)
    + Math.round(p.wingSerration * 5) * 2 + Math.round(p.wingBuds) * 2 * 9);
  const budReq = 2 * budCount * (10 + budLevels * 8);
  const totalReq = hullReq + wingReq + budReq;
  const k = totalReq > pool ? pool / totalReq : 1;

  const hullDepth = affordableDepth(maxDepth, hullReq * k);
  const spare = Math.max(0, Math.floor(hullReq * k) - gasketCost(hullDepth));
  const wingAlloc = Math.floor(wingReq * k) + Math.floor(spare * 0.6);
  const perWing = wingUnits > 0 ? Math.floor(wingAlloc / wingUnits) : 0;
  const wingLevels = affordableDepth(wantWingDetail, perWing);

  em.group = 0;
  em.setQuota(gasketCost(hullDepth));
  gasket(em, N, W, T, 0, hullDepth, bias, edges, 0.955);

  const wingDepth = hullDepth + 1;
  const budDepthBase = wingDepth + 3;

  // Accents: a nose cap that is a scaled copy of the hull nose, and a core lozenge.
  // Emitted before the bulb chains against their own reserve so nothing can starve them.
  em.setQuota(ACCENT_RESERVE);
  if (p.accentAmount > 0) {
    const nt = 0.035 + 0.03 * p.accentAmount;
    const na = lerpP(N, W, nt);
    const nb = lerpP(N, T, nt);
    em.emitSym([N.x, N.y, na.x, na.y, nb.x, nb.y, na.x, -na.y], budDepthBase + 6, 0.85, true, false);
    const cr = Math.max(1.2, p.coreSize * L * 1.5);
    const cxp = T.x + (N.x - T.x) * 0.42;
    em.emitSym([cxp + cr * 2.6, 0, cxp, cr, cxp - cr * 2.6, 0, cxp, -cr], budDepthBase + 6, 0.7, true, true);
  }

  // Both chains start at the wingtip, so the largest bulbs sit at the shoulder and
  // taper forward and aft — the cardioid-neck reading.
  const inside: P = { x: (N.x + W.x + T.x) / 3, y: (N.y + W.y + T.y) / 3 };

  // Wings: distinct groups, each of `wingElements` abutting elements. Elements inside a
  // group merge into one feathered surface (no notches between them); separate groups
  // stay clearly apart and shrink toward the nose, so a second pair reads as a canard.
  em.setQuota(wingAlloc);
  let groupId = 0;
  let groupU = p.wingStation;
  // One engine module per wing surface, seated at its back-middle. `emit` mirrors, so a
  // single group id is one port+starboard wing pair: one surface = 2 wings = speed
  // tier 1, two surfaces = 4 wings = tier 2.
  const engineGroupIds: number[] = [];
  for (let grp = 0; grp < wingPairs; grp++) {
    if (em.full || groupU < 0.02) break;
    const gScale = Math.pow(0.66, grp);
    const chordG = Math.max(0.03, p.wingChord * gScale);
    for (let e = 0; e < wingElements; e++) {
      if (em.full) break;
      const u0 = Math.min(0.94, groupU + e * chordG);
      const u1 = Math.min(0.985, u0 + chordG);
      if (u0 >= 0.94) break;
      const r0 = lerpP(N, W, u0);
      const r1 = lerpP(N, W, u1);
      // Span falls off only slightly across elements of one group so their tips stay
      // close enough not to bite notches out between them.
      const out = p.wingSpan * L * gScale * (1 - e * 0.12);
      const sw = p.wingSweep * L + out * 0.4;
      // wingRake pulls the tip forward toward the nose; 0 leaves it raked aft.
      const tipF: P = { x: r0.x - sw + p.wingRake * (N.x - r0.x) * 0.8, y: span * 0.5 + out };
      // Root points seated a hair inboard so the chord seals against the hull.
      const rootA = lerpP(r0, inside, 0.045);
      const rootB0 = lerpP(r1, inside, 0.045);
      const rootB: P = { x: rootB0.x - sw * 0.22, y: rootB0.y };
      em.group = ++groupId;
      if (engineGroupIds.length < MAX_ENGINE_MODULES) engineGroupIds.push(groupId);
      emitWing(em, rootA, rootB, tipF, bias, wingLevels, wingDepth, p, anchors, e === wingElements - 1);
      em.group = 0;
    }
    groupU -= chordG * wingElements + p.wingGroupGap;
  }

  // Fins: narrow elongated triangles raked off the trailing edge.
  em.setQuota(finCost);
  for (let i = 0; i < finCount; i++) {
    if (em.full) break;
    const f = finCount === 1 ? 0.4 : 0.1 + (i / (finCount - 1)) * 0.66;
    const chord = 0.1 + p.finSpread * 0.35;
    const r0 = lerpP(T, W, f);
    const r1 = lerpP(T, W, Math.min(0.95, f + chord));
    const fl = p.finLength * L * 0.55;
    const mid = lerpP(r0, r1, 0.5);
    // Base sits on the trailing edge, apex rakes aft: a tapered fin, not a tooth.
    const apex: P = { x: mid.x - fl, y: mid.y + fl * 0.18 };
    em.group = ++groupId;
    em.emit(triPts(r0, r1, apex), wingDepth + 2, 0.6 + f * 0.22);
    em.group = 0;
  }

  // Both chains start at the wingtip, so the largest bulbs sit at the shoulder and
  // taper forward and aft — the cardioid-neck reading.
  em.setQuota(MAX_POLYGONS - em.count);
  em.group = ++groupId;
  budChain(em, W, N, inside, budCount, p.budScale, budDepthBase, bias, p, anchors);
  em.group = ++groupId;
  budChain(em, W, T, inside, budCount, p.budScale * 0.85, budDepthBase, bias, p, anchors);
  em.group = 0;

  // Silhouette = convex hull of everything emitted, so the rim traces wings and buds too.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const cloud: number[][] = [];
  for (const poly of em.polys) {
    for (let i = 0; i < poly.pts.length; i += 2) {
      const x = poly.pts[i], y = poly.pts[i + 1];
      cloud.push([x, y]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) { minX = minY = -1; maxX = maxY = 1; }
  const outline = convexHull(cloud).map((h) => new Vec2(h[0], h[1]));

  // The strokable/fallback silhouette is the base planform, not the convex hull: the hull
  // encloses too much empty space between wings to read as an outline.
  const silhouette = typeof Path2D === 'undefined' ? null : new Path2D();
  const ml = 1 - Math.min(0.4, p.asymmetry);
  silhouette?.moveTo(N.x, N.y);
  silhouette?.lineTo(W.x, W.y);
  silhouette?.lineTo(T.x, T.y);
  silhouette?.lineTo(W.x, -W.y * ml);
  silhouette?.closePath();

  const bands = Math.round(Math.max(2, Math.min(12, p.shadeBands)));
  const buckets = bakeBuckets(em.polys, bands);

  // Peripherality is weighted hard toward outboard distance and SIZE, so the big outer
  // panels go early and damage is legible at a glance; small interior gasket leaves no
  // longer soak up the whole shed budget. Accents stay pinned to 0.
  const halfW = Math.max(1, Math.max(Math.abs(minY), Math.abs(maxY)));
  let maxFeat = 1;
  for (const poly of em.polys) if (poly.feature > maxFeat) maxFeat = poly.feature;
  const maxD = Math.max(1, hullDepth + 12);
  for (const poly of em.polys) {
    poly.peripheral = poly.accent ? 0 : Math.min(1,
      0.58 * Math.min(1, Math.abs(poly.cy) / halfW)
      + 0.27 * (poly.feature / maxFeat)
      + 0.15 * Math.min(1, poly.depth / maxD));
  }

  // Build shed entries: an ungrouped polygon sheds alone, a group (wing element, fin,
  // bulb chain) sheds as one unit so the ship visibly loses whole structures.
  const jitter = () => (rng() - 0.5) * 0.18;
  const groups = new Map<number, number[]>();
  const entries: { score: number; members: number[] }[] = [];
  for (const poly of em.polys) {
    if (poly.group === 0) { entries.push({ score: poly.peripheral + jitter(), members: [poly.index] }); continue; }
    let members = groups.get(poly.group);
    if (!members) { members = []; groups.set(poly.group, members); }
    members.push(poly.index);
  }
  for (const members of groups.values()) {
    let peak = 0, sum = 0;
    for (const idx of members) {
      const v = em.polys[idx].peripheral;
      if (v > peak) peak = v;
      sum += v;
    }
    // Bias groups ahead of loose polygons of the same score so whole structures go first.
    entries.push({ score: peak * 0.6 + (sum / members.length) * 0.4 + 0.12 + jitter(), members });
  }
  entries.sort((a, b) => b.score - a.score);
  const shedOrder: number[] = [];
  for (const entry of entries) for (const idx of entry.members) shedOrder.push(idx);

  const totalMass = em.polys.reduce((sum, p) => sum + p.area, 0);
  const coreIndices = em.polys.filter(p => p.isCore).map(p => p.index);
  const corePath = typeof Path2D === 'undefined' ? null : new Path2D();
  if (corePath) {
    for (const idx of coreIndices) {
      const poly = em.polys[idx];
      corePath.moveTo(poly.pts[0], poly.pts[1]);
      for (let i = 2; i < poly.pts.length; i += 2) {
        corePath.lineTo(poly.pts[i], poly.pts[i+1]);
      }
      corePath.closePath();
    }
  }

  for (let i = 0; i < em.polys.length; i++) {
    const p1 = em.polys[i];
    for (let j = i + 1; j < em.polys.length; j++) {
      const p2 = em.polys[j];
      const dx = p1.cx - p2.cx;
      const dy = p1.cy - p2.cy;
      const maxDist = (p1.feature + p2.feature) * 1.5;
      if (dx * dx + dy * dy > maxDist * maxDist) continue;
      if (polygonsAdjacent(p1.pts, p2.pts, maxDist * 0.15)) {
        p1.neighbors.push(p2.index);
        p2.neighbors.push(p1.index);
      }
    }
  }

  const queue = [...coreIndices];
  const visited = new Set(coreIndices);
  for (const idx of coreIndices) {
    em.polys[idx].coreDistance = 0;
  }
  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currDist = em.polys[curr].coreDistance;
    for (const neighbor of em.polys[curr].neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        em.polys[neighbor].coreDistance = currDist + 1;
        queue.push(neighbor);
      }
    }
  }
  for (const poly of em.polys) {
    if (!visited.has(poly.index)) {
      poly.coreDistance = Infinity; // disconnected from core even initially (rare)
    }
  }

  const engineModules: number[][] = [];
  for (const id of engineGroupIds) {
    const members = groups.get(id);
    if (members && members.length) engineModules.push(members.slice());
  }

  return {
    polygons: em.polys,
    buckets,
    silhouette,
    outline,
    shadeBands: bands,
    hueSpread: p.hueSpread,
    accentHueShift: p.accentHueShift,
    boundingBox: { minX, minY, maxX, maxY },
    gasketEdges: edges,
    budAnchors: anchors,
    polyCount: em.polys.length,
    bucketCount: buckets.length,
    shedOrder,
    stageBuckets: [buckets],
    stageSilhouettes: [silhouette],
    componentPaths: null,
    totalMass,
    coreIndices,
    corePath,
    engineModules,
  };
}

/** Bake polygons into one Path2D per (depth, shadeIndex, accent) so drawing a ship is a
 *  handful of ctx.fill() calls with zero per-frame path construction. */
export function bakeBuckets(polys: ShipPolygon[], bands: number): ShipBucket[] {
  const map = new Map<number, ShipBucket>();
  for (const poly of polys) {
    const si = Math.max(0, Math.min(bands - 1, Math.round(poly.shade * (bands - 1))));
    const key = poly.depth * 64 + si * 2 + (poly.accent ? 1 : 0);
    let b = map.get(key);
    if (!b) {
      b = { depth: poly.depth, shadeIndex: si, accent: poly.accent, path: typeof Path2D === 'undefined' ? null : new Path2D(), minFeature: Infinity, polyCount: 0 };
      map.set(key, b);
    }
    b.path?.moveTo(poly.pts[0], poly.pts[1]);
    for (let i = 2; i < poly.pts.length; i += 2) b.path?.lineTo(poly.pts[i], poly.pts[i + 1]);
    b.path?.closePath();
    if (poly.feature < b.minFeature) b.minFeature = poly.feature;
    b.polyCount++;
  }
  return [...map.values()].sort((a, b) =>
    a.depth - b.depth || (a.accent ? 1 : 0) - (b.accent ? 1 : 0) || a.shadeIndex - b.shadeIndex);
}

// ---------------------------------------------------------------------------
// Faction colour ramps — cached, never rebuilt per frame or per ship.
// ---------------------------------------------------------------------------

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToCss(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return `rgb(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)})`;
}

export interface ShadeRamp { fills: string[]; accents: string[]; rim: string; }

const rampCache = new Map<string, ShadeRamp>();
const NEUTRAL: Color = { r: 120, g: 165, b: 210, intensity: 1 };

export function getShadeRamp(color: Color, bands: number, hueSpread: number, accentHueShift: number): ShadeRamp {
  const key = `${color.r},${color.g},${color.b},${color.intensity}|${bands}|${hueSpread}|${accentHueShift}`;
  let ramp = rampCache.get(key);
  if (ramp) return ramp;
  const r = Math.min(255, color.r * color.intensity);
  const g = Math.min(255, color.g * color.intensity);
  const b = Math.min(255, color.b * color.intensity);
  let [h, s] = rgbToHsl(r, g, b);
  if (s < 0.18) s = 0.18;
  // The accent target is chosen from the hull hue rather than being a fixed rotation:
  // a warm hull gets an ice-cyan accent, a cool hull gets amber. A fixed +150 turned
  // green factions magenta. accentHueShift still slides the accent hue continuously.
  const hullWarm = h >= 330 || h <= 72;
  const accentH = (hullWarm ? 196 : 36) + (accentHueShift - 150);
  const fills: string[] = [];
  const accents: string[] = [];
  for (let i = 0; i < bands; i++) {
    const u = bands === 1 ? 1 : i / (bands - 1);
    const l = 0.12 + u * u * 0.25 + u * 0.55;                 // dark field -> bright highlight
    const sat = s * (1 - Math.pow(Math.max(0, u - 0.45) / 0.55, 2) * 0.82);
    fills.push(hslToCss(h + hueSpread * (u - 0.25), Math.min(1, sat), Math.min(0.95, l)));
    accents.push(hslToCss(accentH + hueSpread * 0.25 * u, 0.78, 0.46 + u * 0.32));
  }
  ramp = { fills, accents, rim: hslToCss(h + hueSpread * 0.9, Math.min(1, s * 0.5), 0.88) };
  rampCache.set(key, ramp);
  return ramp;
}

// ---------------------------------------------------------------------------
// Geometry cache — keyed by seed+params so gameplay never regenerates per frame.
// ---------------------------------------------------------------------------

const geometryCache = new Map<string, ShipGeometry>();
/** Identity fast path: many units share one immutable definition object, and hashing its
 *  params every frame per ship would be the dominant cost. Swapped out on invalidation. */
let geometryByRef = new WeakMap<ProceduralShipDefinition, ShipGeometry>();

export function designCacheKey(def: ProceduralShipDefinition): string {
  return def.seed + '|' + JSON.stringify(def.params);
}

/** Get (and lazily generate/cache) geometry for a design. */
export function getShipGeometry(def: ProceduralShipDefinition): ShipGeometry {
  const hit = geometryByRef.get(def);
  if (hit) return hit;
  const key = designCacheKey(def);
  let geo = geometryCache.get(key);
  if (!geo) {
    geo = generateShipGeometry(def);
    if (geometryCache.size > 400) geometryCache.clear();
    geometryCache.set(key, geo);
  }
  geometryByRef.set(def, geo);
  return geo;
}

/** Drop a cached entry (or the whole cache) — call when Ship Lab params change. */
export function invalidateShipGeometryCache(def?: ProceduralShipDefinition): void {
  geometryByRef = new WeakMap();
  if (def) geometryCache.delete(designCacheKey(def));
  else geometryCache.clear();
}

/** Number of quantised damage stages. Stage 0 is undamaged and uses the existing
 *  cache path unchanged, so healthy ships — the common case — cost exactly what they did
 *  before. Bucket sets are cached per (design, stage) and shared by every ship at that
 *  stage, so N ships of one design cost at most DAMAGE_STAGES bucket sets, not N. */
export const DAMAGE_STAGES = 8;

/** Never strip more than this fraction of components, so a wreck is still a ship. */
const MAX_SHED_FRACTION = 0.62;

/** Quantise a 0..1 health fraction to a stage index. */
export function damageStageForHealth(healthFraction: number): number {
  const hurt = 1 - Math.min(1, Math.max(0, healthFraction));
  return Math.min(DAMAGE_STAGES - 1, Math.floor(hurt * DAMAGE_STAGES));
}

/** How many components have detached by `stage`. */
function shedCountForStage(geo: ShipGeometry, stage: number): number {
  if (stage <= 0) return 0;
  const t = Math.min(1, stage / (DAMAGE_STAGES - 1));
  let count = Math.floor(Math.pow(t, 1.15) * MAX_SHED_FRACTION * geo.shedOrder.length);
  // Round down to a complete group, preserving both atomic detachment and the core budget.
  if (count > 0 && count < geo.shedOrder.length) {
    const group = geo.polygons[geo.shedOrder[count]].group;
    if (group > 0) {
      while (count > 0 && geo.polygons[geo.shedOrder[count - 1]].group === group) count--;
    }
  }
  return count;
}

/** Bucket set for a damage stage. Stage 0 returns the untouched baked buckets. */
export function getStageBuckets(geo: ShipGeometry, stage: number): ShipBucket[] {
  const s = Math.min(DAMAGE_STAGES - 1, Math.max(0, Math.round(stage)));
  if (s === 0) return geo.buckets;
  const cached = geo.stageBuckets[s];
  if (cached) return cached;
  const gone = new Set(geo.shedOrder.slice(0, shedCountForStage(geo, s)));
  const kept = geo.polygons.filter((poly) => !gone.has(poly.index));
  const built = bakeBuckets(kept, geo.shadeBands);
  const silhouette = typeof Path2D === 'undefined' ? null : new Path2D();
  for (const bucket of built) bucket.path && silhouette?.addPath(bucket.path);
  geo.stageSilhouettes[s] = silhouette;
  geo.stageBuckets[s] = built;
  return built;
}

/** Component indices that detach when crossing from `from` to `to` (to > from). */
export function componentsShedBetween(geo: ShipGeometry, from: number, to: number): number[] {
  const a = shedCountForStage(geo, Math.max(0, from));
  const b = shedCountForStage(geo, Math.min(DAMAGE_STAGES - 1, to));
  return b > a ? geo.shedOrder.slice(a, b) : [];
}

/** One Path2D per component, built once per design and shared by every debris piece. */
export function getComponentPath(geo: ShipGeometry, index: number): Path2D {
  let paths = geo.componentPaths;
  if (!paths) {
    paths = geo.polygons.map((poly) => {
      const path = new Path2D();
      path.moveTo(poly.pts[0] - poly.cx, poly.pts[1] - poly.cy);
      for (let i = 2; i < poly.pts.length; i += 2) path.lineTo(poly.pts[i] - poly.cx, poly.pts[i + 1] - poly.cy);
      path.closePath();
      return path;
    });
    geo.componentPaths = paths;
  }
  return paths[index];
}

/** Largest half-extent of a design in ship-local units. Callers normalise against a
 *  unit's own radius with this so changing the `length` slider never changes how big
 *  the unit is in the game world. */
export function shipDesignRadius(def: ProceduralShipDefinition): number {
  const bb = getShipGeometry(def).boundingBox;
  return Math.max(Math.abs(bb.minX), Math.abs(bb.maxX), Math.abs(bb.minY), Math.abs(bb.maxY)) || 1;
}

/** localStorage key the Ship Lab's USE IN GAME button writes to, and that the PlayerShip
 *  constructor reads so a design can be flown in a real match. Dev-only and reversible:
 *  removing the key restores the stock ship appearance. */
export const DEV_SHIP_DESIGN_KEY = 'sign99_shiplab_ingame_design';

let devDesignLoaded = false;
let devDesign: ProceduralShipDefinition | null = null;

/** Reads the dev override once per session. Returns the SAME object every call so every
 *  ship shares one cached geometry. Safe where localStorage does not exist (tests, node). */
export function loadDevShipDesign(): ProceduralShipDefinition | null {
  if (devDesignLoaded) return devDesign;
  devDesignLoaded = true;
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(DEV_SHIP_DESIGN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.params) return null;
    devDesign = { seed: (parsed.seed ?? 0) >>> 0, params: { ...DEFAULT_PARAMS, ...parsed.params } };
  } catch {
    devDesign = null;
  }
  return devDesign;
}

/** Forget the cached dev override so the next read picks up a new one. */
export function resetDevShipDesign(): void {
  devDesignLoaded = false;
  devDesign = null;
}

// ---------------------------------------------------------------------------
// Shared renderer — used by Ship Lab preview AND gameplay ship rendering.
// ---------------------------------------------------------------------------

export interface ShipTransform {
  position: Vec2;
  rotation: number;
  scale?: number;
  /** Owning faction colour; defaults to a neutral steel blue. */
  color?: Color;
  /** Quantised damage stage; 0 (default) is the undamaged, untouched cache path. */
  damageStage?: number;
  damageMesh?: { buckets: ShipBucket[]; silhouette: Path2D | null } | null;
  /** 0..1 fraction of core health. Determines fiery core intensity. */
  coreIntegrityFrac?: number;
}

export interface ShipDebugOverlay {
  showGasketWireframe?: boolean;
  showBudAnchors?: boolean;
  showBoundingBox?: boolean;
  showSymmetryAxis?: boolean;
  showBucketBands?: boolean;
}

/** Detail below this many screen pixels is culled: invisible, and the direct cause of mud. */
const MIN_FEATURE_PX = 2.4;

/** Number of buckets actually filled by the last drawProceduralShip call (diagnostics). */
export let lastFillCalls = 0;

/** Draws a procedural ship. `camera` supplies zoom for line-width scaling, matching other renderers. */
export function drawProceduralShip(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  def: ProceduralShipDefinition,
  transform: ShipTransform,
  debug?: ShipDebugOverlay,
): void {
  const geo = getShipGeometry(def);
  const p = def.params;
  const screen = camera.worldToScreen(transform.position);
  const scale = camera.zoom * (transform.scale ?? 1);
  if (scale <= 0) return;
  const ramp = getShadeRamp(transform.color ?? NEUTRAL, geo.shadeBands, geo.hueSpread, geo.accentHueShift);

  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.rotate(transform.rotation);
  ctx.scale(scale, scale);

  if (geo.corePath) {
    const intensity = transform.coreIntegrityFrac ?? 1;
    if (intensity > 0) {
      const side = Math.max(geo.boundingBox.maxX - geo.boundingBox.minX, geo.boundingBox.maxY - geo.boundingBox.minY);
      renderFieryCore(ctx, {
        path: geo.corePath,
        x: geo.boundingBox.minX,
        y: geo.boundingBox.minY,
        side,
        nodeSize: side * 0.15,
        intensity,
        timeSec: performance.now() * 0.001,
        seed: def.seed,
        glow: !isLegacyGraphics(),
      });
    }
  }

  let fills = 0;
  const buckets = transform.damageMesh?.buckets ?? getStageBuckets(geo, transform.damageStage ?? 0);
  const stage = Math.min(DAMAGE_STAGES - 1, Math.max(0, Math.round(transform.damageStage ?? 0)));
  const silhouette = transform.damageMesh?.silhouette ?? geo.stageSilhouettes[stage]!;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (b.minFeature * scale < MIN_FEATURE_PX) continue;
    ctx.fillStyle = b.accent ? ramp.accents[b.shadeIndex] : ramp.fills[b.shadeIndex];
    if (b.path) ctx.fill(b.path);
    fills++;
  }
  if (fills === 0) {
    ctx.fillStyle = ramp.fills[Math.min(ramp.fills.length - 1, 2)];
    ctx.fill(silhouette);
    fills = 1;
  }
  lastFillCalls = fills;

  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.2 / scale;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.stroke(silhouette);

  if (p.lineThickness > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(0.6, p.lineThickness) / scale;
    ctx.strokeStyle = ramp.rim;
    ctx.globalAlpha = 0.55;
    ctx.stroke(silhouette);
    ctx.globalAlpha = 1;
  }
  if (p.glowAmount > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(0.6, p.glowAmount * 0.6);
    ctx.lineWidth = (1.4 + p.glowAmount) / scale;
    ctx.strokeStyle = ramp.rim;
    ctx.stroke(silhouette);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  if (debug) {
    ctx.lineWidth = 0.8 / scale;
    if (debug.showBoundingBox) {
      const bb = geo.boundingBox;
      ctx.strokeStyle = 'rgba(255,200,80,0.8)';
      ctx.strokeRect(bb.minX, bb.minY, bb.maxX - bb.minX, bb.maxY - bb.minY);
    }
    if (debug.showSymmetryAxis) {
      const bb = geo.boundingBox;
      ctx.strokeStyle = 'rgba(255,80,80,0.85)';
      ctx.beginPath();
      ctx.moveTo(bb.minX, 0);
      ctx.lineTo(bb.maxX, 0);
      ctx.stroke();
    }
    if (debug.showGasketWireframe) {
      ctx.strokeStyle = 'rgba(120,255,180,0.75)';
      for (const e of geo.gasketEdges) {
        ctx.beginPath();
        ctx.moveTo(e[0], e[1]);
        ctx.lineTo(e[2], e[3]);
        ctx.lineTo(e[4], e[5]);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(e[0], -e[1]);
        ctx.lineTo(e[2], -e[3]);
        ctx.lineTo(e[4], -e[5]);
        ctx.closePath();
        ctx.stroke();
      }
    }
    if (debug.showBudAnchors) {
      ctx.strokeStyle = 'rgba(255,255,120,0.9)';
      for (const a of geo.budAnchors) {
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(a.x, -a.y, a.r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (debug.showBucketBands) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 0.5 / scale;
      for (const b of geo.buckets) if (b.path) ctx.stroke(b.path);
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Mutation / randomization helpers (deterministic given a mutation seed)
// ---------------------------------------------------------------------------

const PARAM_RANGES: Record<keyof ProceduralShipParams, [number, number]> = {
  length: [40, 260],
  spanToLength: [0.4, 2.5],
  tipSweep: [0, 0.75],
  tailNotch: [0, 0.6],
  structureDepth: [0, 4],
  gasketBias: [0.15, 0.85],
  budCount: [0, 8],
  budScale: [0, 0.45],
  budFalloff: [0.6, 3.5],
  budTwist: [-1.2, 1.2],
  budDepth: [0, 2],
  budEmbed: [0, 1.2],
  wingPairs: [0, 3],
  wingElements: [1, 3],
  wingStation: [0.05, 0.8],
  wingGroupGap: [0, 0.35],
  wingSweep: [-0.1, 0.45],
  wingChord: [0.05, 0.6],
  wingSpan: [0, 0.7],
  wingRake: [0, 1],
  wingDetail: [0, 3],
  wingBuds: [0, 4],
  wingSerration: [0, 1],
  finCount: [0, 4],
  finLength: [0.05, 0.45],
  finSpread: [0, 0.5],
  shadeBands: [3, 12],
  shadeDepthMix: [0, 1],
  hueSpread: [0, 90],
  accentHueShift: [0, 360],
  accentAmount: [0, 1],
  coreSize: [0, 0.16],
  asymmetry: [0, 0.35],
  lineThickness: [0, 3],
  glowAmount: [0, 1],
};

/** Params that read as style rather than shape — mutation leaves these alone. */
const STYLE_KEYS = new Set<keyof ProceduralShipParams>([
  'shadeBands', 'hueSpread', 'accentHueShift', 'lineThickness', 'glowAmount', 'asymmetry',
]);

export function mutateParams(params: ProceduralShipParams, strength: number, mutationSeed: number): ProceduralShipParams {
  const rng = seededRandom(mutationSeed);
  const out = { ...params };
  for (const key of Object.keys(PARAM_RANGES) as (keyof ProceduralShipParams)[]) {
    if (STYLE_KEYS.has(key)) continue;
    const [lo, hi] = PARAM_RANGES[key];
    const delta = (rng() * 2 - 1) * (hi - lo) * 0.25 * strength;
    out[key] = Math.min(hi, Math.max(lo, out[key] + delta));
  }
  return out;
}

export function randomizeParams(randomSeed: number): ProceduralShipParams {
  const rng = seededRandom(randomSeed);
  const out = { ...DEFAULT_PARAMS };
  const pick = (key: keyof ProceduralShipParams, lo?: number, hi?: number) => {
    const [rlo, rhi] = PARAM_RANGES[key];
    out[key] = (lo ?? rlo) + rng() * ((hi ?? rhi) - (lo ?? rlo));
  };
  pick('length', 80, 200);
  pick('spanToLength', 0.45, 1.6);
  pick('tipSweep', 0.1, 0.55);
  pick('tailNotch', 0.05, 0.4);
  out.structureDepth = 2 + Math.floor(rng() * 3);
  pick('gasketBias', 0.3, 0.72);
  out.budCount = Math.floor(rng() * 6);
  pick('budScale', 0.06, 0.3);
  pick('budFalloff', 1.2, 2.8);
  pick('budTwist', -0.8, 0.9);
  out.budDepth = Math.floor(rng() * 2.4);
  pick('budEmbed', 0.3, 0.85);
  out.wingPairs = 1 + Math.floor(rng() * 2.2);
  out.wingElements = 1 + Math.floor(rng() * 3);
  out.wingDetail = 1 + Math.floor(rng() * 3);
  out.wingBuds = Math.floor(rng() * 4);
  pick('wingGroupGap', 0.04, 0.25);
  pick('wingRake', 0, 0.8);
  pick('wingSerration', 0, 0.9);
  pick('wingStation', 0.15, 0.6);
  pick('wingSweep', 0, 0.35);
  pick('wingChord', 0.1, 0.38);
  pick('wingSpan', 0.12, 0.55);
  out.finCount = Math.floor(rng() * 4.2);
  pick('finLength', 0.1, 0.38);
  pick('finSpread', 0.03, 0.35);
  pick('shadeDepthMix', 0.35, 0.85);
  pick('accentAmount', 0.3, 1);
  pick('coreSize', 0.02, 0.1);
  return out;
}

export { PARAM_RANGES };
