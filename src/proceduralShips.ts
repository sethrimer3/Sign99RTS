/** Procedural spaceship generation — Sierpinski-style structural subdivision plus
 *  Mandelbrot-style bulb budding, baked into flat shaded Path2D buckets.
 *  Ship-local space: +x = forward (nose), y = lateral. Everything is mirrored across y = 0. */

import { Vec2 } from './math.js';
import { Camera } from './camera.js';
import type { Color } from './colors.js';

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
  spanToLength: number;    // span / length. > 1 = wing-dominant delta/manta
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
  wingPairs: number;
  wingStation: number;     // where the first wing root sits along the leading edge
  wingSweep: number;       // sweep-back of the wing tip, fraction of length
  wingChord: number;       // root chord, fraction of the leading edge
  wingSpan: number;        // wing extension beyond the hull, fraction of span
  finCount: number;
  finLength: number;       // fraction of length
  finSpread: number;       // lateral spread of the fin fan, fraction of span
  // Shading
  shadeBands: number;
  shadeDepthMix: number;   // 0 = shade purely by distance from nose, 1 = purely by depth
  hueSpread: number;       // degrees of hue drift across the ramp
  accentHueShift: number;  // degrees; ~150 gives the warm-in-cool contrast
  accentAmount: number;    // 0..1, how much accent geometry is emitted
  coreSize: number;        // accent core radius, fraction of length
  // Misc
  asymmetry: number;       // controlled shared perturbation of the mirrored half
  lineThickness: number;   // silhouette hairline, screen px (0 = no stroke)
  glowAmount: number;      // single additive rim stroke, no shadowBlur
}

