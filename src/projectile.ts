/** Projectile types for Sign99 */

import { Vec2, wrapAngle } from './math.js';
import { Camera } from './camera.js';
import { Entity, EntityType, Team } from './entities.js';
import { Colors, colorToCSS } from './colors.js';
import { ENTITY_RADIUS, HP_VALUES, WEAPON_STATS, SWARM_MISSILE_DAMAGE_MULTIPLIER } from './constants.js';
import { getCinematicLevel } from './cinematic.js';
import type { GameState } from './gamestate.js';
import type { SpaceFluid } from './spacefluid.js';
import { damageLaserLine } from './combatUtils.js';
import { isLegacyGraphics } from './graphicsmode.js';
import { renderProjectileTrail, type ProjectileTrailStyle } from './projectileTrail.js';

const BULLET_TRAIL_LIFETIME = 0.12;
const BULLET_TRAIL_MIN_DISTANCE = 2;
const GATLING_TRAIL_LIFETIME = 0.04;
const COMET_TRAIL_LIFETIME = 0.28;
const COMET_TRAIL_MAX_POINTS = 10;
/** World-distance in a single sample step beyond which the trail is reset. */
const TRAIL_TELEPORT_BREAK = 4000;

interface TrailPoint {
  pos: Vec2;
  age: number;
}

// ---------------------------------------------------------------------------
// Base projectile
// ---------------------------------------------------------------------------

export interface ProjectileOptions {
  type: EntityType;
  team: Team;
  position: Vec2;
  angle: number;
  damage: number;
  speed: number;
  lifetime: number;
  source?: Entity | null;
}

export abstract class ProjectileBase extends Entity {
  damage: number;
  speed: number;
  lifetime: number;
  maxLifetime: number;
  source: Entity | null;
  protected trail: TrailPoint[] = [];
  protected trailLifetime = BULLET_TRAIL_LIFETIME;
  protected trailMinDistance = BULLET_TRAIL_MIN_DISTANCE;
  protected trailMaxPoints = 5;
  /**
   * When set, this projectile renders its trail through the shared
   * high-performance {@link renderProjectileTrail} glow-ribbon system instead
   * of the legacy per-class stroke code.  Enabled for fighter- and ship-fired
   * projectiles via {@link enableGlowTrail}.  The legacy look is still used
   * whenever the player has ticked "Legacy Graphics" in graphics settings
   * (see {@link isLegacyGraphics}).
   */
  protected trailStyle: ProjectileTrailStyle | null = null;
  /**
   * When true, enemy projectiles can collide with and destroy this projectile.
   * Used by SwarmMissile to make swarm missiles interceptable by enemy bullets.
   */
  interceptable: boolean = false;

  constructor(opts: ProjectileOptions) {
    super(opts.type, opts.team, opts.position, 1, ENTITY_RADIUS.bullet);
    this.angle = opts.angle;
    this.damage = opts.damage;
    this.speed = opts.speed;
    this.lifetime = opts.lifetime;
    this.maxLifetime = opts.lifetime;
    this.source = opts.source ?? null;

    // Initial velocity in the direction of the angle
    this.velocity = new Vec2(
      Math.cos(opts.angle) * opts.speed,
      Math.sin(opts.angle) * opts.speed,
    );
    this.trail.push({ pos: this.position.clone(), age: 0 });
  }

  update(dt: number): void {
    if (!this.alive) return;
    this.position = this.position.add(this.velocity.scale(dt));
    this.updateTrail(dt);
    this.lifetime -= dt;
    if (this.lifetime <= 0) {
      this.destroy();
    }
  }

  protected updateTrail(dt: number): void {
    this.compactTrail(dt, this.trailLifetime);
    const last = this.trail[this.trail.length - 1];
    if (!last) {
      this.trail.push({ pos: this.position.clone(), age: 0 });
    } else {
      const dist = last.pos.distanceTo(this.position);
      if (dist >= TRAIL_TELEPORT_BREAK) {
        // Teleport / huge jump: break the trail instead of smearing a ribbon
        // across the whole map.
        this.trail.length = 0;
        this.trail.push({ pos: this.position.clone(), age: 0 });
      } else if (this.trailStyle && dist > this.trailMinDistance * 6) {
        // Fast mover: insert a bounded number of intermediate samples so the
        // ribbon stays continuous rather than showing frame-to-frame gaps.
        const steps = Math.min(4, Math.floor(dist / this.trailMinDistance));
        for (let s = 1; s < steps; s++) {
          const f = s / steps;
          this.trail.push({
            pos: new Vec2(
              last.pos.x + (this.position.x - last.pos.x) * f,
              last.pos.y + (this.position.y - last.pos.y) * f,
            ),
            age: 0,
          });
        }
        this.trail.push({ pos: this.position.clone(), age: 0 });
      } else if (dist >= this.trailMinDistance) {
        this.trail.push({ pos: this.position.clone(), age: 0 });
      }
    }
    while (this.trail.length > this.trailMaxPoints) this.trail.shift();
  }

  protected compactTrail(dt: number, lifetime: number): void {
    let write = 0;
    for (let read = 0; read < this.trail.length; read++) {
      const point = this.trail[read];
      point.age += dt;
      if (point.age <= lifetime) this.trail[write++] = point;
    }
    this.trail.length = write;
  }

  protected drawTrail(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    color: string,
    lifetime: number = BULLET_TRAIL_LIFETIME,
    width: number = 3,
  ): void {
    if (!isLegacyGraphics() && this.trailStyle) {
      renderProjectileTrail(ctx, camera, this.trail, this.position, this.trailStyle);
      return;
    }
    if (this.trail.length < 2) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const cinematicLevel = getCinematicLevel();
    ctx.lineWidth = width * (cinematicLevel >= 2 ? 1.45 : 1);
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1];
      const b = this.trail[i];
      const fade = 1 - Math.max(a.age, b.age) / lifetime;
      if (fade <= 0) continue;
      const from = camera.worldToScreen(a.pos);
      const to = camera.worldToScreen(b.pos);
      ctx.globalAlpha = Math.min(0.95, (0.12 + fade * 0.38) * (cinematicLevel >= 2 ? 1.45 : 1));
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  protected isPlayerShipFire(): boolean {
    return this.source?.type === EntityType.PlayerShip && this.team === Team.Player;
  }

  protected enableCometTrail(minDistance: number = 2.5): void {
    this.trailLifetime = COMET_TRAIL_LIFETIME;
    this.trailMinDistance = minDistance;
    this.trailMaxPoints = COMET_TRAIL_MAX_POINTS;
  }

