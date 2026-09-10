import { getCinematicLevel } from './cinematic.js';

/**
 * spacefluid.ts — Euler fluid background for Sign99 space.
 *
 * Ported and adapted from Chapter 3 EulerFluidEffect.js in
 * sethrimer3/Thero_Idle_TD.  The core particle advection and batched trail
 * rendering approach are preserved; the analytical velocity field has been
 * replaced with a grid-based accumulation model driven entirely by gameplay.
 *
 * Solver structure: inject forces → decay → diffuse → advect particles → draw.
 * No ambient / passive injection: velocity enters the field only through
 * explicit addForce() / addExplosion() calls made by gameplay systems.
 *
 * Opacity model: each trail segment's alpha is gated by the particle's
 * exponentially-smoothed local speed, so the background fades to near-
 * invisible when nothing is moving and brightens during active combat.
 */

// ── Grid resolution ──────────────────────────────────────────────────────────
/** Number of grid columns (constant regardless of canvas size). */
const FLUID_COLS = 60;
/** Number of grid rows (constant regardless of canvas size). */
const FLUID_ROWS = 80;
const FLUID_SIZE = FLUID_COLS * FLUID_ROWS; // 4 800 cells

// ── Particle settings (structure from Thero EulerFluidEffect) ────────────────
/** Particle count on low-graphics mode. */
const PARTICLE_COUNT_LOW  = 280;
/** Particle count on high-graphics mode — roughly 3× the prior high count. */
const PARTICLE_COUNT_HIGH = 1260;
const TRAIL_LENGTH     = 13;
/** Canvas-space line width for trail segments. */
const TRAIL_LINE_WIDTH = 1.4;

// ── Opacity / colour-blend reference ──────────────────────────────────────────
/**
 * Grid-space speed (cells / s) used as a reference for dye-colour blending
 * and for the PARTICLE_FULL_ACT_SPEED derivation.  No longer drives trail
 * opacity directly — that is now handled by the lifecycle model below.
 */
const SPEED_FULL_OPACITY  = 2.0;
/** Peak alpha value for the brightest trail segments. */
const TRAIL_PEAK_ALPHA    = 0.68;
/**
 * Per-frame exponential smoothing coefficient for particle speed.
 * Retained for colour-blend weighting only.
 */
const SPEED_SMOOTH_ALPHA  = 0.14;

// ── Particle lifecycle constants ───────────────────────────────────────────────
/**
 * Grid-space speed (cells / s) a particle must exceed to wake from dormancy.
 * Sub-threshold motion is ignored, so micro-jitter does not create visible trails.
 */
const PARTICLE_WAKE_SPEED        = 0.3;
/**
 * Grid-space speed (cells / s) at which activation reaches ~1.0 before the
 * power curve is applied.  Derived from SPEED_FULL_OPACITY so fast combat
 * produces vivid, saturated trails.
 */
const PARTICLE_FULL_ACT_SPEED    = SPEED_FULL_OPACITY * 4.0;
/** Shortest visible lifetime (seconds) — produced by the weakest disturbances. */
const PARTICLE_MIN_LIFETIME_SEC  = 0.8;
/** Longest visible lifetime (seconds) — produced by strong/fast disturbances. */
const PARTICLE_MAX_LIFETIME_SEC  = 4.0;
/**
 * Exponent applied to the normalised activation fraction.
 * Values > 1 compress weak disturbances toward 0 so tiny movement stays faint.
 */
const PARTICLE_ACTIVATION_POWER  = 1.8;
/**
 * Fractional boost added to an already-active particle's activation when
 * re-disturbed before its lifetime expires.  Prevents re-waking from instantly
 * jumping to full brightness.
 */
const PARTICLE_REWAKE_BOOST      = 0.35;
/** Coarse occupancy grid — column count for sparse-area respawn targeting. */
const SPARSE_RESPAWN_COLS        = 10;
/** Coarse occupancy grid — row count for sparse-area respawn targeting. */
const SPARSE_RESPAWN_ROWS        = 14;

// ── Field parameters ──────────────────────────────────────────────────────────
/**
 * Fraction of grid velocity that remains after 1 second with no new forces.
 * 0.18 → velocity decays to 18 % in 1 s, calming the fluid quickly.
 */
const VEL_RETAIN_PER_SEC  = 0.18;
/**
 * Fraction of dye colour that remains after 1 second.
 * Slightly higher than VEL_RETAIN so colours linger a little longer.
 */
