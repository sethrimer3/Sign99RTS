/** Turret types for Sign99 */

import { Vec2, wrapAngle } from './math.js';
import { Camera } from './camera.js';
import { Entity, EntityType, Team } from './entities.js';
import { BuildingBase } from './building.js';
import { Colors, colorToCSS } from './colors.js';
import { ENTITY_RADIUS, WEAPON_STATS, DT, HP_VALUES } from './constants.js';
import type { GameState } from './gamestate.js';
import { ProjectileBase } from './projectile.js';
import { SynonymousDriftMine, SYNONYMOUS_MINE_LAYER_RANGE } from './synonymousMine.js';
import { aimAngle, aimAtEntity, isCombatTargetValid, isFiniteVec, isHostileTeam, type PredictiveAimResult } from './targeting.js';

export const EXCITER_LOCK_TIME_SECS = 2.0;
export const EXCITER_COOLDOWN_SECS = 3.0;
export const EXCITER_DAMAGE = WEAPON_STATS.exciterbeam.damage;
const EXCITER_LOCK_CIRCLE_RADIUS = 22;

function isExciterLockTarget(entity: Entity): boolean {
  return isTurretTargetableEntity(entity);
}

function isTurretTargetableEntity(entity: Entity): boolean {
  return !(entity instanceof ProjectileBase) || (entity.interceptable && entity.maxHealth > 1);
}

// ---------------------------------------------------------------------------
// Base turret
// ---------------------------------------------------------------------------

export abstract class TurretBase extends BuildingBase {
  targetEntity: Entity | null = null;
  commandTarget: Entity | null = null;
  fireTimer: number = 0;
  fireRate: number; // ticks between shots
  range: number;
  turretAngle: number = 0;
  beamTargetPos: Vec2 | null = null;
  beamTimer: number = 0;
  lastAim: PredictiveAimResult | null = null;

  constructor(
    type: EntityType,
    team: Team,
    position: Vec2,
    health: number,
    fireRate: number,
    range: number,
  ) {
    super(type, team, position, health, ENTITY_RADIUS.building);
    this.fireRate = fireRate;
    this.range = range;
  }

  update(dt: number): void {
    super.update(dt);
    if (!this.alive || this.buildProgress < 1 || !this.powered) return;

    // Rotate towards target
    if (this.targetEntity && this.targetEntity.alive) {
      const aim = this.computeAim(this.targetEntity);
      const desired = aimAngle(aim);
      if (desired === null) {
        this.lastAim = null;
        this.targetEntity = null;
      } else {
        this.lastAim = aim;
      const diff = wrapAngle(desired - this.turretAngle);
      const rotSpeed = 3.0;
      if (Math.abs(diff) < rotSpeed * dt) {
        this.turretAngle = desired;
      } else {
        this.turretAngle = wrapAngle(
          this.turretAngle + Math.sign(diff) * rotSpeed * dt,
        );
      }
      }
    }

    // Tick fire timer
    if (this.fireTimer > 0) {
      this.fireTimer -= dt;
    }
    if (this.beamTimer > 0) {
      this.beamTimer -= dt;
      if (this.beamTimer <= 0) this.beamTargetPos = null;
    }
  }

  /** Check if the turret can fire at its current target. */
  canFire(): boolean {
    if (!this.powered || this.buildProgress < 1 || this.fireTimer > 0 || !isCombatTargetValid(this, this.targetEntity, this.range)) {
      return false;
    }
    if (!isTurretTargetableEntity(this.targetEntity)) return false;
    const aim = this.computeAim(this.targetEntity);
    const angle = aimAngle(aim);
    if (angle === null || !isFiniteVec(aim.direction)) return false;
    this.lastAim = aim;
    this.turretAngle = angle;
    return true;
  }

  /** Consume a shot, resetting the fire timer. */
  consumeShot(): void {
    this.fireTimer = this.fireRate * DT;
  }

  showBeam(target: Vec2, duration: number = 0.18): void {
    this.beamTargetPos = target.clone();
    this.beamTimer = duration;
  }

