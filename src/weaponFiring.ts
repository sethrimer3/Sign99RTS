/**
 * Player weapon firing helpers extracted from game.ts.
 *
 * updatePlayerFiring and updateGuidedMissileControl both return the updated
 * activeGuidedMissile reference so the caller (Game) can store it.
 */

import { Vec2, randomRange } from './math.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Camera } from './camera.js';
import { Colors } from './colors.js';
import { Team } from './entities.js';
import type { GameState } from './gamestate.js';
import { HUD } from './hud.js';
import {
  Bullet,
  GatlingBullet,
  Laser,
  GuidedMissile,
  HomingBullet,
  SwarmMissile,
  ChargedLaserBurst,
} from './projectile.js';
import { tryFireSpecial } from './special.js';
import { CrossLaserMine } from './mine.js';
import {
  WEAPON_STATS,
  DT,
} from './constants.js';
import {
  GATLING_OVERDRIVE_DURATION_SECS,
  GATLING_OVERHEAT_DURATION_SECS,
  GATLING_OVERDRIVE_FIRE_RATE_DIVISOR,
} from './constants.js';
import {
  LASER_MAX_CHARGE_SECS,
  LASER_CHARGE_COOLDOWN_SECS,
  LASER_BURST_BASE_MULTIPLIER,
  LASER_BURST_ENERGY_SCALING,
} from './constants.js';
import {
  ROCKET_SWARM_COUNT,
  ROCKET_SWARM_SPREAD_DEGREES,
  ROCKET_SWARM_ENERGY_COST,
  ROCKET_SWARM_COOLDOWN_SECS,
} from './constants.js';
import {
  GATLING_BATTERY_FIRE_COST,
  GUIDED_MISSILE_CONTROL_BATTERY_DRAIN,
  GUIDED_MISSILE_INITIAL_BATTERY_COST,
} from './ship.js';
import { findClosestEnemy, damageLaserLine, damageLaserLineLimited } from './combatUtils.js';
import { isSynonymousFaction } from './confluence.js';
import type { SpaceFluid } from './spacefluid.js';
import type { ActionMenu } from './actionmenu.js';

const CANNON_MINE_BASE_BATTERY_FRACTION = 0.75;
const CANNON_MINE_UPGRADED_BATTERY_FRACTION = 0.5;
const CANNON_MINE_COOLDOWN_SECS = 0.12;
const CANNON_MINE_INITIAL_SPEED = 120;

// ---------------------------------------------------------------------------
// Weapon firing context — bundles the dependencies shared by all weapon
// helpers so they don't need to accept a long parameter list individually.
// ---------------------------------------------------------------------------

