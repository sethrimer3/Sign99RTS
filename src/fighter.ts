/** AI-controlled fighter and bomber ships for Sign99 */

import { Vec2, wrapAngle, randomRange } from './math.js';
import { Camera } from './camera.js';
import { Entity, EntityType, Team, ShipGroup } from './entities.js';
import { TICK_RATE } from './constants.js';
import { Shipyard } from './building.js';
import { Colors, colorToCSS, Color } from './colors.js';
import { ENTITY_RADIUS, HP_VALUES, PLAYER_SHIP_SCALE, SHIP_STATS, WEAPON_STATS } from './constants.js';
import { ShipHullDamage, type HullImpact } from './shipHullDamage.js';
import { gameplayFleetDesign } from './shipFamilies.js';
import { drawProceduralShip, shipDesignRadius, type ProceduralShipDefinition } from './proceduralShips.js';
import { teamColor } from './teamutils.js';
import { isLegacyGraphics } from './graphicsmode.js';
import { renderProjectileTrail, type ProjectileTrailStyle } from './projectileTrail.js';

export type FighterOrder = 'idle' | 'attack' | 'dock' | 'defend' | 'escort' | 'harass' | 'protect' | 'waypoint' | 'follow';

/** Research keys that grant an individual fighter-ship upgrade (applies to all fighter yard output). */
export const FIGHTER_UPGRADE_RESEARCH_KEYS = [
  'fighterTargeting',
  'fighterWeapon1',
  'fighterWeapon2',
  'fighterSpeed1',
  'fighterSpeed2',
  'fighterHp1',
  'fighterHp2',
] as const;

/** Apply a single fighter-upgrade research key's effect to one fighter. No-op for unrecognized keys. */
export function applyFighterResearchUpgrade(fighter: FighterShip, key: string): void {
  switch (key) {
    case 'fighterTargeting': fighter.upgradeTargeting(); break;
    case 'fighterWeapon1': fighter.upgradeWeaponDamage(); break;
    case 'fighterWeapon2': fighter.upgradeWeaponFireRate(); break;
    case 'fighterSpeed1': fighter.upgradeSpeed(); break;
    case 'fighterSpeed2': fighter.upgradeDash(); break;
    case 'fighterHp1': fighter.upgradeHp(); break;
    case 'fighterHp2': fighter.upgradeShield(); break;
    default: break;
  }
}

/** Revoke a single fighter-upgrade research key's effect on one fighter. No-op for unrecognized keys. */
function revokeFighterResearchUpgrade(fighter: FighterShip, key: string): void {
  switch (key) {
    case 'fighterTargeting': fighter.downgradeTargeting(); break;
    case 'fighterWeapon1': fighter.downgradeWeaponDamage(); break;
    case 'fighterWeapon2': fighter.downgradeWeaponFireRate(); break;
    case 'fighterSpeed1': fighter.downgradeSpeed(); break;
    case 'fighterSpeed2': fighter.downgradeDash(); break;
    case 'fighterHp1': fighter.downgradeHp(); break;
    case 'fighterHp2': fighter.downgradeShield(); break;
    default: break;
  }
}

/**
 * Reconcile one fighter's independent upgrade flags against the full set of
 * currently-completed research (supports 'building' research mode, where an
 * upgrade can be revoked by destroying its Research Node).
 */
export function syncFighterResearchUpgrades(fighter: FighterShip, completed: ReadonlySet<string>): void {
  for (const key of FIGHTER_UPGRADE_RESEARCH_KEYS) {
    if (completed.has(key)) applyFighterResearchUpgrade(fighter, key);
    else revokeFighterResearchUpgrade(fighter, key);
  }
}

const GROUP_COLORS: Record<ShipGroup, Color> = {
  [ShipGroup.Red]: Colors.redgroup,
  [ShipGroup.Green]: Colors.greengroup,
  [ShipGroup.Blue]: Colors.bluegroup,
};

const ENGAGE_RANGE = 300;
const DOCK_DISTANCE = 30;
const SHIELD_REGEN_RATE = 4;
const SHIELD_REGEN_DELAY = 2.0;
const PASSIVE_HEALTH_REGEN_DELAY = 5;
const PASSIVE_HEALTH_REGEN_RATE = 1;
const TRAIL_LIFETIME = 0.42;
const TRAIL_MIN_DISTANCE = 3;
const FIGHTER_VISUAL_SCALE = 0.75;
/** Instant velocity burst applied (as a multiple of maxSpeed) when a dash-unlocked fighter is given a new order. */
const ORDER_DASH_SPEED_MULT = 1.6;
const DASH_TRAIL_LIFETIME = 0.5;
const DASH_TRAIL_MIN_DISTANCE = 5;
const DASH_TRAIL_MAX_POINTS = 18;

interface TrailPoint {
  pos: Vec2;
  age: number;
}

const fighterPreviewCamera = new Camera();
fighterPreviewCamera.setScreenSize(0, 0);
fighterPreviewCamera.zoom = 1;
const fighterPreviewOrigin = new Vec2(0, 0);

/** Canonical Terran fighter hull, shared by gameplay and miniature UI previews. */
export function drawTerranFighterHull(
  ctx: CanvasRenderingContext2D,
  r: number,
  color: Color,
  hostile: boolean,
  alpha: number = 0.72,
): void {
  const def = gameplayFleetDesign(hostile ? Team.Player2 : Team.Player1, 'fighter');
  ctx.save();
  ctx.globalAlpha *= alpha;
  drawProceduralShip(ctx, fighterPreviewCamera, def, {
    position: fighterPreviewOrigin, rotation: 0, scale: r * 1.4 / shipDesignRadius(def), color,
  });
  ctx.restore();
}

// ---------------------------------------------------------------------------
// FighterShip
// ---------------------------------------------------------------------------

export class FighterShip extends Entity {
  fleetDesignOverride: ProceduralShipDefinition | null = null;
  get design() { return this.fleetDesignOverride ?? gameplayFleetDesign(this.team, this.type === EntityType.Bomber ? 'bomber' : 'fighter'); }
  group: ShipGroup;
  docked: boolean = true;
  order: FighterOrder = 'idle';
  targetPos: Vec2 | null = null;
  navigationTarget: Vec2 | null = null;
  homeYard: Shipyard | null = null;

  protected turnRate: number;
  protected thrustPower: number;
  protected maxSpeed: number;
  protected friction: number = 1.0;

