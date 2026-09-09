/** Player ship implementation for Sign99 */

import { Vec2, wrapAngle } from './math.js';
import { Camera } from './camera.js';
import { Input } from './input.js';
import { Entity, EntityType, Team } from './entities.js';
import { Colors, colorToCSS, type Color } from './colors.js';
import { ENTITY_RADIUS, PLAYER_SHIP_SCALE, SHIP_STATS, PLAYER_SPAWN_INVINCIBILITY_SECS } from './constants.js';
import { DEFAULT_SPECIAL_ID } from './special.js';
import type { FactionType } from './confluence.js';
import { SynonymousShipRenderer } from './synonymousShipRenderer.js';
import { teamColor } from './teamutils.js';
import { getDistantSunScreenPosition } from './suns.js';
import { getCinematicLevel } from './cinematic.js';

const BATTERY_MAX = 100;
const BATTERY_REGEN_RATE = 16;
const BATTERY_FIRE_COST = 5;
export const GATLING_BATTERY_FIRE_COST = BATTERY_FIRE_COST / 3;
export const GUIDED_MISSILE_INITIAL_BATTERY_COST = 14;
export const GUIDED_MISSILE_CONTROL_BATTERY_DRAIN = 8;
/** Fraction of max shield regenerated per second once regen kicks in (20%/s → full in 5s). */
const SHIELD_REGEN_FRACTION_PER_SEC = 0.2;
/** Seconds of no damage taken before shield regen begins. */
const SHIELD_REGEN_DELAY = 5;
/** Each ship-upgrade level adds this fraction of the *base* stat (non-cumulative/non-compounding). */
const SHIP_UPGRADE_STEP = 0.25;
export const SHIP_HP_MAX_LEVEL = 4;
export const SHIP_SPEED_ENERGY_MAX_LEVEL = 4;
export const SHIP_SHIELD_MAX_LEVEL = 2;
const PASSIVE_HEALTH_REGEN_DELAY = 5;
const PASSIVE_HEALTH_REGEN_RATE = 1;
const TRAIL_LIFETIME = 0.42;
const TRAIL_MIN_DISTANCE = 3;
const DASH_TRAIL_LIFETIME = 1.6;
const SHIP_WEAPON_IDS = ['cannon', 'gatling', 'laser', 'guidedmissile', 'synonymousLaser'] as const;
export type ShipWeaponId = typeof SHIP_WEAPON_IDS[number];
export const SHIP_WEAPON_OPTIONS: ReadonlyArray<{
  id: ShipWeaponId;
  label: string;
  researchKey?: string;
  description: string;
}> = [
  { id: 'cannon', label: 'Cannon', description: 'Reliable medium-range primary weapon. Cannon V.2 adds homing shots.' },
  { id: 'gatling', label: 'Gatling', researchKey: 'weaponGatling', description: 'Very weak, very fast, short range.' },
  { id: 'laser', label: 'Laser', researchKey: 'weaponLaser', description: 'Piercing beam; hold RMB to charge deterministic worm lasers (one per 10 energy).' },
  { id: 'guidedmissile', label: 'Guided Missile', researchKey: 'weaponGuidedMissile', description: 'Hold fire to steer a heavy explosive missile.' },
  { id: 'synonymousLaser', label: 'Piercing Laser', description: 'Slow Synonymous beam that pierces clustered targets.' },
];

interface TrailPoint {
  pos: Vec2;
  age: number;
}

/** Speed multiplier when boosting (Shift held). */
const BOOST_SPEED_MULT = 1.8;
/** Battery drained per second while boost-thrusting. */
const BOOST_BATTERY_DRAIN = 30;
const BOOST_LOCKOUT_FRACTION = 0.01;
const BOOST_REENABLE_BATTERY = 25;
const FULL_ENERGY_HEALTH_REGEN_MULT = 2;
const DASH_MIN_ENERGY_FRACTION = 0.75;
const DASH_ENERGY_COST_FRACTION = 0.25;
const DASH_INITIAL_SPEED = 760;
const DASH_TRAIL_MIN_DISTANCE = 6;
const DASH_TRAIL_MAX_POINTS = 52;

/**
 * How quickly the visual ship rotation chases the mouse-aim target. Set high
 * enough that aim feels instant but not so high that fast cursor jumps cause
 * visible snaps in the trail of exhaust particles.
 */
const AIM_TURN_RATE = 18.0; // radians per second

/**
 * Cross-product magnitude of (facing × thrustDir) above which we consider the
 * thrust to be perpendicular enough to the ship's facing to count as a "strafe"
 * (which triggers the side-thruster flame visual). Sin(~17°) ≈ 0.3 means
 * thrust within ~17° of straight forward/back is *not* counted as strafing.
 */
const STRAFE_CROSS_THRESHOLD = 0.3;

export class PlayerShip extends Entity {
  turnRate: number;
  thrustPower: number;
  maxSpeed: number;
  friction: number;

  battery: number = BATTERY_MAX;
  maxBattery: number = BATTERY_MAX;
  baseBatteryRegenRate: number = BATTERY_REGEN_RATE;