  /**
   * Find and set the nearest valid target from a list of entities.
   * For most turrets this means nearest enemy; RegenTurret overrides this.
   */
  acquireTarget(entities: Entity[]): void {
    if (isCombatTargetValid(this, this.targetEntity, this.range) && isTurretTargetableEntity(this.targetEntity)) return;
    let best: Entity | null = null;
    let bestDist = this.range;
    for (const e of entities) {
      if (!e.alive || !isHostileTeam(this.team, e.team)) continue;
      if (!isTurretTargetableEntity(e)) continue;
      const d = this.position.distanceTo(e.position);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    this.targetEntity = best;
  }

  computeAim(target: Entity): PredictiveAimResult {
    return aimAtEntity(this, target, this.projectileSpeedForAim(), {
      maxPredictionTime: this.maxPredictionTimeForAim(),
      fallback: 'shortPrediction',
    });
  }

  projectileSpeedForAim(): number {
    switch (this.type) {
      case EntityType.GatlingTurret: return WEAPON_STATS.gatlingturret.speed;
      case EntityType.MissileTurret: return WEAPON_STATS.missile.speed;
      case EntityType.ExciterTurret: return 0;
      case EntityType.MassDriverTurret: return WEAPON_STATS.massdriverbullet.speed;
      default: return WEAPON_STATS.fire.speed;
    }
  }

  maxPredictionTimeForAim(): number {
    switch (this.type) {
      case EntityType.MissileTurret: return 0.55;
      case EntityType.MassDriverTurret: return 1.6;
      default: return 0.9;
    }
  }

  /** Common turret drawing: square platform + barrel line. */
  protected drawTurretBase(
    ctx: CanvasRenderingContext2D,
    screen: Vec2,
    r: number,
    detailColor: string,
    camera: Camera,
  ): void {
    const vis = this.drawBuildingBase(ctx, screen, detailColor, camera);

    // Barrel line
    ctx.strokeStyle = detailColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y);
    ctx.lineTo(
      screen.x + Math.cos(this.turretAngle) * vis.half * 0.9,
      screen.y + Math.sin(this.turretAngle) * vis.half * 0.9,
    );
    ctx.stroke();

  }

