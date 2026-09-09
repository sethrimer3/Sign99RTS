import { describe, expect, it } from 'vitest';
import { BUILD_DEFS, createBuildingFromDef } from './builddefs.js';
import { EntityType, Team } from './entities.js';
import { Vec2 } from './math.js';
import { CommandPost } from './building.js';
import { ExciterTurret, RegenTurret, TurretBase } from './turret.js';

describe('Terran construction power requirements', () => {
  for (const def of Object.values(BUILD_DEFS)) {
    it(`pauses and resumes ${def.label} construction with power`, () => {
      const building = createBuildingFromDef(def, new Vec2(0, 0), Team.Player);
      if (building.buildDurationSeconds <= 0) return;
      building.buildProgress = 0.25;
      building.powered = false;

      building.update(1);
      expect(building.buildProgress).toBe(0.25);

      building.powered = true;
      building.update(1);
      expect(building.buildProgress).toBeGreaterThan(0.25);
    });
  }
});

describe('Terran turret power requirements', () => {
  const turretDefs = Object.values(BUILD_DEFS).filter((def) => {
    const building = def.factory(new Vec2(0, 0), Team.Player);
    return building instanceof TurretBase && building.type !== EntityType.TimeBomb;
  });

  for (const def of turretDefs) {
    it(`prevents ${def.label} from firing while unpowered`, () => {
      const turret = def.factory(new Vec2(0, 0), Team.Player) as TurretBase;
      const target = new CommandPost(new Vec2(20, 0), Team.Enemy);
      turret.buildProgress = 1;
      turret.powered = false;
      turret.targetEntity = target;

      if (turret instanceof ExciterTurret) {
        turret.lockTarget = target;
        turret.exciterState = 'ready';
      } else if (turret instanceof RegenTurret) {
        const friendly = new CommandPost(new Vec2(20, 0), Team.Player);
        friendly.health -= 1;
        turret.targetEntity = friendly;
      }

      expect(turret.canFire()).toBe(false);

      turret.powered = true;
      expect(turret.canFire()).toBe(true);
    });
  }
});
