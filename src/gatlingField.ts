/**
 * GatlingField — pooled, structure-of-arrays store for gatling-turret bullets.
 *
 * Gatling turrets spit out hundreds (up to ~1000) of short-lived bullets at
 * once.  Routing each one through the normal `ProjectileBase` / `Entity`
 * pipeline is far too expensive at that count: a class instance + `Vec2`
 * allocations every tick, a trail array with cloned points, a spatial-index
 * insert, and a polymorphic `draw()` that does its own `ctx.save()` /
 * `globalCompositeOperation` switch / separate `stroke()` + `fill()` per bullet.
 *
 * This field instead keeps bullet state in flat typed arrays and:
 *   - integrates with plain scalar math (zero per-frame allocation, zero GC),
 *   - resolves collision through {@link GameState.resolveGatlingBullet} using a
 *     shared scratch query (no per-bullet Entity),
 *   - renders every bullet in a single batched pass — one `save()`, one
 *     blend-mode switch, and ~4 path submissions total regardless of count.
 *
 * Visuals match the previous `GatlingTurretBullet`: a short additive streak
 * behind an additive core dot, cyan for the local player, amber for everyone
 * else.  Under the "Legacy Graphics" toggle the firing sites keep spawning the
 * real `GatlingTurretBullet` entity instead, so the old path stays fully
 * revertible.
 */

import { Camera } from './camera.js';
import { Entity, Team } from './entities.js';
import { Colors, colorToCSS } from './colors.js';
import { ENTITY_RADIUS, WEAPON_STATS } from './constants.js';
import { renderBudget } from './renderBudget.js';
import type { GameState } from './gamestate.js';

const TAU = Math.PI * 2;

/** Hard cap on simultaneously live pooled bullets. */
const CAPACITY = 2048;

/** Bullet radius — matches the old `GatlingTurretBullet` (ENTITY_RADIUS.bullet * 0.65). */
const BULLET_RADIUS = ENTITY_RADIUS.bullet * 0.65;

/** Muzzle speed (world units / second). */
const BULLET_SPEED = WEAPON_STATS.gatlingturret.speed;

/** Per-shot damage. */
const BULLET_DAMAGE = WEAPON_STATS.gatlingturret.damage;

/** Lifetime in seconds — range / speed, as the old class computed it. */
const BULLET_LIFETIME = WEAPON_STATS.gatlingturret.range / WEAPON_STATS.gatlingturret.speed;

/** Length of the rendered streak behind the bullet head, in world units. */
const STREAK_WORLD_LEN = 7;

export class GatlingField {
  /** Number of live bullets, occupying slots [0, count). */
  private count = 0;

  private readonly px = new Float32Array(CAPACITY);
  private readonly py = new Float32Array(CAPACITY);
  private readonly vx = new Float32Array(CAPACITY);
  private readonly vy = new Float32Array(CAPACITY);
  /** Previous-tick position, for swept collision. */
  private readonly prevX = new Float32Array(CAPACITY);
  private readonly prevY = new Float32Array(CAPACITY);
  private readonly life = new Float32Array(CAPACITY);
  private readonly team = new Uint8Array(CAPACITY);
  /** Firing turret, kept for kill attribution. Not owned by the field. */
  private readonly src: Array<Entity | null> = new Array(CAPACITY).fill(null);

  /** Live bullet count (for HUD / perf overlays). */
  get activeCount(): number {
    return this.count;
  }

  /** Drop every bullet. */
  clear(): void {
    this.count = 0;
    this.src.fill(null);
  }

  /**
   * Spawn one bullet.  `angle` is the travel direction in radians.  Silently
   * drops the shot if the pool is already full.
   */
  spawn(team: Team, x: number, y: number, angle: number, source: Entity | null): void {
    if (this.count >= CAPACITY) return;
    const i = this.count++;
    this.px[i] = x;
    this.py[i] = y;
    this.prevX[i] = x;
    this.prevY[i] = y;
    this.vx[i] = Math.cos(angle) * BULLET_SPEED;
    this.vy[i] = Math.sin(angle) * BULLET_SPEED;
    this.life[i] = BULLET_LIFETIME;
    this.team[i] = team;
    this.src[i] = source;
  }

