/**
 * Local-player turret firing logic extracted from game.ts.
 *
 * In practice/vs-AI modes the enemy base planner manages enemy turrets
 * directly, so this module only handles the local-player-team turrets
 * that the `Game` class drives (single-player and LAN/online local team).
 */

import { Audio } from './audio.js';
import { EntityType, Team } from './entities.js';
import { GameState } from './gamestate.js';
import { Bullet, ExciterBeam, GatlingTurretBullet } from './projectile.js';
import { MassDriverBullet, Missile } from './projectile.js';
import { TurretBase } from './turret.js';
import { WEAPON_STATS } from './constants.js';
import { damageLaserLine } from './combatUtils.js';
import { aimAngle, recordCombatAimSample } from './targeting.js';
import { Vec2 } from './math.js';
import { isLegacyGraphics } from './graphicsmode.js';

const MAX_AUDIBLE_GATLING_TURRETS = 2;

/**
 * Acquire targets and fire for every fully-built turret that belongs to
 * `localTeam`.  Uses `state.player.position` for spatial audio distance.
 */
export function fireTurretShots(state: GameState, localTeam: Team): void {
  const phase = Math.floor(state.gameTime * 12);
  for (const b of state.buildings) {
    if (!b.alive || b.team !== localTeam || !(b instanceof TurretBase)) continue;
    if (b.buildProgress < 1 || !b.powered) continue;
    if (!b.targetEntity || ((b.id + phase) % 3) === 0) {
      state.acquireTurretTarget(b);
    }
    if (!b.canFire()) continue;
    const target = b.targetEntity;
    if (!target) continue;
    const aim = b.computeAim(target);
    const angle = aimAngle(aim);
    if (b.type !== EntityType.ExciterTurret && angle === null) continue;
    if (angle !== null) b.turretAngle = angle;
    if (b.type === EntityType.RegenTurret) {
      b.consumeShot();
      target.repair(10);
      state.particles.emitHealing(target.position);
      b.showBeam(target.position);
      Audio.playSoundAt('regenbullet', b.position);
    } else if (b.type === EntityType.MissileTurret) {
      b.consumeShot();
      state.addEntity(new Missile(b.team, b.position.clone(), angle ?? b.turretAngle, b, target));
      Audio.playSoundAt('missile', b.position);
    } else if (b.type === EntityType.GatlingTurret) {
      b.consumeShot();
      const spread = (Math.random() - 0.5) * WEAPON_STATS.gatlingturret.spread;
      const fireAngle = (angle ?? b.turretAngle) + spread;
      if (isLegacyGraphics()) {
        state.addEntity(new GatlingTurretBullet(b.team, b.position.clone(), fireAngle, b));
      } else {
        state.gatlingField.spawn(b.team, b.position.x, b.position.y, fireAngle, b);
      }
      if (Math.random() < 0.25) state.particles.emitMuzzleFlash(b.position, fireAngle);
      Audio.playLimitedSoundAt('shortbullet', b.position, MAX_AUDIBLE_GATLING_TURRETS);
    } else if (b.type === EntityType.ExciterTurret) {
      const targetPos = target.position.clone();
      const fireAngle = b.position.angleTo(targetPos);
      b.turretAngle = fireAngle;
      const end = b.position.add(new Vec2(Math.cos(fireAngle), Math.sin(fireAngle)).scale(WEAPON_STATS.exciterbeam.range));
      b.consumeShot();
      state.addEntity(new ExciterBeam(b.team, b.position.clone(), end, b));
      damageLaserLine(state, null, b, b.position, end, WEAPON_STATS.exciterbeam.damage, 4);
      Audio.playSoundAt('exciterbeam', b.position);
    } else if (b.type === EntityType.MassDriverTurret) {
      b.consumeShot();
      state.addEntity(new MassDriverBullet(b.team, b.position.clone(), angle ?? b.turretAngle, b));
      Audio.playSoundAt('massdriverbullet', b.position);
    } else {
      b.consumeShot();
      const fireAngle = angle ?? b.turretAngle;
      state.addEntity(new Bullet(b.team, b.position.clone(), fireAngle, b));
      state.particles.emitMuzzleFlash(b.position, fireAngle);
      Audio.playSoundAt('fire', b.position);
    }
    recordCombatAimSample({
      shooterId: b.id,
      targetId: target.id,
      shooter: b.position.clone(),
      target: target.position.clone(),
      targetVelocity: target.velocity.clone(),
      aimPoint: aim.aimPoint.clone(),
      spawn: b.position.clone(),
      range: b.range,
      interceptValid: aim.valid && !aim.usedFallback,
      createdAt: state.gameTime,
    });
  }
}
