/** Particle system for Sign99 */

import { Vec2, randomRange } from './math.js';
import { Camera } from './camera.js';
import { Team } from './entities.js';
import { Colors, colorToCSS, Color } from './colors.js';
import { renderBudget } from './renderBudget.js';

// ---------------------------------------------------------------------------
// Effect budget constants
// ---------------------------------------------------------------------------

/** Maximum sparks emitted per impact (scaled by particleScale). */
const IMPACT_SPARK_COUNT = 6;
/** Maximum small outward sparks emitted when a building takes damage. */
const BUILDING_DAMAGE_SPARK_COUNT = 5;
/** Maximum sparks emitted per muzzle flash (scaled by particleScale). */
const MUZZLE_SPARK_COUNT = 3;
/** Share of player thrust particles that should originate from the ship rear. */
const REAR_ENGINE_EXHAUST_CHANCE = 0.75;

// ---------------------------------------------------------------------------
// Single particle
// ---------------------------------------------------------------------------

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: Color;
  alpha: number;
  life: number;
  maxLife: number;
  size: number;
  active: boolean;
  /**
   * When true the particle is rendered with additive blending
   * (`globalCompositeOperation = 'lighter'`) so overlapping hot particles
   * bloom into bright white cores — essential for convincing explosions and
   * energy sparks in a space setting.
   */
  additive: boolean;
  /**
   * When true this particle is an engine exhaust/thrust particle.
   * Exhaust particles are drawn in a separate underlay pass (before ship
   * bodies) so the thrust visually sits behind the ship silhouette.
   */
  isExhaust: boolean;
}

interface FloatingText {
  text: string;
  pos: Vec2;
  vel: Vec2;
  color: Color;
  life: number;
  maxLife: number;
}

// ---------------------------------------------------------------------------
// Object pool — active-list design
// ---------------------------------------------------------------------------

const POOL_SIZE = 4096;

function createParticle(): Particle {
  return {
    x: 0, y: 0,
    vx: 0, vy: 0,
    color: Colors.particles_explosion1,
    alpha: 1,
    life: 0,
    maxLife: 1,
    size: 2,
    active: false,
    additive: false,
    isExhaust: false,
  };
}

function lightenColor(color: Color, amount: number): Color {
  const t = Math.min(1, Math.max(0, amount));
  return {
    r: color.r + (255 - color.r) * t,
    g: color.g + (255 - color.g) * t,
    b: color.b + (255 - color.b) * t,
    intensity: color.intensity,
  };
}

// ---------------------------------------------------------------------------
// ParticleSystem
// ---------------------------------------------------------------------------

export class ParticleSystem {
  private pool: Particle[];
  private floatingTexts: FloatingText[] = [];

  /**
   * Indices of active particles.  Maintained by acquire() and update().
   * Drawing and updating iterate this list instead of the full pool.
   */
  private activeIndices: number[];

  /**
   * Stack of free (inactive) pool indices.  acquire() pops O(1);
   * update() pushes dead indices back.
   */
  private freeStack: number[];

  /**
   * Fraction (0–1) of the full particle budget to emit.  Controlled by the
   * active visual-quality preset via {@link setParticleScale}.
   */
  private _particleScale: number = 1;

  /**
   * Additional performance-based scale applied on top of _particleScale.
   * Set via {@link setAdaptiveScale}; default 1 (no reduction).
   */
  private _performanceScale: number = 1;

  // --- Per-frame stats (reset at the start of each draw call) ---

  /** Number of currently active (live) particles. */
  activeCount: number = 0;
  /** Number of particles drawn last frame. */
  drawnCount: number = 0;
  /** Number of particles culled (viewport) last frame. */
  culledCount: number = 0;
  /** Number of particles emitted since the last update(). */
  emittedThisFrame: number = 0;
  /** Number of active particles that were recycled this frame. */
  recycledCount: number = 0;
  /** Total pool capacity. */
  readonly poolCapacity: number = POOL_SIZE;

  constructor() {
    this.pool = Array.from({ length: POOL_SIZE }, createParticle);
    // Pre-fill the free stack (reversed so index 0 is popped first)
    this.freeStack = Array.from({ length: POOL_SIZE }, (_, i) => POOL_SIZE - 1 - i);
    this.activeIndices = [];
  }

