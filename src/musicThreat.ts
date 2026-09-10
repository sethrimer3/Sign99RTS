import { EntityType, Team } from './entities.js';

export type ThreatLevel = 1 | 2 | 3 | 4 | 5;
export interface ThreatMetrics {
  enemyTurrets: number;
  enemyFighters: number;
  playerFighters: number;
  commandPostHealthRatio: number;
}
const turretTypes = new Set([EntityType.GatlingTurret, EntityType.MissileTurret,
  EntityType.ExciterTurret, EntityType.MassDriverTurret, EntityType.RegenTurret, EntityType.TetherTurret]);
interface ThreatEntity { type: EntityType; team: Team; alive: boolean; }
interface ThreatBuilding extends ThreatEntity { buildProgress: number; health: number; maxHealth: number; }
export function readThreatMetrics(state: { buildings: readonly ThreatBuilding[]; fighters: readonly ThreatEntity[] }, localTeam: Team): ThreatMetrics {
  const hostile = (team: Team) => team !== Team.Neutral && team !== localTeam;
  const cp = state.buildings.find(b => b.type === EntityType.CommandPost && b.team === localTeam && b.alive);
  return {
    enemyTurrets: state.buildings.filter(b => b.alive && b.buildProgress >= 1 && hostile(b.team) && turretTypes.has(b.type)).length,
    enemyFighters: state.fighters.filter(f => f.alive && f.type === EntityType.Fighter && hostile(f.team)).length,
    playerFighters: state.fighters.filter(f => f.alive && f.type === EntityType.Fighter && f.team === localTeam).length,
    commandPostHealthRatio: cp && cp.maxHealth > 0 ? cp.health / cp.maxHealth : 0,
  };
}
export function qualifyingThreatLevel(m: ThreatMetrics): ThreatLevel {
  if (m.enemyFighters >= Math.max(10, m.playerFighters * 2) && m.commandPostHealthRatio <= 0.75) return 5;
  if (m.enemyTurrets >= 60 || m.enemyFighters >= 30) return 4;
  if (m.enemyTurrets >= 40 || m.enemyFighters >= 15) return 3;
  if (m.enemyTurrets >= 20 || m.enemyFighters >= 5) return 2;
  return 1;
}

/** Gameplay time only: a changed candidate must persist continuously. */
export class MusicThreatTracker {
  level: ThreatLevel = 1;
  private candidate: ThreatLevel = 1;
  private elapsed = 0;
  reset(): void { this.level = this.candidate = 1; this.elapsed = 0; }
  update(metrics: ThreatMetrics, dt: number): ThreatLevel {
    const next = qualifyingThreatLevel(metrics);
    if (next === this.level) { this.candidate = next; this.elapsed = 0; return this.level; }
    if (next !== this.candidate) { this.candidate = next; this.elapsed = 0; }
    this.elapsed += Math.max(0, dt);
    if (this.elapsed + 1e-9 >= (next > this.level ? 5 : 30)) {
      this.level = next;
      this.elapsed = 0;
    }
    return this.level;
  }
}
