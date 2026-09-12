import { Vec2 } from './math.js';
import { Input } from './input.js';
import { Colors } from './colors.js';
import { Team, EntityType } from './entities.js';
import type { GameState } from './gamestate.js';
import { HUD } from './hud.js';
import { CommandPost } from './building.js';
import { AIShip } from './vsaibot.js';
import { isHostile, isPlayableTeam, teamColor } from './teamutils.js';
import { WORLD_HEIGHT, WORLD_WIDTH } from './constants.js';
import { GhostShipEffect } from './ghostShipEffect.js';
import { hashStringToSeed } from './proceduralShips.js';

export interface PlayerRespawnRuntime {
  respawnTimer: number;
  deathHandled: boolean;
  loss: boolean;
  ghostPos: Vec2 | null;
  ghostVel: Vec2;
  ghostFacing: number;
  /** Purely visual fractal "spirit ship" grown behind the spectator anchor. */
  ghostEffect: GhostShipEffect;
}

export interface AIRespawnRuntime {
  respawnTimer: number;
  deathHandled: boolean;
}

export function createPlayerRespawnRuntime(): PlayerRespawnRuntime {
  return {
    respawnTimer: 0,
    deathHandled: false,
    loss: false,
    ghostPos: null,
    ghostVel: new Vec2(0, 0),
    ghostFacing: 0,
    ghostEffect: new GhostShipEffect(),
  };
}

export function createAIRespawnRuntime(): AIRespawnRuntime {
  return {
    respawnTimer: 0,
    deathHandled: false,
  };
}

export function resetRespawnRuntime(
  playerRuntime: PlayerRespawnRuntime,
  aiRuntime: AIRespawnRuntime,
): void {
  playerRuntime.deathHandled = false;
  playerRuntime.respawnTimer = 0;
  playerRuntime.loss = false;
  playerRuntime.ghostPos = null;
  playerRuntime.ghostVel = new Vec2(0, 0);
  playerRuntime.ghostFacing = 0;
  playerRuntime.ghostEffect.clear();
  aiRuntime.respawnTimer = 0;
  aiRuntime.deathHandled = false;
}

export function updatePlayerRespawn(
  state: GameState,
  hud: HUD,
  localTeam: Team,
  runtime: PlayerRespawnRuntime,
  dt: number,
  respawnDelay: number,
): void {
  const respawnCp = findRespawnCommandPost(state, localTeam);

  // A ship without a Command Post has already lost its physical foothold in
  // the match. Enter spectator form immediately instead of leaving an armed,
  // targetable player ship flying around until something eventually kills it.
  if (!respawnCp && state.player.alive) {
    runtime.ghostPos = state.player.position.clone();
    runtime.ghostVel = state.player.velocity.clone();
    runtime.ghostFacing = state.player.angle;
    beginGhostEffect(state, runtime);
    state.player.alive = false;
    runtime.deathHandled = true;
    runtime.respawnTimer = 0;
    refundPlannedConstruction(state, hud, state.player.team);
    hud.showMessage('Command Post destroyed - ghost ship engaged.', Colors.alert1, 5);
  }

  if (state.player.alive) {
    runtime.deathHandled = false;
    runtime.respawnTimer = 0;
    runtime.ghostPos = null;
    runtime.ghostVel = new Vec2(0, 0);
    runtime.ghostEffect.clear();
    return;
  }

  if (!runtime.ghostPos) {
    runtime.ghostPos = state.player.position.clone();
    runtime.ghostVel = new Vec2(0, 0);
    runtime.ghostFacing = state.player.angle;
    beginGhostEffect(state, runtime);
  }

  if (!respawnCp) {
    runtime.loss = true;
    runtime.respawnTimer = 0;
    return;
  }

  if (!runtime.deathHandled) {
    runtime.deathHandled = true;
    runtime.respawnTimer = respawnDelay;
    refundPlannedConstruction(state, hud, state.player.team);

    const penalty = 40 + countShipResearchUpgrades(state) * 10;
    awardSurvivalHeroShipReward(state, state.player.team, state.player.lastDamageSource?.team ?? Team.Neutral, state.player.position, Math.floor(penalty * 0.5));
    state.resources = Math.max(0, state.resources - penalty);

    hud.showMessage(
      `Ship destroyed! Respawning in ${respawnDelay}s  (-${penalty} resources)`,
      Colors.alert1,
      respawnDelay + 1,
    );
  }

  runtime.respawnTimer -= dt;
  if (runtime.respawnTimer <= 0) {
    const spawnPos = new Vec2(respawnCp.position.x, respawnCp.position.y - 60);
    state.player.revive(spawnPos);
    runtime.loss = false;
    runtime.ghostPos = null;
    runtime.ghostVel = new Vec2(0, 0);
    runtime.ghostEffect.clear();
    hud.showMessage('Respawned!', Colors.friendly_status, 2);
  }
}