  /**
   * Set the quality scale that governs how many particles are spawned for
   * expensive emitters (explosions, sparks).  1 = full quality; 0.35 = low.
   */
  setParticleScale(scale: number): void {
    this._particleScale = Math.max(0.1, Math.min(1, scale));
  }

  /**
   * Set the adaptive performance scale (0.35–1.0).  Combined multiplicatively
   * with the quality particleScale.  Call this from the render budget update.
   */
  setAdaptiveScale(scale: number): void {
    this._performanceScale = Math.max(0.2, Math.min(1, scale));
  }

  /** Combined emission scale = quality × adaptive. */
  private get _effectiveScale(): number {
    return this._particleScale * this._performanceScale;
  }

  /**
   * Acquire one particle from the pool in O(1).
   * If the pool is full, recycles an existing active particle (oldest-ish).
   */
  private acquire(): Particle {
    if (this.freeStack.length > 0) {
      const idx = this.freeStack.pop()!;
      this.activeIndices.push(idx);
      this.emittedThisFrame++;
      const p = this.pool[idx];
      p.isExhaust = false;
      return p;
    }
    // Pool full — recycle the first active particle (arbitrary position in the active list, not guaranteed oldest)
    const idx = this.activeIndices[0];
    this.recycledCount++;
    this.emittedThisFrame++;
    const p = this.pool[idx];
    p.isExhaust = false;
    return p;
  }

  // --- Emitters ---

  emitExhaust(
    pos: Vec2,
    angle: number,
    _team: Team,
    options: {
      speedFraction?: number;
      scaleSizeWithSpeed?: boolean;
      varyLightness?: boolean;
      isBoosting?: boolean;
      facingAngle?: number;
    } = {},
  ): void {
    const isBoosting = options.isBoosting ?? false;
    // Warm thrust colour palette — randomly sampled for each particle.
    const warmPalette: Color[] = [
      Colors.thrust_warm_yellow,
      Colors.thrust_warm_orange,
      Colors.thrust_burnt_orange,
      Colors.thrust_deep_red,
    ];
    // Occasional white-hot core burst at high intensity (fast or boosting).
    const speedFraction = Math.min(1, Math.max(0, options.speedFraction ?? 0));
    const coreChance = speedFraction * (isBoosting ? 0.55 : 0.25);

    const count = isBoosting ? 3 : 2;
    // Boost increases spread (more chaos), size, speed, and lifetime.
    const boostSpreadMult   = isBoosting ? 2.0 : 1.0;
    const boostSizeMult     = isBoosting ? 1.55 : 1.0;
    const boostSpeedMult    = isBoosting ? 1.35 : 1.0;
    const boostLifeMult     = isBoosting ? 1.4  : 1.0;

    // Even at top speed keep some randomized spread so exhaust isn't a rigid line.
    const spreadRange = (0.09 + 0.28 * (1 - speedFraction)) * boostSpreadMult;
    const sizeScale = options.scaleSizeWithSpeed ? 0.2 + 0.8 * speedFraction : 1;
    const inputBackAngle = angle + Math.PI;
    const hasFacingAngle = Number.isFinite(options.facingAngle);
    const rearBackAngle = hasFacingAngle ? options.facingAngle! + Math.PI : inputBackAngle;

    for (let i = 0; i < count; i++) {
      const p = this.acquire();
      p.active    = true;
      p.isExhaust = true;
      p.additive  = true;

      const useRearEngine = hasFacingAngle && Math.random() < REAR_ENGINE_EXHAUST_CHANCE;
      const exhaustAngle = useRearEngine ? rearBackAngle : inputBackAngle;

      // Rear-engine particles stay anchored to the ship's physical nozzle;
      // input particles keep the existing directional feedback plume.
      const nozzleDist = useRearEngine
        ? randomRange(5, 9)
        : 3 + Math.random() * 3;
      const lateralJitter = useRearEngine ? randomRange(-2.2, 2.2) : 0;
      const lateralAngle = exhaustAngle + Math.PI / 2;
      p.x = pos.x + Math.cos(exhaustAngle) * nozzleDist + Math.cos(lateralAngle) * lateralJitter;
      p.y = pos.y + Math.sin(exhaustAngle) * nozzleDist + Math.sin(lateralAngle) * lateralJitter;

      const spread = randomRange(-spreadRange, spreadRange);
      const spd = randomRange(35, 90) * boostSpeedMult;
      p.vx = Math.cos(exhaustAngle + spread) * spd;
      p.vy = Math.sin(exhaustAngle + spread) * spd;

      // Select warm colour — occasional white-hot core
      if (Math.random() < coreChance) {
        p.color = Colors.thrust_core_hot;
      } else {
        const c = warmPalette[Math.floor(Math.random() * warmPalette.length)];
        p.color = options.varyLightness ? lightenColor(c, randomRange(0, 0.25)) : c;
      }

      p.alpha   = isBoosting ? 0.92 : 0.78;
      p.life    = randomRange(0.22, 0.55) * boostLifeMult;
      p.maxLife = p.life;
      p.size    = randomRange(1.2, 2.8) * sizeScale * boostSizeMult * 0.5;
    }
  }