export const DEFAULT_PARAMS: ProceduralShipParams = {
  length: 120,
  spanToLength: 1.45,
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
  wingStation: 0.34,
  wingSweep: 0.16,
  wingChord: 0.26,
  wingSpan: 0.18,
  finCount: 2,
  finLength: 0.2,
  finSpread: 0.3,
  shadeBands: 8,
  shadeDepthMix: 0.72,
  hueSpread: 34,
  accentHueShift: 150,
  accentAmount: 0.7,
  coreSize: 0.055,
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
export const MAX_POLYGONS = 260;

export interface ShipPolygon {
  pts: number[];      // flat [x0,y0,x1,y1,...] in ship-local units
  depth: number;      // paint order; higher paints later
  shade: number;      // 0..1 before quantization
  accent: boolean;
  feature: number;    // characteristic size in ship-local units, for LOD
}

export interface ShipBucket {
  depth: number;
  shadeIndex: number;
  accent: boolean;
  path: Path2D;
  /** Smallest feature in this bucket; the bucket is skipped when it is sub-pixel. */
  minFeature: number;
  polyCount: number;
}

export interface ShipGeometry {
  polygons: ShipPolygon[];
  buckets: ShipBucket[];
  silhouette: Path2D;
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
}

type P = { x: number; y: number };

function lerpP(a: P, b: P, t: number): P {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function polyFeature(pts: number[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const j = (i + 2) % pts.length;
    area += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return Math.sqrt(Math.abs(area) * 0.5) || 0.0001;
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
    private span: number,
    private L: number,
    private depthMix: number,
    private asym: number,
  ) {}

  get full(): boolean { return this.polys.length + 2 > MAX_POLYGONS; }

  /** Shade blends a structural target (recursion depth / part type) with normalized
   *  distance from the nose, so the ship bands deliberately instead of mottling. */
  shadeFor(pts: number[], target: number): number {
    const dx = (this.noseX - centroidX(pts)) / (this.L * 1.05);
    const dy = Math.abs(centroidY(pts)) / (this.span * 0.7 + 1e-6);
    const dist = Math.min(1, Math.sqrt(dx * dx * 0.9 + dy * dy * 0.45));
    return Math.min(1, Math.max(0, this.depthMix * target + (1 - this.depthMix) * (1 - dist)));
  }

  /** Emit a right-half polygon and its mirror. */
  emit(pts: number[], depth: number, target: number, accent = false): void {
    if (this.full) return;
    const shade = this.shadeFor(pts, target);
    const feature = polyFeature(pts);
    this.polys.push({ pts, depth, shade, accent, feature });
    const m = new Array<number>(pts.length);
    const k = 1 - this.asym;
    for (let i = 0; i < pts.length; i += 2) { m[i] = pts[i]; m[i + 1] = -pts[i + 1] * k; }
    this.polys.push({ pts: m, depth, shade, accent, feature });
  }

  /** Emit a polygon that already straddles the symmetry axis. */
  emitSym(pts: number[], depth: number, target: number, accent = false): void {
    if (this.polys.length + 1 > MAX_POLYGONS) return;
    this.polys.push({ pts, depth, shade: this.shadeFor(pts, target), accent, feature: polyFeature(pts) });
  }
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
function gasket(em: Emitter, a: P, b: P, c: P, depth: number, maxDepth: number, bias: number, edges: number[][], inset: number): void {
  const t = maxDepth === 0 ? 1 : depth / maxDepth;
  em.emit(depth === 0 ? triPts(a, b, c) : insetTri(a, b, c, inset), depth, 0.02 + 0.93 * t);
  if (depth >= maxDepth || em.full) return;
  const ab = lerpP(a, b, bias);
  const bc = lerpP(b, c, bias);
  const ca = lerpP(c, a, bias);
  if (depth < 2) edges.push([ab.x, ab.y, bc.x, bc.y, ca.x, ca.y]);
  gasket(em, a, ab, ca, depth + 1, maxDepth, bias, edges, inset);
  gasket(em, ab, b, bc, depth + 1, maxDepth, bias, edges, inset);
  gasket(em, ca, bc, c, depth + 1, maxDepth, bias, edges, inset);
}

const LOBE_SIDES = 9;

/** A bulb: a slightly outward-elongated n-gon, the round counterpart to the gasket's
 *  straight edges. Cheap and it reads as a Mandelbrot bulb at any size. */
function lobe(cx: number, cy: number, r: number, rot: number): number[] {
  const out = new Array<number>(LOBE_SIDES * 2);
  const co = Math.cos(rot), si = Math.sin(rot);
  for (let i = 0; i < LOBE_SIDES; i++) {
    const a = (i / LOBE_SIDES) * Math.PI * 2;
    const lx = Math.cos(a) * r * 1.12, ly = Math.sin(a) * r * 0.88;
    out[i * 2] = cx + lx * co - ly * si;
    out[i * 2 + 1] = cy + lx * si + ly * co;
  }
  return out;
}

/** Bulbs budding on a parent bulb's rim — the self-similar step that makes the chain
 *  read as Mandelbrot rather than as beads on a string. */
function budChildren(
  em: Emitter, cx: number, cy: number, r: number, rot: number, count: number,
  depthBase: number, level: number, p: ProceduralShipParams,
): void {
  if (level > Math.round(p.budDepth) || count < 1 || em.full) return;
  for (let j = 0; j < Math.min(2, count); j++) {
    if (em.full) return;
    const rc = (r * 0.42) / Math.pow(j + 1, p.budFalloff * 0.5);
    if (rc < p.length * 0.008) return;
    const ang = rot + (j - (count - 1) * 0.5) * (0.85 + p.budTwist * 0.6) + p.budTwist;
    const px = cx + Math.cos(ang) * (r * 0.94 + rc * 0.7);
    const py = cy + Math.sin(ang) * (r * 0.94 + rc * 0.7);
    em.emit(lobe(px, py, rc, ang), depthBase + level, 0.66 + level * 0.14);
    budChildren(em, px, py, rc, ang, Math.max(1, count - 1), depthBase, level + 1, p);
  }
}

/** Bud sizes follow r_n = scale * edgeLen / (n+1)^falloff — the 1/n^p law is what makes
 *  Mandelbrot's bulb chains read the way they do — and are packed tangent to each other. */
function budChain(
  em: Emitter, A: P, B: P, inside: P, count: number, scale: number,
  depthBase: number, p: ProceduralShipParams, anchors: { x: number; y: number; r: number }[],
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
    // Accent lands on a small mid-chain bulb, never the largest one: keeps the warm
    // contrast to a few percent of the area.
    const accent = n === 2 && p.accentAmount > 0.35;
    em.emit(lobe(px, py, r, rot), depthBase, 0.4 + n * 0.05, accent);
    // A concentric highlight turns a flat blob into a bulb with its own bright interior.
    em.emit(lobe(px + Math.cos(rot) * r * 0.16, py + Math.sin(rot) * r * 0.16, r * 0.52, rot), depthBase + 1, 0.82, false);
    anchors.push({ x: px, y: py, r });
    budChildren(em, px, py, r, rot, Math.max(1, count - 2), depthBase + 2, 1, p);
    cursor += r * 0.92;
  }
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

  const em = new Emitter(N.x, span, L, p.shadeDepthMix, Math.min(0.4, p.asymmetry));
  const edges: number[][] = [];
  const anchors: { x: number; y: number; r: number }[] = [];

  const bias = Math.min(0.92, Math.max(0.08, p.gasketBias + jBias));
  gasket(em, N, W, T, 0, maxDepth, bias, edges, 0.955);

  // Both chains start at the wingtip, so the largest bulbs sit at the shoulder and
  // taper forward and aft — the cardioid-neck reading.
  const inside: P = { x: (N.x + W.x + T.x) / 3, y: (N.y + W.y + T.y) / 3 };
  const budDepthBase = maxDepth + 1;
  budChain(em, W, N, inside, Math.round(p.budCount), p.budScale, budDepthBase, p, anchors);
  budChain(em, W, T, inside, Math.round(p.budCount), p.budScale * 0.85, budDepthBase, p, anchors);

  // Wings: swept deltas rooted on the leading edge, each given one level of the same gasket rule.
  const wingPairs = Math.round(Math.max(0, Math.min(3, p.wingPairs)));
  const wingDepth = budDepthBase + Math.round(p.budDepth) + 2;
  const lead = { x: W.x - N.x, y: W.y - N.y };
  const leadLen = Math.hypot(lead.x, lead.y) || 1;
  const lu = { x: lead.x / leadLen, y: lead.y / leadLen };
  const ln = { x: -lu.y, y: lu.x };
  if (ln.y < 0) { ln.x = -ln.x; ln.y = -ln.y; }
  for (let i = 0; i < wingPairs; i++) {
    if (em.full) break;
    const u0 = Math.min(0.88, p.wingStation + i * (p.wingChord + 0.08));
    const u1 = Math.min(0.98, u0 + p.wingChord);
    const r0 = lerpP(N, W, u0);
    const r1 = lerpP(N, W, u1);
    // Tip rides the leading-edge normal and sweeps back along the edge, so the wing
    // grows out of the hull instead of reading as a bolted-on slab.
    const out = p.wingSpan * span * 0.8;
    const sw = p.wingSweep * L;
    const anchor = lerpP(r0, r1, 0.72);
    const tipP: P = { x: anchor.x + ln.x * out + lu.x * sw, y: anchor.y + ln.y * out + lu.y * sw };
    em.emit(triPts(r0, r1, tipP), wingDepth, 0.26);
    const m0 = lerpP(r0, r1, bias);
    const m1 = lerpP(r1, tipP, bias);
    const m2 = lerpP(tipP, r0, bias);
    em.emit(insetTri(r0, m0, m2, 0.94), wingDepth + 1, 0.5);
    em.emit(insetTri(m0, r1, m1, 0.94), wingDepth + 1, 0.62);
    em.emit(insetTri(m2, m1, tipP, 0.94), wingDepth + 1, 0.8);
  }

  // Fins: narrow elongated triangles raked off the trailing edge.
  const finCount = Math.round(Math.max(0, Math.min(4, p.finCount)));
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
    em.emit(triPts(r0, r1, apex), wingDepth + 2, 0.6 + f * 0.22);
  }

  // Accents: a nose cap that is a scaled copy of the hull nose, and a core lozenge.
  if (p.accentAmount > 0) {
    const nt = 0.07 + 0.06 * p.accentAmount;
    const na = lerpP(N, W, nt);
    const nb = lerpP(N, T, nt);
    em.emitSym([N.x, N.y, na.x, na.y, nb.x, nb.y, na.x, -na.y], wingDepth + 3, 0.85, true);
    const cr = Math.max(0.5, p.coreSize * L);
    const cxp = T.x + (N.x - T.x) * 0.42;
    em.emitSym([cxp + cr * 1.9, 0, cxp, cr, cxp - cr * 1.9, 0, cxp, -cr], wingDepth + 3, 0.7, true);
  }

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
  const silhouette = new Path2D();
  const ml = 1 - Math.min(0.4, p.asymmetry);
  silhouette.moveTo(N.x, N.y);
  silhouette.lineTo(W.x, W.y);
  silhouette.lineTo(T.x, T.y);
  silhouette.lineTo(W.x, -W.y * ml);
  silhouette.closePath();

  const bands = Math.round(Math.max(2, Math.min(12, p.shadeBands)));
  const buckets = bakeBuckets(em.polys, bands);

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
  };
}

