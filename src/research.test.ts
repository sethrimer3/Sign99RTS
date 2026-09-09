import { describe, expect, it } from 'vitest';
import { Vec2 } from './math.js';
import { PlayerShip } from './ship.js';
import { Team, EntityType } from './entities.js';
import { footprintForBuildingType } from './buildingfootprint.js';
import { researchCategory, researchIcon } from './research.js';
import { ResearchLab } from './building.js';
import { footprintForBuilding } from './buildingfootprint.js';
import { GameState } from './gamestate.js';

describe('physical upgrade labs', () => {
  it('keeps the prerequisite lab at 9x9', () => {
    expect(footprintForBuildingType(EntityType.ResearchLab)).toBe(9);
    expect(footprintForBuilding(new ResearchLab(new Vec2(0, 0), Team.Player, 'shipDash'))).toBe(3);
  });

  it('does not let a Research Node satisfy the main Research Lab prerequisite', () => {
    const state = new GameState(new Vec2(0, 0));
    const node = new ResearchLab(new Vec2(100, 100), Team.Player, 'shipDash');
    node.powered = true;
    node.buildProgress = 1;
    state.addEntity(node);
    expect(state.hasResearchLab()).toBe(false);

    const lab = new ResearchLab(new Vec2(400, 400), Team.Player);
    lab.powered = true;
    lab.buildProgress = 1;
    state.addEntity(lab);
    expect(state.hasResearchLab()).toBe(true);
  });

  it('exposes the four public categories and keeps exact owner icons distinct', () => {
    expect(researchCategory('shipDash')).toBe('S');
    expect(researchCategory('fighterHp1')).toBe('F');
    expect(researchCategory('massdriverturret')).toBe('D');
    expect(researchCategory('weaponLaser')).toBe('W');
    expect(researchIcon('shipDash')).not.toBe(researchIcon('weaponLaser'));
  });

  it('can grant and revoke an individual ship upgrade', () => {
    const ship = new PlayerShip(new Vec2(0, 0), Team.Player);
    ship.syncResearchUpgrades(new Set(['shipHp1', 'shipHp2', 'shipDash']));
    expect(ship.hpLevel).toBe(2);
    expect(ship.dashUnlocked).toBe(true);

    ship.syncResearchUpgrades(new Set(['shipHp2']));
    expect(ship.hpLevel).toBe(1);
    expect(ship.dashUnlocked).toBe(false);
  });
});