  /**
   * Emit thruster particles from the side of a ship when strafing.
   * @param pos      World position of the ship centre
   * @param angle    Facing angle of the ship (radians)
   * @param sideSign -1 = strafing left (right-side thruster fires, exhaust exits rightward)
   *                 +1 = strafing right (left-side thruster fires, exhaust exits leftward)
   * @param _team    (unused — all exhaust uses warm colours)
   */
  emitSideExhaust(
    pos: Vec2,
    angle: number,
    sideSign: number,
    _team: Team,
    options: { speedFraction?: number; varyLightness?: boolean } = {},
  ): void {
    const count = 2;
    const warmPalette: Color[] = [
      Colors.thrust_warm_yellow,
      Colors.thrust_warm_orange,
      Colors.thrust_burnt_orange,
    ];
    const speedFraction = Math.min(1, Math.max(0, options.speedFraction ?? 0));
    const spreadRange = 0.09 + 0.28 * (1 - speedFraction);
    // Thruster is on the opposite side from the strafe direction.
    const thrusterSide = -sideSign;
    const offsetAngle = angle + (thrusterSide * Math.PI / 2);
    const exhaustAngle = angle + (thrusterSide * Math.PI / 2);
    for (let i = 0; i < count; i++) {
      const p = this.acquire();
      p.active    = true;
      p.isExhaust = true;
      p.additive  = true;
      const offsetDist = randomRange(3, 8);
      p.x = pos.x + Math.cos(offsetAngle) * offsetDist;
      p.y = pos.y + Math.sin(offsetAngle) * offsetDist;
      const spread = randomRange(-spreadRange, spreadRange);
      const spd = randomRange(25, 60);
      p.vx = Math.cos(exhaustAngle + spread) * spd;
      p.vy = Math.sin(exhaustAngle + spread) * spd;
      const c = warmPalette[Math.floor(Math.random() * warmPalette.length)];
      p.color = options.varyLightness ? lightenColor(c, randomRange(0, 0.25)) : c;
      p.alpha   = 0.72;
      p.life    = randomRange(0.15, 0.35);
      p.maxLife = p.life;
      p.size    = randomRange(0.8, 2.0) * 0.5;
    }
  }

