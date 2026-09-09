import { describe, expect, it } from 'vitest';
import { Vec2 } from './math.js';
import { PlayerShip } from './ship.js';
import { Team, EntityType } from './entities.js';
import { footprintForBuildingType } from './buildingfootprint.js';
import { researchCategory, researchIcon } from './research.js';

describe('physical upgrade labs', () => {
  it('uses the requested 3x3 footprint', () => {
    expect(footprintForBuildingType(EntityType.ResearchLab)).toBe(3);
  });

  it('exposes only the three public categories and keeps exact owner icons distinct', () => {
    expect(researchCategory('shipDash')).toBe('S');
    expect(researchCategory('advancedFighters')).toBe('F');
    expect(researchCategory('massdriverturret')).toBe('D');
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