  primaryFireTimer: number = 0;
  specialFireTimer: number = 0;
  primaryWeaponId: ShipWeaponId = 'cannon';
  fireCooldownMultiplier: number = 1;
  shieldUnlocked = false;
  dashUnlocked = false;
  shield: number = 0;
  maxShield: number = 0;
  private shieldRegenDelay = 0;
  /** Research levels for the standardized, non-cumulative ship upgrades. */
  hpLevel = 0;
  speedEnergyLevel = 0;
  shieldLevel = 0;
  private readonly baseMaxHealth: number;
  private readonly baseMaxSpeed: number;
  private readonly baseThrustPower: number;
  private readonly baseEnergyRegenRate: number;
  private healthRegenDelay = 0;
  /** Countdown timer for the brief shield-hit flash ring (set when shield absorbs damage). */
  private shieldHitFlashTimer = 0;
  faction: FactionType = 'terran';
  synonymousPierceMultiplier = 1;
  synonymousFireSpeedLevel = 0;
  synonymousVitalityUnlocked = false;
  synonymousHealthRegenRate = 0;
  synonymousMuzzleFlash = 0;
  private synonymousRenderer: SynonymousShipRenderer | null = null;
  private trail: TrailPoint[] = [];
  private dashTrail: TrailPoint[] = [];
  private dashEffectTimer = 0;

  /** Accumulated time used for visual effects like the low-battery flash. */
  drawTime: number = 0;

  /**
   * World-space target the ship rotates toward. The game loop updates this
   * each tick from the mouse cursor (via Camera.screenToWorld). Defaults to
   * "directly to the right" so the ship has a sensible angle before any
   * mouse movement.
   */
  aimWorld: Vec2;

  /** Id of the currently equipped special ability (RMB). */
  specialAbilityId: string = DEFAULT_SPECIAL_ID;

  // ---------------------------------------------------------------------------
  // Special-ability state — managed by game.ts; held here for rendering access
  // ---------------------------------------------------------------------------

  /**
   * Spawn-invincibility countdown (seconds).  Decremented in update(); while
   * > 0 all incoming damage is blocked and a shield ring is drawn.
   */
  spawnInvincibilityTimer: number = PLAYER_SPAWN_INVINCIBILITY_SECS;

  /**
   * Gatling overdrive countdown (seconds).  While > 0 the gatling fires at
   * extreme speed; decremented and transitioned by game.ts.
   */
  gatlingOverdriveTimer: number = 0;

  /**
   * Gatling overheat lockdown countdown (seconds).  While > 0 the ship cannot
   * move; decremented and transitioned by game.ts.
   */
  gatlingOverheatTimer: number = 0;

  /** True while the laser charged-burst is accumulating charge (RMB held). */
  isLaserCharging: boolean = false;

  /** Elapsed laser charge time in seconds (clamped to LASER_MAX_CHARGE_SECS). */
  laserChargeTimer: number = 0;

  /**
   * Per-weapon special-ability cooldown (seconds).  Used by swarm missiles
   * and cannon homing; decremented in update().
   */
  weaponSpecialCooldown: number = 0;

  /**
   * Direction of last applied thrust (unit vector). Used by game.ts to emit
   * exhaust particles trailing behind the actual motion direction rather than
   * behind the ship's facing (which is now decoupled from movement).
   */
  thrustDir: Vec2 = new Vec2(0, 0);
  /** True if any movement key was held this tick (used for SFX/exhaust). */
  isThrusting: boolean = false;
  /** True when boosting (Shift held while thrusting with battery remaining). */
  isBoosting: boolean = false;
  private boostLockedUntilRecharge = false;

  constructor(position: Vec2, team: Team = Team.Player) {
    super(
      EntityType.PlayerShip,
      team,
      position,
      SHIP_STATS.mainguy.health,
      ENTITY_RADIUS.mainguy * PLAYER_SHIP_SCALE,
    );
    this.turnRate = SHIP_STATS.mainguy.turnRate;
    this.thrustPower = SHIP_STATS.mainguy.speed;
    this.maxSpeed = SHIP_STATS.mainguy.speed;
    this.baseMaxHealth = this.maxHealth;
    this.baseMaxSpeed = this.maxSpeed;
    this.baseThrustPower = this.thrustPower;
    this.baseEnergyRegenRate = this.baseBatteryRegenRate;
    this.friction = 1.0;
    this.aimWorld = new Vec2(position.x + 100, position.y);
  }

  update(dt: number): void {
    if (!this.alive) return;

    this.handleInput(dt);

    // Apply friction (damping). No brake in the new control scheme — releasing
    // all keys naturally decelerates the ship via this friction term.
    this.velocity = this.velocity.scale(1 / (1 + this.friction * dt));

    // Clamp speed — boost allows a higher cap.
    const speed = this.velocity.length();
    const speedCap = (this.isBoosting ? this.maxSpeed * BOOST_SPEED_MULT : this.maxSpeed) * this.tetherSpeedMultiplier();
    if (speed > speedCap) {
      this.velocity = this.velocity.normalize().scale(speedCap);
    }

    // Integrate position
    this.position = this.position.add(this.velocity.scale(dt));
    this.updateTrail(dt);

    // Regenerate battery
    this.battery = Math.min(this.maxBattery, this.battery + this.baseBatteryRegenRate * dt);
    if (this.synonymousHealthRegenRate > 0 && this.health > 0 && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + this.synonymousHealthRegenRate * dt);
    }
    this.updateShield(dt);
    this.updatePassiveHealthRegen(dt);

    // Accumulate draw time for visual effects
    this.drawTime += dt;