  protected drawBeam(ctx: CanvasRenderingContext2D, camera: Camera, screen: Vec2): void {
    if (!this.beamTargetPos || this.beamTimer <= 0) return;
    const target = camera.worldToScreen(this.beamTargetPos);
    const a = Math.min(1, this.beamTimer / 0.18);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = colorToCSS(Colors.particles_healing, 0.25 + a * 0.45);
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
    ctx.strokeStyle = colorToCSS(Colors.particles_switch, 0.45 + a * 0.35);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// GatlingTurret
// ---------------------------------------------------------------------------

export class GatlingTurret extends TurretBase {
  constructor(position: Vec2, team: Team) {
    super(
      EntityType.GatlingTurret,
      team,
      position,
      HP_VALUES.turret,
      WEAPON_STATS.gatlingturret.fireRate,
      WEAPON_STATS.gatlingturret.range,
    );
  }

  protected drawStructure(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;
    const detail = colorToCSS(Colors.gatlingturret_detail);
    this.drawTurretBase(ctx, screen, r, detail, camera);

    // Twin barrels
    const perpX = -Math.sin(this.turretAngle) * r * 0.22;
    const perpY = Math.cos(this.turretAngle) * r * 0.22;
    const endX = Math.cos(this.turretAngle) * r * 1.05;
    const endY = Math.sin(this.turretAngle) * r * 1.05;
    ctx.strokeStyle = detail;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(screen.x + perpX, screen.y + perpY);
    ctx.lineTo(screen.x + perpX + endX, screen.y + perpY + endY);
    ctx.moveTo(screen.x - perpX, screen.y - perpY);
    ctx.lineTo(screen.x - perpX + endX, screen.y - perpY + endY);
    ctx.stroke();

    // Rotating drum — 4 small cylinders in a ring, spinning with animationTime
    const drumR = r * 0.27;
    const drumDotR = Math.max(1.2, r * 0.062);
    const drumAngle = this.animationTime * 4.5;
    ctx.fillStyle = colorToCSS(Colors.gatlingturret_detail, 0.62);
    for (let i = 0; i < 4; i++) {
      const a = drumAngle + i * (Math.PI / 2);
      ctx.beginPath();
      ctx.arc(screen.x + Math.cos(a) * drumR, screen.y + Math.sin(a) * drumR, drumDotR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Idle scanning arc — slow sweep when no target is locked
    if (!this.targetEntity && this.powered && this.buildProgress >= 1) {
      const scanOsc = Math.sin(this.animationTime * 1.2) * 0.55;
      const scanCenter = this.turretAngle + scanOsc;
      const spanHalf = 0.26;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = colorToCSS(Colors.gatlingturret_detail, 0.28);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(screen.x, screen.y);
      ctx.arc(screen.x, screen.y, r * 1.65, scanCenter - spanHalf, scanCenter + spanHalf);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------------------
// MissileTurret
// ---------------------------------------------------------------------------

export class MissileTurret extends TurretBase {
  constructor(position: Vec2, team: Team) {
    super(
      EntityType.MissileTurret,
      team,
      position,
      HP_VALUES.turret,
      WEAPON_STATS.missile.fireRate,
      400,
    );
  }

  protected drawStructure(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;
    const detail = colorToCSS(Colors.missileturret_detail);
    this.drawTurretBase(ctx, screen, r, detail, camera);

    // Side-mounted launch pods — two thick stub barrels flanking the main barrel
    const cosA = Math.cos(this.turretAngle);
    const sinA = Math.sin(this.turretAngle);
    const perpX = -sinA * r * 0.32;
    const perpY =  cosA * r * 0.32;
    const tubeLen = r * 0.82;
    ctx.save();
    ctx.lineCap = 'square';
    ctx.strokeStyle = colorToCSS(Colors.missileturret_detail, 0.78);
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.beginPath();
    // Left pod
    ctx.moveTo(screen.x + perpX, screen.y + perpY);
    ctx.lineTo(screen.x + perpX + cosA * tubeLen, screen.y + perpY + sinA * tubeLen);
    // Right pod
    ctx.moveTo(screen.x - perpX, screen.y - perpY);
    ctx.lineTo(screen.x - perpX + cosA * tubeLen, screen.y - perpY + sinA * tubeLen);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.restore();

    // Missile silhouette at each pod tip
    ctx.fillStyle = detail;
    for (const sign of [1, -1]) {
      const ox = perpX * sign;
      const oy = perpY * sign;
      const tipX = screen.x + ox + cosA * tubeLen;
      const tipY = screen.y + oy + sinA * tubeLen;
      const backLen = r * 0.28;
      const wingSpan = r * 0.12;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - cosA * backLen + (-sinA) * wingSpan, tipY - sinA * backLen + cosA * wingSpan);
      ctx.lineTo(tipX - cosA * backLen - (-sinA) * wingSpan, tipY - sinA * backLen - cosA * wingSpan);
      ctx.closePath();
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------------------
// ExciterTurret
// ---------------------------------------------------------------------------

export class ExciterTurret extends TurretBase {
  lockTarget: Entity | null = null;
  lockProgress = 0;
  cooldownRemaining = 0;
  exciterState: 'idle' | 'locking' | 'ready' | 'cooldown' = 'idle';
  lastLaserTargetPos: Vec2 | null = null;

  constructor(position: Vec2, team: Team) {
    super(
      EntityType.ExciterTurret,
      team,
      position,
      HP_VALUES.turret,
      WEAPON_STATS.exciterbeam.fireRate,
      WEAPON_STATS.exciterbeam.range,
    );
  }

  override update(dt: number): void {
    super.update(dt);
    if (!this.alive || this.buildProgress < 1 || !this.powered) return;

    if (this.exciterState === 'cooldown') {
      this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);
      if (this.cooldownRemaining <= 0) this.exciterState = 'idle';
      return;
    }

    if (this.exciterState === 'locking') {
      if (!isCombatTargetValid(this, this.lockTarget, this.range) || !isExciterLockTarget(this.lockTarget)) {
        this.cancelLockToCooldown();
        return;
      }
      this.targetEntity = this.lockTarget;
      this.lockProgress = Math.min(1, this.lockProgress + dt / EXCITER_LOCK_TIME_SECS);
      if (this.lockTarget) {
        const desired = this.position.angleTo(this.lockTarget.position);
        const diff = wrapAngle(desired - this.turretAngle);
        this.turretAngle = wrapAngle(this.turretAngle + Math.sign(diff) * Math.min(Math.abs(diff), 4.2 * dt));
      }
      if (this.lockProgress >= 1) this.exciterState = 'ready';
    } else if (this.exciterState === 'ready') {
      if (!isCombatTargetValid(this, this.lockTarget, this.range) || !isExciterLockTarget(this.lockTarget)) {
        this.cancelLockToCooldown();
        return;
      }
      this.targetEntity = this.lockTarget;
    }
  }

  override acquireTarget(entities: Entity[]): void {
    if (this.exciterState !== 'idle') return;
    let best: Entity | null = null;
    let bestDist = this.range;
    for (const e of entities) {
      if (!e.alive || !isHostileTeam(this.team, e.team)) continue;
      if (!isExciterLockTarget(e)) continue;
      const d = this.position.distanceTo(e.position);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    if (best) {
      this.lockTarget = best;
      this.targetEntity = best;
      this.lockProgress = 0;
      this.exciterState = 'locking';
    }
  }

  override canFire(): boolean {
    if (!this.powered || this.buildProgress < 1 || this.exciterState !== 'ready') return false;
    if (!isCombatTargetValid(this, this.lockTarget, this.range) || !isExciterLockTarget(this.lockTarget)) {
      this.cancelLockToCooldown();
      return false;
    }
    this.targetEntity = this.lockTarget;
    return true;
  }

  override consumeShot(): void {
    this.lastLaserTargetPos = this.lockTarget?.position.clone() ?? null;
    this.lockTarget = null;
    this.targetEntity = null;
    this.lockProgress = 0;
    this.cooldownRemaining = EXCITER_COOLDOWN_SECS;
    this.exciterState = 'cooldown';
  }

  cancelLockToCooldown(): void {
    this.lockTarget = null;
    this.targetEntity = null;
    this.lockProgress = 0;
    this.cooldownRemaining = EXCITER_COOLDOWN_SECS;
    this.exciterState = 'cooldown';
  }

  protected drawStructure(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;
    const detail = colorToCSS(Colors.exciterturret_detail);
    this.drawExciterPlusBase(ctx, screen, detail, camera);

    // Y-shaped focusing mast: center spine + two diagonal wings spreading from mid-point.
    const baseHalf = this.getBaseVisual(camera).half;
    const spineLen = baseHalf * 0.62;
    const cosA = Math.cos(this.turretAngle);
    const sinA = Math.sin(this.turretAngle);
    // Spine
    ctx.strokeStyle = detail;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y);
    ctx.lineTo(screen.x + cosA * spineLen, screen.y + sinA * spineLen);
    ctx.stroke();
    // Wings branch from midpoint
    const pivotX = screen.x + cosA * baseHalf * 0.36;
    const pivotY = screen.y + sinA * baseHalf * 0.36;
    const wingLen = baseHalf * 0.32;
    const wingAngleL = this.turretAngle - 0.52;
    const wingAngleR = this.turretAngle + 0.52;
    ctx.strokeStyle = colorToCSS(Colors.exciterturret_detail, 0.75);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pivotX, pivotY);
    ctx.lineTo(pivotX + Math.cos(wingAngleL) * wingLen, pivotY + Math.sin(wingAngleL) * wingLen);
    ctx.moveTo(pivotX, pivotY);
    ctx.lineTo(pivotX + Math.cos(wingAngleR) * wingLen, pivotY + Math.sin(wingAngleR) * wingLen);
    ctx.stroke();
    // Glowing antenna tips when locking/ready
    if (this.exciterState === 'locking' || this.exciterState === 'ready') {
      const pulse = 0.5 + 0.5 * Math.sin(this.animationTime * 9);
      const alpha = 0.38 + this.lockProgress * 0.45 + pulse * 0.17;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = colorToCSS(Colors.exciterturret_detail, alpha);
      for (const wingA of [wingAngleL, wingAngleR]) {
        ctx.beginPath();
        ctx.arc(
          pivotX + Math.cos(wingA) * wingLen,
          pivotY + Math.sin(wingA) * wingLen,
          baseHalf * 0.07, 0, Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.restore();
    }
    this.drawLockOn(ctx, camera, screen);
  }

  private drawExciterPlusBase(ctx: CanvasRenderingContext2D, screen: Vec2, detailColor: string, camera: Camera): void {
    const v = this.getBaseVisual(camera);
    const x = screen.x - v.half;
    const y = screen.y - v.half;
    const cell = v.side / 4;
    const damage = 1 - Math.max(0, Math.min(1, this.healthFraction));
    const alpha = Math.max(0.15, this.buildProgress);
    const powerAlpha = this.powered ? 1 : 0.34;

    ctx.save();
    ctx.globalAlpha = alpha;
    const plus = new Path2D();
    plus.rect(x + cell, y, cell * 2, cell * 4);
    plus.rect(x, y + cell, cell * 4, cell * 2);
    ctx.clip(plus);

    const grad = ctx.createRadialGradient(screen.x, screen.y, cell * 0.2, screen.x, screen.y, v.half * 1.25);
    grad.addColorStop(0, `rgba(255, 202, 86, ${(0.84 * powerAlpha).toFixed(3)})`);
    grad.addColorStop(0.28, `rgba(92, 69, 35, ${(0.96 - damage * 0.25).toFixed(3)})`);
    grad.addColorStop(0.68, `rgba(34, 47, 43, ${(0.96 - damage * 0.22).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(10, 15, 18, 0.98)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, v.side, v.side);

    ctx.strokeStyle = colorToCSS(Colors.menu_background_detail, 0.42);
    ctx.lineWidth = Math.max(1, camera.zoom);
    ctx.beginPath();
    ctx.moveTo(x + cell, y + cell); ctx.lineTo(x + cell * 3, y + cell);
    ctx.moveTo(x + cell, y + cell * 3); ctx.lineTo(x + cell * 3, y + cell * 3);
    ctx.moveTo(x + cell, y + cell); ctx.lineTo(x + cell, y + cell * 3);
    ctx.moveTo(x + cell * 3, y + cell); ctx.lineTo(x + cell * 3, y + cell * 3);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colorToCSS(Colors.advanced_building, 0.55 * powerAlpha);
    ctx.lineWidth = Math.max(1.2, 1.8 * camera.zoom);
    ctx.stroke(plus);
    ctx.strokeStyle = detailColor;
    ctx.lineWidth = Math.max(1.1, 1.3 * camera.zoom);
    ctx.strokeRect(x + cell, y + cell, cell * 2, cell * 2);
    ctx.fillStyle = colorToCSS(Colors.menu_background_detail, 0.5);
    ctx.fillRect(x + cell * 1.36, y + cell * 1.36, cell * 1.28, cell * 1.28);
    ctx.fillStyle = this.powered
      ? colorToCSS(Colors.radar_allied_status, 0.74)
      : colorToCSS(Colors.alert1, 0.64);
    ctx.fillRect(x + cell * 1.2, y + cell * 2.78, cell * 1.6, Math.max(2, cell * 0.12));
    if (!this.powered) {
      ctx.strokeStyle = colorToCSS(Colors.alert1, 0.66);
      ctx.lineWidth = Math.max(1, camera.zoom);
      ctx.beginPath();
      ctx.moveTo(screen.x - cell * 0.24, screen.y - cell * 0.18);
      ctx.lineTo(screen.x, screen.y + cell * 0.28);
      ctx.lineTo(screen.x + cell * 0.24, screen.y - cell * 0.18);
      ctx.stroke();
    }
    if (this.buildProgress < 1) {
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.18);
      ctx.fillRect(x, y + v.side * this.buildProgress, v.side, v.side * (1 - this.buildProgress));
      if (!this.synonymousVisualKind) this.drawConstructionOverlay(ctx, x, y, v.side);
    }
    if (this.deleting) {
      ctx.fillStyle = colorToCSS(Colors.alert1, 0.18 + this.deletionProgress * 0.22);
      ctx.fillRect(x, y, v.side, v.side);
    }
    ctx.restore();
  }

  private drawLockOn(ctx: CanvasRenderingContext2D, camera: Camera, turretScreen: Vec2): void {
    if ((this.exciterState !== 'locking' && this.exciterState !== 'ready') || !this.lockTarget?.alive) return;
    const target = camera.worldToScreen(this.lockTarget.position);
    const progress = Math.max(0, Math.min(1, this.lockProgress));
    const circleR = EXCITER_LOCK_CIRCLE_RADIUS * camera.zoom;
    const outerGap = (42 - 26 * progress) * camera.zoom;
    const triLen = 10 * camera.zoom;
    const color = this.team === Team.Player ? Colors.friendlyfire : Colors.enemyfire;

    const dx = target.x - turretScreen.x;
    const dy = target.y - turretScreen.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const edgeX = target.x - (dx / len) * circleR;
    const edgeY = target.y - (dy / len) * circleR;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = colorToCSS(color, 0.2 + progress * 0.55);
    ctx.lineWidth = 0.8 + progress * 4.2;
    ctx.beginPath();
    ctx.moveTo(turretScreen.x, turretScreen.y);
    ctx.lineTo(edgeX, edgeY);
    ctx.stroke();

    ctx.strokeStyle = colorToCSS(Colors.exciterturret_detail, 0.62 + progress * 0.28);
    ctx.lineWidth = Math.max(1, 1.4 * camera.zoom);
    ctx.beginPath();
    ctx.arc(target.x, target.y, circleR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = colorToCSS(color, 0.12 + progress * 0.28);
    ctx.beginPath();
    ctx.moveTo(target.x, target.y);
    ctx.arc(target.x, target.y, circleR * 0.86, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = colorToCSS(color, 0.76 + progress * 0.22);
    ctx.lineWidth = Math.max(2, 3.4 * camera.zoom);
    ctx.beginPath();
    ctx.arc(target.x, target.y, circleR * 0.86, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    ctx.stroke();

    const tickCount = 12;
    ctx.strokeStyle = colorToCSS(Colors.exciterturret_detail, 0.28 + progress * 0.46);
    ctx.lineWidth = Math.max(1, 1.2 * camera.zoom);
    for (let i = 0; i < tickCount; i++) {
      const a = -Math.PI / 2 + (Math.PI * 2 * i) / tickCount;
      const inner = circleR * 1.05;
      const outer = circleR * 1.22;
      ctx.beginPath();
      ctx.moveTo(target.x + Math.cos(a) * inner, target.y + Math.sin(a) * inner);
      ctx.lineTo(target.x + Math.cos(a) * outer, target.y + Math.sin(a) * outer);
      ctx.stroke();
    }

    ctx.fillStyle = colorToCSS(color, 0.42 + progress * 0.42);
    const dirs = [
      { x: 0, y: -1, a: Math.PI / 2 },
      { x: 1, y: 0, a: Math.PI },
      { x: 0, y: 1, a: -Math.PI / 2 },
      { x: -1, y: 0, a: 0 },
    ];
    for (const d of dirs) {
      const tipX = target.x + d.x * (circleR + outerGap);
      const tipY = target.y + d.y * (circleR + outerGap);
      ctx.save();
      ctx.translate(tipX, tipY);
      ctx.rotate(d.a);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-triLen, -triLen * 0.55);
      ctx.lineTo(-triLen, triLen * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// MassDriverTurret
// ---------------------------------------------------------------------------

export class MassDriverTurret extends TurretBase {
  constructor(position: Vec2, team: Team) {
    super(
      EntityType.MassDriverTurret,
      team,
      position,
      HP_VALUES.turret,
      WEAPON_STATS.massdriverbullet.fireRate,
      500,
    );
  }

  protected drawStructure(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;
    const detail = colorToCSS(Colors.massdriverturret_detail);
    this.drawTurretBase(ctx, screen, r, detail, camera);

    // Thick reinforced barrel
    ctx.strokeStyle = detail;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y);
    const tipX = screen.x + Math.cos(this.turretAngle) * r * 1.2;
    const tipY = screen.y + Math.sin(this.turretAngle) * r * 1.2;
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // Kinetic reticle at barrel tip: 4 diagonal tick marks when targeting
    if (this.targetEntity?.alive) {
      const reticleR = r * 0.50;
      const arm = r * 0.28;
      const chargeBase = 1 - Math.max(0, this.fireTimer) / Math.max(0.001, this.fireRate * DT);
      const charge = Math.max(0, Math.min(1, chargeBase));
      ctx.save();
      ctx.strokeStyle = colorToCSS(Colors.massdriverturret_detail, 0.45 + charge * 0.35);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + i * (Math.PI / 2);
        ctx.moveTo(tipX + Math.cos(a) * reticleR, tipY + Math.sin(a) * reticleR);
        ctx.lineTo(tipX + Math.cos(a) * (reticleR + arm), tipY + Math.sin(a) * (reticleR + arm));
      }
      ctx.stroke();
      ctx.restore();
    }

    if (this.targetEntity && this.fireTimer <= this.fireRate * DT * 0.42) {
      const charge = 1 - Math.max(0, this.fireTimer) / Math.max(0.001, this.fireRate * DT * 0.42);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = colorToCSS(Colors.alert2, 0.18 + charge * 0.42);
      ctx.lineWidth = 1 + charge * 3;
      ctx.beginPath();
      ctx.arc(tipX, tipY, r * (0.25 + charge * 0.65), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = colorToCSS(Colors.explosion, 0.12 + charge * 0.28);
      ctx.beginPath();
      ctx.arc(tipX, tipY, r * (0.18 + charge * 0.32), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------------------
// RegenTurret – heals nearby friendlies instead of attacking
// ---------------------------------------------------------------------------

export class RegenTurret extends TurretBase {
  constructor(position: Vec2, team: Team) {
    super(
      EntityType.RegenTurret,
      team,
      position,
      HP_VALUES.turret,
      WEAPON_STATS.regenbullet.fireRate,
      300,
    );
  }

  /** Override: targets the nearest damaged friendly unit or building. */
  override canFire(): boolean {
    if (!this.powered || this.buildProgress < 1 || this.fireTimer > 0 || !this.targetEntity || !this.targetEntity.alive) return false;
    if (this.targetEntity.team !== this.team || this.targetEntity.health >= this.targetEntity.maxHealth) return false;
    if (!isFiniteVec(this.position) || !isFiniteVec(this.targetEntity.position)) return false;
    return this.position.distanceTo(this.targetEntity.position) <= this.range;
  }

  /** Override: targets the nearest damaged friendly unit or building. */
  acquireTarget(entities: Entity[]): void {
    if (
      this.commandTarget?.alive &&
      this.commandTarget.team !== Team.Neutral &&
      this.commandTarget.team !== this.team &&
      this.position.distanceTo(this.commandTarget.position) <= this.range
    ) {
      this.targetEntity = this.commandTarget;
      return;
    }
    if (this.commandTarget && (!this.commandTarget.alive || this.position.distanceTo(this.commandTarget.position) > this.range)) {
      this.commandTarget = null;
    }
    let best: Entity | null = null;
    let bestDist = this.range;
    for (const e of entities) {
      if (!e.alive || e.team !== this.team) continue;
      if (e.health >= e.maxHealth) continue;
      if (e === (this as Entity)) continue;
      const d = this.position.distanceTo(e.position);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    this.targetEntity = best;
  }

  protected drawStructure(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;
    const detail = colorToCSS(Colors.regenturret_detail);
    this.drawTurretBase(ctx, screen, r, detail, camera);
    this.drawBeam(ctx, camera, screen);

    // Pulsing healing aura when actively firing at a target
    if (this.beamTimer > 0 || (this.targetEntity?.alive && this.fireTimer < this.fireRate * DT * 0.3)) {
      const pulse = 0.5 + 0.5 * Math.sin(this.animationTime * 8);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = colorToCSS(Colors.particles_healing, 0.22 + pulse * 0.20);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * (1.4 + pulse * 0.18), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Plus / cross symbol with corner accent dots
    ctx.strokeStyle = colorToCSS(Colors.particles_healing, 0.85);
    ctx.lineWidth = 2;
    const s = r * 0.35;
    ctx.beginPath();
    ctx.moveTo(screen.x - s, screen.y);
    ctx.lineTo(screen.x + s, screen.y);
    ctx.moveTo(screen.x, screen.y - s);
    ctx.lineTo(screen.x, screen.y + s);
    ctx.stroke();
    // Corner accent dots
    ctx.fillStyle = colorToCSS(Colors.regenturret_detail, 0.48);
    const dotR = Math.max(1, r * 0.07);
    const dotOff = s * 0.75;
    for (const [dx, dy] of [[dotOff, dotOff], [-dotOff, dotOff], [dotOff, -dotOff], [-dotOff, -dotOff]]) {
      ctx.beginPath();
      ctx.arc(screen.x + dx, screen.y + dy, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------------------
// TetherTurret – latches onto an enemy ship and drags its speed down
// ---------------------------------------------------------------------------

/** Range at which a Tether can acquire and hold a ship. */
export const TETHER_RANGE = 420;
/** Peak slow fraction a single fully-charged Tether applies (20%). */
export const TETHER_MAX_SLOW = 0.2;
/** Seconds for a fresh Tether to ramp from 0% to peak slow. */
export const TETHER_RAMP_SECS = 3.0;
/** Seconds to recover to peak slow after a dash halves the hold. */
export const TETHER_RERAMP_SECS = 1.5;

export class TetherTurret extends TurretBase {
  /** Ship this Tether is currently latched onto. */
  tetherTarget: Entity | null = null;
  /** Current slow fraction this Tether contributes (0 .. TETHER_MAX_SLOW). */
  tetherStrength = 0;
  /** Last seen dashCount of the target, to detect dashes. */
  private targetDashCount = 0;
  /** Seconds left of accelerated re-ramp after a dash. */
  postDashTimer = 0;

  constructor(position: Vec2, team: Team) {
    super(
      EntityType.TetherTurret,
      team,
      position,
      HP_VALUES.turret,
      60,
      TETHER_RANGE,
    );
  }

  /** Tethers never fire projectiles — their effect is applied in GameState. */
  override canFire(): boolean {
    return false;
  }

  /** Advance the tether hold against `target` (already validated in range). */
  tickTether(target: Entity, dt: number): void {
    if (target !== this.tetherTarget) {
      this.tetherTarget = target;
      this.tetherStrength = 0;
      this.targetDashCount = target.dashCount;
      this.postDashTimer = 0;
    }
    if (target.dashCount !== this.targetDashCount) {
      this.targetDashCount = target.dashCount;
      this.tetherStrength *= 0.5;
      this.postDashTimer = TETHER_RERAMP_SECS;
    }
    const rate = this.postDashTimer > 0
      ? TETHER_MAX_SLOW / TETHER_RERAMP_SECS
      : TETHER_MAX_SLOW / TETHER_RAMP_SECS;
    this.tetherStrength = Math.min(TETHER_MAX_SLOW, this.tetherStrength + rate * dt);
    if (this.postDashTimer > 0) this.postDashTimer = Math.max(0, this.postDashTimer - dt);
    this.turretAngle = this.position.angleTo(target.position);
    this.beamTargetPos = target.position.clone();
  }

  /** Drop the current hold (target lost / out of range / turret unpowered). */
  releaseTether(): void {
    this.tetherTarget = null;
    this.tetherStrength = 0;
    this.postDashTimer = 0;
    this.beamTargetPos = null;
  }

  protected drawStructure(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;
    const detail = colorToCSS(Colors.exciterturret_detail);
    this.drawTurretBase(ctx, screen, r, detail, camera);

    // Emitter ring — three prongs that pulse brighter as the hold charges.
    const charge = this.tetherStrength / TETHER_MAX_SLOW;
    ctx.save();
    ctx.strokeStyle = colorToCSS(Colors.exciterturret_detail, 0.4 + charge * 0.5);
    ctx.lineWidth = Math.max(1.4, 2 * camera.zoom);
    for (let i = 0; i < 3; i++) {
      const a = this.turretAngle + (i - 1) * 0.9;
      ctx.beginPath();
      ctx.moveTo(screen.x + Math.cos(a) * r * 0.35, screen.y + Math.sin(a) * r * 0.35);
      ctx.lineTo(screen.x + Math.cos(a) * r * 1.05, screen.y + Math.sin(a) * r * 1.05);
      ctx.stroke();
    }
    ctx.restore();

    // Latch beam to the held ship.
    if (this.tetherTarget?.alive && this.beamTargetPos) {
      const t = camera.worldToScreen(this.beamTargetPos);
      const pulse = 0.5 + 0.5 * Math.sin(this.animationTime * 10);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = colorToCSS(Colors.exciterturret_detail, 0.25 + charge * 0.4 + pulse * 0.1);
      ctx.lineWidth = Math.max(1, (1.5 + charge * 2.5) * camera.zoom);
      ctx.beginPath();
      ctx.moveTo(screen.x, screen.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      ctx.restore();
    }
  }
}

export class SynonymousMineLayer extends BuildingBase {
  private spin = 0;
  private mineTimer = 0.35;
  private mineIndex = 0;

  constructor(position: Vec2, team: Team) {
    super(EntityType.TimeBomb, team, position, HP_VALUES.turret, ENTITY_RADIUS.building);
  }

  override update(dt: number): void {
    super.update(dt);
    if (!this.alive || this.buildProgress < 1) return;
    this.spin += dt * 0.55;
    this.mineTimer -= dt;
  }

  tickMineLayer(state: GameState): void {
    if (!this.alive || this.buildProgress < 1 || this.mineTimer > 0) return;
    const liveMines = state.projectiles.filter((p) => p.alive && p.source === this && p instanceof SynonymousDriftMine).length;
    if (liveMines >= 9) {
      this.mineTimer = 0.8;
      return;
    }
    const golden = Math.PI * (3 - Math.sqrt(5));
    const angle = this.spin + this.mineIndex * golden;
    const spawn = new Vec2(
      this.position.x + Math.cos(angle) * this.radius * 1.1,
      this.position.y + Math.sin(angle) * this.radius * 1.1,
    );
    state.addEntity(new SynonymousDriftMine(this.team, this.position, angle, SYNONYMOUS_MINE_LAYER_RANGE, this, state));
    const mine = state.projectiles[state.projectiles.length - 1];
    mine.position = spawn;
    this.mineIndex++;
    this.mineTimer = 2.7;
  }

  protected override drawStructure(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const screen = camera.worldToScreen(this.position);
    const side = this.radius * 2.6 * camera.zoom;
    const color = this.team === Team.Player ? Colors.friendlyfire : Colors.enemyfire;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = colorToCSS(color, 0.38 + this.healthFraction * 0.28);
    ctx.lineWidth = Math.max(1, 1.3 * camera.zoom);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, side * 0.48, 0, Math.PI * 2);
    ctx.stroke();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(this.spin);
    for (let i = 0; i < 20; i++) {
      const a = i * Math.PI * 2 / 20;
      const pulse = 0.86 + 0.14 * Math.sin(this.spin * 2 + i * 0.9);
      const x = Math.cos(a) * side * 0.42 * pulse;
      const y = Math.sin(a) * side * 0.42 * pulse;
      ctx.fillStyle = colorToCSS(color, 0.66);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.5, 2.1 * camera.zoom), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = colorToCSS(Colors.alert2, 0.35);
    ctx.beginPath();
    ctx.arc(0, 0, side * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