  // Weapon
  fireTimer: number = 0;
  fireRate: number = 10; // ticks between shots
  weaponRange: number = 250;
  weaponDamage: number = 1;
  private readonly swarmSeed: number;
  private readonly orbitPhase: number;
  private readonly orbitRadius: number;
  private readonly orbitDrift: number;
  private avoidVelocity: Vec2 = new Vec2(0, 0);
  private trail: TrailPoint[] = [];
  shieldUnlocked = false;
  /** True while this fighter's own fighterHp2 research grants it a standing shield (independent of the player's escort aura). */
  protected hpShieldResearched = false;
  shield: number = 0;
  maxShield: number = 0;
  shieldRegenRate: number = SHIELD_REGEN_RATE;
  private shieldRegenDelay = 0;
  protected healthRegenDelay = 0;
  /**
   * True once every individual fighter upgrade has been granted. Used only
   * for LAN client mirroring (a single wire flag bundles the whole set) —
   * gameplay code should check the specific upgrade flag it cares about.
   */
  advancedTier = false;
  /** Individual, independently-researchable fighter upgrades. */
  targetingUpgraded = false;
  weaponDamageUpgraded = false;
  weaponFireRateUpgraded = false;
  speedUpgraded = false;
  dashUnlocked = false;
  hpUpgraded = false;
  private dashTrail: TrailPoint[] = [];
  private dashEffectTimer = 0;

  constructor(
    position: Vec2,
    team: Team,
    group: ShipGroup,
    homeYard: Shipyard | null = null,
  ) {
    super(
      EntityType.Fighter,
      team,
      position,
      SHIP_STATS.fighter.health,
      ENTITY_RADIUS.fighter * PLAYER_SHIP_SCALE,
    );
    this.hullDamage = new ShipHullDamage(() => this.design, 1.05);
    this.group = group;
    this.homeYard = homeYard;
    this.turnRate = SHIP_STATS.fighter.turnRate;
    this.thrustPower = SHIP_STATS.fighter.speed;
    this.maxSpeed = SHIP_STATS.fighter.speed;
    this.maxShield = this.maxHealth * 0.5;
    this.swarmSeed = Math.abs(Math.imul(this.id, 2654435761));
    this.orbitPhase = (this.swarmSeed % 6283) / 1000;
    this.orbitRadius = 34 + ((this.swarmSeed >>> 8) % 52);
    this.orbitDrift = 0.7 + ((this.swarmSeed >>> 16) % 70) / 100;
  }

  update(dt: number): void {
    if (!this.alive) return;
    if (this.docked) {
      this.trail.length = 0;
      return;
    }

    this.runAI(dt);
    this.applyPhysics(dt);
    this.updateTrail(dt);
    this.updateShield(dt);
    this.updatePassiveHealthRegen(dt);

    if (this.fireTimer > 0) this.fireTimer -= dt;
  }

  /** Override point for AI behaviour. */
  protected runAI(dt: number): void {
    switch (this.order) {
      case 'attack':
      case 'defend':
      case 'escort':
      case 'harass':
      case 'protect':
      case 'waypoint':
      case 'follow':
        this.aiAttack(dt);
        break;
      case 'dock':
        this.aiDock(dt);
        break;
      case 'idle':
      default:
        this.aiIdle(dt);
        break;
    }
  }

  // --- AI states ---

  private aiIdle(dt: number): void {
    const t = performance.now() * 0.001;
    this.angularVel += (Math.sin(t * this.orbitDrift + this.orbitPhase) * 0.7 + randomRange(-0.18, 0.18)) * dt;
    this.angle = wrapAngle(this.angle + this.angularVel * dt);
    this.angularVel *= 0.95;
    this.thrustForward(dt * 0.12);
  }

  private aiAttack(dt: number): void {
    if (!this.targetPos) {
      this.order = 'idle';
      return;
    }
    const steerTarget = this.steeringTarget() ?? this.targetPos;
    const dist = this.position.distanceTo(this.targetPos);
    if (this.order === 'waypoint' || this.order === 'follow' || this.order === 'protect') {
      const organicTarget = this.weaveTarget(steerTarget, 22 + this.orbitRadius * 0.35);
      this.steerTowards(organicTarget, dt);
      this.thrustForward(dt * (dist < 55 ? 0.35 : 0.85));
      return;
    }
    if (dist < 90) {
      const t = performance.now() * 0.001;
      // Alternate orbit direction periodically per-ship to avoid predictable circles.
      // Base frequency ~0.48 rad/s + per-ship seed offset (low 4 bits × 0.028) gives
      // each fighter a unique flip interval (~2–8 s).  Phase offset further de-syncs them.
      const orbitDir = Math.sin(t * (0.48 + (this.swarmSeed & 0xf) * 0.028) + this.orbitPhase * 2.5) > 0 ? 1 : -1;
      const circleTarget = new Vec2(
        this.targetPos.x - (this.position.y - this.targetPos.y) * orbitDir,
        this.targetPos.y + (this.position.x - this.targetPos.x) * orbitDir,
      );
      // Overlay organic weave on the orbit to break the circular pattern.
      const erraticTarget = this.weaveTarget(circleTarget, 24 + this.orbitRadius * 0.50);
      this.steerTowards(erraticTarget, dt);
      // Thrust ranges 0.26–0.54 (min + amplitude × sine) — surges and slowdowns.
      const thrustPulse = 0.26 + 0.28 * (0.5 + 0.5 * Math.sin(t * 1.15 + this.orbitPhase));
      this.thrustForward(dt * thrustPulse);
      return;
    }
    this.steerTowards(this.weaveTarget(steerTarget, 18 + this.orbitRadius * 0.28), dt);
    this.thrustForward(dt);
  }

  private aiDock(dt: number): void {
    if (!this.homeYard || !this.homeYard.alive) {
      this.order = 'idle';
      return;
    }
    const dist = this.position.distanceTo(this.homeYard.position);
    if (dist < DOCK_DISTANCE) {
      this.docked = true;
      this.velocity.set(0, 0);
      this.position = this.homeYard.position.clone();
      return;
    }
    this.steerTowards(this.steeringTarget() ?? this.homeYard.position, dt);
    this.thrustForward(dt);
  }

  // --- Helpers ---

  protected steerTowards(target: Vec2, dt: number): void {
    const desired = this.position.angleTo(target);
    const diff = wrapAngle(desired - this.angle);
    if (Math.abs(diff) < this.turnRate * dt) {
      this.angle = desired;
    } else {
      this.angle = wrapAngle(this.angle + Math.sign(diff) * this.turnRate * dt);
    }
  }

  protected thrustForward(dt: number): void {
    const thrust = new Vec2(Math.cos(this.angle), Math.sin(this.angle)).scale(
      this.thrustPower * dt,
    );
    this.velocity = this.velocity.add(thrust);
  }