  /** True when this projectile was fired by a fighter, bomber, or ship. */
  protected isShipOrFighterFire(): boolean {
    const t = this.source?.type;
    return t === EntityType.PlayerShip || t === EntityType.Fighter || t === EntityType.Bomber;
  }

  /**
   * Opt this projectile into the shared glow-ribbon trail renderer.  Also
   * tunes the position-history sampling so the ribbon stays smooth without
   * accumulating redundant points.  Falls back to the legacy per-class trail
   * automatically when Legacy Graphics is enabled.
   */
  protected enableGlowTrail(
    style: ProjectileTrailStyle,
    opts?: { maxSamples?: number; sampleDistance?: number },
  ): void {
    this.trailStyle = style;
    this.trailMaxPoints = opts?.maxSamples ?? 8;
    this.trailMinDistance = opts?.sampleDistance ?? 4;
    this.trailLifetime = style.fadeTime ?? this.trailLifetime;
  }

  protected drawCometTrail(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    glowColor: string,
    coreColor: string = 'rgba(255,255,255,0.92)',
    width: number = 8,
  ): void {
    if (!isLegacyGraphics() && this.trailStyle) {
      renderProjectileTrail(ctx, camera, this.trail, this.position, this.trailStyle);
      return;
    }
    if (this.trail.length < 2) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const cinematicLevel = getCinematicLevel();

    for (let layer = 0; layer < 3; layer++) {
      const layerWidth = width * (cinematicLevel >= 2 ? 1.35 : 1) * (layer === 0 ? 1 : layer === 1 ? 0.48 : 0.18);
      ctx.lineWidth = Math.max(1, layerWidth * camera.zoom);
      ctx.strokeStyle = layer === 2 ? coreColor : glowColor;
      for (let i = 1; i < this.trail.length; i++) {
        const a = this.trail[i - 1];
        const b = this.trail[i];
        const fade = 1 - ((a.age + b.age) * 0.5) / this.trailLifetime;
        if (fade <= 0) continue;
        const from = camera.worldToScreen(a.pos);
        const to = camera.worldToScreen(b.pos);
        const headBias = i / Math.max(1, this.trail.length - 1);
        ctx.globalAlpha = Math.min(1, (layer === 0 ? 0.18 : layer === 1 ? 0.34 : 0.62) * fade * (0.45 + headBias * 0.55) * (cinematicLevel >= 2 ? 1.35 : 1));
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
    }

    // Level 3: chromatic aberration fringe — red and blue ghost trails offset perpendicularly.
    if (cinematicLevel >= 3) {
      ctx.save();
      const aberrationWidth = Math.max(0.5, width * 0.22 * 1.35 * camera.zoom);
      ctx.lineWidth = aberrationWidth;
      for (let i = 1; i < this.trail.length; i++) {
        const a = this.trail[i - 1];
        const b = this.trail[i];
        const fade = 1 - ((a.age + b.age) * 0.5) / this.trailLifetime;
        if (fade <= 0) continue;
        const from = camera.worldToScreen(a.pos);
        const to   = camera.worldToScreen(b.pos);
        const tdx  = to.x - from.x;
        const tdy  = to.y - from.y;
        const tlen = Math.hypot(tdx, tdy) || 1;
        // Perpendicular unit vector.
        const px   =  tdy / tlen;
        const py   = -tdx / tlen;
        const offset = aberrationWidth * 1.8;
        const headBias = i / Math.max(1, this.trail.length - 1);
        ctx.globalAlpha = Math.min(1, 0.06 * fade * (0.45 + headBias * 0.55));

        // Red fringe.
        ctx.strokeStyle = 'rgba(255,60,40,1)';
        ctx.beginPath();
        ctx.moveTo(from.x + px * offset, from.y + py * offset);
        ctx.lineTo(to.x   + px * offset, to.y   + py * offset);
        ctx.stroke();

        // Blue fringe.
        ctx.strokeStyle = 'rgba(40,140,255,1)';
        ctx.beginPath();
        ctx.moveTo(from.x - px * offset, from.y - py * offset);
        ctx.lineTo(to.x   - px * offset, to.y   - py * offset);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Level 4: plasma compression rings — periodic expanding halos that eject
    // from the projectile head, giving the comet a "shockwave pulse" quality
    // not present at level 3.  Rings are spaced every ~4th trail segment and
    // expand outward as they age.
    if (cinematicLevel >= 4 && this.trail.length >= 4) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const step = Math.max(1, Math.floor(this.trail.length / 4));
      for (let i = step; i < this.trail.length; i += step) {
        const pt  = this.trail[i];
        const age = pt.age / this.trailLifetime;
        if (age <= 0 || age >= 1) continue;
        const scr      = camera.worldToScreen(pt.pos);
        const ringR    = Math.max(1, width * camera.zoom * (1.2 + age * 3.5));
        const ringAlpha = (1 - age) * 0.22;
        ctx.strokeStyle = glowColor.replace(/[\d.]+\)$/, `${ringAlpha.toFixed(3)})`);
        ctx.lineWidth   = Math.max(0.4, width * camera.zoom * 0.18 * (1 - age));
        ctx.beginPath();
        ctx.arc(scr.x, scr.y, ringR, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Level 5: filament braid accents sampled along the trail.
    if (cinematicLevel >= 5 && this.trail.length >= 5) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = Math.max(0.4, width * camera.zoom * 0.08);
      for (let i = 2; i < this.trail.length; i += 2) {
        const a = this.trail[i - 1];
        const b = this.trail[i];
        const fade = 1 - ((a.age + b.age) * 0.5) / this.trailLifetime;
        if (fade <= 0) continue;
        const from = camera.worldToScreen(a.pos);
        const to = camera.worldToScreen(b.pos);
        const tdx = to.x - from.x;
        const tdy = to.y - from.y;
        const tlen = Math.hypot(tdx, tdy) || 1;
        const px = tdy / tlen;
        const py = -tdx / tlen;
        const offset = Math.max(0.6, width * camera.zoom * 0.14);
        const braidA = Math.min(0.20, fade * 0.14);
        ctx.strokeStyle = `rgba(175,215,255,${braidA.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(from.x + px * offset, from.y + py * offset);
        ctx.lineTo(to.x - px * offset, to.y - py * offset);
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.restore();
  }
}
// ---------------------------------------------------------------------------

const NORMAL_CANNON_RANGE_MULTIPLIER = 0.75;

export class Bullet extends ProjectileBase {
  targetEntity: Entity | null = null;
  private readonly turnRate: number = 0.22;

  constructor(
    team: Team,
    position: Vec2,
    angle: number,
    source: Entity | null = null,
    target: Entity | null = null,
  ) {
    super({
      type: EntityType.Bullet,
      team,
      position,
      angle,
      damage: WEAPON_STATS.fire.damage,
      speed: WEAPON_STATS.fire.speed,
      lifetime: (WEAPON_STATS.fire.range * NORMAL_CANNON_RANGE_MULTIPLIER) / WEAPON_STATS.fire.speed,
      source,
    });
    this.targetEntity = target;
    if (this.isShipOrFighterFire()) {
      this.enableGlowTrail({
        color: colorToCSS(this.team === Team.Player ? Colors.bullet_player_cannon : Colors.bullet_enemy_cannon, 0.6),
        coreColor: 'rgba(255,255,255,0.95)',
        width: 6.5,
        fadeTime: 0.26,
      });
    } else if (this.isPlayerShipFire()) {
      this.enableCometTrail();
    }
  }

  update(dt: number): void {
    if (!this.alive) return;
    if (this.targetEntity && this.targetEntity.alive) {
      const desired = this.position.angleTo(this.targetEntity.position);
      const diff = wrapAngle(desired - this.angle);
      const steer = Math.max(-this.turnRate * dt, Math.min(this.turnRate * dt, diff));
      this.angle = wrapAngle(this.angle + steer);
      this.velocity = new Vec2(
        Math.cos(this.angle) * this.speed,
        Math.sin(this.angle) * this.speed,
      );
    }
    super.update(dt);
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const coreColor = this.team === Team.Player
      ? colorToCSS(Colors.bullet_player_cannon)
      : colorToCSS(Colors.bullet_enemy_cannon);
    const trailColor = this.team === Team.Player
      ? colorToCSS(Colors.bullet_player_cannon, 0.55)
      : colorToCSS(Colors.bullet_enemy_cannon, 0.55);
    if (this.isPlayerShipFire()) {
      this.drawCometTrail(ctx, camera, trailColor, 'rgba(255,255,255,0.95)', 7.5);
    } else {
      this.drawTrail(ctx, camera, trailColor);
    }

    // Bright elongated streak
    const tail = this.velocity.normalize().scale(-5 * camera.zoom);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = coreColor;
    ctx.lineWidth = 2.5 * camera.zoom;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y);
    ctx.lineTo(screen.x + tail.x, screen.y + tail.y);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 1.8 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export class GatlingBullet extends ProjectileBase {
  constructor(
    team: Team,
    position: Vec2,
    angle: number,
    source: Entity | null = null,
  ) {
    super({
      type: EntityType.Bullet,
      team,
      position,
      angle,
      damage: WEAPON_STATS.gatling.damage,
      speed: WEAPON_STATS.gatling.speed,
      lifetime: WEAPON_STATS.gatling.range / WEAPON_STATS.gatling.speed,
      source,
    });
    this.radius = ENTITY_RADIUS.bullet * 0.75;
    if (this.isShipOrFighterFire()) {
      this.enableGlowTrail({
        color: colorToCSS(this.team === Team.Player ? Colors.bullet_player_gatling : Colors.bullet_enemy_gatling, 0.68),
        coreColor: 'rgba(255,255,220,0.95)',
        width: 4.5,
        fadeTime: 0.14,
      }, { maxSamples: 7, sampleDistance: 3 });
    } else if (this.isPlayerShipFire()) {
      this.enableCometTrail(4);
    }
  }

  protected override updateTrail(dt: number): void {
    if (this.isShipOrFighterFire()) {
      super.updateTrail(dt);
      return;
    }
    this.compactTrail(dt, GATLING_TRAIL_LIFETIME);
    const last = this.trail[this.trail.length - 1];
    if (!last || last.pos.distanceTo(this.position) >= 5) {
      this.trail.push({ pos: this.position.clone(), age: 0 });
    }
    if (this.trail.length > 2) this.trail.shift();
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const coreColor = this.team === Team.Player
      ? colorToCSS(Colors.bullet_player_gatling)
      : colorToCSS(Colors.bullet_enemy_gatling);
    if (this.isPlayerShipFire()) {
      this.drawCometTrail(ctx, camera, colorToCSS(Colors.bullet_player_gatling, 0.72), 'rgba(255,255,220,0.95)', 5.5);
    } else {
      this.drawTrail(ctx, camera, coreColor, GATLING_TRAIL_LIFETIME, 1.25);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = coreColor;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 1.4 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export class GatlingTurretBullet extends ProjectileBase {
  constructor(
    team: Team,
    position: Vec2,
    angle: number,
    source: Entity | null = null,
  ) {
    super({
      type: EntityType.Bullet,
      team,
      position,
      angle,
      damage: WEAPON_STATS.gatlingturret.damage,
      speed: WEAPON_STATS.gatlingturret.speed,
      lifetime: WEAPON_STATS.gatlingturret.range / WEAPON_STATS.gatlingturret.speed,
      source,
    });
    this.radius = ENTITY_RADIUS.bullet * 0.65;
  }

  protected override updateTrail(dt: number): void {
    this.compactTrail(dt, GATLING_TRAIL_LIFETIME);
    const last = this.trail[this.trail.length - 1];
    if (!last || last.pos.distanceTo(this.position) >= 4) {
      this.trail.push({ pos: this.position.clone(), age: 0 });
    }
    if (this.trail.length > 3) this.trail.shift();
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const coreColor = this.team === Team.Player
      ? colorToCSS(Colors.bullet_player_turret)
      : colorToCSS(Colors.bullet_enemy_turret);
    this.drawTrail(ctx, camera, coreColor, GATLING_TRAIL_LIFETIME, 1.1);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = coreColor;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 1.2 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Missile – homing towards target
// ---------------------------------------------------------------------------

export class Missile extends ProjectileBase {
  targetEntity: Entity | null = null;
  readonly turnRate: number = 2.5;

  constructor(
    team: Team,
    position: Vec2,
    angle: number,
    source: Entity | null = null,
    target: Entity | null = null,
  ) {
    super({
      type: EntityType.Missile,
      team,
      position,
      angle,
      damage: WEAPON_STATS.missile.damage,
      speed: WEAPON_STATS.missile.speed,
      lifetime: WEAPON_STATS.missile.range / WEAPON_STATS.missile.speed,
      source,
    });
    this.radius = ENTITY_RADIUS.missile;
    this.targetEntity = target;
  }

  update(dt: number): void {
    if (!this.alive) return;

    // Homing behaviour
    if (this.targetEntity && this.targetEntity.alive) {
      const desired = this.position.angleTo(this.targetEntity.position);
      let diff = desired - this.angle;
      // Normalize
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const steer = Math.sign(diff) * Math.min(Math.abs(diff), this.turnRate * dt);
      this.angle += steer;
    }

    this.velocity = new Vec2(
      Math.cos(this.angle) * this.speed,
      Math.sin(this.angle) * this.speed,
    );

    super.update(dt);
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;
    // Warm ember trail regardless of team
    this.drawTrail(ctx, camera, colorToCSS(Colors.missile_trail, 0.72), BULLET_TRAIL_LIFETIME, 2.2);

    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(this.angle);

    // Engine glow (additive warm pulse at rear)
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = colorToCSS(Colors.missile_trail, 0.45);
    ctx.beginPath();
    ctx.arc(-r * 0.7, 0, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // Missile body — team-colored triangle
    const bodyColor = this.team === Team.Player
      ? colorToCSS(Colors.friendlyfire)
      : colorToCSS(Colors.enemyfire);
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.moveTo(r * 1.2, 0);
    ctx.lineTo(-r * 0.6, -r * 0.5);
    ctx.lineTo(-r * 0.6, r * 0.5);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }
}

export class GuidedMissile extends ProjectileBase {
  readonly blastRadius: number = 110;
  readonly releaseLifetime: number = 0.75;
  private readonly minSpeed: number = 110;
  private readonly maxSpeed: number = WEAPON_STATS.guidedmissile.speed;
  private readonly acceleration: number = 520;
  private readonly turnRate: number = 6.5;
  private guided = true;

  constructor(
    team: Team,
    position: Vec2,
    angle: number,
    source: Entity | null = null,
  ) {
    super({
      type: EntityType.Missile,
      team,
      position,
      angle,
      damage: WEAPON_STATS.guidedmissile.damage,
      speed: 110,
      lifetime: WEAPON_STATS.guidedmissile.range / WEAPON_STATS.guidedmissile.speed + 1.1,
      source,
    });
    this.radius = ENTITY_RADIUS.missile * 1.7;
    this.health = HP_VALUES.destructibleProjectile;
    this.maxHealth = HP_VALUES.destructibleProjectile;
    this.interceptable = true;
    if (this.isShipOrFighterFire()) {
      this.enableGlowTrail({
        color: colorToCSS(Colors.alert2, 0.8),
        coreColor: 'rgba(255,255,255,0.96)',
        width: 9,
        fadeTime: 0.3,
      }, { maxSamples: 9, sampleDistance: 4 });
    } else if (this.isPlayerShipFire()) {
      this.enableCometTrail(3.5);
    }
  }

  steerToward(target: Vec2): void {
    if (!this.guided || !this.alive) return;
    const desired = this.position.angleTo(target);
    const diff = wrapAngle(desired - this.angle);
    const maxStep = this.turnRate / 60;
    this.angle = wrapAngle(this.angle + Math.sign(diff) * Math.min(Math.abs(diff), maxStep));
  }

  release(): void {
    if (!this.guided) return;
    this.guided = false;
    this.lifetime = Math.min(this.lifetime, this.releaseLifetime);
  }

  update(dt: number): void {
    if (!this.alive) return;
    this.speed = Math.min(this.maxSpeed, Math.max(this.minSpeed, this.speed + this.acceleration * dt));
    this.velocity = new Vec2(Math.cos(this.angle) * this.speed, Math.sin(this.angle) * this.speed);
    super.update(dt);
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;
    if (this.isPlayerShipFire()) {
      this.drawCometTrail(ctx, camera, colorToCSS(Colors.alert2, 0.82), 'rgba(255,255,255,0.96)', 9);
    } else {
      this.drawTrail(ctx, camera, colorToCSS(Colors.alert2, 0.9), 0.14, 4);
    }
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(this.angle);
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 2.2);
    glow.addColorStop(0, 'rgba(255,255,255,0.65)');
    glow.addColorStop(0.35, colorToCSS(Colors.alert2, 0.36));
    glow.addColorStop(1, colorToCSS(Colors.explosion, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = colorToCSS(Colors.friendlyfire);
    ctx.beginPath();
    ctx.moveTo(r * 1.45, 0);
    ctx.lineTo(-r * 0.85, -r * 0.55);
    ctx.lineTo(-r * 0.45, 0);
    ctx.lineTo(-r * 0.85, r * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = colorToCSS(Colors.particles_neutral_exhaust, 0.75);
    ctx.beginPath();
    ctx.arc(-r, 0, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export class BomberMissile extends ProjectileBase {
  readonly blastRadius: number = 48;

  constructor(
    team: Team,
    position: Vec2,
    angle: number,
    source: Entity | null = null,
  ) {
    super({
      type: EntityType.Missile,
      team,
      position,
      angle,
      damage: WEAPON_STATS.bigmissile.damage,
      speed: WEAPON_STATS.bigmissile.speed,
      lifetime: WEAPON_STATS.bigmissile.range / WEAPON_STATS.bigmissile.speed,
      source,
    });
    this.radius = ENTITY_RADIUS.missile * 1.25;
    if (this.isShipOrFighterFire()) {
      this.enableGlowTrail({
        color: colorToCSS(Colors.missile_trail, 0.8),
        coreColor: 'rgba(255,225,180,0.95)',
        width: 6,
        fadeTime: 0.18,
      }, { maxSamples: 8, sampleDistance: 4 });
    }
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;
    this.drawTrail(ctx, camera, colorToCSS(Colors.missile_trail, 0.85), 0.14, 2.8);
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(this.angle);
    // Engine glow
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = colorToCSS(Colors.missile_trail, 0.38);
    ctx.beginPath();
    ctx.arc(-r * 0.8, 0, r * 0.65, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this.team === Team.Player ? colorToCSS(Colors.friendlyfire) : colorToCSS(Colors.enemyfire);
    ctx.beginPath();
    ctx.moveTo(r * 1.2, 0);
    ctx.lineTo(-r * 0.7, -r * 0.55);
    ctx.lineTo(-r * 0.7, r * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Laser – instant-hit beam
// ---------------------------------------------------------------------------

export class SynonymousNovaBomb extends ProjectileBase {
  readonly aoeRadius: number;
  readonly pulseDamage: number;
  readonly maxTravelDistance: number;
  private traveled = 0;
  private exploded = false;
  private pulseTimes = [-1, -1];

  constructor(team: Team, position: Vec2, angle: number, aoeRadius: number, pulseDamage: number, maxTravelDistance: number, source: Entity | null = null) {
    super({ type: EntityType.Missile, team, position, angle, damage: 0, speed: 145, lifetime: maxTravelDistance / 145 + 1.35, source });
    this.aoeRadius = aoeRadius;
    this.pulseDamage = pulseDamage;
    this.maxTravelDistance = maxTravelDistance;
    this.radius = ENTITY_RADIUS.missile * 1.8;
    this.interceptable = false;
  }

  override update(dt: number): void {
    if (!this.alive) return;
    if (!this.exploded) {
      const step = this.velocity.scale(dt);
      this.position = this.position.add(step);
      this.traveled += step.length();
      this.updateTrail(dt);
      if (this.traveled >= this.maxTravelDistance) this.triggerExplosion();
    } else {
      this.pulseTimes[0] -= dt;
      this.pulseTimes[1] -= dt;
    }
    this.lifetime -= dt;
    if (this.lifetime <= 0 || (this.exploded && this.pulseTimes[1] < -0.18)) this.destroy();
  }

  triggerExplosion(): void {
    if (this.exploded) return;
    this.exploded = true;
    this.velocity.set(0, 0);
    this.pulseTimes = [0, 1];
    this.lifetime = Math.max(this.lifetime, 1.25);
  }

  consumePulse(): boolean {
    if (!this.exploded) return false;
    for (let i = 0; i < this.pulseTimes.length; i++) {
      if (this.pulseTimes[i] <= 0 && this.pulseTimes[i] > -0.08) {
        this.pulseTimes[i] = -0.09;
        return true;
      }
    }
    return false;
  }

  override draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const t = performance.now() * 0.001;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (!this.exploded) {
      this.drawTrail(ctx, camera, colorToCSS(Colors.particles_switch, 0.72), 0.16, 2.2);
      const r = (5 + Math.sin(t * 19 + this.id) * 1.6) * camera.zoom;
      ctx.fillStyle = colorToCSS(Colors.explosion, 0.52);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colorToCSS(Colors.particles_switch, 0.9);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = colorToCSS(Colors.alert2, 0.65);
      ctx.lineWidth = Math.max(1, camera.zoom);
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = t * 7 + i * 2.399963;
        ctx.moveTo(screen.x, screen.y);
        ctx.lineTo(screen.x + Math.cos(a) * r * (1.6 + (i % 3)), screen.y + Math.sin(a) * r * (1.6 + (i % 3)));
      }
      ctx.stroke();
    } else {
      const radius = this.aoeRadius * camera.zoom;
      ctx.strokeStyle = colorToCSS(Colors.explosion, 0.42);
      ctx.lineWidth = Math.max(1.4, 2 * camera.zoom);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = colorToCSS(Colors.particles_switch, 0.22);
      ctx.setLineDash([7, 6]);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius * (0.55 + 0.08 * Math.sin(t * 8)), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }
}

export class Laser extends ProjectileBase {
  targetPos: Vec2;

  constructor(
    team: Team,
    startPos: Vec2,
    targetPos: Vec2,
    source: Entity | null = null,
  ) {
    const angle = startPos.angleTo(targetPos);
    super({
      type: EntityType.Laser,
      team,
      position: startPos,
      angle,
      damage: WEAPON_STATS.laser.damage,
      speed: 0,
      lifetime: 0.1,
      source,
    });
    this.targetPos = targetPos.clone();
    this.velocity.set(0, 0);
  }

  update(dt: number): void {
    if (!this.alive) return;
    this.lifetime -= dt;
    if (this.lifetime <= 0) this.destroy();
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const from = camera.worldToScreen(this.position);
    const to = camera.worldToScreen(this.targetPos);
    const fade = Math.max(0, this.lifetime / 0.1);
    const fireColor =
      this.team === Team.Player
        ? colorToCSS(Colors.friendlyfire, 0.85 * fade)
        : colorToCSS(Colors.enemyfire, 0.85 * fade);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.strokeStyle = this.team === Team.Player
      ? colorToCSS(Colors.friendlyfire, 0.16 * fade)
      : colorToCSS(Colors.enemyfire, 0.16 * fade);
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    ctx.strokeStyle = fireColor;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    const crawl = ((performance.now() * 0.12) % 12) - 12;
    ctx.setLineDash([8, 10]);
    ctx.lineDashOffset = crawl;
    ctx.strokeStyle = fireColor;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Bright core
    ctx.strokeStyle = `rgba(255,255,255,${0.72 * fade})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    ctx.strokeStyle = `rgba(255,255,255,${0.35 * fade})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(to.x, to.y, 5 * camera.zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// ExciterBullet – fast, small damage
// ---------------------------------------------------------------------------

export class SynonymousDroneLaser extends Laser {
  private static readonly LIFETIME = 0.32;

  constructor(team: Team, startPos: Vec2, targetPos: Vec2, source: Entity | null = null) {
    super(team, startPos, targetPos, source);
    this.damage = 0;
    this.lifetime = SynonymousDroneLaser.LIFETIME;
  }

  override draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const from = camera.worldToScreen(this.position);
    const to = camera.worldToScreen(this.targetPos);
    const fade = Math.pow(Math.max(0, this.lifetime / SynonymousDroneLaser.LIFETIME), 1.7);
    const fireColor = this.team === Team.Player
      ? colorToCSS(Colors.particles_switch, 0.62 * fade)
      : colorToCSS(Colors.enemyfire, 0.54 * fade);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.strokeStyle = colorToCSS(Colors.particles_switch, 0.10 * fade);
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.strokeStyle = fireColor;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }
}

export class SwarmFighterLaser extends Laser {
  private static readonly LIFETIME = 0.62;

  constructor(team: Team, startPos: Vec2, targetPos: Vec2, source: Entity | null = null) {
    super(team, startPos, targetPos, source);
    this.damage = 0;
    this.lifetime = SwarmFighterLaser.LIFETIME;
  }

  override draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const from = camera.worldToScreen(this.position);
    const to = camera.worldToScreen(this.targetPos);
    const fade = Math.pow(Math.max(0, this.lifetime / SwarmFighterLaser.LIFETIME), 2.25);
    const beamColor = this.team === Team.Player ? Colors.particles_switch : Colors.enemyfire;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.strokeStyle = colorToCSS(beamColor, 0.46 * fade);
    ctx.lineWidth = Math.max(3.0, 6.4 * camera.zoom);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    ctx.strokeStyle = colorToCSS(beamColor, 0.95 * fade);
    ctx.lineWidth = Math.max(1.45, 2.55 * camera.zoom);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    ctx.strokeStyle = colorToCSS(Colors.thrust_core_hot, 0.62 * fade);
    ctx.lineWidth = Math.max(0.9, 1.1 * camera.zoom);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }
}

export class ExciterBullet extends ProjectileBase {
  constructor(
    team: Team,
    position: Vec2,
    angle: number,
    source: Entity | null = null,
  ) {
    super({
      type: EntityType.ExciterBullet,
      team,
      position,
      angle,
      damage: WEAPON_STATS.exciterbullet.damage,
      speed: WEAPON_STATS.exciterbullet.speed,
      lifetime: WEAPON_STATS.exciterbullet.range / WEAPON_STATS.exciterbullet.speed,
      source,
    });
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    this.drawTrail(ctx, camera, colorToCSS(Colors.exciterturret_detail, 0.9));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = colorToCSS(Colors.exciterturret_detail, 0.85);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 2.2 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colorToCSS(Colors.particles_nova, 0.6);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 1.1 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// ExciterBeam – instant hit beam variant
// ---------------------------------------------------------------------------

export class ExciterBeam extends ProjectileBase {
  targetPos: Vec2;

  constructor(
    team: Team,
    startPos: Vec2,
    targetPos: Vec2,
    source: Entity | null = null,
  ) {
    const angle = startPos.angleTo(targetPos);
    super({
      type: EntityType.ExciterBeam,
      team,
      position: startPos,
      angle,
      damage: WEAPON_STATS.exciterbeam.damage,
      speed: 0,
      lifetime: 0.16,
      source,
    });
    this.targetPos = targetPos.clone();
    this.velocity.set(0, 0);
  }

  update(dt: number): void {
    if (!this.alive) return;
    this.lifetime -= dt;
    if (this.lifetime <= 0) this.destroy();
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const from = camera.worldToScreen(this.position);
    const to = camera.worldToScreen(this.targetPos);
    const fade = Math.max(0, this.lifetime / 0.16);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / len;
    const ny = dx / len;
    const pulse = 0.75 + 0.25 * Math.sin(this.lifetime * 180);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    // Broad shock halo.
    ctx.strokeStyle = colorToCSS(Colors.exciterturret_detail, 0.16 * fade);
    ctx.lineWidth = 22 * pulse;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    // Hot beam body.
    ctx.strokeStyle = colorToCSS(Colors.exciterturret_detail, 0.72 * fade);
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    // Twin cutting edges give the shot a heavy cannon-like read.
    ctx.strokeStyle = `rgba(255,180,70,${0.62 * fade})`;
    ctx.lineWidth = 2.2;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(from.x + nx * side * 5, from.y + ny * side * 5);
      ctx.lineTo(to.x + nx * side * 5, to.y + ny * side * 5);
      ctx.stroke();
    }
    // Bright core.
    ctx.strokeStyle = `rgba(255,255,230,${0.96 * fade})`;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    ctx.fillStyle = `rgba(255,245,190,${0.72 * fade})`;
    ctx.beginPath();
    ctx.arc(to.x, to.y, 8 + 8 * fade, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// MassDriverBullet – slow, high damage, penetrating
// ---------------------------------------------------------------------------

export class MassDriverBullet extends ProjectileBase {
  private burstElapsed = 0;
  private burstPulseIndex = 0;
  private bursting = false;
  private readonly travelRadius = 14;
  private readonly burstDuration = 4.35;
  private readonly expansionDuration = 0.28;
  readonly blastRadius = 0;

  constructor(
    team: Team,
    position: Vec2,
    angle: number,
    source: Entity | null = null,
  ) {
    super({
      type: EntityType.MassDriverBullet,
      team,
      position,
      angle,
      damage: WEAPON_STATS.massdriverbullet.damage,
      speed: WEAPON_STATS.massdriverbullet.speed,
      lifetime: WEAPON_STATS.massdriverbullet.range / WEAPON_STATS.massdriverbullet.speed,
      source,
    });
    this.radius = this.travelRadius;
  }

  triggerBurst(): void {
    if (this.bursting) return;
    this.bursting = true;
    this.burstElapsed = 0;
    this.burstPulseIndex = 0;
    this.velocity = new Vec2(0, 0);
    this.lifetime = this.burstDuration;
  }

  override update(dt: number): void {
    if (!this.alive) return;
    if (!this.bursting) {
      this.position = this.position.add(this.velocity.scale(dt));
      this.updateTrail(dt);
      this.lifetime -= dt;
      if (this.lifetime <= 0) this.triggerBurst();
      return;
    }

    this.burstElapsed += dt;
    this.lifetime -= dt;
    this.radius = this.currentBlastRadius();
    if (this.lifetime <= 0) this.destroy();
  }

  consumeDamagePulse(): number | null {
    if (!this.bursting) return null;
    const pulseAt = this.burstPulseIndex;
    if (this.burstPulseIndex < 5 && this.burstElapsed >= pulseAt) {
      this.burstPulseIndex++;
      return this.currentBlastRadius();
    }
    return null;
  }

  get isBursting(): boolean {
    return this.bursting;
  }

  /** How many damage pulses have been consumed so far (1 == the first blast). */
  get pulsesFired(): number {
    return this.burstPulseIndex;
  }

  private currentBlastRadius(): number {
    const grow = Math.min(1, this.burstElapsed / this.expansionDuration);
    const eased = 1 - Math.pow(1 - grow, 3);
    return this.travelRadius * (1 + eased * 6);
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const r = (this.bursting ? this.currentBlastRadius() : this.travelRadius) * camera.zoom;
    if (!this.bursting) this.drawTrail(ctx, camera, colorToCSS(Colors.alert2, 0.65), 0.18, 5);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    const crackle = 0.65 + 0.35 * Math.sin((this.burstElapsed + this.lifetime) * 34 + this.id);
    ctx.strokeStyle = colorToCSS(Colors.alert2, (this.bursting ? 0.35 : 0.55) * crackle);
    ctx.lineWidth = Math.max(1, camera.zoom * (this.bursting ? 3 : 5));
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r * (this.bursting ? 1 : 0.9), 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = colorToCSS(Colors.particles_switch, 0.24 * crackle);
    ctx.lineWidth = Math.max(1, camera.zoom * 1.5);
    for (let i = 0; i < 5; i++) {
      const a = this.burstElapsed * (5.5 + i) + i * 1.7 + this.id;
      const inner = r * (0.22 + (i % 2) * 0.2);
      const outer = r * (0.74 + (i % 3) * 0.09);
      ctx.beginPath();
      ctx.moveTo(screen.x + Math.cos(a) * inner, screen.y + Math.sin(a) * inner);
      ctx.lineTo(screen.x + Math.cos(a + 0.55) * outer, screen.y + Math.sin(a + 0.55) * outer);
      ctx.stroke();
    }
    ctx.fillStyle = colorToCSS(Colors.alert2, this.bursting ? 0.28 : 0.85);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, Math.max(2, r * (this.bursting ? 0.08 : 0.32)), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// RegenBullet – heals friendly, damages enemy
// ---------------------------------------------------------------------------

export class RegenBullet extends ProjectileBase {
  constructor(
    team: Team,
    position: Vec2,
    angle: number,
    source: Entity | null = null,
  ) {
    super({
      type: EntityType.RegenBullet,
      team,
      position,
      angle,
      damage: WEAPON_STATS.regenbullet.damage,
      speed: WEAPON_STATS.regenbullet.speed,
      lifetime: WEAPON_STATS.regenbullet.range / WEAPON_STATS.regenbullet.speed,
      source,
    });
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    this.drawTrail(ctx, camera, colorToCSS(Colors.particles_healing, 0.85));
    ctx.fillStyle = colorToCSS(Colors.particles_healing, 0.9);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 2 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// FireBomb – area damage on impact
// ---------------------------------------------------------------------------

export class FireBomb extends ProjectileBase {
  readonly blastRadius: number = 60;

  constructor(
    team: Team,
    position: Vec2,
    angle: number,
    source: Entity | null = null,
  ) {
    super({
      type: EntityType.FireBomb,
      team,
      position,
      angle,
      damage: WEAPON_STATS.firebomb.damage,
      speed: WEAPON_STATS.firebomb.speed,
      lifetime: WEAPON_STATS.firebomb.range / WEAPON_STATS.firebomb.speed,
      source,
    });
    this.radius = ENTITY_RADIUS.missile;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;
    const progress = 1 - this.lifetime / this.maxLifetime;

    // Pulsing glow that grows as it nears detonation
    const glow = r * (1 + progress * 0.5);
    ctx.fillStyle = colorToCSS(Colors.explosion, 0.3 + progress * 0.4);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, glow, 0, Math.PI * 2);
    ctx.fill();

    // Core
    ctx.fillStyle = colorToCSS(Colors.enemyfire);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// HomingBullet – cannon special: blue-tinted homing bullet (3× energy cost)
// ---------------------------------------------------------------------------

/**
 * Homing cannon bullet fired by the player's RMB cannon special.
 * Steers toward the nearest locked enemy at a moderate turn rate — not instant
 * perfect tracking — so skilled enemies can still dodge.  Visually distinct
 * from ordinary cannon rounds by its blue/cyan tint.
 */
export class HomingBullet extends ProjectileBase {
  targetEntity: Entity | null = null;
  /** Radians per second the bullet can turn.  Moderate — not instant. */
  readonly turnRate: number = 3.1;

  constructor(
    team: Team,
    position: Vec2,
    angle: number,
    source: Entity | null = null,
    target: Entity | null = null,
  ) {
    super({
      type: EntityType.Bullet,
      team,
      position,
      angle,
      damage: WEAPON_STATS.fire.damage, // same base damage as normal cannon
      speed: WEAPON_STATS.fire.speed,
      lifetime: WEAPON_STATS.fire.range / WEAPON_STATS.fire.speed,
      source,
    });
    this.radius = ENTITY_RADIUS.bullet * 1.15;
    this.targetEntity = target;
    if (this.isShipOrFighterFire()) {
      this.enableGlowTrail({
        color: colorToCSS(Colors.alliedfire, 0.7),
        coreColor: 'rgba(235,255,255,0.96)',
        width: 7,
        fadeTime: 0.26,
      });
    } else if (this.isPlayerShipFire()) {
      this.enableCometTrail();
    }
  }

  update(dt: number): void {
    if (!this.alive) return;
    // Steer toward target if it is still alive
    if (this.targetEntity && this.targetEntity.alive) {
      const desired = this.position.angleTo(this.targetEntity.position);
      const diff = wrapAngle(desired - this.angle);
      const steer = Math.max(-this.turnRate * dt, Math.min(this.turnRate * dt, diff));
      this.angle = wrapAngle(this.angle + steer);
      this.velocity = new Vec2(
        Math.cos(this.angle) * this.speed,
        Math.sin(this.angle) * this.speed,
      );
    }
    super.update(dt);
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    // Blue/cyan trail to distinguish from normal green cannon bullets
    const bulletColor = colorToCSS(Colors.alliedfire, 0.9);
    if (this.isPlayerShipFire()) {
      this.drawCometTrail(ctx, camera, colorToCSS(Colors.alliedfire, 0.72), 'rgba(235,255,255,0.96)', 8.5);
    } else {
      this.drawTrail(ctx, camera, bulletColor);
    }

    const tail = this.velocity.normalize().scale(-3 * camera.zoom);
    ctx.strokeStyle = bulletColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y);
    ctx.lineTo(screen.x + tail.x, screen.y + tail.y);
    ctx.stroke();

    // Glow core
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = colorToCSS(Colors.alliedfire, 0.4);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 3.5 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = bulletColor;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 2 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// SwarmMissile – guided-missile special: small blast-AOE, interceptable
// ---------------------------------------------------------------------------

/**
 * One missile in a rocket swarm (RMB ability for the guided-missile weapon).
 * Smaller than a BomberMissile but carries a blast radius so it deals AOE
 * damage on impact.  Setting `interceptable = true` allows enemy bullets to
 * destroy these missiles mid-flight, reusing the existing conduit-interaction
 * pattern.
 */
export class SwarmMissile extends ProjectileBase {
  /** AOE blast radius — smaller than a BomberMissile (48). */
  readonly blastRadius: number = 35;

  constructor(
    team: Team,
    position: Vec2,
    angle: number,
    source: Entity | null = null,
  ) {
    super({
      type: EntityType.Missile,
      team,
      position,
      angle,
      damage: Math.round(WEAPON_STATS.bigmissile.damage * SWARM_MISSILE_DAMAGE_MULTIPLIER),
      speed: WEAPON_STATS.missile.speed * 1.05,
      lifetime: (WEAPON_STATS.bigmissile.range * 0.65) / (WEAPON_STATS.missile.speed * 1.05),
      source,
    });
    this.radius = ENTITY_RADIUS.missile * 1.1;
    this.health = HP_VALUES.destructibleProjectile;
    this.maxHealth = HP_VALUES.destructibleProjectile;
    this.interceptable = true; // enemy bullets can destroy swarm missiles
    if (this.isShipOrFighterFire()) {
      this.enableGlowTrail({
        color: colorToCSS(Colors.alert2, 0.85),
        coreColor: 'rgba(255,240,210,0.95)',
        width: 5,
        fadeTime: 0.16,
      }, { maxSamples: 7, sampleDistance: 3 });
    }
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;
    const missileColor = colorToCSS(Colors.alert2, 0.9);
    this.drawTrail(ctx, camera, missileColor, 0.12, 2);
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(this.angle);
    ctx.fillStyle = missileColor;
    ctx.beginPath();
    ctx.moveTo(r * 1.1, 0);
    ctx.lineTo(-r * 0.6, -r * 0.5);
    ctx.lineTo(-r * 0.6, r * 0.5);
    ctx.closePath();
    ctx.fill();
    // Exhaust glow
    ctx.fillStyle = colorToCSS(Colors.particles_neutral_exhaust, 0.55);
    ctx.beginPath();
    ctx.arc(-r * 0.7, 0, r * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// ChargedLaserBurst – traveling vermiculate laser special
// ---------------------------------------------------------------------------

/**
 * A seeded, worm-like piercing laser. It sweeps damage along every movement
 * segment and remembers hit entity IDs so a given laser damages each target
 * at most once while passing through it.
 *
 * chargeFraction ∈ [0, 1] controls width and brightness.
 */
export class ChargedLaserBurst extends ProjectileBase {
  targetPos: Vec2;
  readonly chargeFraction: number;
  private readonly state: GameState;
  private readonly spaceFluid: SpaceFluid | null;
  private readonly hitIds = new Set<number>();
  private randomState: number;
  /** Seconds until the next gentle re-tuning of the arc. */
  private turnTimer = 0;
  /** Constant steering sign (+1 / -1); a laser mostly holds one curl. */
  private curveDir = 1;
  /** Current angular velocity in rad/s. Broad, slowly-varying arcs. */
  private curveRate = 1.05;

  constructor(
    team: Team,
    startPos: Vec2,
    targetPos: Vec2,
    source: Entity | null = null,
    chargeFraction: number = 1.0,
    state: GameState,
    spaceFluid: SpaceFluid | null,
    seed: number = 1,
  ) {
    const angle = startPos.angleTo(targetPos);
    super({
      type: EntityType.Laser,
      team,
      position: startPos,
      angle,
      damage: 0, // damage handled externally by damageLaserLine()
      speed: 570,
      lifetime: 2.15,
      source,
    });
    this.targetPos = startPos.clone();
    this.chargeFraction = Math.max(0, Math.min(1, chargeFraction));
    this.state = state;
    this.spaceFluid = spaceFluid;
    this.randomState = seed || 1;
    this.radius = 4 + this.chargeFraction * 2;
    this.trailLifetime = 0.72;
    this.trailMinDistance = 5;
    this.trailMaxPoints = 54;
    // Deterministic per-laser arc: one curl direction, a broad constant-ish
    // turn rate. This mirrors the circular tracers of TheroMathTD's
    // VermiculateEffect rather than the old rapidly-reversing "worm" jitter.
    this.curveDir = this.random() < 0.5 ? -1 : 1;
    this.curveRate = 0.85 + this.random() * 0.6;
    this.turnTimer = 1.1 + this.random() * 1.4;
  }

  update(dt: number): void {
    if (!this.alive) return;
    const previous = this.position.clone();
    this.turnTimer -= dt;
    if (this.turnTimer <= 0) {
      // Gentle re-tuning keeps the path wandering without worm-like jitter:
      // nudge the arc radius and, rarely, reverse the curl.
      this.turnTimer = 1.1 + this.random() * 1.4;
      this.curveRate = 0.85 + this.random() * 0.6;
      if (this.random() < 0.18) this.curveDir = -this.curveDir;
    }
    this.angle = wrapAngle(this.angle + this.curveDir * this.curveRate * dt);
    this.velocity.set(Math.cos(this.angle) * this.speed, Math.sin(this.angle) * this.speed);
    super.update(dt);
    this.targetPos = previous;
    damageLaserLine(this.state, this.spaceFluid, this.source ?? this, previous, this.position, this.damage, this.radius, this.hitIds);
  }

  private random(): number {
    let x = this.randomState | 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.randomState = x >>> 0;
    return this.randomState / 0x100000000;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const from = camera.worldToScreen(this.position);
    const to = camera.worldToScreen(this.targetPos);
    const fade = Math.min(1, this.lifetime / 0.32);
    const beamWidth = (2.2 + this.chargeFraction * 2.3) * camera.zoom;
    const burstColor = this.team === Team.Player ? Colors.friendlyfire : Colors.enemyfire;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    // Lightweight additive glow over the fading worm trail.
    this.drawTrail(ctx, camera, colorToCSS(burstColor, 0.8), this.trailLifetime, 11);
    ctx.strokeStyle = colorToCSS(burstColor, 0.28 * fade);
    ctx.lineWidth = beamWidth * 3.4;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    // Mid beam
    ctx.strokeStyle = colorToCSS(burstColor, 0.8 * fade);
    ctx.lineWidth = beamWidth;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    // Bright white core
    ctx.strokeStyle = `rgba(255,255,255,${0.65 * fade})`;
    ctx.lineWidth = beamWidth * 0.35;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    ctx.strokeStyle = colorToCSS(burstColor, 0.38 * fade);
    ctx.lineWidth = Math.max(1, 2 * camera.zoom);
    ctx.beginPath();
    ctx.arc(from.x, from.y, (7 + this.chargeFraction * 5) * camera.zoom * fade, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }
}
