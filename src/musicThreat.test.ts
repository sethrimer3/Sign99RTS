import { describe, expect, it } from 'vitest';
import { EntityType, Team } from './entities.js';
import { MusicThreatTracker, qualifyingThreatLevel, readThreatMetrics, type ThreatMetrics } from './musicThreat.js';
const safe: ThreatMetrics = { enemyTurrets: 0, enemyFighters: 0, playerFighters: 10, commandPostHealthRatio: 1 };
describe('music threat thresholds', () => {
  it.each([[19,1],[20,2],[39,2],[40,3],[59,3],[60,4]])('counts %i turrets as level %i', (enemyTurrets, level) => {
    expect(qualifyingThreatLevel({ ...safe, enemyTurrets })).toBe(level);
  });
  it.each([[4,1],[5,2],[14,2],[15,3],[29,3],[30,4]])('counts %i fighters as level %i', (enemyFighters, level) => {
    expect(qualifyingThreatLevel({ ...safe, enemyFighters })).toBe(level);
  });
  it('requires every level-five condition and chooses the highest level', () => {
    const danger = { ...safe, enemyFighters: 20, commandPostHealthRatio: 0.75 };
    expect(qualifyingThreatLevel(danger)).toBe(5);
    expect(qualifyingThreatLevel({ ...danger, enemyFighters: 19 })).toBe(3);
    expect(qualifyingThreatLevel({ ...danger, commandPostHealthRatio: 0.751 })).toBe(3);
    expect(qualifyingThreatLevel({ ...danger, playerFighters: 0, enemyFighters: 9 })).toBe(2);
    expect(qualifyingThreatLevel({ ...danger, playerFighters: 0, enemyFighters: 10 })).toBe(5);
    expect(qualifyingThreatLevel({ ...safe, enemyTurrets: 60, enemyFighters: 5 })).toBe(4);
  });
  it('delays escalation 5 seconds and recovery 30 seconds, with direct jumps and resets', () => {
    const tracker = new MusicThreatTracker();
    const danger = { ...safe, enemyFighters: 30 };
    expect(tracker.update(danger, 4.9)).toBe(1);
    expect(tracker.update(danger, 0.1)).toBe(4);
    expect(tracker.update(safe, 29.9)).toBe(4);
    expect(tracker.update(safe, 0.1)).toBe(1);
    tracker.update(danger, 4);
    tracker.update(safe, 1);
    expect(tracker.update(danger, 1)).toBe(1);
    tracker.reset();
    expect(tracker.update(danger, 4)).toBe(1);
    expect(tracker.update(danger, 1)).toBe(4);
  });
  it('restarts the timer when the qualifying level changes', () => {
    const tracker = new MusicThreatTracker();
    tracker.update({ ...safe, enemyFighters: 5 }, 4);
    expect(tracker.update({ ...safe, enemyFighters: 30 }, 1)).toBe(1);
    expect(tracker.update({ ...safe, enemyFighters: 30 }, 4)).toBe(4);
  });
  it('uses local-team ownership, completed living turrets, and fighter types', () => {
    const turret = { type: EntityType.MissileTurret, team: Team.Player1, alive: true, buildProgress: 1, health: 100, maxHealth: 100 };
    const fighter = { type: EntityType.Fighter, team: Team.Player1, alive: true };
    const metrics = readThreatMetrics({ buildings: [turret, { ...turret, team: Team.Player3 }, { ...turret, team: Team.Neutral }, { ...turret, team: Team.Player2 }, { ...turret, alive: false }, { ...turret, buildProgress: 0.99 }, { ...turret, type: EntityType.CommandPost, team: Team.Player2, health: 75 }], fighters: [fighter, { ...fighter, team: Team.Player2 }, { ...fighter, alive: false }, { ...fighter, type: EntityType.Bomber }, { ...fighter, team: Team.Neutral }] }, Team.Player2);
    expect(metrics).toEqual({ enemyTurrets: 2, enemyFighters: 1, playerFighters: 1, commandPostHealthRatio: 0.75 });
    expect(readThreatMetrics({ buildings: [], fighters: [] }, Team.Player2).commandPostHealthRatio).toBe(0);
  });
});