const DYE_RETAIN_PER_SEC  = 0.28;
/**
 * Maximum speed in the grid (cells / s).  Forces exceeding this are clamped
 * to prevent runaway accumulation when many sources overlap.
 */
const MAX_GRID_VEL        = 48.0;
const PARTICLE_FLOW_VARIATION_RAD = Math.PI / 90; // 2 degrees
/**
 * Per-particle mobility (inverse mass) range.  At wake / recycle each particle is
 * randomly assigned a mass so it is propelled anywhere from 75 % as easily (more
 * inertia, moves less) to 150 % as easily (less inertia, propelled faster and
 * further) as the raw velocity field would otherwise carry it.
 */
const PARTICLE_MOBILITY_MIN   = 0.75;
const PARTICLE_MOBILITY_MAX   = 1.5;
function _randMobility(): number {
  return PARTICLE_MOBILITY_MIN + Math.random() * (PARTICLE_MOBILITY_MAX - PARTICLE_MOBILITY_MIN);
}

// ── Colour helpers ─────────────────────────────────────────────────────────────
/** Minimum RGB magnitude (0–255 space) for the dye field to influence a particle's colour. */
const MIN_DYE_MAG_FOR_BLEND  = 8.0;
/** RGB delta below which a colour is considered near-grey for hue-bucket assignment. */
const HUE_GREY_THRESHOLD     = 8;
/** Hue-bucket index used when RGB is near-grey (maps to ~210° violet for visual appeal). */
const HUE_GREY_BUCKET        = 7;
/** Default initial particle colour channels (R, G, B: 0–255) — deep space blue. */
const INITIAL_PARTICLE_R     =  60;
const INITIAL_PARTICLE_G     =  80;
const INITIAL_PARTICLE_B     = 200;

// ── Force injection ───────────────────────────────────────────────────────────
/** Gaussian σ (grid cells) for force / colour splats. */
const FORCE_SIGMA_CELLS   = 2.0;
const FORCE_TWO_SIGMA_SQ  = 2.0 * FORCE_SIGMA_CELLS * FORCE_SIGMA_CELLS;
/** Max injected velocity magnitude (grid cells / s). */
const MAX_INJECT_VEL      = 20.0;

// ── Particle lifecycle ────────────────────────────────────────────────────────
/** Cells beyond the grid boundary before a particle is recycled. */
const OOB_MARGIN_CELLS     = 2;
/** Relative size change that triggers a full reset on resize. */
const RESIZE_THRESHOLD_FR  = 0.06;

// ── Colour batching (approach from Thero EulerFluidEffect) ───────────────────
/**
 * Number of alpha buckets.  Trail segments are sorted into buckets by their
 * combined (trail-age × speed) alpha level, allowing at most
 * HUE_STEPS × ALPHA_BUCKETS canvas state changes per frame.
 */
const ALPHA_BUCKETS = 5;
/** Hue is quantised into 12 × 30° buckets spanning the full 360° wheel. */
const HUE_STEPS     = 12;

// Pre-allocated draw-batch arrays: [hueIdx][alphaIdx] → flat [x1,y1,x2,y2,…]
const _batches: number[][][] = Array.from(
  { length: HUE_STEPS },
  () => Array.from({ length: ALPHA_BUCKETS }, () => []),
);

// ── Internal math ─────────────────────────────────────────────────────────────
function _clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Smooth-step — C1 continuous, maps [0,1] → [0,1]. */
function _smoothstep(t: number): number {
  const c = _clamp(t, 0, 1);
  return c * c * (3.0 - 2.0 * c);
}

/** Convert linear RGB (0–255) to a hue bucket index [0 … HUE_STEPS). */
function _hueBucket(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d   = max - min;
  if (d < HUE_GREY_THRESHOLD) return HUE_GREY_BUCKET;
  let h: number;
  if (max === r)      h = ((g - b) / d + 6.0) % 6.0;
  else if (max === g) h = (b - r) / d + 2.0;
  else                h = (r - g) / d + 4.0;
  return Math.floor(h / 6.0 * HUE_STEPS) % HUE_STEPS;
}

/**
 * Bilinear interpolation into a flat FLUID_COLS × FLUID_ROWS Float32Array.
 * @param u  fractional column (x in grid space)
 * @param v  fractional row   (y in grid space)
 */
