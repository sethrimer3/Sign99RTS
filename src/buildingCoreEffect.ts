/**
 * Building "core" effect — the four corner nodes of every structure (and the
 * thin lines that connect them) become glowing masks behind which a sharp,
 * fiery Perlin-noise fog burns like an engine core.
 *
 * Three noise layers scroll slowly in different directions with partial
 * transparency, composited additively and tinted through a warm orange→yellow
 * fire gradient.  On High / Ultra graphics the node frame also gets a soft warm
 * shader-style bloom.
 *
 * The whole effect scales with an `intensity` value in [0, 1] supplied by the
 * caller — normally the structure's remaining hit-point fraction, forced to 0
 * when the structure is unpowered or still under construction.  At intensity 0
 * nothing is drawn and the building looks exactly like its base art.
 *
 * Gated behind `!isLegacyGraphics()` by the caller.  Reverts via the global
 * Legacy Graphics toggle.
 */

import type { VisualQuality } from './visualquality.js';

/** Warm bloom around the node frame is only worth it on these tiers. */
let glowEnabled = true;
/** Number of scrolling noise layers (fire depth). Trimmed on low tiers. */
let layerCount = 3;

export function setBuildingCoreEffectTier(tier: VisualQuality): void {
  glowEnabled = tier === 'high' || tier === 'ultraHigh';
  layerCount = tier === 'ultraLow' ? 1 : tier === 'low' ? 2 : 3;
}

// --- Baked fire-noise tile -------------------------------------------------

const TILE = 96;
let noiseTile: HTMLCanvasElement | null = null;

