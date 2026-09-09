import { BuildingBase } from './building.js';
import { GRID_CELL_SIZE, type CellCoord } from './grid.js';
import { footprintForBuilding } from './buildingfootprint.js';

export interface BuildingShipCollisionRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function buildingBlocksShips(building: BuildingBase): boolean {
  // Buildings still have gameplay footprints, but ships currently ignore them
  // so mobile units can move directly without expensive obstacle pathfinding.
  void building;
  return false;
}

export function buildingFootprintOrigin(building: BuildingBase): CellCoord {
  const size = footprintForBuilding(building);
  return {
    cx: Math.round(building.position.x / GRID_CELL_SIZE - size / 2),
    cy: Math.round(building.position.y / GRID_CELL_SIZE - size / 2),
  };
}

export function buildingShipCollisionRect(building: BuildingBase, inflate = 0): BuildingShipCollisionRect {
  const size = footprintForBuilding(building);
  const halfSide = size * GRID_CELL_SIZE * 0.5;
  return {
    left: building.position.x - halfSide - inflate,
    right: building.position.x + halfSide + inflate,
    top: building.position.y - halfSide - inflate,
    bottom: building.position.y + halfSide + inflate,
  };
}
