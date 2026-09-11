/** Procedural spaceship silhouette generation — pure math/geometry, no rendering side effects
 *  beyond the shared draw() function. Used by both the Ship Lab dev tool and (optionally) gameplay. */

import { Vec2 } from './math.js';
import { Camera } from './camera.js';

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
  length: number;
  maxWidth: number;
  noseSharpness: number;      // Beta exponent controlling the nose taper
  tailWidth: number;          // fraction of maxWidth kept at the tail
  widestPoint: number;        // 0..1 fraction along the spine, where the hull is widest
  edgeCurve: number;          // overall hull profile exponent bias
  edgeWaveAmplitude: number;  // sinusoidal ripple on the hull edge, fraction of local half-width
  edgeWaveFrequency: number;  // ripple cycles along the spine
  edgeWavePhase: number;      // ripple phase offset (radians)
  ribCount: number;           // number of symmetric internal ribs
  ribCurvature: number;       // bezier bow of each rib
  ribInset: number;           // fraction ribs are inset from the hull edge
  spineThickness: number;     // width of the drawn center spine line
  corePosition: number;       // 0..1 along spine, position of the core marker
  coreSize: number;           // radius of the core marker
  innerStructureDensity: number; // number of small structural nodes
  asymmetry: number;          // 0..1, breaks bilateral symmetry (default 0)
  lineThickness: number;
  glowAmount: number;
  hullFillOpacity: number;
  interiorLineOpacity: number;
}

export const DEFAULT_PARAMS: ProceduralShipParams = {
  length: 120,
  maxWidth: 40,
  noseSharpness: 2.2,
  tailWidth: 0.35,
  widestPoint: 0.62,
  edgeCurve: 1.0,
  edgeWaveAmplitude: 0,
  edgeWaveFrequency: 3,
  edgeWavePhase: 0,
  ribCount: 4,
  ribCurvature: 0.35,
  ribInset: 0.15,
  spineThickness: 1,
  corePosition: 0.55,
  coreSize: 6,
  innerStructureDensity: 6,
  asymmetry: 0,
  lineThickness: 1.4,
  glowAmount: 0.4,
  hullFillOpacity: 0.12,
  interiorLineOpacity: 0.5,
};

/** Cheap-to-serialize definition of a ship design: what it *is*, not runtime state. */
export interface ProceduralShipDefinition {
  seed: number;
  params: ProceduralShipParams;
}

// ---------------------------------------------------------------------------
// Geometry (generated once per design, cached — cheap to transform per frame)
// ---------------------------------------------------------------------------

export interface ShipGeometry {
  /** Full hull outline, closed loop, nose-first, going down one side and back the other. */
  outline: Vec2[];
  /** Sample points before mirroring/waving — one per t, right-side half-width only. */
  hullSamples: { x: number; y: number }[];
  spine: Vec2[];
  ribs: Vec2[][];        // each rib is a polyline (bezier-sampled), one per rib, mirrored pair combined
  innerHull: Vec2[];
  core: { x: number; y: number; r: number };
  nodes: { x: number; y: number; r: number }[];
  boundingBox: { minX: number; minY: number; maxX: number; maxY: number };
}

const SAMPLE_COUNT = 48;

/** Normalized Beta-like profile: t^a * (1-t)^b, remapped so the peak lands at widestPoint. */
function betaProfile(t: number, a: number, b: number): number {
  const v = Math.pow(t, a) * Math.pow(1 - t, b);
  return v;
}

function halfWidthAt(t: number, p: ProceduralShipParams): number {
  // Derive beta exponents from noseSharpness/widestPoint/edgeCurve so the peak sits at widestPoint.
  const wp = Math.min(0.95, Math.max(0.05, p.widestPoint));
  const a = Math.max(0.1, p.noseSharpness);
  // For t^a*(1-t)^b, the peak is at t = a/(a+b) => b = a*(1-wp)/wp
  const b = (a * (1 - wp)) / wp;
  const peak = betaProfile(wp, a, b) || 1e-6;
  let w = (betaProfile(t, a, b) / peak) * p.maxWidth * 0.5;
  w = Math.pow(Math.max(0, w / (p.maxWidth * 0.5)), p.edgeCurve) * p.maxWidth * 0.5;
  // Blend toward a minimum tail width near the stern so ships don't pinch to zero.
  const tailBlend = Math.max(0, t - 0.85) / 0.15;
  const tailFloor = p.tailWidth * p.maxWidth * 0.5;
  w = w * (1 - tailBlend) + tailFloor * tailBlend;
  // Sinusoidal edge ripple, mirrored identically on both sides (applied to magnitude only).
  const wave = Math.sin(t * p.edgeWaveFrequency * Math.PI * 2 + p.edgeWavePhase) * p.edgeWaveAmplitude * w;
  return Math.max(0, w + wave);
}

