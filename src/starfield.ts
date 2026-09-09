/**
 * Background starfield rendering for Sign99.
 *
 * Improvements over the original implementation:
 *  - 2400 stars across multiple depth layers for a rich parallax effect.
 *  - Per-star twinkling via a phase-shifted sine oscillation.
 *  - Three colour archetypes: cool blue-white, neutral white, warm yellow-orange.
 *  - Rare "giant" bright stars (3× base size) scattered throughout.
 *  - Occasional shooting-star streaks that fire across the field.
 */

import { Vec2, randomRange } from './math.js';
import { Camera } from './camera.js';
import { Colors, colorToCSS, Color } from './colors.js';
import { WORLD_WIDTH, WORLD_HEIGHT } from './constants.js';
import { getCinematicLevel } from './cinematic.js';
import { isLegacyGraphics } from './graphicsmode.js';

// ---------------------------------------------------------------------------
// Star data
// ---------------------------------------------------------------------------

/** 0 = cool blue-white, 1 = neutral white, 2 = warm yellow-orange, 3 = faint violet */
type StarColorType = 0 | 1 | 2 | 3;

interface Star {
  x: number;
  y: number;
  brightness: number;
  size: number;
  /** Depth layer 0–1 where 0 is far (slow parallax) and 1 is near. */
  depth: number;
  /** Phase offset for the twinkling animation (radians). */
  twinklePhase: number;
  /** Twinkling oscillation frequency in radians-per-second. */
  twinkleRate: number;
  /** Colour archetype. */
  colorType: StarColorType;
  /** True for rare larger-than-normal giant stars. */
  isGiant: boolean;
}

// ---------------------------------------------------------------------------
// Shooting star data
// ---------------------------------------------------------------------------

interface ShootingStar {
  active: boolean;
  /** World-space start position. */
  x: number;
  y: number;
  /** World-space velocity (pixels/s). */
  vx: number;
  vy: number;
  /** Visible trail length in world units. */
  trailLen: number;
  /** Remaining lifetime (seconds). */
  life: number;
  maxLife: number;
  /** Countdown until the next shooting star spawns (seconds). */
  cooldown: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STAR_COUNT     = 2400;
const MAP_CENTER_X   = WORLD_WIDTH * 0.5;

/** Fraction of stars that are giant. */
const GIANT_FRACTION = 0.018;

/** CSS colour strings for each star archetype. */
const STAR_COLORS: Record<StarColorType, string> = {
  0: 'rgba(170,200,255,',   // cool blue-white
  1: 'rgba(230,230,240,',   // neutral white
  2: 'rgba(255,230,170,',   // warm yellow-orange
  3: 'rgba(210,185,255,',   // faint violet
};

/** Weight distribution for colour archetypes (cumulative). */
const COLOR_WEIGHTS = [0.32, 0.74, 0.94, 1.00];

/** Shooting-star speed range (world units / second). */
const SHOOT_SPEED_MIN = 2000;
const SHOOT_SPEED_MAX = 4500;

/** Re-spawn interval range (seconds). */
const SHOOT_COOLDOWN_MIN = 8;
const SHOOT_COOLDOWN_MAX = 20;

// ---------------------------------------------------------------------------
// Starfield
// ---------------------------------------------------------------------------

export class Starfield {
  private stars: Star[] = [];
  private shootingStar: ShootingStar;
  private time: number = 0;
  private _shootingStarsEnabled = true;

  constructor() {
    this.generate();
    this.shootingStar = {
      active: false,
      x: 0, y: 0, vx: 0, vy: 0,
      trailLen: 0,
      life: 0, maxLife: 0,
      cooldown: randomRange(SHOOT_COOLDOWN_MIN, SHOOT_COOLDOWN_MAX),
    };
  }