  protected applyPhysics(dt: number): void {
    this.velocity = this.velocity.add(this.avoidVelocity.scale(dt));
    this.avoidVelocity = this.avoidVelocity.scale(0.65);
    this.velocity = this.velocity.scale(1 / (1 + this.friction * dt));
    const speed = this.velocity.length();
    const cap = this.maxSpeed * this.tetherSpeedMultiplier();
    if (speed > cap) {
      this.velocity = cap <= 0 ? new Vec2(0, 0) : this.velocity.normalize().scale(cap);
    }
    this.position = this.position.add(this.velocity.scale(dt));
  }

  /** Check whether the fighter should engage an enemy at the given position. */
  isInEngageRange(enemyPos: Vec2): boolean {
    return this.position.distanceTo(enemyPos) < ENGAGE_RANGE;
  }

  canFire(): boolean {
    return this.fireTimer <= 0 && !this.docked;
  }

  setNavigationTarget(target: Vec2 | null): void {
    this.navigationTarget = target ? target.clone() : null;
  }

  consumeShot(cooldownTicks: number): void {
    this.fireTimer = cooldownTicks / TICK_RATE;
  }

  /** Grants every individual fighter upgrade at once (used for LAN client mirroring). */
  upgradeToAdvanced(): void {
    if (this.advancedTier) return;
    this.advancedTier = true;
    this.upgradeTargeting();
    this.upgradeHp();
    this.upgradeShield();
    this.upgradeSpeed();
    this.upgradeDash();
    this.upgradeWeaponDamage();
    this.upgradeWeaponFireRate();
  }

  /** Smarter AI targeting/decision-making: hazard avoidance + turret-priority targeting. */
  upgradeTargeting(): void {
    this.targetingUpgraded = true;
  }

  /** +50% max HP. */
  upgradeHp(): void {
    if (this.hpUpgraded) return;
    this.hpUpgraded = true;
    this.maxHealth *= 1.5;
    this.health = this.maxHealth;
    if (this.shieldUnlocked) this.maxShield = this.maxHealth * 0.5;
  }

  /** Second HP tier: unlocks a shield equal to 50% of max HP. */
  upgradeShield(): void {
    this.hpShieldResearched = true;
    this.shieldUnlocked = true;
    this.maxShield = this.maxHealth * 0.5;
    this.shield = this.maxShield;
  }

  /** +50% thrust/speed, +20% turn rate. */
  upgradeSpeed(): void {
    if (this.speedUpgraded) return;
    this.speedUpgraded = true;
    this.thrustPower *= 1.5;
    this.maxSpeed *= 1.5;
    this.turnRate *= 1.2;
  }

  /** Second speed tier: an instant dash burst whenever the fighter is given a new order. */
  upgradeDash(): void {
    this.dashUnlocked = true;
  }

  /** +50% weapon damage, +8% weapon range. */
  upgradeWeaponDamage(): void {
    if (this.weaponDamageUpgraded) return;
    this.weaponDamageUpgraded = true;
    this.weaponDamage *= 1.5;
    this.weaponRange *= 1.08;
  }

  /** Second weapon tier: 50% faster fire rate. */
  upgradeWeaponFireRate(): void {
    if (this.weaponFireRateUpgraded) return;
    this.weaponFireRateUpgraded = true;
    this.fireRate = Math.max(1, this.fireRate / 1.5);
  }

  /**
   * Instant velocity burst toward `target`, mirroring the player ship's dash.
   * Called whenever a dash-unlocked fighter is given a fresh move order
   * (a new waypoint, follow, protect, or similar instruction) rather than on
   * every AI re-target within the same order.
   */
  triggerOrderDash(target: Vec2): void {
    if (!this.dashUnlocked || this.docked || !this.alive) return;
    const toTarget = target.sub(this.position);
    const dir = toTarget.length() > 1 ? toTarget.normalize() : new Vec2(Math.cos(this.angle), Math.sin(this.angle));
    this.velocity = dir.scale(this.maxSpeed * ORDER_DASH_SPEED_MULT);
    this.dashEffectTimer = DASH_TRAIL_LIFETIME;
    this.dashTrail = [
      { pos: this.position.add(dir.scale(-this.radius * 0.8)), age: DASH_TRAIL_LIFETIME * 0.16 },
      { pos: this.position.clone(), age: 0 },
    ];
  }

  /** Reverses upgradeToAdvanced() (used for LAN client mirroring). */
  downgradeFromAdvanced(): void {
    if (!this.advancedTier) return;
    this.advancedTier = false;
    this.downgradeTargeting();
    this.downgradeHp();
    this.downgradeShield();
    this.downgradeSpeed();
    this.downgradeDash();
    this.downgradeWeaponDamage();
    this.downgradeWeaponFireRate();
  }

  /** Reverses upgradeTargeting(). */
  downgradeTargeting(): void {
    this.targetingUpgraded = false;
  }

  /** Reverses upgradeHp(). */
  downgradeHp(): void {
    if (!this.hpUpgraded) return;
    const healthFraction = this.maxHealth > 0 ? this.health / this.maxHealth : 1;
    this.hpUpgraded = false;
    this.maxHealth /= 1.5;
    this.health = Math.max(1, this.maxHealth * healthFraction);
    if (this.shieldUnlocked) this.maxShield = this.maxHealth * 0.5;
  }

  /** Reverses upgradeShield(). Leaves an escort-granted shield (from the player's aura) untouched. */
  downgradeShield(): void {
    if (!this.hpShieldResearched) return;
    this.hpShieldResearched = false;
    this.shieldUnlocked = false;
    this.maxShield = 0;
    this.shield = 0;
  }

  /** Reverses upgradeSpeed(). */
  downgradeSpeed(): void {
    if (!this.speedUpgraded) return;
    this.speedUpgraded = false;
    this.thrustPower /= 1.5;
    this.maxSpeed /= 1.5;
    this.turnRate /= 1.2;
  }

  /** Reverses upgradeDash(). */
  downgradeDash(): void {
    this.dashUnlocked = false;
  }

  /** Reverses upgradeWeaponDamage(). */
  downgradeWeaponDamage(): void {
    if (!this.weaponDamageUpgraded) return;
    this.weaponDamageUpgraded = false;
    this.weaponDamage /= 1.5;
    this.weaponRange /= 1.08;
  }

  /** Reverses upgradeWeaponFireRate(). */
  downgradeWeaponFireRate(): void {
    if (!this.weaponFireRateUpgraded) return;
    this.weaponFireRateUpgraded = false;
    this.fireRate *= 1.5;
  }

  avoidHazard(center: Vec2, radius: number, dt: number): void {
    if (!this.alive || this.docked || radius <= 0) return;
    const offset = this.position.sub(center);
    const dist = offset.length();
    const avoidRadius = radius + this.radius + 72;
    if (dist <= 0.001 || dist > avoidRadius) return;
    const strength = (1 - dist / avoidRadius) * this.maxSpeed * 5.5 * dt;
    this.avoidVelocity = this.avoidVelocity.add(offset.scale(1 / dist).scale(strength));
  }