  emitExplosion(pos: Vec2, size: number): void {
    const scale = this._effectiveScale;

    // Central nova flash — always emit at least one regardless of quality.
    {
      const p = this.acquire();
      p.active = true;
      p.x = pos.x;
      p.y = pos.y;
      p.vx = 0;
      p.vy = 0;
      p.color = Colors.particles_nova;
      p.alpha = 1;
      p.life = 0.07;
      p.maxLife = p.life;
      p.size = Math.max(4, size * 0.65);
      p.additive = true;
    }

    // Primary fireball
    const primaryCount = Math.max(2, Math.floor((18 + size * 2.5) * scale));
    const fireballColors: Color[] = [
      Colors.particles_explosion1,
      Colors.particles_explosion2,
      Colors.alert2,
      Colors.particles_explosion3,
      Colors.particles_ember,
      Colors.particles_nova,
    ];
    for (let i = 0; i < primaryCount; i++) {
      const p = this.acquire();
      p.active = true;
      p.x = pos.x + randomRange(-size * 0.25, size * 0.25);
      p.y = pos.y + randomRange(-size * 0.25, size * 0.25);
      const ang = randomRange(0, Math.PI * 2);
      const spd = randomRange(30, 150) * (size / 20);
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.color = fireballColors[i % fireballColors.length];
      p.alpha = 1;
      p.life = randomRange(0.35, 1.1);
      p.maxLife = p.life;
      p.size = randomRange(2.0, 4.5);
      p.additive = true;
    }

    // Secondary debris — 60 % additive embers + 40 % normal debris
    const debrisCount = Math.max(1, Math.floor((8 + size * 1.2) * scale));
    for (let i = 0; i < debrisCount; i++) {
      const useEmber = i % 5 < 3;
      const p = this.acquire();
      p.active = true;
      p.x = pos.x + randomRange(-size * 0.4, size * 0.4);
      p.y = pos.y + randomRange(-size * 0.4, size * 0.4);
      const ang = randomRange(0, Math.PI * 2);
      const spd = randomRange(10, 60) * (size / 20);
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.color = useEmber ? Colors.particles_ember : Colors.particles_explosion2;
      p.alpha = useEmber ? 0.9 : 0.8;
      p.life = randomRange(0.5, 1.5);
      p.maxLife = p.life;
      p.size = randomRange(1.0, 2.5);
      p.additive = useEmber;
    }

    // High-velocity sparks
    const sparkColors: Color[] = [Colors.alert2, Colors.particles_ember, Colors.particles_nova];
    const sparkCount = Math.max(1, Math.min(10, Math.floor((3 + size * 0.22) * scale)));
    for (let i = 0; i < sparkCount; i++) {
      const p = this.acquire();
      p.active = true;
      p.x = pos.x;
      p.y = pos.y;
      const ang = randomRange(0, Math.PI * 2);
      const spd = randomRange(140, 260) * Math.max(0.65, size / 45);
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.color = sparkColors[i % sparkColors.length];
      p.alpha = 1;
      p.life = randomRange(0.10, 0.24);
      p.maxLife = p.life;
      p.size = randomRange(0.9, 1.8);
      p.additive = true;
    }
  }

  emitSpark(pos: Vec2): void {
    const count = Math.max(1, Math.round(5 * this._effectiveScale));
    for (let i = 0; i < count; i++) {
      const p = this.acquire();
      p.active = true;
      p.x = pos.x;
      p.y = pos.y;
      const ang = randomRange(0, Math.PI * 2);
      const spd = randomRange(60, 150);
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.color = Colors.particles_spark;
      p.alpha = 1;
      p.life = randomRange(0.1, 0.35);
      p.maxLife = p.life;
      p.size = randomRange(1.2, 2.5);
      p.additive = true;
    }
  }

  emitHealing(pos: Vec2): void {
    const count = 4;
    for (let i = 0; i < count; i++) {
      const p = this.acquire();
      p.active = true;
      p.x = pos.x + randomRange(-8, 8);
      p.y = pos.y + randomRange(-8, 8);
      p.vx = randomRange(-10, 10);
      p.vy = randomRange(-30, -10);
      p.color = Colors.particles_healing;
      p.alpha = 1;
      p.life = randomRange(0.4, 0.8);
      p.maxLife = p.life;
      p.size = randomRange(1.5, 3);
      p.additive = false;
    }
  }

  emitFloatingText(pos: Vec2, text: string, color: Color): void {
    this.floatingTexts.push({
      text,
      pos: pos.clone(),
      vel: new Vec2(randomRange(-8, 8), randomRange(-42, -28)),
      color,
      life: 1.25,
      maxLife: 1.25,
    });
    if (this.floatingTexts.length > 48) this.floatingTexts.splice(0, this.floatingTexts.length - 48);
  }

