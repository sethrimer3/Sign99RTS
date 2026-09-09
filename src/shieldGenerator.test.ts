import { describe, expect, it } from 'vitest';
import { ShieldGenerator, Wall } from './building.js';
import { Team } from './entities.js';
import { GRID_CELL_SIZE } from './grid.js';
import { Vec2 } from './math.js';

function finishedGenerator(): ShieldGenerator {
  const generator = new ShieldGenerator(new Vec2(100, 100), Team.Player);
  generator.powered = true;
  generator.buildProgress = 1;
  return generator;
}

describe('ShieldGenerator', () => {
  it('covers a centered 9x9 square area', () => {
    const generator = finishedGenerator();
    const half = 4.5 * GRID_CELL_SIZE;
    expect(generator.contains(new Vec2(100 + half, 100 - half))).toBe(true);
    expect(generator.contains(new Vec2(100 + half + 0.01, 100))).toBe(false);
  });

  it('spends its shared shield before protected hull health', () => {
    const generator = finishedGenerator();
    const wall = new Wall(new Vec2(100, 100), Team.Player);
    wall.areaShield = generator;

    wall.takeDamage(35);

    expect(generator.shield).toBe(55);
    expect(wall.health).toBe(wall.maxHealth);
  });

  it('waits five seconds after depletion, then regenerates five HP per second', () => {
    const generator = finishedGenerator();
    expect(generator.absorbDamage(100)).toBe(10);
    expect(generator.shield).toBe(0);

    generator.update(4.9);
    expect(generator.shield).toBe(0);
    generator.update(0.1);
    expect(generator.shield).toBeCloseTo(0.5);
    generator.update(1);
    expect(generator.shield).toBeCloseTo(5.5);
  });
});
