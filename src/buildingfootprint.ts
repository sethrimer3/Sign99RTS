import { EntityType } from './entities.js';

export function footprintForBuildingType(type: EntityType): number {
  switch (type) {
    case EntityType.CommandPost:
      return 6;
    case EntityType.Wall:
      return 2;
    case EntityType.FighterYard:
      return 5;
    case EntityType.BomberYard:
      return 6;
    case EntityType.SwarmYard:
      return 7;
    case EntityType.Factory:
      return 4;
    case EntityType.ExciterTurret:
      return 4;
    case EntityType.TetherTurret:
      return 4;
    case EntityType.MassDriverTurret:
      return 6;
    case EntityType.ResearchLab:
      return 9;
    default:
      return 3;
  }
}