    // Tick fire timers
    if (this.primaryFireTimer > 0) this.primaryFireTimer -= dt;
    if (this.specialFireTimer > 0) this.specialFireTimer -= dt;
    if (this.synonymousMuzzleFlash > 0) this.synonymousMuzzleFlash = Math.max(0, this.synonymousMuzzleFlash - dt);
    if (this.shieldHitFlashTimer > 0) this.shieldHitFlashTimer = Math.max(0, this.shieldHitFlashTimer - dt);
    // Spawn invincibility — counts down to 0
    if (this.spawnInvincibilityTimer > 0) this.spawnInvincibilityTimer -= dt;
    // Weapon special cooldown (swarm / homing) — counts down to 0
    if (this.weaponSpecialCooldown > 0) this.weaponSpecialCooldown = Math.max(0, this.weaponSpecialCooldown - dt);
  }

  /**
   * Revive the ship at a new position after death (respawn). Preserves
   * equipped specials and any other configuration that should survive death.
   */
  revive(position: Vec2): void {
    this.position = position.clone();
    this.velocity = new Vec2(0, 0);
    this.health = this.maxHealth;
    this.alive = true;
    this.battery = this.maxBattery;
    this.shield = this.shieldUnlocked ? this.maxShield : 0;
    this.shieldRegenDelay = 0;
    this.healthRegenDelay = 0;
    this.primaryFireTimer = 0;
    this.specialFireTimer = 0;
    this.aimWorld = new Vec2(position.x + 100, position.y);
    this.thrustDir = new Vec2(0, 0);
    this.trail = [{ pos: position.clone(), age: 0 }];
    this.dashTrail = [];
    this.dashEffectTimer = 0;
    this.isThrusting = false;
    this.isBoosting = false;
    this.boostLockedUntilRecharge = false;
    // Re-apply spawn invincibility on each (re)spawn
    this.spawnInvincibilityTimer = PLAYER_SPAWN_INVINCIBILITY_SECS;
    // Clear any lingering special-ability states
    this.gatlingOverdriveTimer = 0;
    this.gatlingOverheatTimer = 0;
    this.isLaserCharging = false;
    this.laserChargeTimer = 0;
    this.weaponSpecialCooldown = 0;
  }

  setAimPoint(world: Vec2): void {
    this.aimWorld = world;
  }

  protected handleInput(dt: number): void {
    // Gatling overheat: the ship is completely immobilised — only aiming works.
    if (this.gatlingOverheatTimer > 0) {
      this.isThrusting = false;
      this.isBoosting = false;
      // Still allow aim rotation so the player can plan their next move
      const desired = Math.atan2(
        this.aimWorld.y - this.position.y,
        this.aimWorld.x - this.position.x,
      );
      let delta = wrapAngle(desired - this.angle);
      const maxStep = AIM_TURN_RATE * dt;
      if (delta > maxStep) delta = maxStep;
      else if (delta < -maxStep) delta = -maxStep;
      this.angle = wrapAngle(this.angle + delta);
      return;
    }

    if (Input.wasPressed('Shift')) this.tryDash();

    // --- Movement: WASD as a 4-axis direction, decoupled from facing -----
    let dx = 0;
    let dy = 0;
    if (Input.isDown('w')) dy -= 1;
    if (Input.isDown('s')) dy += 1;
    if (Input.isDown('a')) dx -= 1;
    if (Input.isDown('d')) dx += 1;

    if (dx !== 0 || dy !== 0) {
      // Normalize so diagonals don't get a sqrt(2) speed boost.
      const len = Math.hypot(dx, dy);
      const ux = dx / len;
      const uy = dy / len;

      // Shift boost: doubles thrust and speed cap, drains battery.
      const shiftHeld = Input.isDown('Shift');
      const canBoost = shiftHeld && this.canUseBoost();
      const thrustMult = canBoost ? BOOST_SPEED_MULT : 1.0;

      this.velocity = this.velocity.add(
        new Vec2(ux * this.thrustPower * thrustMult * dt, uy * this.thrustPower * thrustMult * dt),
      );
      this.thrustDir = new Vec2(ux, uy);
      this.isThrusting = true;
      this.isBoosting = canBoost;

      if (canBoost) {
        this.battery = Math.max(0, this.battery - BOOST_BATTERY_DRAIN * dt);
        this.updateBoostLockout();
      }
    } else {
      this.isThrusting = false;
      this.isBoosting = false;
    }

    // --- Aiming: rotate toward the world-space mouse cursor ---------------
    const desired = Math.atan2(
      this.aimWorld.y - this.position.y,
      this.aimWorld.x - this.position.x,
    );
    // Smooth turn toward desired angle so rapid cursor flicks don't snap.
    let delta = wrapAngle(desired - this.angle);
    const maxStep = AIM_TURN_RATE * dt;
    if (delta > maxStep) delta = maxStep;
    else if (delta < -maxStep) delta = -maxStep;
    this.angle = wrapAngle(this.angle + delta);
  }

  private canUseBoost(): boolean {
    this.updateBoostLockout();
    return !this.boostLockedUntilRecharge && this.battery > 0;
  }

  private updateBoostLockout(): void {
    if (this.battery <= this.maxBattery * BOOST_LOCKOUT_FRACTION) {
      this.boostLockedUntilRecharge = true;
    } else if (this.battery >= BOOST_REENABLE_BATTERY) {
      this.boostLockedUntilRecharge = false;
    }
  }

  /**
   * Whether the ship is being side-thrusted. Retained for backward-compatible
   * rendering of the side thruster flames; under WASD-aim, "strafing" is any
   * thrust direction that isn't roughly aligned with the ship's facing.
   */
  get isStrafingLeft(): boolean {
    if (!this.isThrusting) return false;
    // Cross product sign of facing × thrustDir; positive = thrust is to the
    // ship's left (in screen-space where +y is down).
    const fx = Math.cos(this.angle);
    const fy = Math.sin(this.angle);
    return fx * this.thrustDir.y - fy * this.thrustDir.x < -STRAFE_CROSS_THRESHOLD;
  }
  get isStrafingRight(): boolean {
    if (!this.isThrusting) return false;
    const fx = Math.cos(this.angle);
    const fy = Math.sin(this.angle);
    return fx * this.thrustDir.y - fy * this.thrustDir.x > STRAFE_CROSS_THRESHOLD;
  }

  // --- Weapons ---

  canFirePrimary(): boolean {
    return this.primaryFireTimer <= 0 && this.battery >= BATTERY_FIRE_COST;
  }

  consumePrimaryFire(cooldown: number, cost: number = BATTERY_FIRE_COST): void {
    this.primaryFireTimer = cooldown;
    this.battery -= cost;
  }

  drainBattery(amount: number): boolean {
    if (amount <= 0) return true;
    if (this.battery <= 0) {
      this.battery = 0;
      return false;
    }
    this.battery = Math.max(0, this.battery - amount);
    return this.battery > 0;
  }

  canFireSpecial(): boolean {
    return this.specialFireTimer <= 0 && this.battery >= BATTERY_FIRE_COST * 2;
  }

  consumeSpecialFire(cooldown: number): void {
    this.specialFireTimer = cooldown;
    this.battery -= BATTERY_FIRE_COST * 2;
  }

  selectPrimaryWeapon(id: ShipWeaponId): void {
    if (SHIP_WEAPON_IDS.includes(id)) this.primaryWeaponId = id;
  }

  cyclePrimaryWeapon(dir: number, unlocked: (id: ShipWeaponId) => boolean): void {
    const available = SHIP_WEAPON_OPTIONS.filter((w) => unlocked(w.id)).map((w) => w.id);
    if (available.length === 0) return;
    const current = available.indexOf(this.primaryWeaponId);
    const start = current >= 0 ? current : 0;
    const next = (start + Math.sign(dir) + available.length) % available.length;
    this.primaryWeaponId = available[next];
  }

  selectFirstUnlockedWeapon(unlocked: (id: ShipWeaponId) => boolean): void {
    const first = SHIP_WEAPON_OPTIONS.find((w) => unlocked(w.id));
    if (first) this.primaryWeaponId = first.id;
  }

  /**
   * Returns false during the gatling overdrive or overheat states to prevent
   * the player from bypassing the lockdown by switching weapons.  Other
   * special states (laser charging, missile cooldown) do not need to block
   * weapon switching because they resolve naturally when the weapon changes.
   */
  canSwitchWeapon(): boolean {
    return this.gatlingOverheatTimer <= 0 && this.gatlingOverdriveTimer <= 0;
  }

  applyResearchUpgrade(item: string): void {
    if (this.faction === 'synonymous') {
      this.applySynonymousResearchUpgrade(item);
      return;
    }
    const match = /^(shipHp|shipSpeedEnergy|shipShield)(\d)$/.exec(item);
    if (match) {
      const [, kind, levelStr] = match;
      const level = parseInt(levelStr, 10);
      if (kind === 'shipHp') {
        this.hpLevel = Math.min(SHIP_HP_MAX_LEVEL, Math.max(this.hpLevel, level));
        this.recomputeHpStats();
      } else if (kind === 'shipSpeedEnergy') {
        this.speedEnergyLevel = Math.min(SHIP_SPEED_ENERGY_MAX_LEVEL, Math.max(this.speedEnergyLevel, level));
        this.recomputeSpeedEnergyStats();
      } else if (kind === 'shipShield') {
        this.shieldUnlocked = true;
        this.shieldLevel = Math.min(SHIP_SHIELD_MAX_LEVEL, Math.max(this.shieldLevel, level));
        this.recomputeShieldStats();
        this.shield = this.maxShield;
        this.shieldRegenDelay = 0;
      }
      return;
    }
    switch (item) {
      case 'shipDash':
        this.dashUnlocked = true;
        break;
      default:
        break;
    }
  }

  /** Rebuild reversible ship stats from the upgrade labs that currently exist. */
  syncResearchUpgrades(items: ReadonlySet<string>): void {
    const healthFraction = this.maxHealth > 0 ? this.health / this.maxHealth : 1;
    this.hpLevel = 0;
    this.speedEnergyLevel = 0;
    this.shieldLevel = 0;
    this.shieldUnlocked = false;
    this.dashUnlocked = false;
    this.synonymousPierceMultiplier = 1;
    this.synonymousFireSpeedLevel = 0;
    this.synonymousVitalityUnlocked = false;
    this.synonymousHealthRegenRate = 0;
    this.maxHealth = this.baseMaxHealth;
    this.maxSpeed = this.baseMaxSpeed;
    this.thrustPower = this.baseThrustPower;
    this.baseBatteryRegenRate = this.baseEnergyRegenRate;
    this.fireCooldownMultiplier = 1;
    this.maxShield = 0;
    this.shield = 0;
    this.hpLevel = [...items].filter((item) => /^shipHp\d$/.test(item)).length;
    this.speedEnergyLevel = [...items].filter((item) => /^shipSpeedEnergy\d$/.test(item)).length;
    this.shieldLevel = [...items].filter((item) => /^shipShield\d$/.test(item)).length;
    this.shieldUnlocked = this.shieldLevel > 0;
    this.synonymousFireSpeedLevel = [...items].filter((item) => /^synonymousFireSpeed\d$/.test(item)).length;
    this.recomputeHpStats();
    this.recomputeSpeedEnergyStats();
    this.recomputeShieldStats();
    for (const item of items) {
      if (/^(shipHp|shipSpeedEnergy|shipShield|synonymousFireSpeed)\d$/.test(item)) continue;
      this.applyResearchUpgrade(item);
    }
    this.health = Math.max(1, Math.min(this.maxHealth, this.maxHealth * healthFraction));
  }

  /** HP upgrade: each level adds +25% of *base* max HP (non-cumulative — level 4 = +100%, not compounded). */
  private recomputeHpStats(): void {
    const healthFraction = this.maxHealth > 0 ? this.health / this.maxHealth : 1;
    this.maxHealth = Math.round(this.baseMaxHealth * (1 + this.hpLevel * SHIP_UPGRADE_STEP));
    this.health = Math.round(this.maxHealth * healthFraction);
    this.recomputeShieldStats();
  }

  /** Speed/Energy/Fire-Speed upgrade: each level adds +25% of the base stat. */
  private recomputeSpeedEnergyStats(): void {
    const multiplier = 1 + this.speedEnergyLevel * SHIP_UPGRADE_STEP;
    this.maxSpeed = this.baseMaxSpeed * multiplier;
    this.thrustPower = this.baseThrustPower * multiplier;
    this.baseBatteryRegenRate = this.baseEnergyRegenRate * multiplier;
    this.fireCooldownMultiplier = 1 / multiplier;
  }

  /** Shield upgrade: each level converts +25% of current max HP into shield capacity (max 50% at level 2). */
  private recomputeShieldStats(): void {
    this.maxShield = this.shieldUnlocked ? this.maxHealth * this.shieldLevel * SHIP_UPGRADE_STEP : 0;
    this.shield = Math.min(this.shield, this.maxShield);
  }

  private applySynonymousResearchUpgrade(item: string): void {
    switch (item) {
      case 'synonymousPierce':
        this.synonymousPierceMultiplier = 2;
        break;
      case 'synonymousSpeed':
        this.maxSpeed *= 1.16;
        this.thrustPower *= 1.18;
        break;
      case 'synonymousFireSpeed1':
      case 'synonymousFireSpeed2':
      case 'synonymousFireSpeed3':
      case 'synonymousFireSpeed4':
        this.synonymousFireSpeedLevel = Math.min(4, this.synonymousFireSpeedLevel + 1);
        break;
      case 'synonymousVitality':
        this.maxHealth = Math.round(this.maxHealth * 1.4);
        this.health = this.maxHealth;
        this.synonymousVitalityUnlocked = true;
        this.synonymousHealthRegenRate = 2.2;
        break;
      default:
        break;
    }
  }

  setFaction(faction: FactionType): void {
    this.faction = faction;
    if (faction === 'synonymous') {
      this.primaryWeaponId = 'synonymousLaser';
      if (!this.synonymousRenderer) this.synonymousRenderer = new SynonymousShipRenderer();
    } else if (this.primaryWeaponId === 'synonymousLaser') {
      this.primaryWeaponId = 'cannon';
    }
  }

  synonymousLaserCooldown(baseCooldown: number): number {
    const fireRateMultiplier = 1 + this.synonymousFireSpeedLevel * 0.25;
    return baseCooldown / fireRateMultiplier;
  }

  override takeDamage(amount: number, source?: Entity): void {
    if (!this.alive || amount <= 0) {
      super.takeDamage(amount, source);
      return;
    }
    // Spawn invincibility blocks all incoming damage during the grace period
    if (this.spawnInvincibilityTimer > 0) return;
    if (this.shieldUnlocked) {
      this.shieldRegenDelay = SHIELD_REGEN_DELAY;
      if (this.shield > 0) {
        const blocked = Math.min(this.shield, amount);
        this.shield -= blocked;
        amount -= blocked;
        if (blocked > 0) this.shieldHitFlashTimer = 0.22;
      }
    }
    this.healthRegenDelay = PASSIVE_HEALTH_REGEN_DELAY;
    if (amount > 0) super.takeDamage(amount, source);
  }

  private updateShield(dt: number): void {
    if (!this.shieldUnlocked || !this.alive) return;
    if (this.shieldRegenDelay > 0) {
      this.shieldRegenDelay -= dt;
      return;
    }
    this.shield = Math.min(this.maxShield, this.shield + this.maxShield * SHIELD_REGEN_FRACTION_PER_SEC * dt);
  }

  private updatePassiveHealthRegen(dt: number): void {
    if (!this.alive) return;
    if (this.healthRegenDelay > 0) {
      this.healthRegenDelay -= dt;
      return;
    }
    if (this.health > 0 && this.health < this.maxHealth) {
      const fullEnergy = this.battery >= this.maxBattery;
      const regenMult = fullEnergy ? FULL_ENERGY_HEALTH_REGEN_MULT : 1;
      this.health = Math.min(this.maxHealth, this.health + PASSIVE_HEALTH_REGEN_RATE * regenMult * dt);
    }
  }

  get passiveHealthRegenActive(): boolean {
    return this.alive && this.healthRegenDelay <= 0 && this.health > 0 && this.health < this.maxHealth;
  }

  private updateTrail(dt: number): void {
    for (const point of this.trail) point.age += dt;
    this.trail = this.trail.filter((point) => point.age <= TRAIL_LIFETIME);
    const last = this.trail[this.trail.length - 1];
    if (!last || last.pos.distanceTo(this.position) >= TRAIL_MIN_DISTANCE) {
      this.trail.push({ pos: this.position.clone(), age: 0 });
    }
    if (this.trail.length > 24) this.trail.shift();

    for (const point of this.dashTrail) point.age += dt;
    this.dashTrail = this.dashTrail.filter((point) => point.age <= DASH_TRAIL_LIFETIME);
    if (this.dashEffectTimer > 0) {
      this.dashEffectTimer = Math.max(0, this.dashEffectTimer - dt);
      const dashLast = this.dashTrail[this.dashTrail.length - 1];
      if (!dashLast || dashLast.pos.distanceTo(this.position) >= DASH_TRAIL_MIN_DISTANCE) {
        this.dashTrail.push({ pos: this.position.clone(), age: 0 });
      }
    }
    while (this.dashTrail.length > DASH_TRAIL_MAX_POINTS) this.dashTrail.shift();
  }

  private tryDash(): void {
    if (!this.dashUnlocked || this.gatlingOverheatTimer > 0) return;
    if (this.battery <= this.maxBattery * DASH_MIN_ENERGY_FRACTION) return;
    const dir = new Vec2(Math.cos(this.angle), Math.sin(this.angle));
    this.battery = Math.max(0, this.battery - this.maxBattery * DASH_ENERGY_COST_FRACTION);
    this.velocity = this.velocity.add(dir.scale(DASH_INITIAL_SPEED));
    // Dashing tears against any Tether holds — halve their grip immediately and
    // let them re-tighten. dashCount bump is what the Tethers watch for.
    this.dashCount++;
    this.tetherSlowFrac *= 0.5;
    this.dashEffectTimer = DASH_TRAIL_LIFETIME;
    this.dashTrail = [
      { pos: this.position.add(dir.scale(-this.radius * 0.8)), age: DASH_TRAIL_LIFETIME * 0.16 },
      { pos: this.position.clone(), age: 0 },
    ];
  }

  private drawMotionTrail(ctx: CanvasRenderingContext2D, camera: Camera, color: Color): void {
    if (this.trail.length < 2) return;
    const speedCap = this.maxSpeed * (this.isBoosting ? BOOST_SPEED_MULT : 1);
    const speedFraction = Math.max(0, Math.min(1, this.velocity.length() / Math.max(1, speedCap)));
    const sizeScale = 0.2 + speedFraction * 0.8;
    const cinematicScale = getCinematicLevel() >= 2 ? 1.35 : 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 7 * sizeScale * camera.zoom * cinematicScale;
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1];
      const b = this.trail[i];
      const fade = 1 - Math.max(a.age, b.age) / TRAIL_LIFETIME;
      if (fade <= 0) continue;
      const from = camera.worldToScreen(a.pos);
      const to = camera.worldToScreen(b.pos);
      ctx.strokeStyle = colorToCSS(color, Math.min(0.75, (0.08 + fade * 0.28) * cinematicScale));
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawDashTrail(ctx: CanvasRenderingContext2D, camera: Camera, color: Color): void {
    if (this.dashTrail.length < 2) return;
    const cinematicScale = getCinematicLevel() >= 2 ? 1.28 : 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < this.dashTrail.length; i++) {
      const a = this.dashTrail[i - 1];
      const b = this.dashTrail[i];
      const fade = 1 - Math.max(a.age, b.age) / DASH_TRAIL_LIFETIME;
      if (fade <= 0) continue;
      const from = camera.worldToScreen(a.pos);
      const to = camera.worldToScreen(b.pos);
      const headBias = i / Math.max(1, this.dashTrail.length - 1);
      ctx.strokeStyle = colorToCSS(color, Math.min(0.9, (0.10 + fade * 0.48) * cinematicScale));
      ctx.lineWidth = (4 + fade * 10 + headBias * 4) * camera.zoom * cinematicScale;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.strokeStyle = colorToCSS(Colors.particles_spark, 0.08 + fade * 0.32);
      ctx.lineWidth = (1.5 + fade * 3) * camera.zoom;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- Drawing ---

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.alive) return;
    const coreColor = teamColor(this.team);
    this.drawDashTrail(ctx, camera, coreColor);
    this.drawMotionTrail(ctx, camera, coreColor);
    if (this.faction === 'synonymous') {
      if (!this.synonymousRenderer) this.synonymousRenderer = new SynonymousShipRenderer();
      this.synonymousRenderer.draw(ctx, camera, this, Input.isDown('q'));
      return;
    }
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;

    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(this.angle);

    // Side thruster flames when strafing
    if (this.isStrafingLeft || this.isStrafingRight) {
      const side = this.isStrafingLeft ? 1 : -1; // +1 = flame on right side of ship (strafing left)
      ctx.strokeStyle = colorToCSS(Colors.particles_friendly_exhaust, 0.85);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-r * 0.2, side * r * 0.7);
      ctx.lineTo(-r * 0.2, side * (r * 0.7 + r * 0.6));
      ctx.stroke();
      ctx.strokeStyle = colorToCSS(Colors.particles_friendly_exhaust, 0.4);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(r * 0.3, side * r * 0.55);
      ctx.lineTo(r * 0.3, side * (r * 0.55 + r * 0.45));
      ctx.stroke();
    }

    // Ship body: triangle / arrow shape
    const shipColor = colorToCSS(teamColor(this.team));
    ctx.fillStyle = this.team === Team.Player
      ? 'rgba(20, 36, 32, 0.72)'
      : 'rgba(42, 18, 20, 0.72)';
    ctx.beginPath();
    ctx.moveTo(r * 1.4, 0);
    ctx.lineTo(-r, -r * 0.7);
    ctx.lineTo(-r * 0.5, 0);
    ctx.lineTo(-r, r * 0.7);
    ctx.closePath();
    ctx.fill();
    this.drawSunRimGlare(ctx, camera, screen, r);
    ctx.strokeStyle = shipColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(r * 1.4, 0);
    ctx.lineTo(-r, -r * 0.7);
    ctx.lineTo(-r * 0.5, 0);
    ctx.lineTo(-r, r * 0.7);
    ctx.closePath();
    ctx.stroke();

    ctx.restore();

    const corePulse = 0.5 + 0.5 * Math.sin(this.drawTime * 3.4);
    const coreGlint = 0.5 + 0.5 * Math.sin(this.drawTime * 6.1 + 0.8);
    const cinematicShipBoost = getCinematicLevel() >= 2 ? 1.35 : 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = colorToCSS(coreColor, Math.min(0.42, (0.10 + corePulse * 0.12) * cinematicShipBoost));
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r * (getCinematicLevel() >= 2 ? 1.32 : 1.05), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colorToCSS(coreColor, Math.min(0.62, (0.22 + corePulse * 0.16) * cinematicShipBoost));
    ctx.lineWidth = getCinematicLevel() >= 2 ? 1.5 : 1;
    ctx.beginPath();
    ctx.arc(
      screen.x,
      screen.y,
      r * (0.62 + corePulse * 0.08),
      this.drawTime * 1.6,
      this.drawTime * 1.6 + Math.PI * 1.45,
    );
    ctx.stroke();

    // Level 3: second outer orbit arc spinning in the opposite direction.
    if (getCinematicLevel() >= 3) {
      ctx.strokeStyle = colorToCSS(coreColor, Math.min(0.44, (0.14 + coreGlint * 0.10) * cinematicShipBoost));
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      ctx.arc(
        screen.x,
        screen.y,
        r * (1.05 + coreGlint * 0.06),
        -this.drawTime * 1.1,
        -this.drawTime * 1.1 + Math.PI * 0.85,
      );
      ctx.stroke();
    }

    // Level 4: tight inner energy ring — three short arc segments spinning fast
    // at the core radius.  Unlike the outer arcs this sits *inside* the ship
    // body, creating a luminous engine-core signature not visible at level 3.
    if (getCinematicLevel() >= 4) {
      const innerR = r * (0.34 + corePulse * 0.04);
      const segCount = 3;
      for (let seg = 0; seg < segCount; seg++) {
        const segOffset = (seg / segCount) * Math.PI * 2;
        const segStart  = this.drawTime * 2.8 + segOffset;
        const segAlpha  = Math.min(0.68, (0.28 + corePulse * 0.22) * cinematicShipBoost);
        ctx.strokeStyle = colorToCSS(coreColor, segAlpha);
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, innerR, segStart, segStart + Math.PI * 0.52);
        ctx.stroke();
      }
      // Central pinpoint glow — a bright white hot spot at the very core.
      const hotA = Math.min(0.90, (0.50 + coreGlint * 0.40) * cinematicShipBoost);
      ctx.fillStyle = `rgba(255,245,220,${hotA.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }

    // Level 5: micro-constellation motes orbiting the core ring.
    if (getCinematicLevel() >= 5) {
      const moteCount = 3;
      const orbitR = r * (0.82 + corePulse * 0.10);
      for (let i = 0; i < moteCount; i++) {
        const a = this.drawTime * 0.95 + (i / moteCount) * Math.PI * 2;
        const mx = screen.x + Math.cos(a) * orbitR;
        const my = screen.y + Math.sin(a) * orbitR * 0.76;
        const moteAlpha = Math.min(0.52, 0.22 + coreGlint * 0.20);
        ctx.fillStyle = `rgba(200,240,255,${moteAlpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(mx, my, Math.max(0.6, r * 0.055), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();

    ctx.fillStyle = colorToCSS(coreColor, 0.72 + 0.28 * this.healthFraction);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colorToCSS(Colors.particles_switch, 0.25 + coreGlint * 0.2);
    ctx.beginPath();
    ctx.arc(screen.x - r * 0.1, screen.y - r * 0.1, r * 0.13, 0, Math.PI * 2);
    ctx.fill();

    // Battery ring — color shifts green→yellow→red; flashes when critical
    const batteryFrac = this.battery / this.maxBattery;
    if (batteryFrac > 0) {
      let ringColor: string;
      if (batteryFrac > 0.6) {
        ringColor = colorToCSS(Colors.radar_friendly_status, 0.75);
      } else if (batteryFrac > 0.3) {
        ringColor = colorToCSS(Colors.alert2, 0.85);
      } else {
        // Flash at critical level
        const flash = batteryFrac < 0.15 ? 0.5 + 0.5 * Math.sin(this.drawTime * 10) : 1;
        ringColor = colorToCSS(Colors.alert1, 0.9 * flash);
      }
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(
        screen.x,
        screen.y,
        r * 0.55,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * batteryFrac,
      );
      ctx.stroke();
    }

    if (this.shieldUnlocked && this.shield > 0) {
      const shieldFrac = this.shield / this.maxShield;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = colorToCSS(Colors.radar_allied_status, 0.18 + shieldFrac * 0.42);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * (1.45 + shieldFrac * 0.08), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (this.dashEffectTimer > 0) {
      const frac = this.dashEffectTimer / DASH_TRAIL_LIFETIME;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = colorToCSS(Colors.particles_spark, 0.16 + frac * 0.42);
      ctx.lineWidth = 1.5 + frac * 2.5;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * (1.35 + (1 - frac) * 1.0), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = colorToCSS(coreColor, 0.04 + frac * 0.16);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * (1.9 + frac * 0.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // --- Shield hit flash ------------------------------------------------
    // Brief bright expanding ring when the shield absorbs a hit
    if (this.shieldHitFlashTimer > 0) {
      const flashFrac = this.shieldHitFlashTimer / 0.22;          // 1 → 0
      const expandR = r * (1.4 + (1 - flashFrac) * 0.9);         // expands outward
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = colorToCSS(Colors.particles_spark, flashFrac * 0.85);
      ctx.lineWidth = 2 + flashFrac * 3;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, expandR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // --- Spawn invincibility ring -------------------------------------------
    // Pulsing cyan ring that shrinks slightly as the grace period nears expiry
    if (this.spawnInvincibilityTimer > 0) {
      const fraction = Math.max(0, this.spawnInvincibilityTimer / PLAYER_SPAWN_INVINCIBILITY_SECS);
      const pulse = 0.5 + 0.5 * Math.sin(this.drawTime * 9);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = colorToCSS(Colors.particles_spark, (0.35 + pulse * 0.3) * fraction);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * (2.1 + pulse * 0.25), 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = colorToCSS(Colors.particles_spark, 0.12 * fraction);
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * 1.85, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // --- Gatling overheat aura -----------------------------------------------
    // Red flickering glow while the ship is locked down
    if (this.gatlingOverheatTimer > 0) {
      const heatPulse = 0.5 + 0.5 * Math.sin(this.drawTime * 13);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = colorToCSS(Colors.alert1, 0.10 + heatPulse * 0.20);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = colorToCSS(Colors.alert1, 0.4 + heatPulse * 0.35);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * 1.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // --- Gatling overdrive glow -----------------------------------------------
    // Orange/yellow aura during overdrive burst
    if (this.gatlingOverdriveTimer > 0) {
      const overdrivePulse = 0.5 + 0.5 * Math.sin(this.drawTime * 16);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = colorToCSS(Colors.alert2, 0.12 + overdrivePulse * 0.18);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * 2.0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = colorToCSS(Colors.alert2, 0.55 + overdrivePulse * 0.3);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * 1.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // --- Laser charge buildup glow -------------------------------------------
    // Expanding green glow proportional to charge fraction
    if (this.isLaserCharging && this.laserChargeTimer > 0) {
      const chargeFrac = this.laserChargeTimer / 2.5; // normalised (max ~2.5 s)
      const pulse = 0.5 + 0.5 * Math.sin(this.drawTime * 14);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = colorToCSS(Colors.friendlyfire, (0.22 + chargeFrac * 0.5) * (0.7 + pulse * 0.3));
      ctx.lineWidth = 1.5 + chargeFrac * 4;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * (1.3 + chargeFrac * 1.6), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawSunRimGlare(ctx: CanvasRenderingContext2D, camera: Camera, screen: Vec2, r: number): void {
    const sun = getDistantSunScreenPosition(camera, ctx.canvas.width, ctx.canvas.height);
    const toSunX = sun.x - screen.x;
    const toSunY = sun.y - screen.y;
    const dist = Math.max(1, Math.hypot(toSunX, toSunY));
    const cosA = Math.cos(-this.angle);
    const sinA = Math.sin(-this.angle);
    const localSunX = (toSunX * cosA - toSunY * sinA) / dist;
    const localSunY = (toSunX * sinA + toSunY * cosA) / dist;
    const points = [
      { x: r * 1.4, y: 0 },
      { x: -r, y: -r * 0.7 },
      { x: -r * 0.5, y: 0 },
      { x: -r, y: r * 0.7 },
    ];

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const edgeLen = Math.max(1, Math.hypot(dx, dy));
      const nx = -dy / edgeLen;
      const ny = dx / edgeLen;
      const facing = nx * localSunX + ny * localSunY;
      if (facing <= 0.12) continue;
      const alpha = Math.min(0.88, 0.26 + facing * 0.62);
      ctx.strokeStyle = `rgba(182, 49, 12, ${(alpha * 0.72).toFixed(3)})`;
      ctx.lineWidth = Math.max(2, r * 0.38);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255, 138, 35, ${alpha.toFixed(3)})`;
      ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }
}
