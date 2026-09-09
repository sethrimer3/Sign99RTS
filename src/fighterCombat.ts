/**
 * Fighter weapon-fire logic extracted from game.ts.
 *
 * Handles the per-tick firing pass for all live, undocked fighters,
 * regardless of team — this covers human-controlled fighters on any team
 * as well as LAN AI fighters (which have no other source of autonomous
 * fire; practicemode.ts only drives the single-player Vs. AI enemy base).
 */

import { Audio } from './audio.js';
import { EntityType, Team } from './entities.js';
import { GameState } from './gamestate.js';
import {
  BomberShip,
  FighterShip,
  SynonymousFighterShip,
  SynonymousNovaBomberShip,
  SwarmShip,
} from './fighter.js';
import {
  Bullet,
  BomberMissile,
  SynonymousDroneLaser,
  SynonymousNovaBomb,
  SwarmFighterLaser,
} from './projectile.js';
import { SpaceFluid } from './spacefluid.js';
import { WEAPON_STATS } from './constants.js';
import { damageLaserLineLimited } from './combatUtils.js';
import { aimAngle, aimAtEntity, isCombatTargetValid, recordCombatAimSample } from './targeting.js';
import type { Entity } from './entities.js';

const fighterTargetScratch: Entity[] = [];

/**
 * For each live, undocked fighter: find the nearest enemy in weapon range
 * and fire the appropriate weapon for that fighter type.
 *
 * In 'practice'/'vs_ai' modes the single Vs. AI enemy base's fighters are
 * already fired by practicemode.ts's own loop (which also drives their
 * targeting/orders), so this pass skips them there to avoid double-firing.
 * In LAN/online modes there is no such per-team loop, so every team's
 * fighters (human and AI alike) are handled here.
 *
 * Fighter references are not mutated beyond standard shot-consumption and
 * nova-charge state; all projectiles are inserted into `state` directly.
 */
export function updateFighterWeaponFire(state: GameState, spaceFluid: SpaceFluid): void {
  const skipNonPlayerTeams = state.gameMode === 'practice' || state.gameMode === 'vs_ai';
  for (const f of state.fighters) {
    if (!f.alive || f.docked) continue;
    if (skipNonPlayerTeams && f.team !== Team.Player) continue;
    if (!f.canFire()) continue;

    const nearby = state.queryEntitiesInRange(f.position, f.weaponRange, fighterTargetScratch);
    let target = null;
    let bestScore = Infinity;
    for (const e of nearby) {
      if (!isCombatTargetValid(f, e, f.weaponRange)) continue;
      const d = f.position.distanceTo(e.position);
      const score = fighterTargetScore(f, e, d);
      if (score < bestScore) {
        bestScore = score;
        target = e;
      }
    }
    if (!target) continue;
    const isSwarmFighter = f instanceof SwarmShip;
    if (isSwarmFighter) {
      const end = target.position.clone();
      f.consumeShot(f.fireRate);
      state.addEntity(new SwarmFighterLaser(f.team, f.position.clone(), end, f));
      damageLaserLineLimited(state, spaceFluid, f.position.clone(), end, f.weaponDamage, 1, 1, f);
      Audio.playSoundAt('laser', f.position, 1400, 1 / 3);
      recordCombatAimSample({
        shooterId: f.id,
        targetId: target.id,
        shooter: f.position.clone(),
        target: target.position.clone(),
        targetVelocity: target.velocity.clone(),
        aimPoint: end,
        spawn: f.position.clone(),
        range: f.weaponRange,
        interceptValid: true,
        createdAt: state.gameTime,
      });
      continue;
    }
    const projectileSpeed = f instanceof BomberShip ? WEAPON_STATS.bigmissile.speed : isSwarmFighter ? WEAPON_STATS.laser.speed : WEAPON_STATS.fire.speed;
    const aim = aimAtEntity(f, target, projectileSpeed, {
      maxPredictionTime: f instanceof BomberShip ? 0.7 : 1.0,
      fallback: isSwarmFighter ? 'current' : 'shortPrediction',
    });
    const angle = aimAngle(aim);
    if (angle === null) continue;
    let firedAimPoint = aim.aimPoint.clone();

    if (f instanceof SynonymousNovaBomberShip) {
      const charged = f.consumeChargedNova();
      if (charged) {
        const novaFireAngle = f.position.angleTo(charged.target);
        state.addEntity(new SynonymousNovaBomb(
          f.team, f.position.clone(), novaFireAngle,
          charged.aoeRadius, charged.damage, charged.travel, f,
        ));
        Audio.playSoundAt('laser', f.position, 1400);
      } else {
        f.beginNovaCharge(target.position);
      }
    } else if (f instanceof BomberShip) {
      f.consumeShot(WEAPON_STATS.bigmissile.fireRate);
      state.addEntity(new BomberMissile(f.team, f.position.clone(), angle, f));
      Audio.playSoundAt('missile', f.position, 1400);
    } else if (f instanceof SynonymousFighterShip) {
      f.markCombatSplit();
      f.consumeShot(f.fireRate);
      for (let i = 0; i < f.droneCount; i++) {
        const start = f.firingOrigin(i);
        const laserAim = aimAtEntity(f, target, WEAPON_STATS.laser.speed, { fallback: 'current' });
        const end = laserAim.aimPoint.clone();
        state.addEntity(new SynonymousDroneLaser(f.team, start, end, f));
        damageLaserLineLimited(state, spaceFluid, start, end, f.weaponDamage, 3, 2, f);
      }
      Audio.playSoundAt('laser', f.position, 1400);
    } else {
      f.consumeShot(WEAPON_STATS.fire.fireRate);
      const bullet = new Bullet(f.team, f.position.clone(), angle, f, target);
      bullet.damage = f.weaponDamage;
      state.addEntity(bullet);
    }
    recordCombatAimSample({
      shooterId: f.id,
      targetId: target.id,
      shooter: f.position.clone(),
      target: target.position.clone(),
      targetVelocity: target.velocity.clone(),
      aimPoint: firedAimPoint,
      spawn: f.position.clone(),
      range: f.weaponRange,
      interceptValid: aim.valid && !aim.usedFallback,
      createdAt: state.gameTime,
    });
  }
}

function fighterTargetScore(fighter: FighterShip, target: Entity, distance: number): number {
  if (!fighter.targetingUpgraded) return distance;
  if (target.type === EntityType.RegenTurret) return distance - 20_000;
  if (
    target.type === EntityType.GatlingTurret ||
    target.type === EntityType.MissileTurret ||
    target.type === EntityType.ExciterTurret ||
    target.type === EntityType.MassDriverTurret
  ) {
    return distance - 10_000;
  }
  return distance;
}