  emitBuildEffect(pos: Vec2): void {
    const count = 3;
    for (let i = 0; i < count; i++) {
      const p = this.acquire();
      p.active = true;
      const ang = randomRange(0, Math.PI * 2);
      const dist = randomRange(5, 20);
      p.x = pos.x + Math.cos(ang) * dist;
      p.y = pos.y + Math.sin(ang) * dist;
      p.vx = randomRange(-15, 15);
      p.vy = randomRange(-25, -5);
      p.color = Colors.particles_switch;
      p.alpha = 0.85;
      p.life = randomRange(0.3, 0.7);
      p.maxLife = p.life;
      p.size = randomRange(1, 2.5);
      p.additive = true;
    }
  }

  /**
   * Emit a small burst of directional impact sparks when a non-lethal
   * projectile hit occurs.  Scaled by the quality budget.
   */
  emitImpact(pos: Vec2, angle: number): void {
    const count = Math.max(1, Math.round(IMPACT_SPARK_COUNT * this._effectiveScale));
    for (let i = 0; i < count; i++) {
      const p = this.acquire();
      p.active = true;
      p.x = pos.x;
      p.y = pos.y;
      const scatter = (Math.random() - 0.5) * Math.PI * 1.4;
      const backAngle = angle + Math.PI + scatter;
      const spd = randomRange(80, 200);
      p.vx = Math.cos(backAngle) * spd;
      p.vy = Math.sin(backAngle) * spd;
      p.color = Colors.particles_impact;
      p.alpha = 1;
      p.life = randomRange(0.06, 0.18);
      p.maxLife = p.life;
      p.size = randomRange(0.8, 2.2);
      p.additive = true;
    }
  }

  /**
   * Fiery spray released when a ship's hull takes a non-lethal hit.
   *
   * Particles originate from the point on the ship's perimeter nearest the
   * damage source (`hitPoint` — a projectile impact, the centre of a splash
   * blast, or a laser/perimeter crossing) and spray straight outward, away
   * from the ship's core, like a burst of scorched exhaust.
   */
  emitShipDamageSpray(center: Vec2, radius: number, hitPoint: Vec2, intensity: number = 1): void {
    let ox = hitPoint.x - center.x;
    let oy = hitPoint.y - center.y;
    let olen = Math.hypot(ox, oy);
    if (olen <= 1e-4) {
      ox = 1;
      oy = 0;
      olen = 1;
    }
    ox /= olen;
    oy /= olen;
    const outAngle = Math.atan2(oy, ox);
    const originX = center.x + ox * radius;
    const originY = center.y + oy * radius;
    const tangentAngle = outAngle + Math.PI / 2;

    // Warm thrust palette, hottest at the core of the spray.
    const warmPalette: Color[] = [
      Colors.thrust_core_hot,
      Colors.thrust_warm_yellow,
      Colors.thrust_warm_orange,
      Colors.thrust_burnt_orange,
      Colors.thrust_deep_red,
    ];

    const count = Math.max(1, Math.round(9 * intensity * this._effectiveScale));
    for (let i = 0; i < count; i++) {
      const p = this.acquire();
      p.active = true;
      p.additive = true;

      // Cluster the emission along the hull around the perimeter contact point.
      const along = randomRange(-radius * 0.35, radius * 0.35);
      p.x = originX + Math.cos(tangentAngle) * along;
      p.y = originY + Math.sin(tangentAngle) * along;

      const spread = randomRange(-0.7, 0.7);
      const spd = randomRange(60, 190) * (0.7 + 0.6 * intensity);
      p.vx = Math.cos(outAngle + spread) * spd;
      p.vy = Math.sin(outAngle + spread) * spd;

      // Tighter (more central) particles run hotter; the fringes cool off.
      const heat = 1 - Math.min(1, Math.abs(spread) / 0.7);
      const ci = Math.min(
        warmPalette.length - 1,
        Math.floor((1 - heat) * warmPalette.length + Math.random()),
      );
      p.color = warmPalette[ci];
      p.alpha = randomRange(0.75, 1);
      p.life = randomRange(0.18, 0.5);
      p.maxLife = p.life;
      p.size = randomRange(1.2, 3.0);
    }
  }