interface WeaponFiringCtx {
  state: GameState;
  camera: Camera;
  hud: HUD;
  spaceFluid: SpaceFluid;
  actionMenu: ActionMenu;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Handle all per-tick player weapon firing (overdrive, overheat, primary,
 * and special abilities).  Returns the (possibly new) activeGuidedMissile.
 */
export function updatePlayerFiring(
  ctx: WeaponFiringCtx,
  activeGuidedMissile: GuidedMissile | null,
): GuidedMissile | null {
  const { state, camera, hud, spaceFluid, actionMenu } = ctx;
  if (!state.player.alive) return activeGuidedMissile;
  const player = state.player;

  if (Input.isDown('c') || actionMenu.open || actionMenu.placementMode) {
    // Cancel laser charge if the player opened the menu while charging
    if (player.isLaserCharging && !Input.mouse2Down) {
      player.isLaserCharging = false;
      player.laserChargeTimer = 0;
    }
    return activeGuidedMissile;
  }

  const aimWorld = camera.screenToWorld(Input.mousePos);

  // --- Gatling overdrive: auto-fires at extreme rate, no LMB required ---
  if (player.gatlingOverdriveTimer > 0) {
    // Overdrive fire rate is much faster than normal; divide the base interval
    const overdriveCooldown =
      WEAPON_STATS.gatling.fireRate * DT * player.fireCooldownMultiplier / GATLING_OVERDRIVE_FIRE_RATE_DIVISOR;
    if (player.primaryFireTimer <= 0 && player.battery >= GATLING_BATTERY_FIRE_COST) {
      player.consumePrimaryFire(overdriveCooldown, GATLING_BATTERY_FIRE_COST);
      const spread = randomRange(-Math.PI / 36, Math.PI / 36);
      state.addEntity(new GatlingBullet(
        Team.Player, player.position.clone(), player.angle + spread, player,
      ));
      Audio.playSound('shortbullet');
    }
    player.gatlingOverdriveTimer -= DT;
    if (player.gatlingOverdriveTimer <= 0) {
      player.gatlingOverdriveTimer = 0;
      player.gatlingOverheatTimer = GATLING_OVERHEAT_DURATION_SECS;
      hud.showMessage('GATLING OVERHEAT — immobilised for 4s', Colors.alert1, 4.5);
      Audio.playSound('explode0');
    }
    return activeGuidedMissile; // no other firing during overdrive
  }

  // --- Gatling overheat lockdown: no movement or firing ---
  if (player.gatlingOverheatTimer > 0) {
    player.gatlingOverheatTimer -= DT;
    if (player.gatlingOverheatTimer <= 0) {
      player.gatlingOverheatTimer = 0;
      hud.showMessage('System cooled', Colors.friendly_status, 2);
    }
    return activeGuidedMissile; // no firing during overheat
  }

  // --- Primary fire (LMB) ---
  let updatedMissile = activeGuidedMissile;
  if (Input.mouseDown && player.canFirePrimary()) {
    updatedMissile = fireSelectedPrimary(ctx, aimWorld, activeGuidedMissile);
  }

  // --- Weapon special ability (RMB) ---
  handleWeaponSpecial(ctx, aimWorld);

  return updatedMissile;
}

/**
 * Steer or release the active guided missile each tick.
 * Returns the (possibly cleared) activeGuidedMissile.
 */
export function updateGuidedMissileControl(
  ctx: WeaponFiringCtx,
  activeGuidedMissile: GuidedMissile | null,
): GuidedMissile | null {
  const { state, camera, actionMenu } = ctx;
  const missile = activeGuidedMissile;
  if (!missile) return null;
  if (!missile.alive) return null;
  if (!Input.mouseDown || Input.isDown('c') || actionMenu.open || actionMenu.placementMode) {
    missile.release();
    return null;
  }
  const stillPowered = state.player.drainBattery(GUIDED_MISSILE_CONTROL_BATTERY_DRAIN * DT);
  if (!stillPowered) {
    missile.release();
    return null;
  }
  missile.steerToward(camera.screenToWorld(Input.mousePos));
  return missile;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function fireSelectedPrimary(
  ctx: WeaponFiringCtx,
  aimWorld: Vec2,
  activeGuidedMissile: GuidedMissile | null,
): GuidedMissile | null {
  const { state, spaceFluid } = ctx;
  const weapon = state.player.primaryWeaponId;
  const PLAYER_FIRE_COOLDOWN = WEAPON_STATS.fire.fireRate * DT;

  if (weapon === 'gatling' && state.researchedItems.has('weaponGatling')) {
    state.player.consumePrimaryFire(
      WEAPON_STATS.gatling.fireRate * DT * state.player.fireCooldownMultiplier,
      GATLING_BATTERY_FIRE_COST,
    );
    const spread = randomRange(-Math.PI / 60, Math.PI / 60);
    state.addEntity(new GatlingBullet(
      Team.Player,
      state.player.position.clone(),
      state.player.angle + spread,
      state.player,
    ));
    // Small muzzle flash on every 3rd shot to avoid spam
    if (Math.random() < 0.33) {
      const mpos = new Vec2(
        state.player.position.x + Math.cos(state.player.angle) * 12,
        state.player.position.y + Math.sin(state.player.angle) * 12,
      );
      state.particles.emitMuzzleFlash(mpos, state.player.angle);
    }
    Audio.playSound('shortbullet');
    return activeGuidedMissile;
  }
  if (weapon === 'guidedmissile' && state.researchedItems.has('weaponGuidedMissile')) {
    if (activeGuidedMissile?.alive) return activeGuidedMissile;
    if (state.player.battery < GUIDED_MISSILE_INITIAL_BATTERY_COST) return activeGuidedMissile;
    state.player.consumePrimaryFire(
      WEAPON_STATS.guidedmissile.fireRate * DT * state.player.fireCooldownMultiplier,
      GUIDED_MISSILE_INITIAL_BATTERY_COST,
    );
    const missile = new GuidedMissile(
      Team.Player,
      state.player.position.clone(),
      state.player.angle,
      state.player,
    );
    missile.steerToward(aimWorld);
    state.addEntity(missile);
    Audio.playSound('missile');
    return missile;
  }
  if (weapon === 'laser' && state.researchedItems.has('weaponLaser')) {
    state.player.consumePrimaryFire(WEAPON_STATS.laser.fireRate * DT * state.player.fireCooldownMultiplier);
    const start = state.player.position.clone();
    const end = new Vec2(
      start.x + Math.cos(state.player.angle) * WEAPON_STATS.laser.range,
      start.y + Math.sin(state.player.angle) * WEAPON_STATS.laser.range,
    );
    state.addEntity(new Laser(Team.Player, start, end, state.player));
    damageLaserLine(state, spaceFluid, state.player, start, end, WEAPON_STATS.laser.damage);
    Audio.playSound('laser');
    return activeGuidedMissile;
  }
  if (weapon === 'synonymousLaser' && isSynonymousFaction(state.factionByTeam, Team.Player)) {
    const player = state.player;
    const cooldown = player.synonymousLaserCooldown(WEAPON_STATS.synonymousLaser.fireRate * DT);
    player.consumePrimaryFire(cooldown);
    player.synonymousMuzzleFlash = 0.22;
    const start = player.position.clone();
    const end = new Vec2(
      start.x + Math.cos(player.angle) * WEAPON_STATS.synonymousLaser.range,
      start.y + Math.sin(player.angle) * WEAPON_STATS.synonymousLaser.range,
    );
    state.addEntity(new Laser(Team.Player, start, end, player));
    damageLaserLineLimited(
      state,
      spaceFluid,
      start,
      end,
      WEAPON_STATS.synonymousLaser.damage,
      5,
      WEAPON_STATS.synonymousLaser.pierce * player.synonymousPierceMultiplier,
      player,
    );
    Audio.playSound('laser');
    return activeGuidedMissile;
  }

  state.player.consumePrimaryFire(PLAYER_FIRE_COOLDOWN * state.player.fireCooldownMultiplier);
  const muzzlePos = new Vec2(
    state.player.position.x + Math.cos(state.player.angle) * 14,
    state.player.position.y + Math.sin(state.player.angle) * 14,
  );
  state.particles.emitMuzzleFlash(muzzlePos, state.player.angle);
  const target = findClosestEnemy(state, state.player.position, Team.Player, 520);
  const projectile = state.researchedItems.has('weaponCannon')
    ? new HomingBullet(Team.Player, state.player.position.clone(), state.player.angle, state.player, target)
    : new Bullet(Team.Player, state.player.position.clone(), state.player.angle, state.player, target);
  state.addEntity(projectile);
  Audio.playSound('fire');
  return activeGuidedMissile;
}

/**
 * Dispatch the right-click (RMB) special ability for the equipped weapon.
 * Each weapon has its own unique ability; the fallback is the registered
 * special ability from special.ts (homing missile).
 */
function handleWeaponSpecial(ctx: WeaponFiringCtx, aimWorld: Vec2): void {
  const { state, hud } = ctx;
  const player = state.player;
  const weapon = player.primaryWeaponId;

  if (weapon === 'gatling' && state.researchedItems.has('weaponGatling')) {
    handleGatlingSpecial(state, hud);
  } else if (weapon === 'laser' && state.researchedItems.has('weaponLaser')) {
    handleLaserSpecial(ctx, aimWorld);
  } else if (weapon === 'guidedmissile' && state.researchedItems.has('weaponGuidedMissile')) {
    handleRocketSwarmSpecial(ctx, aimWorld);
  } else if (weapon === 'cannon') {
    handleCannonMineSpecial(state, aimWorld);
  } else {
    // Fallback: registered special ability (missile)
    if (Input.mouse2Down) {
      tryFireSpecial(state, player, aimWorld);
    }
  }
}

function handleCannonMineSpecial(state: GameState, aimWorld: Vec2): void {
  const player = state.player;
  if (!Input.mouse2Down) return;
  if (player.weaponSpecialCooldown > 0) return;
  const mineCost = player.maxBattery * (
    state.researchedItems.has('weaponCannon')
      ? CANNON_MINE_UPGRADED_BATTERY_FRACTION
      : CANNON_MINE_BASE_BATTERY_FRACTION
  );
  if (player.battery < mineCost) return;

  const angle = player.position.angleTo(aimWorld);
  const deployOffset = player.radius + 10;
  const spawn = new Vec2(
    player.position.x + Math.cos(angle) * deployOffset,
    player.position.y + Math.sin(angle) * deployOffset,
  );
  const mine = new CrossLaserMine(Team.Player, spawn, angle, CANNON_MINE_INITIAL_SPEED, player, state);
  state.addEntity(mine);
  player.battery -= mineCost;
  player.weaponSpecialCooldown = CANNON_MINE_COOLDOWN_SECS;
  Audio.playSound('missile');
}

/**
 * Gatling gun special (RMB): enter overdrive — extreme auto-fire for
 * GATLING_OVERDRIVE_DURATION_SECS, then GATLING_OVERHEAT_DURATION_SECS of
 * complete immobility.
 */
function handleGatlingSpecial(state: GameState, hud: HUD): void {
  const player = state.player;
  if (!Input.mouse2Pressed) return;
  if (player.gatlingOverdriveTimer > 0 || player.gatlingOverheatTimer > 0) return;
  if (player.battery < GATLING_BATTERY_FIRE_COST) return;

  player.gatlingOverdriveTimer = GATLING_OVERDRIVE_DURATION_SECS;
  hud.showMessage('GATLING OVERDRIVE!', Colors.alert2, 2.5);
  Audio.playSound('shortbullet');
}

/**
 * Laser special (RMB): hold to charge, release to fire deterministic,
 * vermiculate piercing lasers. Every complete 10 battery creates one laser.
 */
function handleLaserSpecial(ctx: WeaponFiringCtx, aimWorld: Vec2): void {
  const { state, spaceFluid } = ctx;
  const player = state.player;

  if (player.weaponSpecialCooldown > 0) {
    if (player.isLaserCharging && !Input.mouse2Down) {
      player.isLaserCharging = false;
      player.laserChargeTimer = 0;
    }
    return;
  }

  if (Input.mouse2Down) {
    if (!player.isLaserCharging) {
      if (player.battery > 0) {
        player.isLaserCharging = true;
        player.laserChargeTimer = 0;
      }
    } else {
      player.laserChargeTimer = Math.min(player.laserChargeTimer + DT, LASER_MAX_CHARGE_SECS);
    }
  }

  if (player.isLaserCharging && !Input.mouse2Down) {
    player.isLaserCharging = false;
    if (player.battery > 0 && player.laserChargeTimer > 0.15) {
      const energySpent = player.battery;
      const chargeFraction = Math.min(1, player.laserChargeTimer / LASER_MAX_CHARGE_SECS);
      // Damage scales with both energy available and charge fraction.
      // LASER_BURST_BASE_MULTIPLIER is the floor at empty battery / no charge;
      // LASER_BURST_ENERGY_SCALING adds up to 8× extra at full battery + full charge.
      const burstDamage =
        WEAPON_STATS.laser.damage * (LASER_BURST_BASE_MULTIPLIER + (energySpent / player.maxBattery) * LASER_BURST_ENERGY_SCALING * chargeFraction);
      const laserCount = Math.floor(energySpent / 10);
      if (laserCount === 0) {
        player.laserChargeTimer = 0;
        return;
      }
      player.battery = 0;
      const start = player.position.clone();
      const seedBase = hashLaserEnergy(energySpent);
      for (let i = 0; i < laserCount; i++) {
        const spread = laserCount <= 1 ? 0 : ((i / (laserCount - 1)) - 0.5) * 0.72;
        const angle = player.angle + spread;
        const end = start.add(new Vec2(Math.cos(angle), Math.sin(angle)));
        state.addEntity(new ChargedLaserBurst(
          Team.Player, start, end, player, chargeFraction, state, spaceFluid,
          (seedBase ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0,
        ));
      }
      state.particles.emitMuzzleFlash(start, player.angle);
      player.weaponSpecialCooldown = LASER_CHARGE_COOLDOWN_SECS;
      player.laserChargeTimer = 0;
      Audio.playSound('laser');
    } else {
      player.laserChargeTimer = 0;
    }
  }
}

/** Stable seed that preserves fractional energy differences as well as whole units. */
function hashLaserEnergy(energy: number): number {
  const text = energy.toPrecision(15);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Guided missile special (RMB): launch a spread swarm of
 * ROCKET_SWARM_COUNT small blast missiles.  Each swarm missile has a blast
 * radius, is interceptable by enemy bullets, and detonates on impact.
 */
function handleRocketSwarmSpecial(ctx: WeaponFiringCtx, aimWorld: Vec2): void {
  const { state, hud } = ctx;
  const player = state.player;
  if (!Input.mouse2Pressed) return;
  if (player.weaponSpecialCooldown > 0) return;
  if (player.battery < ROCKET_SWARM_ENERGY_COST) return;

  player.battery -= ROCKET_SWARM_ENERGY_COST;
  player.weaponSpecialCooldown = ROCKET_SWARM_COOLDOWN_SECS;

  const baseAngle = player.position.angleTo(aimWorld);
  const spreadRad = ROCKET_SWARM_SPREAD_DEGREES * (Math.PI / 180);
  const count = ROCKET_SWARM_COUNT;

  for (let i = 0; i < count; i++) {
    // Spread missiles evenly across the fan angle
    const t = count > 1 ? i / (count - 1) - 0.5 : 0;
    const angle = baseAngle + t * spreadRad;
    state.addEntity(new SwarmMissile(Team.Player, player.position.clone(), angle, player));
  }
  Audio.playSound('missile');
  hud.showMessage('Missile swarm!', Colors.alert2, 1.5);
}