  /** Integrate + collide every bullet. Call while the spatial index is populated. */
  update(dt: number, state: GameState): void {
    let i = 0;
    while (i < this.count) {
      const prevX = this.px[i];
      const prevY = this.py[i];
      const nx = prevX + this.vx[i] * dt;
      const ny = prevY + this.vy[i] * dt;
      this.px[i] = nx;
      this.py[i] = ny;
      this.prevX[i] = prevX;
      this.prevY[i] = prevY;

      const life = this.life[i] - dt;
      this.life[i] = life;

      let dead = life <= 0;
      if (!dead) {
        dead = state.resolveGatlingBullet(
          prevX,
          prevY,
          nx,
          ny,
          this.vx[i],
          this.vy[i],
          BULLET_RADIUS,
          BULLET_DAMAGE,
          this.team[i] as Team,
          this.src[i],
        );
      }

      if (dead) this.removeAt(i);
      else i++;
    }
  }

  /** Swap-remove the bullet at slot `i`. */
  private removeAt(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.px[i] = this.px[last];
      this.py[i] = this.py[last];
      this.vx[i] = this.vx[last];
      this.vy[i] = this.vy[last];
      this.prevX[i] = this.prevX[last];
      this.prevY[i] = this.prevY[last];
      this.life[i] = this.life[last];
      this.team[i] = this.team[last];
      this.src[i] = this.src[last];
    }
    this.src[last] = null;
  }

  /**
   * Render every on-screen bullet.  Two colour groups (local player vs. the
   * rest), two path submissions each (streak + core dot) — six canvas draw
   * calls total, independent of bullet count.
   */
  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const n = this.count;
    renderBudget.gatlingFieldActive = n;
    if (n === 0) return;

    const zoom = camera.zoom;
    const invZoom = 1 / zoom;
    const camX = camera.position.x;
    const camY = camera.position.y;
    const marginW = 48 * invZoom;
    const minX = camX - camera.screenW * 0.5 * invZoom - marginW;
    const maxX = camX + camera.screenW * 0.5 * invZoom + marginW;
    const minY = camY - camera.screenH * 0.5 * invZoom - marginW;
    const maxY = camY + camera.screenH * 0.5 * invZoom + marginW;

    const streakScreenLen = STREAK_WORLD_LEN * zoom;
    const dotR = Math.max(0.6, 1.2 * zoom);
    const lineW = Math.max(1, 1.1 * zoom);

    const playerCSS = colorToCSS(Colors.bullet_player_turret);
    const enemyCSS = colorToCSS(Colors.bullet_enemy_turret);
    const playerStreakCSS = colorToCSS(Colors.bullet_player_turret, 0.5);
    const enemyStreakCSS = colorToCSS(Colors.bullet_enemy_turret, 0.5);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    // --- Streaks: one path + one stroke per colour group ---
    for (let group = 0; group < 2; group++) {
      const wantPlayer = group === 0;
      ctx.strokeStyle = wantPlayer ? playerStreakCSS : enemyStreakCSS;
      ctx.lineWidth = lineW;
      ctx.beginPath();
      let emitted = false;
      for (let i = 0; i < n; i++) {
        if ((this.team[i] === Team.Player) !== wantPlayer) continue;
        const x = this.px[i];
        const y = this.py[i];
        if (x < minX || x > maxX || y < minY || y > maxY) continue;
        const sx = camera.screenX(x);
        const sy = camera.screenY(y);
        const vX = this.vx[i];
        const vY = this.vy[i];
        const inv = streakScreenLen / (Math.hypot(vX, vY) || 1);
        ctx.moveTo(sx - vX * inv, sy - vY * inv);
        ctx.lineTo(sx, sy);
        emitted = true;
      }
      if (emitted) ctx.stroke();
    }

    // --- Core dots: one path + one fill per colour group ---
    for (let group = 0; group < 2; group++) {
      const wantPlayer = group === 0;
      ctx.fillStyle = wantPlayer ? playerCSS : enemyCSS;
      ctx.beginPath();
      let emitted = false;
      for (let i = 0; i < n; i++) {
        if ((this.team[i] === Team.Player) !== wantPlayer) continue;
        const x = this.px[i];
        const y = this.py[i];
        if (x < minX || x > maxX || y < minY || y > maxY) continue;
        const sx = camera.screenX(x);
        const sy = camera.screenY(y);
        ctx.moveTo(sx + dotR, sy);
        ctx.arc(sx, sy, dotR, 0, TAU);
        emitted = true;
      }
      if (emitted) ctx.fill();
    }

    ctx.restore();
  }
}