  /**
   * Emit a small directional shower from a building impact point.
   * `outwardAngle` points away from the building body.
   */
  emitBuildingDamageSparks(pos: Vec2, outwardAngle: number): void {
    const count = Math.max(1, Math.round(BUILDING_DAMAGE_SPARK_COUNT * this._effectiveScale));
    const sparkColors: Color[] = [Colors.particles_impact, Colors.particles_ember, Colors.particles_nova];
    for (let i = 0; i < count; i++) {
      const p = this.acquire();
      p.active = true;
      p.x = pos.x + Math.cos(outwardAngle) * randomRange(0, 3);
      p.y = pos.y + Math.sin(outwardAngle) * randomRange(0, 3);
      const scatter = randomRange(-0.8, 0.8);
      const spd = randomRange(70, 180);
      p.vx = Math.cos(outwardAngle + scatter) * spd;
      p.vy = Math.sin(outwardAngle + scatter) * spd;
      p.color = sparkColors[i % sparkColors.length];
      p.alpha = 0.95;
      p.life = randomRange(0.08, 0.22);
      p.maxLife = p.life;
      p.size = randomRange(0.7, 1.8);
      p.additive = true;
    }
  }

  /**
   * Emit a brief bright muzzle flash when a weapon fires.
   */
  emitMuzzleFlash(pos: Vec2, angle: number): void {
    {
      const p = this.acquire();
      p.active = true;
      p.x = pos.x;
      p.y = pos.y;
      p.vx = Math.cos(angle) * 20;
      p.vy = Math.sin(angle) * 20;
      p.color = Colors.particles_muzzle;
      p.alpha = 1;
      p.life = 0.055;
      p.maxLife = p.life;
      p.size = randomRange(2.5, 4.5);
      p.additive = true;
    }
    const sparkCount = Math.max(1, Math.round(MUZZLE_SPARK_COUNT * this._effectiveScale));
    for (let i = 0; i < sparkCount; i++) {
      const p = this.acquire();
      p.active = true;
      p.x = pos.x;
      p.y = pos.y;
      const spread = (Math.random() - 0.5) * 0.9;
      const spd = randomRange(120, 280);
      p.vx = Math.cos(angle + spread) * spd;
      p.vy = Math.sin(angle + spread) * spd;
      p.color = Colors.particles_nova;
      p.alpha = 0.9;
      p.life = randomRange(0.04, 0.10);
      p.maxLife = p.life;
      p.size = randomRange(0.6, 1.6);
      p.additive = true;
    }
  }

  // --- Simulation ---

  /**
   * Advance all active particles.
   * Iterates only the active list — O(active count), not O(pool size).
   */
  update(dt: number): void {
    this.emittedThisFrame = 0;
    this.recycledCount = 0;
    const active = this.activeIndices;
    let len = active.length;
    let i = 0;
    while (i < len) {
      const idx = active[i];
      const p = this.pool[idx];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        p.alpha = 0;
        // Swap-remove: move the last element to this slot, shrink list
        this.freeStack.push(idx);
        active[i] = active[--len];
        active.length = len;
        // Do not increment i — we need to process the swapped-in element
      } else {
        p.alpha = p.life / p.maxLife;
        i++;
      }
    }
    this.activeCount = len;

    for (let j = this.floatingTexts.length - 1; j >= 0; j--) {
      const ft = this.floatingTexts[j];
      ft.pos = ft.pos.add(ft.vel.scale(dt));
      ft.vel = ft.vel.scale(1 / (1 + 0.35 * dt));
      ft.life -= dt;
      if (ft.life <= 0) this.floatingTexts.splice(j, 1);
    }

