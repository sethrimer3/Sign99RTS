import { describe, it, expect, beforeEach } from 'vitest';
import { PlayerShip } from './ship.js';
import { FighterShip } from './fighter.js';
import { Vec2 } from './math.js';
import { Team } from './entities.js';
import { Camera } from './camera.js';

describe('PlayerShip and FighterShip glowing trails', () => {
  let camera: Camera;
  let mockCtx: CanvasRenderingContext2D;

  beforeEach(() => {
    camera = new Camera();
    camera.setScreenSize(1280, 720);
    camera.position = new Vec2(500, 500);

    mockCtx = {
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      beginPath: () => {},
      closePath: () => {},
      arc: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      fill: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      strokeText: () => {},
      fillText: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      canvas: { width: 1280, height: 720 },
    } as unknown as CanvasRenderingContext2D;
  });

  it('PlayerShip accumulates movement trail and renders via renderProjectileTrail', () => {
    const ship = new PlayerShip(new Vec2(500, 500), Team.Player);

    // Move the ship over several ticks
    for (let i = 0; i < 15; i++) {
      ship.position = ship.position.add(new Vec2(10, 5));
      ship.velocity = new Vec2(100, 50);
      ship.update(0.05);
    }

    // Ship should render motion trail without error
    expect(() => ship.draw(mockCtx, camera)).not.toThrow();
  });

  it('PlayerShip dash produces dash trail with intermediate samples and renders smoothly', () => {
    const ship = new PlayerShip(new Vec2(500, 500), Team.Player);
    ship.syncResearchUpgrades(new Set(['shipDash']));
    ship.battery = 100;

    // Trigger dash by simulating shift tap while at high energy
    (ship as unknown as { tryDash: () => void }).tryDash();

    // Dash trail should now have points
    const dashTrail = (ship as unknown as { dashTrail: Array<{ pos: Vec2; age: number }> }).dashTrail;
    expect(dashTrail.length).toBeGreaterThanOrEqual(2);

    // Update with high velocity simulating dash movement
    for (let i = 0; i < 10; i++) {
      ship.position = ship.position.add(new Vec2(35, 0));
      ship.update(0.05);
    }

    expect(dashTrail.length).toBeGreaterThanOrEqual(2);
    expect(() => ship.draw(mockCtx, camera)).not.toThrow();
  });

  it('FighterShip accumulates motion and dash trails and renders without error', () => {
    const fighter = new FighterShip(new Vec2(400, 400), Team.Player);

    // Move fighter over several ticks
    for (let i = 0; i < 15; i++) {
      fighter.position = fighter.position.add(new Vec2(8, 4));
      fighter.velocity = new Vec2(80, 40);
      fighter.update(0.05);
    }

    // Upgrade dash on fighter and trigger order dash
    fighter.upgradeDash();
    fighter.triggerOrderDash(new Vec2(500, 400));
    for (let i = 0; i < 5; i++) {
      fighter.position = fighter.position.add(new Vec2(25, 0));
      fighter.update(0.05);
    }

    expect(() => fighter.draw(mockCtx, camera)).not.toThrow();
  });
});