function bezierPoint(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, u: number): Vec2 {
  const mu = 1 - u;
  const x = mu * mu * mu * p0.x + 3 * mu * mu * u * c0.x + 3 * mu * u * u * c1.x + u * u * u * p1.x;
  const y = mu * mu * mu * p0.y + 3 * mu * mu * u * c0.y + 3 * mu * u * u * c1.y + u * u * u * p1.y;
  return new Vec2(x, y);
}

/** Build full geometry for a design. Pure function of (seed, params) — cache the result. */
export function generateShipGeometry(def: ProceduralShipDefinition): ShipGeometry {
  const { seed, params: p } = def;
  const rng = seededRandom(seed);
  const L = p.length;

  const hullSamples: { x: number; y: number }[] = [];
  for (let i = 0; i <= SAMPLE_COUNT; i++) {
    const t = i / SAMPLE_COUNT;
    const x = (t - 0.5) * L; // nose at +L/2, tail at -L/2
    const w = halfWidthAt(t, p);
    hullSamples.push({ x, y: w });
  }

  const asym = p.asymmetry;
  const rightSide = hullSamples.map((s) => new Vec2(s.x, s.y));
  const leftSide = hullSamples.map((s) => new Vec2(s.x, -s.y * (1 - asym)));
  const outline = [...rightSide, ...leftSide.reverse()];

  const spine: Vec2[] = [];
  for (let i = 0; i <= SAMPLE_COUNT; i++) {
    const t = i / SAMPLE_COUNT;
    spine.push(new Vec2((t - 0.5) * L, 0));
  }

  const ribs: Vec2[][] = [];
  const ribCount = Math.max(0, Math.round(p.ribCount));
  for (let r = 0; r < ribCount; r++) {
    const t = (r + 1) / (ribCount + 1);
    const x = (t - 0.5) * L;
    const w = halfWidthAt(t, p) * (1 - p.ribInset);
    const bow = p.ribCurvature * w;
    const p0 = new Vec2(x, -w);
    const p1 = new Vec2(x, w);
    const c0 = new Vec2(x + bow, -w * 0.4);
    const c1 = new Vec2(x + bow, w * 0.4);
    const poly: Vec2[] = [];
    const RIB_SAMPLES = 10;
    for (let i = 0; i <= RIB_SAMPLES; i++) {
      poly.push(bezierPoint(p0, c0, c1, p1, i / RIB_SAMPLES));
    }
    ribs.push(poly);
  }

  const innerHull: Vec2[] = [];
  const innerScale = 0.55;
  for (let i = 0; i <= SAMPLE_COUNT; i++) {
    const s = hullSamples[i];
    innerHull.push(new Vec2(s.x * innerScale, s.y * innerScale));
  }
  for (let i = SAMPLE_COUNT; i >= 0; i--) {
    const s = hullSamples[i];
    innerHull.push(new Vec2(s.x * innerScale, -s.y * innerScale * (1 - asym)));
  }

  const coreT = p.corePosition;
  const core = { x: (coreT - 0.5) * L, y: 0, r: p.coreSize };

  const nodes: { x: number; y: number; r: number }[] = [];
  const nodeCount = Math.max(0, Math.round(p.innerStructureDensity));
  for (let i = 0; i < nodeCount; i++) {
    const t = 0.1 + rng() * 0.8;
    const w = halfWidthAt(t, p);
    const side = rng() < 0.5 ? -1 : 1;
    const off = rng() * w * 0.7;
    nodes.push({ x: (t - 0.5) * L, y: side * off, r: 1 + rng() * 2 });
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pt of outline) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  return { outline, hullSamples, spine, ribs, innerHull, core, nodes, boundingBox: { minX, minY, maxX, maxY } };
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
}