    // Push stats to the shared budget
    renderBudget.activeParticles = this.activeCount;
    renderBudget.emittedThisFrame = this.emittedThisFrame;
    renderBudget.recycledParticles = this.recycledCount;
  }

  // --- Rendering ---

  /**
   * Draw all active particles with viewport culling.
   * Computes world-space viewport bounds once; iterates only the active list.
   * Skips exhaust particles — those are drawn by drawExhaust() before ship bodies.
   */
  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const active = this.activeIndices;
    const len = active.length;
    if (len === 0) return;

    const zoom = camera.zoom;
    const camX = camera.position.x;
    const camY = camera.position.y;
    const sw = camera.screenW;
    const sh = camera.screenH;
    const hw = sw * 0.5;
    const hh = sh * 0.5;

    // World-space viewport bounds with margin (avoids per-particle isOnScreen call)
    const margin = 30; // world units at zoom=1 → 30px screen margin
    const marginW = margin / zoom;
    const vpMinX = camX - hw / zoom - marginW;
    const vpMaxX = camX + hw / zoom + marginW;
    const vpMinY = camY - hh / zoom - marginW;
    const vpMaxY = camY + hh / zoom + marginW;

    let drawn = 0;
    let culled = 0;

    // Pass 1 — normal blend (non-additive, non-exhaust particles)
    for (let i = 0; i < len; i++) {
      const p = this.pool[active[i]];
      if (p.additive || p.alpha <= 0 || p.isExhaust) continue;
      if (p.x < vpMinX || p.x > vpMaxX || p.y < vpMinY || p.y > vpMaxY) { culled++; continue; }

      const sx = (p.x - camX) * zoom + hw;
      const sy = (p.y - camY) * zoom + hh;
      const r = Math.max(0.4, p.size * zoom);

      ctx.fillStyle = colorToCSS(p.color, p.alpha);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      drawn++;
    }

    // Pass 2 — additive blend (non-exhaust only)
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < len; i++) {
      const p = this.pool[active[i]];
      if (!p.additive || p.alpha <= 0 || p.isExhaust) continue;
      if (p.x < vpMinX || p.x > vpMaxX || p.y < vpMinY || p.y > vpMaxY) { culled++; continue; }

      const sx = (p.x - camX) * zoom + hw;
      const sy = (p.y - camY) * zoom + hh;
      const r = Math.max(0.4, p.size * zoom);

      ctx.fillStyle = colorToCSS(p.color, p.alpha);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      drawn++;
    }
    ctx.globalCompositeOperation = 'source-over';

    if (this.floatingTexts.length > 0) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.max(12, 16 * camera.zoom)}px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif`;
      for (const ft of this.floatingTexts) {
        const alpha = Math.max(0, Math.min(1, ft.life / ft.maxLife));
        const screen = camera.worldToScreen(ft.pos);
        ctx.lineWidth = Math.max(2, 3 * camera.zoom);
        ctx.strokeStyle = `rgba(0,0,0,${alpha * 0.65})`;
        ctx.fillStyle = colorToCSS(ft.color, alpha);
        ctx.strokeText(ft.text, screen.x, screen.y);
        ctx.fillText(ft.text, screen.x, screen.y);
      }
      ctx.restore();
    }

    this.drawnCount = drawn;
    this.culledCount = culled;

    // Update shared budget stats
    renderBudget.drawnParticles = drawn;
    renderBudget.culledParticles = culled;
    renderBudget.particleCapacity = POOL_SIZE;
  }

  /**
   * Draw only engine exhaust / thrust particles.
   * Call this BEFORE ship bodies are drawn so thrust visually sits underneath
   * the ship silhouette.  Uses additive blending for a warm glow effect.
   */
  drawExhaust(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const active = this.activeIndices;
    const len = active.length;
    if (len === 0) return;

    const zoom = camera.zoom;
    const camX = camera.position.x;
    const camY = camera.position.y;
    const sw = camera.screenW;
    const sh = camera.screenH;
    const hw = sw * 0.5;
    const hh = sh * 0.5;

    const margin = 30;
    const marginW = margin / zoom;
    const vpMinX = camX - hw / zoom - marginW;
    const vpMaxX = camX + hw / zoom + marginW;
    const vpMinY = camY - hh / zoom - marginW;
    const vpMaxY = camY + hh / zoom + marginW;

    // All exhaust particles use additive blending for a warm glow.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < len; i++) {
      const p = this.pool[active[i]];
      if (!p.isExhaust || p.alpha <= 0) continue;
      if (p.x < vpMinX || p.x > vpMaxX || p.y < vpMinY || p.y > vpMaxY) continue;

      const sx = (p.x - camX) * zoom + hw;
      const sy = (p.y - camY) * zoom + hh;
      const r = Math.max(0.4, p.size * zoom);

      ctx.fillStyle = colorToCSS(p.color, p.alpha);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();

      // Soft warm glow halo around each exhaust particle.
      ctx.fillStyle = colorToCSS(p.color, p.alpha * 0.22);
      ctx.beginPath();
      ctx.arc(sx, sy, r * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