  firingOrigin(index: number = 0): Vec2 {
    void index;
    return this.position.clone();
  }

  /** Undock from shipyard and take off. */
  launch(): void {
    this.docked = false;
    this.angle = randomRange(0, Math.PI * 2);
    this.velocity = new Vec2(Math.cos(this.angle), Math.sin(this.angle)).scale(
      this.maxSpeed * 0.3,
    );
    this.trail = [{ pos: this.position.clone(), age: 0 }];
  }

  destroy(): void {
    super.destroy();
    if (this.homeYard) {
      this.homeYard.activeShips = Math.max(0, this.homeYard.activeShips - 1);
    }
  }

  enableShield(): void {
    const wasUnlocked = this.shieldUnlocked;
    this.shieldUnlocked = true;
    this.maxShield = this.maxHealth * 0.5;
    if (!wasUnlocked) {
      this.shield = this.maxShield;
      this.shieldRegenDelay = 0;
    }
  }

  /** Turns off an escort-granted shield. A no-op while fighterHp2 grants this fighter its own standing shield. */
  disableShield(): void {
    if (this.hpShieldResearched) return;
    this.shieldUnlocked = false;
    this.shield = 0;
    this.shieldRegenDelay = 0;
  }

  override takeDamage(amount: number, source?: Entity, impact?: HullImpact): void {
    if (!this.alive || amount <= 0) {
      super.takeDamage(amount, source, impact);
      return;
    }
    this.markTookDamage();
    if (this.shieldUnlocked && this.shield > 0) {
      const blocked = Math.min(this.shield, amount);
      this.shield -= blocked;
      amount -= blocked;
      this.shieldRegenDelay = SHIELD_REGEN_DELAY;
    }
    if (amount > 0) {
      if (this.hullDamage) {
        if (source) this.lastDamageSource = source;
        this.hullDamage.hit(this, amount, impact);
        if (this.health <= 0 || this.hullDamage.coreIntegrity <= 0) {
          this.health = 0;
          this.destroy();
        }
      } else {
        super.takeDamage(amount, source, impact);
      }
    }
  }

  protected markTookDamage(): void {
    this.healthRegenDelay = PASSIVE_HEALTH_REGEN_DELAY;
  }

  private updateShield(dt: number): void {
    if (!this.shieldUnlocked) return;
    if (this.shieldRegenDelay > 0) {
      this.shieldRegenDelay -= dt;
      return;
    }
    this.shield = Math.min(this.maxShield, this.shield + this.shieldRegenRate * dt);
  }

  protected updatePassiveHealthRegen(dt: number): void {
    if (this.healthRegenDelay > 0) {
      this.healthRegenDelay -= dt;
      return;
    }
    if (this.health > 0 && this.health < this.maxHealth) {
      const amount = PASSIVE_HEALTH_REGEN_RATE * dt;
      if (this.hullDamage) {
        this.hullDamage.repair(this, amount);
      } else {
        this.health = Math.min(this.maxHealth, this.health + amount);
      }
    }
  }

  private updateTrail(dt: number): void {
    let write = 0;
    for (let read = 0; read < this.trail.length; read++) {
      const point = this.trail[read];
      point.age += dt;
      if (point.age <= TRAIL_LIFETIME) this.trail[write++] = point;
    }
    this.trail.length = write;
    const last = this.trail[this.trail.length - 1];
    if (!last) {
      this.trail.push({ pos: this.position.clone(), age: 0 });
    } else {
      const dist = last.pos.distanceTo(this.position);
      if (dist >= 4000) {
        this.trail.length = 0;
        this.trail.push({ pos: this.position.clone(), age: 0 });
      } else if (dist >= TRAIL_MIN_DISTANCE) {
        this.trail.push({ pos: this.position.clone(), age: 0 });
      }
    }
    while (this.trail.length > 20) this.trail.shift();

    let dashWrite = 0;
    for (let read = 0; read < this.dashTrail.length; read++) {
      const point = this.dashTrail[read];
      point.age += dt;
      if (point.age <= DASH_TRAIL_LIFETIME) this.dashTrail[dashWrite++] = point;
    }
    this.dashTrail.length = dashWrite;

    if (this.dashEffectTimer > 0) {
      this.dashEffectTimer = Math.max(0, this.dashEffectTimer - dt);
      const dashLast = this.dashTrail[this.dashTrail.length - 1];
      if (!dashLast) {
        this.dashTrail.push({ pos: this.position.clone(), age: 0 });
      } else {
        const dist = dashLast.pos.distanceTo(this.position);
        if (dist >= 4000) {
          this.dashTrail.length = 0;
          this.dashTrail.push({ pos: this.position.clone(), age: 0 });
        } else if (dist > DASH_TRAIL_MIN_DISTANCE * 4) {
          const steps = Math.min(3, Math.floor(dist / DASH_TRAIL_MIN_DISTANCE));
          for (let s = 1; s < steps; s++) {
            const f = s / steps;
            this.dashTrail.push({
              pos: new Vec2(
                dashLast.pos.x + (this.position.x - dashLast.pos.x) * f,
                dashLast.pos.y + (this.position.y - dashLast.pos.y) * f,
              ),
              age: 0,
            });
          }
          this.dashTrail.push({ pos: this.position.clone(), age: 0 });
        } else if (dist >= DASH_TRAIL_MIN_DISTANCE) {
          this.dashTrail.push({ pos: this.position.clone(), age: 0 });
        }
      }
    }
    while (this.dashTrail.length > DASH_TRAIL_MAX_POINTS) this.dashTrail.shift();
  }