/** Bake polygons into one Path2D per (depth, shadeIndex, accent) so drawing a ship is a
 *  handful of ctx.fill() calls with zero per-frame path construction. */
function bakeBuckets(polys: ShipPolygon[], bands: number): ShipBucket[] {
  const map = new Map<number, ShipBucket>();
  for (const poly of polys) {
    const si = Math.max(0, Math.min(bands - 1, Math.round(poly.shade * (bands - 1))));
    const key = poly.depth * 64 + si * 2 + (poly.accent ? 1 : 0);
    let b = map.get(key);
    if (!b) {
      b = { depth: poly.depth, shadeIndex: si, accent: poly.accent, path: new Path2D(), minFeature: Infinity, polyCount: 0 };
      map.set(key, b);
    }
    b.path.moveTo(poly.pts[0], poly.pts[1]);
    for (let i = 2; i < poly.pts.length; i += 2) b.path.lineTo(poly.pts[i], poly.pts[i + 1]);
    b.path.closePath();
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
  const fills: string[] = [];
  const accents: string[] = [];
  for (let i = 0; i < bands; i++) {
    const u = bands === 1 ? 1 : i / (bands - 1);
    const l = 0.12 + u * u * 0.25 + u * 0.55;                 // dark field -> bright highlight
    const sat = s * (1 - Math.pow(Math.max(0, u - 0.45) / 0.55, 2) * 0.82);
    fills.push(hslToCss(h + hueSpread * (u - 0.25), Math.min(1, sat), Math.min(0.95, l)));
    accents.push(hslToCss(h + accentHueShift + hueSpread * 0.3 * u, Math.min(1, 0.62 + 0.3 * s), 0.36 + u * 0.42));
  }
  ramp = { fills, accents, rim: hslToCss(h + hueSpread * 0.9, Math.min(1, s * 0.5), 0.88) };
  rampCache.set(key, ramp);
  return ramp;
}

// ---------------------------------------------------------------------------
// Geometry cache — keyed by seed+params so gameplay never regenerates per frame.
// ---------------------------------------------------------------------------

const geometryCache = new Map<string, ShipGeometry>();

export function designCacheKey(def: ProceduralShipDefinition): string {
  return def.seed + '|' + JSON.stringify(def.params);
}

/** Get (and lazily generate/cache) geometry for a design. */
export function getShipGeometry(def: ProceduralShipDefinition): ShipGeometry {
  const key = designCacheKey(def);
  let geo = geometryCache.get(key);
  if (!geo) {
    geo = generateShipGeometry(def);
    if (geometryCache.size > 400) geometryCache.clear();
    geometryCache.set(key, geo);
  }
  return geo;
}

/** Drop a cached entry (or the whole cache) — call when Ship Lab params change. */
export function invalidateShipGeometryCache(def?: ProceduralShipDefinition): void {
  if (def) geometryCache.delete(designCacheKey(def));
  else geometryCache.clear();
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

  let fills = 0;
  const buckets = geo.buckets;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (b.minFeature * scale < MIN_FEATURE_PX) continue;
    ctx.fillStyle = b.accent ? ramp.accents[b.shadeIndex] : ramp.fills[b.shadeIndex];
    ctx.fill(b.path);
    fills++;
  }
  if (fills === 0) {
    ctx.fillStyle = ramp.fills[Math.min(ramp.fills.length - 1, 2)];
    ctx.fill(geo.silhouette);
    fills = 1;
  }
  lastFillCalls = fills;

  if (p.lineThickness > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(0.6, p.lineThickness) / scale;
    ctx.strokeStyle = ramp.rim;
    ctx.globalAlpha = 0.55;
    ctx.stroke(geo.silhouette);
    ctx.globalAlpha = 1;
  }
  if (p.glowAmount > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(0.6, p.glowAmount * 0.6);
    ctx.lineWidth = (1.4 + p.glowAmount) / scale;
    ctx.strokeStyle = ramp.rim;
    ctx.stroke(geo.silhouette);
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
      for (const b of geo.buckets) ctx.stroke(b.path);
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
  wingStation: [0.05, 0.8],
  wingSweep: [-0.1, 0.45],
  wingChord: [0.05, 0.5],
  wingSpan: [0, 0.5],
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
  pick('spanToLength', 0.55, 2.2);
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
  out.wingPairs = Math.floor(rng() * 3.2);
  pick('wingStation', 0.15, 0.6);
  pick('wingSweep', 0, 0.35);
  pick('wingChord', 0.12, 0.4);
  pick('wingSpan', 0.05, 0.35);
  out.finCount = Math.floor(rng() * 4.2);
  pick('finLength', 0.1, 0.38);
  pick('finSpread', 0.03, 0.35);
  pick('shadeDepthMix', 0.35, 0.85);
  pick('accentAmount', 0.3, 1);
  pick('coreSize', 0.02, 0.1);
  return out;
}

export { PARAM_RANGES };
