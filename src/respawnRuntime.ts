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

export interface PlayerRespawnRuntime {
  respawnTimer: number;
  deathHandled: boolean;
  loss: boolean;
  ghostPos: Vec2 | null;
  ghostVel: Vec2;
  ghostFacing: number;
  ghostLights: GhostLight[];
}

export interface GhostTrailSample {
  x: number;
  y: number;
  age: number;
}

export interface GhostLight {
  x: number;
  y: number;
  response: number;
  sampleTimer: number;
  trail: GhostTrailSample[];
}

/** Hull-perimeter points, in ship-radius units, ordered around the outline. */
const GHOST_HULL_POINTS: ReadonlyArray<readonly [number, number]> = [
  [1.38, 0], [0.82, -0.38], [0.22, -0.62], [-0.42, -0.72],
  [-0.90, -0.72], [-0.70, -0.36], [-0.52, 0], [-0.70, 0.36],
  [-0.90, 0.72], [-0.42, 0.72], [0.22, 0.62], [0.82, 0.38],
];
const GHOST_RADIUS = 22;
const GHOST_TRAIL_SAMPLES = 8;
const GHOST_TRAIL_LIFETIME = 0.34;

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
    ghostLights: [],
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
  playerRuntime.ghostLights.length = 0;
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
    resetGhostLights(runtime);
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
    runtime.ghostLights.length = 0;
    return;
  }

  if (!runtime.ghostPos) {
    runtime.ghostPos = state.player.position.clone();
    runtime.ghostVel = new Vec2(0, 0);
    runtime.ghostFacing = state.player.angle;
    resetGhostLights(runtime);
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
    runtime.ghostLights.length = 0;
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
  updateGhostLights(runtime, dt);
}

function resetGhostLights(runtime: PlayerRespawnRuntime): void {
  runtime.ghostLights.length = 0;
  if (!runtime.ghostPos) return;
  const cos = Math.cos(runtime.ghostFacing);
  const sin = Math.sin(runtime.ghostFacing);
  for (let i = 0; i < GHOST_HULL_POINTS.length; i++) {
    const [hx, hy] = GHOST_HULL_POINTS[i];
    const ox = hx * GHOST_RADIUS;
    const oy = hy * GHOST_RADIUS;
    const x = runtime.ghostPos.x + ox * cos - oy * sin;
    const y = runtime.ghostPos.y + ox * sin + oy * cos;
    runtime.ghostLights.push({
      x,
      y,
      response: 5 + (i % 5) * 1.7,
      sampleTimer: 0,
      trail: [{ x, y, age: 0 }],
    });
  }
}

function updateGhostLights(runtime: PlayerRespawnRuntime, dt: number): void {
  if (!runtime.ghostPos) return;
  if (runtime.ghostLights.length !== GHOST_HULL_POINTS.length) resetGhostLights(runtime);
  const cos = Math.cos(runtime.ghostFacing);
  const sin = Math.sin(runtime.ghostFacing);
  for (let i = 0; i < runtime.ghostLights.length; i++) {
    const light = runtime.ghostLights[i];
    const [hx, hy] = GHOST_HULL_POINTS[i];
    const ox = hx * GHOST_RADIUS;
    const oy = hy * GHOST_RADIUS;
    const targetX = runtime.ghostPos.x + ox * cos - oy * sin;
    const targetY = runtime.ghostPos.y + ox * sin + oy * cos;
    if (Math.hypot(targetX - light.x, targetY - light.y) > 420) {
      light.x = targetX;
      light.y = targetY;
      light.trail.length = 0;
    } else {
      const follow = 1 - Math.exp(-light.response * dt);
      light.x += (targetX - light.x) * follow;
      light.y += (targetY - light.y) * follow;
    }

    let write = 0;
    for (let read = 0; read < light.trail.length; read++) {
      const sample = light.trail[read];
      sample.age += dt;
      if (sample.age <= GHOST_TRAIL_LIFETIME) light.trail[write++] = sample;
    }
    light.trail.length = write;
    light.sampleTimer += dt;
    const last = light.trail[light.trail.length - 1];
    if (!last || light.sampleTimer >= 0.035 || Math.hypot(light.x - last.x, light.y - last.y) >= 2.5) {
      light.trail.push({ x: light.x, y: light.y, age: 0 });
      light.sampleTimer = 0;
      if (light.trail.length > GHOST_TRAIL_SAMPLES) light.trail.shift();
    }
  }
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
    if (key.startsWith('shipHp') || key.startsWith('shipSpeedEnergy') || key.startsWith('shipShield')) count++;
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