export interface ShipDebugOverlay {
  showHullSamples?: boolean;
  showSpine?: boolean;
  showControlPoints?: boolean;
  showBoundingBox?: boolean;
  showSymmetryAxis?: boolean;
}

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

  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.rotate(transform.rotation);
  ctx.scale(scale, scale);

  const lineW = Math.max(0.5, p.lineThickness) / scale;

  // Hull outline + fill
  ctx.beginPath();
  geo.outline.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
  ctx.closePath();
  if (p.hullFillOpacity > 0) {
    ctx.fillStyle = `rgba(180,210,255,${p.hullFillOpacity})`;
    ctx.fill();
  }
  ctx.lineWidth = lineW;
  ctx.strokeStyle = `rgba(200,225,255,${0.85 + p.glowAmount * 0.15})`;
  if (p.glowAmount > 0) {
    ctx.shadowColor = 'rgba(150,200,255,0.9)';
    ctx.shadowBlur = p.glowAmount * 8;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Interior: spine, ribs, inner hull, core, nodes
  const interiorAlpha = p.interiorLineOpacity;
  if (interiorAlpha > 0) {
    ctx.strokeStyle = `rgba(190,215,255,${interiorAlpha})`;
    ctx.lineWidth = Math.max(0.4, p.spineThickness) / scale;
    ctx.beginPath();
    geo.spine.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
    ctx.stroke();

    ctx.lineWidth = lineW * 0.6;
    for (const rib of geo.ribs) {
      ctx.beginPath();
      rib.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
      ctx.stroke();
    }

    ctx.beginPath();
    geo.innerHull.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
    ctx.closePath();
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(geo.core.x, geo.core.y, geo.core.r, 0, Math.PI * 2);
    ctx.stroke();

    for (const n of geo.nodes) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  if (debug) {
    ctx.lineWidth = 0.75 / scale;
    if (debug.showBoundingBox) {
      const b = geo.boundingBox;
      ctx.strokeStyle = 'rgba(255,200,80,0.8)';
      ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    }
    if (debug.showSymmetryAxis) {
      const b = geo.boundingBox;
      ctx.strokeStyle = 'rgba(255,80,80,0.8)';
      ctx.beginPath();
      ctx.moveTo(b.minX, 0);
      ctx.lineTo(b.maxX, 0);
      ctx.stroke();
    }
    if (debug.showHullSamples) {
      ctx.fillStyle = 'rgba(80,255,140,0.9)';
      for (const s of geo.hullSamples) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 1.2 / scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(s.x, -s.y, 1.2 / scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (debug.showSpine) {
      ctx.strokeStyle = 'rgba(120,180,255,0.9)';
      ctx.lineWidth = 1 / scale;
      ctx.beginPath();
      geo.spine.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
      ctx.stroke();
    }
    if (debug.showControlPoints) {
      ctx.fillStyle = 'rgba(255,255,120,0.9)';
      ctx.beginPath();
      ctx.arc(geo.core.x, geo.core.y, 2 / scale, 0, Math.PI * 2);
      ctx.fill();
      for (const n of geo.nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 1.5 / scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Mutation / randomization helpers (deterministic given a mutation seed)
// ---------------------------------------------------------------------------

const PARAM_RANGES: Record<keyof ProceduralShipParams, [number, number]> = {
  length: [40, 260],
  maxWidth: [10, 120],
  noseSharpness: [0.3, 6],
  tailWidth: [0, 1],
  widestPoint: [0.1, 0.9],
  edgeCurve: [0.3, 2.5],
  edgeWaveAmplitude: [0, 0.3],
  edgeWaveFrequency: [0.5, 10],
  edgeWavePhase: [0, Math.PI * 2],
  ribCount: [0, 12],
  ribCurvature: [-1, 1],
  ribInset: [0, 0.6],
  spineThickness: [0.3, 4],
  corePosition: [0.05, 0.95],
  coreSize: [1, 20],
  innerStructureDensity: [0, 24],
  asymmetry: [0, 0.5],
  lineThickness: [0.5, 4],
  glowAmount: [0, 1],
  hullFillOpacity: [0, 0.5],
  interiorLineOpacity: [0, 1],
};

export function mutateParams(params: ProceduralShipParams, strength: number, mutationSeed: number): ProceduralShipParams {
  const rng = seededRandom(mutationSeed);
  const out = { ...params };
  for (const key of Object.keys(PARAM_RANGES) as (keyof ProceduralShipParams)[]) {
    const [lo, hi] = PARAM_RANGES[key];
    const range = hi - lo;
    const delta = (rng() * 2 - 1) * range * 0.25 * strength;
    out[key] = Math.min(hi, Math.max(lo, out[key] + delta));
  }
  return out;
}

export function randomizeParams(randomSeed: number): ProceduralShipParams {
  const rng = seededRandom(randomSeed);
  const out = { ...DEFAULT_PARAMS };
  for (const key of Object.keys(PARAM_RANGES) as (keyof ProceduralShipParams)[]) {
    const [lo, hi] = PARAM_RANGES[key];
    out[key] = lo + rng() * (hi - lo);
  }
  return out;
}

export { PARAM_RANGES };