  /**
   * Enable or disable animated shooting-star streaks.  When disabled (Low
   * quality) the cooldown timer still runs so a streak can appear immediately
   * if quality is raised mid-session.
   */
  setShootingStarsEnabled(enabled: boolean): void {
    this._shootingStarsEnabled = enabled;
  }

  // --------------------------------------------------------------------------
  // Generation
  // --------------------------------------------------------------------------

  private generate(): void {
    this.stars = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      const roll = Math.random();
      let colorType: StarColorType;
      if (roll < COLOR_WEIGHTS[0])      colorType = 0;
      else if (roll < COLOR_WEIGHTS[1]) colorType = 1;
      else if (roll < COLOR_WEIGHTS[2]) colorType = 2;
      else                              colorType = 3;

      const isGiant = Math.random() < GIANT_FRACTION;
      const depth = randomRange(0.08, 1.0);
      const brightRoll = Math.random();
      const brightness = isGiant
        ? randomRange(0.82, 1.0)
        : brightRoll < 0.58
          ? randomRange(0.32, 0.58)
          : brightRoll < 0.90
            ? randomRange(0.58, 0.86)
            : randomRange(0.86, 1.0);
      const size = isGiant
        ? randomRange(2.8, 4.8)
        : brightRoll < 0.58
          ? randomRange(0.75, 1.25)
          : brightRoll < 0.90
            ? randomRange(1.05, 1.75)
            : randomRange(1.55, 2.35);
      this.stars.push({
        // Keep stars in the playable world bounds. The previous extra-wide
        // distribution made most generated stars live far outside the current
        // parallax window, so the screen looked sparse even with many stars.
        x: randomRange(0, WORLD_WIDTH),
        y: randomRange(0, WORLD_HEIGHT),
        brightness,
        size,
        depth,
        twinklePhase: randomRange(0, Math.PI * 2),
        twinkleRate: randomRange(1.0, 5.0),
        colorType,
        isGiant,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Update
  // --------------------------------------------------------------------------

  update(dt: number): void {
    this.time += dt;
    this.updateShootingStar(dt);
  }

  private updateShootingStar(dt: number): void {
    const ss = this.shootingStar;
    if (ss.active) {
      ss.x    += ss.vx * dt;
      ss.y    += ss.vy * dt;
      ss.life -= dt;
      if (ss.life <= 0) {
        ss.active   = false;
        ss.cooldown = randomRange(SHOOT_COOLDOWN_MIN, SHOOT_COOLDOWN_MAX);
      }
    } else {
      ss.cooldown -= dt;
      if (ss.cooldown <= 0) {
        this.spawnShootingStar();
      }
    }
  }

  private spawnShootingStar(): void {
    const ss = this.shootingStar;
    // Spawn anywhere in an expanded world region.
    ss.x = randomRange(-WORLD_WIDTH * 0.2, WORLD_WIDTH * 1.2);
    ss.y = randomRange(-WORLD_HEIGHT * 0.2, WORLD_HEIGHT * 1.2);
    // Random direction, bias roughly leftward or downward for variety.
    const angle  = randomRange(0, Math.PI * 2);
    const speed  = randomRange(SHOOT_SPEED_MIN, SHOOT_SPEED_MAX);
    ss.vx        = Math.cos(angle) * speed;
    ss.vy        = Math.sin(angle) * speed;
    ss.trailLen  = randomRange(180, 400);
    ss.maxLife   = ss.trailLen / speed * 3;
    ss.life      = ss.maxLife;
    ss.active    = true;
  }

  // --------------------------------------------------------------------------
  // Drawing
  // --------------------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, camera: Camera, screenW: number, screenH: number): void {
    const cinematicLevel = getCinematicLevel();
    if (cinematicLevel <= -3) return;
    this.drawStars(ctx, camera, screenW, screenH);
    if (this._shootingStarsEnabled && cinematicLevel > -2) {
      this.drawShootingStar(ctx, camera, screenW, screenH);
    }
  }

  private drawStars(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    screenW: number,
    screenH: number,
  ): void {
    const t = this.time;

    const sparse = getCinematicLevel() === -2;
    for (let index = 0; index < this.stars.length; index++) {
      if (sparse && index % 12 !== 0) continue;
      const star = this.stars[index]!;
      // Parallax: deeper stars move slower relative to camera.
      const parallax = 0.2 + star.depth * 0.6;
      const sx =
        (star.x - camera.position.x * parallax) * camera.zoom + screenW * 0.5;
      const sy =
        (star.y - camera.position.y * parallax) * camera.zoom + screenH * 0.5;

      // Cull off-screen stars.
      if (sx < -6 || sx > screenW + 6 || sy < -6 || sy > screenH + 6) continue;

      // Twinkling: modulate brightness with a slow sine wave.
      const twinkle = 0.82 + 0.18 * Math.sin(t * star.twinkleRate + star.twinklePhase);
      const depthAlpha = 0.68 + star.depth * 0.42;
      const alpha = Math.min(0.98, Math.max(star.isGiant ? 0.58 : 0.20, star.brightness * twinkle * depthAlpha));
      const r = star.size * camera.zoom * (0.62 + star.depth * 0.58);

      const cssColor = STAR_COLORS[star.colorType];
      ctx.fillStyle = cssColor + alpha.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(0.65, r), 0, Math.PI * 2);
      ctx.fill();

      if (!star.isGiant && alpha > 0.62 && r > 0.9) {
        ctx.fillStyle = cssColor + (alpha * 0.16).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(sx, sy, r * 1.85, 0, Math.PI * 2);
        ctx.fill();
      }

      // Giant stars get a faint diffraction cross to make them pop.
      // Legacy only — the "+" shine reads cheesy in the current look.
      if (star.isGiant && r > 1.2 && isLegacyGraphics()) {
        const crossAlpha = alpha * 0.35;
        const crossLen   = r * 3.5;
        ctx.strokeStyle = cssColor + crossAlpha.toFixed(3) + ')';
        ctx.lineWidth   = 0.5;
        ctx.beginPath();
        ctx.moveTo(sx - crossLen, sy);
        ctx.lineTo(sx + crossLen, sy);
        ctx.moveTo(sx, sy - crossLen);
        ctx.lineTo(sx, sy + crossLen);
        ctx.stroke();
      }
    }
  }

  private drawShootingStar(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    screenW: number,
    screenH: number,
  ): void {
    const ss = this.shootingStar;
    if (!ss.active) return;

    // Use depth = 0.6 so the shooting star has some parallax.
    const parallax = 0.56; // 0.2 + 0.6*0.6
    const headSx   = (ss.x - camera.position.x * parallax) * camera.zoom + screenW * 0.5;
    const headSy   = (ss.y - camera.position.y * parallax) * camera.zoom + screenH * 0.5;

    const angle    = Math.atan2(ss.vy, ss.vx);
    const trailPx  = ss.trailLen * camera.zoom * (ss.life / ss.maxLife);

    const tailSx   = headSx - Math.cos(angle) * trailPx;
    const tailSy   = headSy - Math.sin(angle) * trailPx;

    // Fade out as the shooting star dies.
    const fade     = Math.min(1, ss.life / (ss.maxLife * 0.25));

    const grad = ctx.createLinearGradient(headSx, headSy, tailSx, tailSy);
    grad.addColorStop(0.0, `rgba(255,255,255,${(0.9 * fade).toFixed(3)})`);
    grad.addColorStop(0.3, `rgba(200,230,255,${(0.5 * fade).toFixed(3)})`);
    grad.addColorStop(1.0, 'rgba(0,0,0,0)');

    ctx.strokeStyle = grad;
    ctx.lineWidth   = Math.max(0.5, 1.2 * camera.zoom);
    ctx.beginPath();
    ctx.moveTo(headSx, headSy);
    ctx.lineTo(tailSx, tailSy);
    ctx.stroke();
  }
}