/** 2D value noise from an integer hash — cheap, seamless enough when tiled. */
function hash2(ix: number, iy: number): number {
  let h = (ix * 374761393 + iy * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const n00 = hash2(x0, y0);
  const n10 = hash2(x0 + 1, y0);
  const n01 = hash2(x0, y0 + 1);
  const n11 = hash2(x0 + 1, y0 + 1);
  return (
    n00 * (1 - fx) * (1 - fy) +
    n10 * fx * (1 - fy) +
    n01 * (1 - fx) * fy +
    n11 * fx * fy
  );
}

/**
 * Ridged multifractal — the `abs()` fold gives the sharp, licking flame edges
 * the brief asks for rather than soft rounded blobs.
 */
function ridged(x: number, y: number): number {
  let sum = 0;
  let amp = 0.55;
  let freq = 1;
  for (let o = 0; o < 4; o++) {
    const n = valueNoise(x * freq, y * freq);
    sum += amp * (1 - Math.abs(n * 2 - 1));
    freq *= 2.03;
    amp *= 0.5;
  }
  return Math.min(1, sum);
}

function buildNoiseTile(): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = TILE;
  cv.height = TILE;
  const c = cv.getContext('2d')!;
  const img = c.createImageData(TILE, TILE);
  const d = img.data;
  // Sample on a torus so the tile wraps seamlessly when scrolled.
  const scale = 4;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const ang1 = (x / TILE) * Math.PI * 2;
      const ang2 = (y / TILE) * Math.PI * 2;
      const nx = (Math.cos(ang1) + 1) * scale;
      const ny = (Math.sin(ang1) + 1) * scale;
      const nz = (Math.cos(ang2) + 1) * scale;
      const nw = (Math.sin(ang2) + 1) * scale;
      let v = ridged(nx + nz, ny + nw);
      // Sharpen contrast so the flame has bright cores and dark gaps, then lift
      // the floor so a multiply pass darkens the gaps without crushing to black.
      v = 0.2 + 0.8 * Math.pow(v, 2.4);
      const g = Math.max(0, Math.min(255, v * 255));
      const i = (y * TILE + x) * 4;
      // Opaque grayscale: multiply uses the RGB value, additive uses brightness.
      d[i] = g;
      d[i + 1] = g;
      d[i + 2] = g;
      d[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  return cv;
}

// --- Public renderer -----------------------------------------------------

export interface CoreEffectOpts {
  /** Screen-space top-left of the building square. */
  x: number;
  y: number;
  /** Screen-space side length of the building square. */
  side: number;
  /** Screen-space edge length of one corner node (= 1 conduit cell). */
  nodeSize: number;
  /** 0..1 — how strongly the effect shows (usually HP fraction; 0 => nothing). */
  intensity: number;
  /** Seconds, for scrolling the layers. */
  timeSec: number;
  /** Per-building constant so neighbours don't scroll in lock-step. */
  seed: number;
  /** Allow the warm frame bloom (caller already checks the graphics tier). */
  glow: boolean;
}

/** Layer scroll directions (unit-ish vectors) and relative speeds / scales. */
const LAYERS = [
  { dx: 0.0, dy: -1.0, speed: 9, scale: 1.0, alpha: 0.55 },
  { dx: 0.87, dy: 0.5, speed: 6, scale: 1.6, alpha: 0.4 },
  { dx: -0.7, dy: 0.2, speed: 13, scale: 0.7, alpha: 0.3 },
];

/**
 * Build the mask geometry: four corner squares of `nodeSize`, plus a thin band
 * along each edge that connects them (kept flush to the outer edge so it reads
 * like the original connecting lines in the base art).
 */
function maskPath(x: number, y: number, side: number, node: number): Path2D {
  const p = new Path2D();
  const n = Math.min(node, side * 0.5);
  // corners
  p.rect(x, y, n, n);
  p.rect(x + side - n, y, n, n);
  p.rect(x, y + side - n, n, n);
  p.rect(x + side - n, y + side - n, n, n);
  // connecting bands (flush to each edge, spanning the gap between the squares)
  const bw = Math.max(1, n * 0.4);
  const gap = side - 2 * n;
  if (gap > 0) {
    p.rect(x + n, y, gap, bw); // top
    p.rect(x + n, y + side - bw, gap, bw); // bottom
    p.rect(x, y + n, bw, gap); // left
    p.rect(x + side - bw, y + n, bw, gap); // right
  }
  return p;
}

export function renderBuildingCoreEffect(ctx: CanvasRenderingContext2D, opts: CoreEffectOpts): void {
  const { x, y, side, nodeSize, timeSec, seed, glow } = opts;
  const intensity = Math.max(0, Math.min(1, opts.intensity));
  if (intensity <= 0.001 || side < 6) return;

  if (!noiseTile) noiseTile = buildNoiseTile();
  const tile = noiseTile;

  const path = maskPath(x, y, side, nodeSize);
  const n = Math.min(nodeSize, side * 0.5);

  const layers = LAYERS.slice(0, layerCount);
  const tileRun = (drawn: number, ox: number, oy: number) => {
    for (let ty = -1; ty <= Math.ceil(side / drawn) + 1; ty++) {
      for (let tx = -1; tx <= Math.ceil(side / drawn) + 1; tx++) {
        ctx.drawImage(tile, x + tx * drawn - ox, y + ty * drawn - oy, drawn, drawn);
      }
    }
  };
  const scroll = (li: number) => {
    const L = layers[li];
    const drawn = n * 2.4 * L.scale;
    const off = timeSec * L.speed + seed * 17.3 + li * 40;
    return {
      drawn,
      ox: ((L.dx * off) % drawn + drawn) % drawn,
      oy: ((L.dy * off) % drawn + drawn) % drawn,
      L,
    };
  };

  ctx.save();
  ctx.beginPath();
  ctx.clip(path);

  // 1) solid warm fire gradient as the colour bed.
  ctx.globalAlpha = intensity;
  const grad = ctx.createLinearGradient(x, y + side, x, y);
  grad.addColorStop(0.0, 'rgb(90, 10, 0)');
  grad.addColorStop(0.4, 'rgb(210, 66, 10)');
  grad.addColorStop(0.75, 'rgb(255, 150, 44)');
  grad.addColorStop(1.0, 'rgb(255, 224, 150)');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, side, side);

  // 2) carve the flame shapes out of the bed — dark noise gaps darken it, so
  //    the sharp ridged pattern reads as licking fire tongues.
  ctx.globalCompositeOperation = 'multiply';
  for (let li = 0; li < layers.length; li++) {
    const s = scroll(li);
    ctx.globalAlpha = intensity * (0.85 - li * 0.12);
    tileRun(s.drawn, s.ox, s.oy);
  }

  // 3) additive hot cores — the brightest noise crests glow white-yellow.
  ctx.globalCompositeOperation = 'lighter';
  for (let li = 0; li < layers.length; li++) {
    const s = scroll(li);
    ctx.globalAlpha = intensity * s.L.alpha * 0.28;
    tileRun(s.drawn * 0.8, s.ox * 1.3, s.oy * 1.3);
  }

  ctx.restore();

  // 4) soft warm shader-style bloom around the node frame (High / Ultra only).
  if (glow && glowEnabled) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = intensity * 0.9;
    ctx.strokeStyle = 'rgba(255, 168, 74, 0.85)';
    ctx.lineWidth = Math.max(1.5, n * 0.14);
    ctx.shadowColor = 'rgba(255, 140, 48, 0.9)';
    ctx.shadowBlur = Math.max(4, n * 0.9);
    ctx.stroke(path);
    ctx.shadowBlur = Math.max(2, n * 0.4);
    ctx.stroke(path);
    ctx.restore();
  }
}