function _bilerp(arr: Float32Array, u: number, v: number): number {
  const xi = Math.floor(u);
  const yi = Math.floor(v);
  const fx = u - xi;
  const fy = v - yi;
  const c0 = _clamp(xi,     0, FLUID_COLS - 1);
  const c1 = _clamp(xi + 1, 0, FLUID_COLS - 1);
  const r0 = _clamp(yi,     0, FLUID_ROWS - 1);
  const r1 = _clamp(yi + 1, 0, FLUID_ROWS - 1);
  return (
    (arr[r0 * FLUID_COLS + c0] * (1 - fx) + arr[r0 * FLUID_COLS + c1] * fx) * (1 - fy) +
    (arr[r1 * FLUID_COLS + c0] * (1 - fx) + arr[r1 * FLUID_COLS + c1] * fx) * fy
  );
}

// ── Particle ──────────────────────────────────────────────────────────────────
interface FluidParticle {
  /** Position in grid space (fractional column and row). */
  x: number;
  y: number;
  /** Ring-buffer trail positions in grid space. */
  trailX: Float32Array;
  trailY: Float32Array;
  trailHead:  number;
  trailCount: number;
  /** Exponentially-smoothed particle speed (grid cells / s) — used for colour blending. */
  smoothedSpeed: number;
  /** Current hue bucket [0 … HUE_STEPS). */
  hueIdx: number;
  /** Normalised RGB colour (0–255) sampled from the dye field. */
  r: number;
  g: number;
  b: number;
  // ── Lifecycle fields ────────────────────────────────────────────────────────
  /** Whether this particle has been woken by a disturbance and is in its visible phase. */
  isActive:      boolean;
  /** Seconds elapsed since this particle was last woken. */
  ageSec:        number;
  /** Total visible duration (seconds) assigned at wake time. */
  lifetimeSec:   number;
  /** 0–1 activation strength set at wake based on disturbance speed. */
  activation:    number;
  /** Per-particle alpha variation (0.7–1.0) — prevents synchronised fade-outs. */
  maxAlphaScale: number;
  /** Tiny per-particle steering offset so disturbed particles do not stack exactly. */
  flowAngleOffset: number;
  /**
   * Inverse-mass factor (0.75–1.5) applied to the advecting velocity so heavier
   * particles resist the flow and lighter ones are flung further.
   */
  mobility: number;
}

function _makeParticle(): FluidParticle {
  return {
    x: Math.random() * FLUID_COLS,
    y: Math.random() * FLUID_ROWS,
    trailX: new Float32Array(TRAIL_LENGTH),
    trailY: new Float32Array(TRAIL_LENGTH),
    trailHead: 0,
    trailCount: 0,
    smoothedSpeed: 0,
    hueIdx: Math.floor(Math.random() * HUE_STEPS),
    r: INITIAL_PARTICLE_R,
    g: INITIAL_PARTICLE_G,
    b: INITIAL_PARTICLE_B,
    // Lifecycle — dormant until woken by a force disturbance.
    isActive:      false,
    ageSec:        0.0,
    lifetimeSec:   PARTICLE_MIN_LIFETIME_SEC,
    activation:    0.0,
    maxAlphaScale: 0.7 + Math.random() * 0.3,
    flowAngleOffset: (Math.random() * 2 - 1) * PARTICLE_FLOW_VARIATION_RAD,
    mobility: _randMobility(),
  };
}

// ── Public API types ───────────────────────────────────────────────────────────

/**
 * A single directional force and colour impulse to inject this frame.
 * All positions and velocities are in world-space units.
 */
export interface FluidImpulse {
  /** World-space position. */
  x: number;
  y: number;
  /** Velocity in world units per second. */
  vx: number;
  vy: number;
  /** Source colour (0–255 per channel). */
  r: number;
  g: number;
  b: number;
  /** Force multiplier — 1.0 for normal entity motion; higher for impacts. */
  strength?: number;
}