  protected drawMotionTrail(ctx: CanvasRenderingContext2D, camera: Camera, color: Color): void {
    if (this.trail.length >= 1) {
      if (isLegacyGraphics()) {
        if (this.trail.length >= 2) {
          const speedFraction = Math.max(0, Math.min(1, this.velocity.length() / Math.max(1, this.maxSpeed)));
          const sizeScale = 0.2 + speedFraction * 0.8;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.lineWidth = 5 * sizeScale;
          for (let i = 1; i < this.trail.length; i++) {
            const a = this.trail[i - 1];
            const b = this.trail[i];
            const fade = 1 - Math.max(a.age, b.age) / TRAIL_LIFETIME;
            if (fade <= 0) continue;
            const from = camera.worldToScreen(a.pos);
            const to = camera.worldToScreen(b.pos);
            ctx.strokeStyle = colorToCSS(color, 0.08 + fade * 0.28);
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.stroke();
          }
          ctx.restore();
        }
      } else {
        const speedFraction = Math.max(0, Math.min(1, this.velocity.length() / Math.max(1, this.maxSpeed)));
        const sizeScale = 0.2 + speedFraction * 0.8;
        const trailStyle: ProjectileTrailStyle = {
          color: colorToCSS(color, 0.42),
          coreColor: colorToCSS(color, 0.80),
          fadeTime: TRAIL_LIFETIME,
          width: Math.max(2, 8 * sizeScale),
          outerWidthMultiplier: 2.2,
          outerAlpha: 0.15 * sizeScale,
          innerWidthMultiplier: 1.0,
          innerAlpha: 0.38 * sizeScale,
          coreWidthMultiplier: 0.35,
          coreAlpha: 0.65 * sizeScale,
          taperExponent: 1.05,
          opacityExponent: 1.25,
        };
        renderProjectileTrail(ctx, camera, this.trail, this.position, trailStyle);
      }
    }
    if (this.dashTrail.length >= 1) {
      if (isLegacyGraphics()) {
        if (this.dashTrail.length >= 2) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.lineWidth = 6;
          for (let i = 1; i < this.dashTrail.length; i++) {
            const a = this.dashTrail[i - 1];
            const b = this.dashTrail[i];
            const fade = 1 - Math.max(a.age, b.age) / DASH_TRAIL_LIFETIME;
            if (fade <= 0) continue;
            const from = camera.worldToScreen(a.pos);
            const to = camera.worldToScreen(b.pos);
            ctx.strokeStyle = colorToCSS(Colors.general_building, 0.15 + fade * 0.5);
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.stroke();
          }
          ctx.restore();
        }
      } else {
        const dashStyle: ProjectileTrailStyle = {
          color: colorToCSS(Colors.general_building, 0.75),
          coreColor: 'rgba(255, 255, 255, 0.95)',
          fadeTime: DASH_TRAIL_LIFETIME,
          width: 14,
          outerWidthMultiplier: 2.4,
          outerAlpha: 0.24,
          innerWidthMultiplier: 1.0,
          innerAlpha: 0.55,
          coreWidthMultiplier: 0.35,
          coreAlpha: 0.90,
          taperExponent: 1.15,
          opacityExponent: 1.25,
        };
        renderProjectileTrail(ctx, camera, this.dashTrail, this.position, dashStyle);
      }
    }
  }

  protected drawFleetHull(ctx: CanvasRenderingContext2D, camera: Camera): void {
    drawProceduralShip(ctx, camera, this.design, {
      position: this.position, rotation: this.angle,
      scale: this.radius * 1.05 / shipDesignRadius(this.design), color: teamColor(this.team),
      damageMesh: this.hullDamage?.renderMesh(),
    });
  }

  // --- Drawing ---

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive || this.docked) return;
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom * FIGHTER_VISUAL_SCALE;
    const coreColor = teamColor(this.team);
    this.drawMotionTrail(ctx, camera, coreColor);

    const coreTime = performance.now() * 0.001 + this.orbitPhase;
    this.drawFleetHull(ctx, camera);

    const groupColor = GROUP_COLORS[this.group];
    const pulse = 0.5 + 0.5 * Math.sin(coreTime * 2.8);
    const glint = 0.5 + 0.5 * Math.sin(coreTime * 5.3 + 1.2);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = colorToCSS(coreColor, 0.12 + pulse * 0.14);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r * 1.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colorToCSS(groupColor, 0.20 + pulse * 0.14);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r * (0.62 + pulse * 0.08), coreTime, coreTime + Math.PI * 1.35);
    ctx.stroke();
    // Engine exhaust glow at rear
    const exhaustX = screen.x - Math.cos(this.angle) * r * 0.7;
    const exhaustY = screen.y - Math.sin(this.angle) * r * 0.7;
    const exhaustColor = this.team === Team.Player ? Colors.particles_friendly_exhaust : Colors.particles_enemy_exhaust;
    ctx.fillStyle = colorToCSS(exhaustColor, 0.18 + pulse * 0.10);
    ctx.beginPath();
    ctx.arc(exhaustX, exhaustY, r * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = colorToCSS(coreColor, 0.72 + 0.28 * this.healthFraction);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colorToCSS(Colors.particles_switch, 0.25 + glint * 0.18);
    ctx.beginPath();
    ctx.arc(screen.x - r * 0.09, screen.y - r * 0.09, r * 0.14, 0, Math.PI * 2);
    ctx.fill();

    if (this.shieldUnlocked && this.shield > 0) {
      const shieldFrac = this.shield / this.maxShield;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = colorToCSS(Colors.radar_allied_status, 0.16 + shieldFrac * 0.34);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * (1.55 + shieldFrac * 0.08), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  applySeparationFrom(other: FighterShip, dt: number): void {
    if (!this.alive || this.docked || !other.alive || other.docked || other === this) return;
    const dx = this.position.x - other.position.x;
    const dy = this.position.y - other.position.y;
    const distSq = dx * dx + dy * dy;
    const desired = Math.max(20, this.radius + other.radius + 18);
    if (distSq <= 0.0001 || distSq > desired * desired) return;
    const dist = Math.sqrt(distSq);
    const push = (1 - dist / desired) * 210 * dt;
    this.avoidVelocity = this.avoidVelocity.add(new Vec2(dx / dist, dy / dist).scale(push));
  }

  private weaveTarget(base: Vec2, amount: number): Vec2 {
    const t = performance.now() * 0.001;
    const waveA = t * this.orbitDrift + this.orbitPhase;
    const waveB = t * (this.orbitDrift * 0.43 + 0.19) + this.orbitPhase * 1.7;
    const radius = Math.min(this.orbitRadius, amount) * (0.82 + 0.18 * Math.sin(waveB));
    return new Vec2(
      base.x + Math.cos(waveA) * radius + Math.sin(waveB * 1.31) * amount * 0.35,
      base.y + Math.sin(waveA * 0.91) * radius + Math.cos(waveB) * amount * 0.35,
    );
  }

  private steeringTarget(): Vec2 | null {
    return this.navigationTarget ?? this.targetPos;
  }
}

// ---------------------------------------------------------------------------
// SynonymousFighterShip - one squad simulated as one fighter, drawn as drones
// ---------------------------------------------------------------------------

export class SynonymousFighterShip extends FighterShip {
  droneCount: 3 | 6;
  private droneHp: number[];
  private splitProgress = 0;
  private splitHoldRemaining = 0;

  constructor(
    position: Vec2,
    team: Team,
    group: ShipGroup,
    homeYard: Shipyard | null = null,
    advanced: boolean = false,
  ) {
    super(position, team, group, homeYard);
    this.hullDamage = null;
    this.droneCount = advanced ? 6 : 3;
    this.droneHp = Array(this.droneCount).fill(HP_VALUES.synonymousFighterDrone);
    this.maxHealth = this.droneCount * HP_VALUES.synonymousFighterDrone;
    this.health = this.maxHealth;
    this.maxShield = this.maxHealth * 0.5;
    this.weaponDamage = 1;
    this.fireRate = 34;
    this.weaponRange = 230;
  }

  get livingDroneCount(): number {
    return this.droneHp.reduce((sum, hp) => sum + (hp > 0 ? 1 : 0), 0);
  }

  override update(dt: number): void {
    super.update(dt);
    if (this.splitHoldRemaining > 0 && this.splitProgress >= 0.92) {
      this.splitHoldRemaining = Math.max(0, this.splitHoldRemaining - dt);
    }
    const targetSplit = this.splitHoldRemaining > 0 ? 1 : 0;
    const smoothing = targetSplit > this.splitProgress ? 3.2 : 1.85;
    this.splitProgress += (targetSplit - this.splitProgress) * (1 - Math.exp(-smoothing * dt));
  }

  markCombatSplit(): void {
    this.splitHoldRemaining = Math.max(this.splitHoldRemaining, 1.0);
  }

  override firingOrigin(index: number = 0): Vec2 {
    const local = this.localDroneOffset(this.livingDroneIndex(index), this.splitProgress);
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    return new Vec2(
      this.position.x + local.x * c - local.y * s,
      this.position.y + local.x * s + local.y * c,
    );
  }

  private localDroneOffset(index: number, splitAmount: number): Vec2 {
    const compact: Array<[number, number]> = [
      [13, 0],
      [-9, -10],
      [-9, 10],
      [2, -5],
      [-9, 0],
      [2, 5],
    ];
    const separated: Array<[number, number]> = [
      [31, 0],
      [-20, -27],
      [-20, 27],
      [14, -23],
      [-34, 0],
      [14, 23],
    ];
    const base = compact[index % this.droneCount];
    const open = separated[index % this.droneCount];
    const eased = splitAmount * splitAmount * (3 - 2 * splitAmount);
    const wave = performance.now() * 0.006 + this.id * 0.37 + index * 1.9;
    const drift = eased * 5.5;
    return new Vec2(
      base[0] + (open[0] - base[0]) * eased + Math.cos(wave) * drift,
      base[1] + (open[1] - base[1]) * eased + Math.sin(wave * 1.3) * drift,
    );
  }

  override takeDamage(amount: number, source?: Entity, impact?: HullImpact): void {
    if (!this.alive || amount <= 0) {
      super.takeDamage(amount, source, impact);
      return;
    }
    let remaining = amount;
    this.markTookDamage();
    let start = 0;
    if (source) {
      const angle = Math.atan2(source.position.y - this.position.y, source.position.x - this.position.x);
      start = Math.abs(Math.floor(((angle + Math.PI) / (Math.PI * 2)) * this.droneCount)) % this.droneCount;
    }
    while (remaining > 0 && this.livingDroneCount > 0) {
      let idx = -1;
      for (let i = 0; i < this.droneCount; i++) {
        const probe = (start + i) % this.droneCount;
        if (this.droneHp[probe] > 0) { idx = probe; break; }
      }
      if (idx < 0) break;
      const applied = Math.min(this.droneHp[idx], remaining);
      this.droneHp[idx] -= applied;
      remaining -= applied;
      start = (idx + 1) % this.droneCount;
    }
    this.health = this.droneHp.reduce((sum, hp) => sum + Math.max(0, hp), 0);
    if (this.health <= 0) this.destroy();
  }

  private livingDroneIndex(shotIndex: number): number {
    for (let i = 0; i < this.droneCount; i++) {
      const probe = (shotIndex + i) % this.droneCount;
      if (this.droneHp[probe] > 0) return probe;
    }
    return 0;
  }

  protected override updatePassiveHealthRegen(dt: number): void {
    if (this.healthRegenDelay > 0) {
      this.healthRegenDelay -= dt;
      return;
    }
    if (this.health <= 0 || this.health >= this.maxHealth) return;
    let healing = PASSIVE_HEALTH_REGEN_RATE * dt;
    for (let i = 0; i < this.droneHp.length && healing > 0; i++) {
      if (this.droneHp[i] <= 0 || this.droneHp[i] >= HP_VALUES.synonymousFighterDrone) continue;
      const applied = Math.min(HP_VALUES.synonymousFighterDrone - this.droneHp[i], healing);
      this.droneHp[i] += applied;
      healing -= applied;
    }
    this.health = this.droneHp.reduce((sum, hp) => sum + Math.max(0, hp), 0);
  }

  override draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive || this.docked) return;
    const screen = camera.worldToScreen(this.position);
    const color = this.team === Team.Player ? Colors.mainguy : Colors.enemy_status;
    const nodeR = Math.max(1.35, 2.6 * camera.zoom * FIGHTER_VISUAL_SCALE);
    const split = this.splitProgress > 0.04;
    this.drawMotionTrail(ctx, camera, color);

    const points: Vec2[] = [];
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(this.angle);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.droneCount; i++) {
      if (this.droneHp[i] <= 0) continue;
      const p = this.localDroneOffset(i, this.splitProgress).scale(camera.zoom * FIGHTER_VISUAL_SCALE);
      points.push(p);
    }

    if (points.length >= 2) {
      ctx.strokeStyle = colorToCSS(color, 0.34 * (1 - this.splitProgress * 0.72));
      ctx.lineWidth = Math.max(0.75, 1.1 * camera.zoom * FIGHTER_VISUAL_SCALE);
      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }

    if (!split) {
      // Hexagonal center core
      const hexR = nodeR * 1.8;
      ctx.strokeStyle = colorToCSS(color, 0.52);
      ctx.lineWidth = Math.max(0.6, 0.9 * camera.zoom * FIGHTER_VISUAL_SCALE);
      ctx.beginPath();
      for (let j = 0; j < 6; j++) {
        const a = j * Math.PI / 3;
        if (j === 0) ctx.moveTo(Math.cos(a) * hexR, Math.sin(a) * hexR);
        else ctx.lineTo(Math.cos(a) * hexR, Math.sin(a) * hexR);
      }
      ctx.closePath();
      ctx.stroke();
      // Center glow dot
      ctx.fillStyle = colorToCSS(color, 0.72);
      ctx.beginPath();
      ctx.arc(0, 0, nodeR * 0.65, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (split) {
        const tri = nodeR * 2.0;
        ctx.strokeStyle = colorToCSS(Colors.particles_switch, 0.32);
        ctx.lineWidth = Math.max(0.55, 0.8 * camera.zoom * FIGHTER_VISUAL_SCALE);
        ctx.beginPath();
        for (let j = 0; j < 3; j++) {
          const a = -Math.PI / 2 + j * Math.PI * 2 / 3 + this.drawPhase();
          const x = p.x + Math.cos(a) * tri;
          const y = p.y + Math.sin(a) * tri;
          if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      }
      ctx.fillStyle = colorToCSS(color, 0.82);
      ctx.beginPath();
      ctx.arc(p.x, p.y, nodeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = colorToCSS(Colors.particles_switch, 0.24);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawPhase(): number {
    return (performance.now() * 0.001 + this.id * 0.07) % (Math.PI * 2);
  }
}

// ---------------------------------------------------------------------------
// BomberShip – slower, more HP, higher damage
// ---------------------------------------------------------------------------

export class BomberShip extends FighterShip {
  constructor(
    position: Vec2,
    team: Team,
    group: ShipGroup,
    homeYard: Shipyard | null = null,
  ) {
    super(position, team, group, homeYard);
    this.type = EntityType.Bomber;
    this.health = SHIP_STATS.bomber.health;
    this.maxHealth = SHIP_STATS.bomber.health;
    this.maxShield = this.maxHealth * 0.5;
    this.radius = ENTITY_RADIUS.bomber * (team === Team.Player ? PLAYER_SHIP_SCALE : 1);
    this.turnRate = SHIP_STATS.bomber.turnRate;
    this.thrustPower = SHIP_STATS.bomber.speed;
    this.maxSpeed = SHIP_STATS.bomber.speed;
    this.fireRate = 20;
    this.weaponRange = 200;
    this.weaponDamage = WEAPON_STATS.bigmissile.damage;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive || this.docked) return;
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;
    const coreColor = teamColor(this.team);
    this.drawMotionTrail(ctx, camera, coreColor);

    this.drawFleetHull(ctx, camera);

    const coreTime = performance.now() * 0.001;
    const groupColor = GROUP_COLORS[this.group];
    const pulse = 0.5 + 0.5 * Math.sin(coreTime * 2.3 + this.id);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = colorToCSS(coreColor, 0.12 + pulse * 0.14);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r * 1.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colorToCSS(groupColor, 0.20 + pulse * 0.13);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r * (0.65 + pulse * 0.08), -coreTime, -coreTime + Math.PI * 1.35);
    ctx.stroke();
    // Bomber engine glows (two rear exhausts)
    const exhaustColor = this.team === Team.Player ? Colors.particles_friendly_exhaust : Colors.particles_enemy_exhaust;
    for (const dy of [-0.45, 0.45]) {
      const ex = screen.x - Math.cos(this.angle) * r * 0.55 + Math.sin(this.angle) * r * dy;
      const ey = screen.y - Math.sin(this.angle) * r * 0.55 - Math.cos(this.angle) * r * dy;
      ctx.fillStyle = colorToCSS(exhaustColor, 0.22 + pulse * 0.12);
      ctx.beginPath();
      ctx.arc(ex, ey, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.fillStyle = colorToCSS(coreColor, 0.72 + 0.28 * this.healthFraction);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colorToCSS(Colors.particles_switch, 0.28);
    ctx.beginPath();
    ctx.arc(screen.x - r * 0.1, screen.y - r * 0.1, r * 0.14, 0, Math.PI * 2);
    ctx.fill();

    if (this.shieldUnlocked && this.shield > 0) {
      const shieldFrac = this.shield / this.maxShield;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = colorToCSS(Colors.radar_allied_status, 0.16 + shieldFrac * 0.34);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * (1.35 + shieldFrac * 0.08), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------------------
// SwarmShip - tiny Terran laser skirmisher from the Swarm Yard
// ---------------------------------------------------------------------------

export class SwarmShip extends FighterShip {
  constructor(
    position: Vec2,
    team: Team,
    group: ShipGroup,
    homeYard: Shipyard | null = null,
  ) {
    super(position, team, group, homeYard);
    this.health = HP_VALUES.swarm;
    this.maxHealth = HP_VALUES.swarm;
    this.maxShield = 0;
    this.radius = 2.3 * (team === Team.Player ? PLAYER_SHIP_SCALE : 1);
    this.turnRate = 5.5;
    this.thrustPower = 310;
    this.maxSpeed = 310;
    this.fireRate = 26;
    this.weaponRange = 175;
    this.weaponDamage = 0.75;
  }

  /** Swarm ships never gain a shield — the HP tier-2 upgrade is a no-op for them. */
  override upgradeShield(): void {
    this.maxShield = 0;
    this.shield = 0;
  }

  override downgradeShield(): void {
    this.maxShield = 0;
    this.shield = 0;
  }

  protected override updatePassiveHealthRegen(dt: number): void {
    if (!this.hpUpgraded) return;
    super.updatePassiveHealthRegen(dt);
  }

  override draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive || this.docked) return;
    this.drawFleetHull(ctx, camera);
  }

}

const NOVA_BOMBER_DRONES = 10;
const NOVA_BOMBER_DRONE_HP = HP_VALUES.synonymousFighterDrone;
const NOVA_BOMBER_MAX_AOE = 56;
const NOVA_BOMBER_CHARGE_SECONDS = 1.15;

export class SynonymousNovaBomberShip extends BomberShip {
  private droneHp: number[] = Array(NOVA_BOMBER_DRONES).fill(NOVA_BOMBER_DRONE_HP);
  private chargeTimer = 0;
  private charging = false;
  private chargeTarget: Vec2 | null = null;

  constructor(position: Vec2, team: Team, group: ShipGroup, homeYard: Shipyard | null = null) {
    super(position, team, group, homeYard);
    this.hullDamage = null;
    this.weaponRange = 245;
    this.fireRate = 130;
    this.maxHealth = NOVA_BOMBER_DRONES * NOVA_BOMBER_DRONE_HP;
    this.health = this.maxHealth;
  }

  get livingDroneCount(): number {
    return this.droneHp.reduce((sum, hp) => sum + (hp > 0 ? 1 : 0), 0);
  }

  get novaAoeRadius(): number {
    return NOVA_BOMBER_MAX_AOE * Math.max(0, this.livingDroneCount / NOVA_BOMBER_DRONES);
  }

  get novaDamagePerPulse(): number {
    const lost = NOVA_BOMBER_DRONES - this.livingDroneCount;
    return this.livingDroneCount > 0 ? Math.max(1, 5 - Math.floor(lost / 2)) : 0;
  }

  get novaMaxTravelDistance(): number {
    return this.weaponRange + 62;
  }

  beginNovaCharge(target: Vec2): void {
    if (this.charging || this.livingDroneCount <= 0) return;
    this.charging = true;
    this.chargeTimer = 0;
    this.chargeTarget = target.clone();
  }

  consumeChargedNova(): { target: Vec2; aoeRadius: number; damage: number; travel: number } | null {
    if (!this.charging || this.chargeTimer < NOVA_BOMBER_CHARGE_SECONDS || !this.chargeTarget) return null;
    const result = {
      target: this.chargeTarget.clone(),
      aoeRadius: this.novaAoeRadius,
      damage: this.novaDamagePerPulse,
      travel: this.novaMaxTravelDistance,
    };
    this.charging = false;
    this.chargeTimer = 0;
    this.chargeTarget = null;
    this.consumeShot(WEAPON_STATS.bigmissile.fireRate);
    return result;
  }

  override canFire(): boolean {
    return super.canFire() || this.charging;
  }

  override update(dt: number): void {
    super.update(dt);
    if (this.charging) this.chargeTimer += dt;
  }

  override takeDamage(amount: number, source?: Entity, impact?: HullImpact): void {
    if (!this.alive || amount <= 0) {
      super.takeDamage(amount, source, impact);
      return;
    }
    // Conservative sub-drone adapter: incoming damage is assigned to one
    // living drone at a time, biased by source angle when a source exists.
    let remaining = amount;
    this.markTookDamage();
    let start = 0;
    if (source) {
      const angle = Math.atan2(source.position.y - this.position.y, source.position.x - this.position.x);
      start = Math.abs(Math.floor(((angle + Math.PI) / (Math.PI * 2)) * NOVA_BOMBER_DRONES)) % NOVA_BOMBER_DRONES;
    }
    while (remaining > 0 && this.livingDroneCount > 0) {
      let idx = -1;
      for (let i = 0; i < NOVA_BOMBER_DRONES; i++) {
        const probe = (start + i) % NOVA_BOMBER_DRONES;
        if (this.droneHp[probe] > 0) { idx = probe; break; }
      }
      if (idx < 0) break;
      const applied = Math.min(this.droneHp[idx], remaining);
      this.droneHp[idx] -= applied;
      remaining -= applied;
      start = (idx + 1) % NOVA_BOMBER_DRONES;
    }
    this.health = this.droneHp.reduce((sum, hp) => sum + Math.max(0, hp), 0);
    if (this.health <= 0) this.destroy();
  }

  private localNovaOffset(index: number): Vec2 {
    const t = performance.now() * 0.001;
    const seed = this.id * 0.173 + index * 1.971;
    const charge = this.charging ? Math.min(1, this.chargeTimer / NOVA_BOMBER_CHARGE_SECONDS) : 0;
    const collapse = charge < 0.45 ? 1 - charge / 0.45 : (charge - 0.45) / 0.55;
    const radius = (10 + (index % 5) * 3.1 + Math.sin(t * 1.7 + seed) * 4.5) * (0.18 + 0.82 * collapse);
    const angle = seed + Math.sin(t * 1.2 + seed * 1.7) * 0.9 + Math.cos(t * 0.73 + index) * 0.55;
    return new Vec2(Math.cos(angle) * radius, Math.sin(angle) * radius * (0.72 + 0.2 * Math.sin(seed)));
  }

  protected override updatePassiveHealthRegen(dt: number): void {
    if (this.healthRegenDelay > 0) {
      this.healthRegenDelay -= dt;
      return;
    }
    if (this.health <= 0 || this.health >= this.maxHealth) return;
    let healing = PASSIVE_HEALTH_REGEN_RATE * dt;
    for (let i = 0; i < this.droneHp.length && healing > 0; i++) {
      if (this.droneHp[i] <= 0 || this.droneHp[i] >= NOVA_BOMBER_DRONE_HP) continue;
      const applied = Math.min(NOVA_BOMBER_DRONE_HP - this.droneHp[i], healing);
      this.droneHp[i] += applied;
      healing -= applied;
    }
    this.health = this.droneHp.reduce((sum, hp) => sum + Math.max(0, hp), 0);
  }

  override draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive || this.docked) return;
    const screen = camera.worldToScreen(this.position);
    const color = this.team === Team.Player ? Colors.mainguy : Colors.enemy_status;
    const nodeR = Math.max(1.7, 2.4 * camera.zoom);
    this.drawMotionTrail(ctx, camera, color);
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = colorToCSS(color, 0.18);
    ctx.lineWidth = Math.max(0.8, camera.zoom);
    ctx.beginPath();
    let first: Vec2 | null = null;
    let prev: Vec2 | null = null;
    for (let i = 0; i < NOVA_BOMBER_DRONES; i++) {
      if (this.droneHp[i] <= 0) continue;
      const p = this.localNovaOffset(i).scale(camera.zoom);
      if (!first) first = p;
      if (prev) { ctx.moveTo(prev.x, prev.y); ctx.lineTo(p.x, p.y); }
      prev = p;
    }
    if (first && prev) { ctx.moveTo(prev.x, prev.y); ctx.lineTo(first.x, first.y); }
    ctx.stroke();
    if (this.charging) {
      const charge = Math.min(1, this.chargeTimer / NOVA_BOMBER_CHARGE_SECONDS);
      ctx.fillStyle = colorToCSS(Colors.explosion, 0.18 + charge * 0.38);
      ctx.beginPath();
      ctx.arc(0, 0, (5 + charge * 15) * camera.zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = colorToCSS(Colors.particles_switch, 0.34 + charge * 0.28);
      ctx.beginPath();
      ctx.arc(0, 0, (8 + charge * 20) * camera.zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let i = 0; i < NOVA_BOMBER_DRONES; i++) {
      if (this.droneHp[i] <= 0) continue;
      const p = this.localNovaOffset(i).scale(camera.zoom);
      ctx.fillStyle = colorToCSS(color, 0.78);
      ctx.beginPath();
      ctx.arc(p.x, p.y, nodeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = colorToCSS(Colors.particles_switch, 0.22);
      ctx.stroke();
    }

    // Drone count indicator arcs — outer ring with one segment per drone
    const arcOuterR = 30 * camera.zoom;
    const arcGap = 0.10;
    const arcStep = Math.PI * 2 / NOVA_BOMBER_DRONES;
    ctx.lineWidth = Math.max(1.5, 2.0 * camera.zoom);
    for (let i = 0; i < NOVA_BOMBER_DRONES; i++) {
      const alive = this.droneHp[i] > 0;
      ctx.strokeStyle = colorToCSS(color, alive ? 0.52 : 0.11);
      ctx.beginPath();
      ctx.arc(0, 0, arcOuterR, -Math.PI / 2 + i * arcStep + arcGap, -Math.PI / 2 + (i + 1) * arcStep - arcGap);
      ctx.stroke();
    }

    ctx.restore();
  }
}