export function updateAIShipRespawn(
  state: GameState,
  hud: HUD,
  runtime: AIRespawnRuntime,
  dt: number,
  aiRespawnDelay: number,
): void {
  if (state.gameMode !== 'vs_ai' || !state.aiPlayerShip) return;
  const ship = state.aiPlayerShip;
  if (!(ship instanceof AIShip)) return;
  if (ship.alive) {
    runtime.deathHandled = false;
    runtime.respawnTimer = 0;
    return;
  }

  const enemyCp = state.getEnemyCommandPost();
  if (!enemyCp) return;

  if (!runtime.deathHandled) {
    runtime.deathHandled = true;
    runtime.respawnTimer = aiRespawnDelay;
    awardSurvivalHeroShipReward(state, ship.team, ship.lastDamageSource?.team ?? Team.Neutral, ship.position, Math.floor((40 + countShipResearchUpgrades(state) * 10) * 0.5));
    hud.showMessage(`Rival ship destroyed - respawning in ${aiRespawnDelay}s`, Colors.alert2, 3);
  }

  runtime.respawnTimer -= dt;
  if (runtime.respawnTimer <= 0) {
    ship.revive(new Vec2(enemyCp.position.x, enemyCp.position.y - 80));
    ship.desiredMove = new Vec2(0, 0);
    ship.desiredAim = state.player.position.clone();
    ship.wantsFire = false;
    runtime.deathHandled = false;
    hud.showMessage('Rival ship respawned!', Colors.alert2, 2);
  }
}

export function updateGhostSpectator(
  state: GameState,
  runtime: PlayerRespawnRuntime,
  dt: number,
  aimWorld?: Vec2,
): void {
  if (state.player.alive || !runtime.ghostPos) return;

  let dx = 0;
  let dy = 0;
  if (Input.isDown('w')) dy -= 1;
  if (Input.isDown('s')) dy += 1;
  if (Input.isDown('a')) dx -= 1;
  if (Input.isDown('d')) dx += 1;

  if (dx !== 0 || dy !== 0) {
    const len = Math.hypot(dx, dy);
    const speed = Input.isDown('Shift') ? 1200 : 720;
    runtime.ghostVel = runtime.ghostVel.add(new Vec2((dx / len) * speed * dt, (dy / len) * speed * dt));
  }
  runtime.ghostVel = runtime.ghostVel.scale(1 / (1 + 5 * dt));
  runtime.ghostPos = runtime.ghostPos.add(runtime.ghostVel.scale(dt));
  runtime.ghostPos.x = Math.max(0, Math.min(WORLD_WIDTH, runtime.ghostPos.x));
  runtime.ghostPos.y = Math.max(0, Math.min(WORLD_HEIGHT, runtime.ghostPos.y));
  if (aimWorld) runtime.ghostFacing = runtime.ghostPos.angleTo(aimWorld);
  runtime.ghostEffect.update(dt, runtime.ghostPos.x, runtime.ghostPos.y, runtime.ghostFacing);
}

/** Grow the spirit ship from the death pose, seeded by the procedural design so the same
 *  ship always leaves the same organism. Visual only: nothing here touches gameplay state. */
function beginGhostEffect(state: GameState, runtime: PlayerRespawnRuntime): void {
  if (!runtime.ghostPos) return;
  const seed = state.player.design?.seed ?? hashStringToSeed('ghost-' + state.player.team);
  runtime.ghostEffect.reset(
    runtime.ghostPos.x,
    runtime.ghostPos.y,
    runtime.ghostFacing,
    seed,
    state.player.radius,
    teamColor(state.player.team),
  );
}

function refundPlannedConstruction(state: GameState, hud: HUD, team: Team): void {
  const cancelled = state.cancelPlannedConstruction(team);
  if (cancelled.buildings === 0 && cancelled.conduits === 0) return;
  const items = cancelled.buildings + cancelled.conduits;
  hud.showMessage(
    `Death cancelled ${items} planned build${items === 1 ? '' : 's'} and refunded ${cancelled.refund > 0 ? `${Math.floor(cancelled.refund)} resources` : 'their full cost'}.`,
    Colors.general_building,
    4,
  );
}

function findRespawnCommandPost(state: GameState, localTeam: Team): CommandPost | null {
  const own = state.getCommandPostForTeam(localTeam);
  if (own) return own;

  for (const b of state.buildings) {
    if (!b.alive || b.type !== EntityType.CommandPost || !(b instanceof CommandPost)) continue;
    if (!isPlayableTeam(b.team)) continue;
    if (!isHostile(localTeam, b.team)) return b;
  }
  return null;
}

function countShipResearchUpgrades(state: GameState): number {
  let count = 0;
  for (const key of state.researchedItems) {
    if (key.startsWith('shipHp') || key.startsWith('shipSpeedEnergy') || key.startsWith('shipShield') || key.startsWith('shipRepair')) count++;
  }
  return count;
}

function awardSurvivalHeroShipReward(
  state: GameState,
  destroyedTeam: Team,
  killerTeam: Team,
  pos: Vec2,
  amount: number,
): void {
  if (!state.survivalKillRewardsEnabled) return;
  if (killerTeam === Team.Neutral || killerTeam === destroyedTeam || amount <= 0) return;
  if (killerTeam === Team.Player) {
    state.resources += amount;
  } else if (destroyedTeam === Team.Player) {
    state.survivalEnemyRewardBank += amount;
  } else {
    return;
  }
  state.particles.emitFloatingText(pos.add(new Vec2(0, -34)), `+${amount}`, teamColor(killerTeam));
}