export interface SpaceFluid {
  /** Update internal cell-size when the canvas dimensions change. */
  resize(widthPx: number, heightPx: number): void;
  /** Anchor the local fluid grid to the current camera view. */
  setView(centerX: number, centerY: number, zoom: number): void;
  /**
   * Inject a directional force and colour impulse at a world-space position.
   * Call once per active entity per frame.
   */
  addForce(impulse: FluidImpulse): void;
  /**
   * Inject a radial outward explosion at world-space (x, y).
   * Used for AoE attacks, enemy deaths, and impact events.
   */
  addExplosion(
    x: number,
    y: number,
    strength: number,
    r: number,
    g: number,
    b: number,
  ): void;
  /** Advance the simulation by deltaMs milliseconds. */
  step(deltaMs: number): void;
  /**
   * Render the fluid as a background layer.
   * Must be called after the canvas has been cleared and before entities are drawn.
   */
  render(ctx: CanvasRenderingContext2D): void;
  /** Clear all grid and particle state (call on restart). */
  reset(): void;
  /**
   * Toggle low-graphics mode.
   * High graphics uses 3× more particles for a denser fluid background.
   */
  setLowGraphicsMode(enabled: boolean): void;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createSpaceFluid(): SpaceFluid {
  let widthPx  = 320;
  let heightPx = 568;
  let zoomPxPerWorld = 1;
  let originWorldX = -widthPx * 0.5;
  let originWorldY = -heightPx * 0.5;
  let cellW    = widthPx  / FLUID_COLS;
  let cellH    = heightPx / FLUID_ROWS;

  // ── Grid arrays (all Float32, flat row-major) ───────────────────────────────
  const vxGrid = new Float32Array(FLUID_SIZE);
  const vyGrid = new Float32Array(FLUID_SIZE);
  // Dye: accumulated, not normalised — decays alongside velocity.
  const dyeR   = new Float32Array(FLUID_SIZE);
  const dyeG   = new Float32Array(FLUID_SIZE);
  const dyeB   = new Float32Array(FLUID_SIZE);
  // Scratch buffers for the diffusion pass (avoids separate allocation per frame).
  const tmpVx  = new Float32Array(FLUID_SIZE);
  const tmpVy  = new Float32Array(FLUID_SIZE);

  // ── Particle pool ───────────────────────────────────────────────────────────
  let currentParticleCount = PARTICLE_COUNT_HIGH; // default: high graphics
  let particles: FluidParticle[] = [];
  for (let i = 0; i < currentParticleCount; i++) particles.push(_makeParticle());

  // ── Sparse occupancy grid (pre-allocated, rebuilt each step) ─────────────────
  // Maps coarse cells → particle count.  Used to steer lifecycle-expired
  // particles toward underpopulated regions without O(n²) nearest-neighbour checks.
  const _occupancy  = new Int16Array(SPARSE_RESPAWN_COLS * SPARSE_RESPAWN_ROWS);
  const _sparseCellW = FLUID_COLS / SPARSE_RESPAWN_COLS;
  const _sparseCellH = FLUID_ROWS / SPARSE_RESPAWN_ROWS;

  // ── Coordinate helpers ──────────────────────────────────────────────────────
  function _toGX(wx: number): number { return (wx - originWorldX) / cellW; }
  function _toGY(wy: number): number { return (wy - originWorldY) / cellH; }
  function _toScreenX(gx: number): number { return (gx * cellW) * zoomPxPerWorld; }
  function _toScreenY(gy: number): number { return (gy * cellH) * zoomPxPerWorld; }

  function _rebaseParticles(
    prevOriginX: number,
    prevOriginY: number,
    prevCellW: number,
    prevCellH: number,
  ): void {
    for (const p of particles) {
      const worldX = prevOriginX + p.x * prevCellW;
      const worldY = prevOriginY + p.y * prevCellH;
      p.x = _toGX(worldX);
      p.y = _toGY(worldY);
      for (let i = 0; i < p.trailCount; i++) {
        const idx = (p.trailHead - p.trailCount + i + TRAIL_LENGTH) % TRAIL_LENGTH;
        p.trailX[idx] = _toGX(prevOriginX + p.trailX[idx] * prevCellW);
        p.trailY[idx] = _toGY(prevOriginY + p.trailY[idx] * prevCellH);
      }
    }
  }

  // ── Force splat ─────────────────────────────────────────────────────────────
  /**
   * Add a Gaussian-weighted velocity and colour impulse centred on grid
   * position (gx, gy).  All neighbouring cells within ≈ 1.5σ are affected.
   */
  function _splat(
    gx: number, gy: number,
    gvx: number, gvy: number,
    gr: number,  gg: number, gb: number,
    strength: number,
  ): void {
    const span = Math.ceil(FORCE_SIGMA_CELLS * 1.6);
    const col0 = Math.max(0, Math.floor(gx) - span);
    const col1 = Math.min(FLUID_COLS - 1, Math.ceil(gx) + span);
    const row0 = Math.max(0, Math.floor(gy) - span);
    const row1 = Math.min(FLUID_ROWS - 1, Math.ceil(gy) + span);

    for (let row = row0; row <= row1; row++) {
      for (let col = col0; col <= col1; col++) {
        const dx  = col - gx;
        const dy  = row - gy;
        const w   = Math.exp(-(dx * dx + dy * dy) / FORCE_TWO_SIGMA_SQ) * strength;
        const idx = row * FLUID_COLS + col;
        vxGrid[idx] += gvx * w;
        vyGrid[idx] += gvy * w;
        dyeR[idx]   += gr  * w;
        dyeG[idx]   += gg  * w;
        dyeB[idx]   += gb  * w;
      }
    }
  }

  // ── Velocity diffusion ──────────────────────────────────────────────────────
  /**
   * One pass of a 5-point Laplacian diffusion with blend factor `mix`.
   * Smooths the velocity field so particle trails look fluid rather than
   * blocky.  The dye field is left undiffused to preserve colour sharpness.
   */
  function _diffuseVelocity(mix: number): void {
    for (let row = 0; row < FLUID_ROWS; row++) {
      for (let col = 0; col < FLUID_COLS; col++) {
        const i  = row * FLUID_COLS + col;
        const il = col > 0            ? i - 1          : i;
        const ir = col < FLUID_COLS-1 ? i + 1          : i;
        const iu = row > 0            ? i - FLUID_COLS : i;
        const id = row < FLUID_ROWS-1 ? i + FLUID_COLS : i;
        tmpVx[i] = vxGrid[i] * (1 - mix) + (vxGrid[il] + vxGrid[ir] + vxGrid[iu] + vxGrid[id]) * (mix * 0.25);
        tmpVy[i] = vyGrid[i] * (1 - mix) + (vyGrid[il] + vyGrid[ir] + vyGrid[iu] + vyGrid[id]) * (mix * 0.25);
      }
    }
    vxGrid.set(tmpVx);
    vyGrid.set(tmpVy);
  }

  // ── Sparse respawn helper ───────────────────────────────────────────────────
  /**
   * Return the index in _occupancy with the lowest particle count.
   * A random start offset breaks ties so consecutive respawns scatter
   * rather than always targeting the same cell.  O(140) — negligible cost.
   */
  function _findSparseCell(): number {
    const n      = _occupancy.length;
    const offset = Math.floor(Math.random() * n);
    let minVal   = 32767;
    let minIdx   = 0;
    for (let k = 0; k < n; k++) {
      const i = (offset + k) % n;
      if (_occupancy[i] < minVal) {
        minVal = _occupancy[i];
        minIdx = i;
      }
    }
    return minIdx;
  }

  // ── Public methods ──────────────────────────────────────────────────────────

  function resize(w: number, h: number): void {
    const prevW = widthPx, prevH = heightPx;
    widthPx  = w;
    heightPx = h;
    cellW = (w / zoomPxPerWorld) / FLUID_COLS;
    cellH = (h / zoomPxPerWorld) / FLUID_ROWS;
    const rw = Math.abs(w - prevW) / (prevW + 1);
    const rh = Math.abs(h - prevH) / (prevH + 1);
    if (rw > RESIZE_THRESHOLD_FR || rh > RESIZE_THRESHOLD_FR) {
      reset();
    }
  }

  function setView(centerX: number, centerY: number, zoom: number): void {
    const prevOriginX = originWorldX;
    const prevOriginY = originWorldY;
    const prevCellW = cellW;
    const prevCellH = cellH;
    zoomPxPerWorld = Math.max(0.05, zoom);
    const viewW = widthPx / zoomPxPerWorld;
    const viewH = heightPx / zoomPxPerWorld;
    originWorldX = centerX - viewW * 0.5;
    originWorldY = centerY - viewH * 0.5;
    cellW = viewW / FLUID_COLS;
    cellH = viewH / FLUID_ROWS;
    _rebaseParticles(prevOriginX, prevOriginY, prevCellW, prevCellH);
  }

  function addForce(impulse: FluidImpulse): void {
    const gx     = _toGX(impulse.x);
    const gy     = _toGY(impulse.y);
    const str    = impulse.strength ?? 1.0;
    // Convert screen px/s → grid cells/s, then cap magnitude.
    const gvxRaw = (impulse.vx / cellW) * 0.25;
    const gvyRaw = (impulse.vy / cellH) * 0.25;
    const gspd   = Math.sqrt(gvxRaw * gvxRaw + gvyRaw * gvyRaw);
    const scale  = gspd > MAX_INJECT_VEL ? MAX_INJECT_VEL / gspd : 1.0;
    // Exponential (quadratic) dropoff: slow movements barely disturb the
    // fluid, fast movements disturb it proportionally more.  This prevents
    // even tiny entity displacements from sending fluid particles flying.
    const normSpd     = _clamp(gspd / MAX_INJECT_VEL, 0, 1);
    const speedFactor = normSpd * normSpd;
    _splat(gx, gy, gvxRaw * scale, gvyRaw * scale, impulse.r, impulse.g, impulse.b, str * speedFactor);
  }

  function addExplosion(
    x: number, y: number,
    strength: number,
    r: number, g: number, b: number,
  ): void {
    const gx     = _toGX(x);
    const gy     = _toGY(y);
    const blastR = FORCE_SIGMA_CELLS * 1.8;
    // Eight evenly-spaced radial jets plus a central colour injection.
    for (let k = 0; k < 8; k++) {
      const angle = (k / 8) * Math.PI * 2;
      const cos   = Math.cos(angle);
      const sin   = Math.sin(angle);
      const ox    = gx + cos * blastR * 0.35;
      const oy    = gy + sin * blastR * 0.35;
      _splat(ox, oy, cos * MAX_INJECT_VEL * 0.75, sin * MAX_INJECT_VEL * 0.75, r, g, b, strength * 0.45);
    }
    // Centre injection carries the colour but minimal velocity.
    _splat(gx, gy, 0, 0, r, g, b, strength);
  }

  function step(deltaMs: number): void {
    const dt = Math.min(deltaMs / 1000.0, 0.1); // seconds, safety-capped

    // 1. Decay velocity and dye.
    const velFactor = Math.pow(VEL_RETAIN_PER_SEC, dt);
    const dyeFactor = Math.pow(DYE_RETAIN_PER_SEC, dt);
    for (let i = 0; i < FLUID_SIZE; i++) {
      vxGrid[i] *= velFactor;
      vyGrid[i] *= velFactor;
      dyeR[i]   *= dyeFactor;
      dyeG[i]   *= dyeFactor;
      dyeB[i]   *= dyeFactor;
    }

    // 2. Clamp to prevent runaway accumulation from overlapping sources.
    for (let i = 0; i < FLUID_SIZE; i++) {
      const spd = Math.sqrt(vxGrid[i] * vxGrid[i] + vyGrid[i] * vyGrid[i]);
      if (spd > MAX_GRID_VEL) {
        const inv = MAX_GRID_VEL / spd;
        vxGrid[i] *= inv;
        vyGrid[i] *= inv;
      }
    }

    // 3. Light diffusion — smooths velocity for fluid-looking trails.
    _diffuseVelocity(0.09);

    // 4. Advect tracer particles through the velocity field using a
    //    lifecycle/activation model.
    //
    //    Each particle is dormant until meaningfully disturbed (speed > PARTICLE_WAKE_SPEED).
    //    On wake, it receives an activation strength (0–1, nonlinear in disturbance speed)
    //    and a finite lifetime proportional to that activation.  Trail opacity fades from
    //    activation → 0 over the lifetime.  When the lifetime expires or the particle
    //    leaves the grid, it is recycled into a sparse region of the coarse occupancy
    //    grid so the pool redistributes naturally rather than clustering in old
    //    high-activity areas.  No teleport streaks: trailCount is cleared on recycle.

    // Rebuild coarse occupancy from current particle positions.
    // Recycled particles increment the target cell so consecutive respawns scatter.
    _occupancy.fill(0);
    for (let i = 0; i < particles.length; i++) {
      const oCol = _clamp(Math.floor(particles[i].x / _sparseCellW), 0, SPARSE_RESPAWN_COLS - 1);
      const oRow = _clamp(Math.floor(particles[i].y / _sparseCellH), 0, SPARSE_RESPAWN_ROWS - 1);
      _occupancy[oRow * SPARSE_RESPAWN_COLS + oCol]++;
    }

    for (let i = 0; i < particles.length; i++) {
      const p  = particles[i];
      const rawVx = _bilerp(vxGrid, p.x, p.y);
      const rawVy = _bilerp(vyGrid, p.x, p.y);
      const cosVar = Math.cos(p.flowAngleOffset);
      const sinVar = Math.sin(p.flowAngleOffset);
      // Per-particle inverse mass: lighter particles are propelled further/faster
      // by the same field velocity, heavier ones resist it.
      const vx = (rawVx * cosVar - rawVy * sinVar) * p.mobility;
      const vy = (rawVx * sinVar + rawVy * cosVar) * p.mobility;

      // Euler-integrate position in grid space.
      p.x += vx * dt;
      p.y += vy * dt;

      const spd = Math.sqrt(vx * vx + vy * vy);

      // ── Lifecycle: wake or re-boost on meaningful disturbance ─────────────
      // activation = clamp((speed − wakeSpeed) / usefulRange, 0, 1)^power
      // so tiny movement produces dim, short-lived trails while fast
      // movement produces bright, long-lived trails.
      if (spd > PARTICLE_WAKE_SPEED) {
        const t      = _clamp(
          (spd - PARTICLE_WAKE_SPEED) / (PARTICLE_FULL_ACT_SPEED - PARTICLE_WAKE_SPEED),
          0, 1,
        );
        const rawAct = Math.pow(t, PARTICLE_ACTIVATION_POWER);

        if (!p.isActive) {
          // Fresh wake from dormancy.
          p.isActive   = true;
          p.ageSec     = 0.0;
          p.activation = rawAct;
          // Lifetime scales with activation; per-particle jitter prevents
          // all nearby particles from fading out simultaneously.
          const baseLife = PARTICLE_MIN_LIFETIME_SEC +
            rawAct * (PARTICLE_MAX_LIFETIME_SEC - PARTICLE_MIN_LIFETIME_SEC);
          p.lifetimeSec  = baseLife * (0.8 + Math.random() * 0.4);
        } else {
          // Re-disturbance while already active: boost activation and extend life.
          const boosted = _clamp(p.activation + rawAct * PARTICLE_REWAKE_BOOST, 0, 1);
          if (boosted > p.activation) {
            p.activation  = boosted;
            const remaining = Math.max(0, p.lifetimeSec - p.ageSec);
            p.lifetimeSec = p.ageSec + Math.min(
              PARTICLE_MAX_LIFETIME_SEC * boosted,
              remaining + PARTICLE_MIN_LIFETIME_SEC,
            );
          }
        }
      }

      // Advance visible-life timer for active particles.
      if (p.isActive) p.ageSec += dt;

      // ── Colour blending (retained from original model) ───────────────────
      p.smoothedSpeed += (spd - p.smoothedSpeed) * SPEED_SMOOTH_ALPHA;
      if (spd > PARTICLE_WAKE_SPEED) {
        const sr  = _bilerp(dyeR, p.x, p.y);
        const sg  = _bilerp(dyeG, p.x, p.y);
        const sb  = _bilerp(dyeB, p.x, p.y);
        const mag = Math.sqrt(sr * sr + sg * sg + sb * sb);
        if (mag > MIN_DYE_MAG_FOR_BLEND) {
          const inv   = 255.0 / mag;
          // Stronger speed → faster colour adoption; preserves vividness.
          const blend = _clamp(spd / (SPEED_FULL_OPACITY * 2.0), 0, 1) * 0.3;
          p.r += (sr * inv - p.r) * blend;
          p.g += (sg * inv - p.g) * blend;
          p.b += (sb * inv - p.b) * blend;
          p.hueIdx = _hueBucket(p.r, p.g, p.b);
        }
      }

      // Record trail in ring buffer.
      p.trailX[p.trailHead] = p.x;
      p.trailY[p.trailHead] = p.y;
      p.trailHead = (p.trailHead + 1) % TRAIL_LENGTH;
      if (p.trailCount < TRAIL_LENGTH) p.trailCount++;

      // ── Recycle if out of bounds or lifetime expired ──────────────────────
      const oob     = p.x < -OOB_MARGIN_CELLS || p.x > FLUID_COLS + OOB_MARGIN_CELLS ||
                      p.y < -OOB_MARGIN_CELLS || p.y > FLUID_ROWS + OOB_MARGIN_CELLS;
      const expired = p.isActive && p.ageSec >= p.lifetimeSec;

      if (oob || expired) {
        // Move to an underpopulated coarse cell — prevents density clustering.
        const cellIdx = _findSparseCell();
        const sx = cellIdx % SPARSE_RESPAWN_COLS;
        const sy = Math.floor(cellIdx / SPARSE_RESPAWN_COLS);
        p.x           = (sx + 0.1 + Math.random() * 0.8) * _sparseCellW;
        p.y           = (sy + 0.1 + Math.random() * 0.8) * _sparseCellH;
        p.trailCount  = 0; // clear trail — no teleport streak
        p.trailHead   = 0;
        p.isActive    = false;
        p.ageSec      = 0.0;
        p.activation  = 0.0;
        p.smoothedSpeed = 0.0;
        p.maxAlphaScale = 0.7 + Math.random() * 0.3;
        p.flowAngleOffset = (Math.random() * 2 - 1) * PARTICLE_FLOW_VARIATION_RAD;
        _occupancy[cellIdx]++;
        // Preserve colour so the palette does not abruptly reset.
        continue;
      }
    }
  }

  function render(ctx: CanvasRenderingContext2D): void {
    // Clear all batch arrays (pre-allocated, so no GC pressure).
    for (let h = 0; h < HUE_STEPS; h++) {
      for (let a = 0; a < ALPHA_BUCKETS; a++) {
        _batches[h][a].length = 0;
      }
    }

    // Bin every trail segment into its (hueIdx, alphaBucket) slot.
    // opacityScale fuses activation strength, lifetime fade, and per-particle
    // alpha variation so the bucket captures the full visible range.
    for (let pi = 0; pi < particles.length; pi++) {
      const p = particles[pi];
      // Skip dormant or invisibly new particles.
      if (!p.isActive || p.trailCount < 2) continue;

      // Opacity = activation × smoothstepped lifetime fade × per-particle scale.
      // Slow disturbances produce faint, short trails; fast ones are vivid and longer.
      const lifeFrac     = _clamp(1.0 - p.ageSec / p.lifetimeSec, 0, 1);
      const opacityScale = p.activation * _smoothstep(lifeFrac) * p.maxAlphaScale;
      if (opacityScale < 0.02) continue;

      const hue = p.hueIdx;
      const n   = p.trailCount;

      for (let j = 1; j < n; j++) {
        // Combined alpha = (trail-age fraction) × (activation/lifetime) × peak
        const ageFrac  = j / n;
        const bkt = _clamp(Math.floor(ageFrac * opacityScale * ALPHA_BUCKETS), 0, ALPHA_BUCKETS - 1);
        const prev = (p.trailHead - n + j - 1 + TRAIL_LENGTH) % TRAIL_LENGTH;
        const curr = (p.trailHead - n + j     + TRAIL_LENGTH) % TRAIL_LENGTH;
        const arr  = _batches[hue][bkt];
        // Store camera-relative screen-space coordinates.
        arr.push(
          _toScreenX(p.trailX[prev]), _toScreenY(p.trailY[prev]),
          _toScreenX(p.trailX[curr]), _toScreenY(p.trailY[curr]),
        );
      }
    }

    // Issue one compound stroke per non-empty (hue, bucket) pair —
    // at most HUE_STEPS × ALPHA_BUCKETS = 60 state changes per frame.
    ctx.save();
    ctx.lineCap   = 'round';
    ctx.lineJoin  = 'round';
    const cinematicLevel = getCinematicLevel();
    ctx.lineWidth = TRAIL_LINE_WIDTH * (cinematicLevel >= 2 ? 1.35 : 1);

    for (let h = 0; h < HUE_STEPS; h++) {
      const hueDeg = h * 30;
      for (let b = 0; b < ALPHA_BUCKETS; b++) {
        const arr = _batches[h][b];
        if (arr.length === 0) continue;

        // Alpha for this bucket: linearly spaced from (1/ALPHA_BUCKETS) up to 1,
        // then scaled by TRAIL_PEAK_ALPHA.
        const alpha = Math.min(0.95, ((b + 1) / ALPHA_BUCKETS) * TRAIL_PEAK_ALPHA * (cinematicLevel >= 2 ? 1.45 : 1));
        ctx.strokeStyle = `hsla(${hueDeg},82%,66%,${alpha.toFixed(3)})`;
        ctx.beginPath();
        for (let k = 0; k < arr.length; k += 4) {
          ctx.moveTo(arr[k],     arr[k + 1]);
          ctx.lineTo(arr[k + 2], arr[k + 3]);
        }
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  function reset(): void {
    vxGrid.fill(0);
    vyGrid.fill(0);
    dyeR.fill(0);
    dyeG.fill(0);
    dyeB.fill(0);
    particles = [];
    for (let i = 0; i < currentParticleCount; i++) particles.push(_makeParticle());
  }

  function setLowGraphicsMode(enabled: boolean): void {
    const newCount = enabled ? PARTICLE_COUNT_LOW : PARTICLE_COUNT_HIGH;
    if (newCount === currentParticleCount) return;
    currentParticleCount = newCount;
    if (newCount > particles.length) {
      // Add particles, inheriting the colour of a random existing particle so
      // the palette doesn't abruptly reset on the newly-added entries.
      const source = particles[0];
      for (let i = particles.length; i < newCount; i++) {
        const np = _makeParticle();
        if (source) { np.r = source.r; np.g = source.g; np.b = source.b; np.hueIdx = source.hueIdx; }
        particles.push(np);
      }
    } else {
      // Shed excess particles; no need to reset the grid.
      particles.length = newCount;
    }
  }

  return { resize, setView, addForce, addExplosion, step, render, reset, setLowGraphicsMode };
}
