import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fleetDesign } from './shipFamilies.js';
import { ShipHullDamage, type HullBody, type HullImpact } from './shipHullDamage.js';
import { getShipGeometry, invalidateShipGeometryCache, shipDesignRadius } from './proceduralShips.js';
import { PlayerShip } from './ship.js';
import { FighterShip } from './fighter.js';
import { Vec2 } from './math.js';
import { Team, ShipGroup } from './entities.js';
import { ShipDebrisSystem } from './shipDebris.js';
import { SHIP_ENGINE_LOSS_FLOOR } from './constants.js';
import { Colors } from './colors.js';
import { GameState } from './gamestate.js';
import { damageLaserLine } from './combatUtils.js';

class TestPath { moveTo() {} lineTo() {} closePath() {} addPath() {} }
beforeEach(() => { vi.stubGlobal('Path2D', TestPath); invalidateShipGeometryCache(); });
afterEach(() => vi.unstubAllGlobals());
function fixture(team = 1) {
  const def = fleetDesign(team, 'hero');
  const body: HullBody = { position: new Vec2(0, 0), angle: 0, radius: shipDesignRadius(def), health: 100, maxHealth: 100, alive: true };
  const hull = new ShipHullDamage(() => def, 1);
  const geo = getShipGeometry(def);
  const hit = (kind: HullImpact['kind'], damage = 8, side = -1) => {
    body.health -= damage;
    hull.hit(body, damage, { kind, x: 0, y: side * 200, dx: 0, dy: -side });
    return hull.removedIndices.map(i => geo.polygons[i]);
  };
  return { def, body, hull, geo, hit };
}

describe('fixed player fleets', () => {
  it('has eight repeatable silhouettes with related, simpler escorts', () => {
    const seeds = new Set<number>();
    const shapes = new Set<string>();
    for (let team = 1; team <= 8; team++) {
      const hero = fleetDesign(team, 'hero'), fighter = fleetDesign(team, 'fighter');
      seeds.add(hero.seed);
      shapes.add(JSON.stringify(getShipGeometry(hero).outline));
      expect(fleetDesign(team, 'hero')).toBe(hero);
      expect(fighter.seed).toBe(hero.seed);
      expect(fighter.params.wingPairs).toBe(hero.params.wingPairs);
      expect(fighter.params.spanToLength).toBe(hero.params.spanToLength);
      expect(getShipGeometry(fighter).polyCount).toBeLessThan(getShipGeometry(hero).polyCount);
      const a = new PlayerShip(new Vec2(0, 0), team as Team);
      const b = new FighterShip(new Vec2(0, 0), team as Team, ShipGroup.Red);
      expect(a.design).toBe(hero);
      expect(b.design).toBe(fighter);
      expect(new FighterShip(new Vec2(20, 0), team as Team, ShipGroup.Blue).design).toBe(b.design);
    }
    expect(seeds.size).toBe(8); expect(shapes.size).toBe(8);
  });
});

describe('impact-directed structural damage', () => {
  it('bullets remove the facing surface and opposite shots choose opposite sides', () => {
    const left = fixture().hit('bullet'), right = fixture().hit('bullet', 8, 1);
    expect(left[0].cy).toBeLessThan(0);
    expect(right[0].cy).toBeGreaterThan(0);
    expect(left.filter(p => p.cy < 0).length).toBeGreaterThan(left.length * 0.8);
    expect(right.filter(p => p.cy > 0).length).toBeGreaterThan(right.length * 0.8);
  });
  it('piercing beams remove both entry and exit material', () => {
    const pieces = fixture().hit('laser');
    expect(pieces[0].cy).toBeLessThan(0);
    expect(pieces[1].cy).toBeGreaterThan(0);
    expect(pieces.filter(p => p.cy < 0).length).toBeGreaterThan(1);
    expect(pieces.filter(p => p.cy > 0).length).toBeGreaterThan(1);
  });
  it('explosions spread over a facing region and larger hits remove more', () => {
    const small = fixture().hit('explosion', 5), big = fixture().hit('explosion', 20);
    expect(big.length).toBeGreaterThan(small.length);
    expect(small.filter(p => p.cy < 0).length).toBeGreaterThan(small.length * 0.8);
    const bullet = fixture().hit('bullet', 5);
    const spread = (p: typeof small) => Math.max(...p.map(v => v.cx)) - Math.min(...p.map(v => v.cx));
    expect(spread(small)).toBeGreaterThan(spread(bullet));
  });
  it('rotates the impact into local hull coordinates deterministically', () => {
    const a = fixture(), b = fixture(); a.hit('laser');
    b.body.angle = Math.PI / 2; b.body.health = 92;
    b.hull.hit(b.body, 8, { kind: 'laser', x: 200, y: 0, dx: -1, dy: 0 });
    expect(b.hull.removedIndices).toEqual(a.hull.removedIndices);
  });
  it('successive hits dig deeper without emitting the same piece twice', () => {
    const f = fixture(); f.hit('bullet'); const first = [...f.hull.removedIndices];
    f.hit('bullet');
    expect(f.hull.removedIndices.length).toBeGreaterThan(first.length);
    expect(new Set(f.hull.removedIndices).size).toBe(f.hull.removedIndices.length);
    expect(f.hull.removedIndices.slice(0, first.length)).toEqual(first);
  });
  it('repairs progressively, shares intact geometry and only rebakes changed damage', () => {
    const f = fixture(); expect(f.hull.renderMesh()).toBeNull(); f.hit('bullet', 30);
    const mesh = f.hull.renderMesh(); expect(f.hull.renderMesh()).toBe(mesh);
    const count = f.hull.removedIndices.length;
    f.hull.repair(f.body, 10);
    expect(f.hull.removedIndices.length).toBeLessThan(count);
    expect(f.hull.renderMesh()).not.toBe(mesh);
    f.hull.repair(f.body, 100);
    expect(f.hull.removedIndices).toEqual([]); expect(f.hull.renderMesh()).toBeNull();
  });
  it('copies exact removal state through JSON snapshots without repeat debris', () => {
    const host = fixture(), client = fixture(); host.hit('laser', 23);
    client.body.health = host.body.health;
    const snapshot = JSON.parse(JSON.stringify(host.hull.snapshot()));
    client.hull.applySnapshot(snapshot, client.body);
    expect(client.hull.removedIndices).toEqual(host.hull.removedIndices);
    const debris = new ShipDebrisSystem();
    client.hull.flush(client.body, debris, Colors.mainguy); const count = debris.activeCount;
    client.hull.applySnapshot(snapshot, client.body);
    client.hull.flush(client.body, debris, Colors.mainguy);
    expect(debris.activeCount).toBe(count);
    client.body.health = 100; client.hull.applySnapshot(undefined, client.body);
    expect(client.hull.removedIndices).toEqual([]);
  });
  it('works in headless simulations without Canvas or Path2D', () => {
    vi.stubGlobal('Path2D', undefined); invalidateShipGeometryCache();
    expect(fixture().hit('bullet').length).toBeGreaterThan(0);
  });
  it('absorbed damage and healing shed nothing; only actual hull damage counts', () => {
    const ship = new PlayerShip(new Vec2(0, 0));
    ship.takeDamage(10); expect(ship.hullDamage?.removedIndices).toEqual([]);
    ship.spawnInvincibilityTimer = 0;
    ship.areaShield = { absorbDamage: () => 0 };
    ship.takeDamage(10); expect(ship.hullDamage?.removedIndices).toEqual([]);
    ship.areaShield = null; ship.shieldUnlocked = true; ship.shield = 10;
    ship.takeDamage(10); expect(ship.hullDamage?.removedIndices).toEqual([]);
    ship.takeDamage(ship.maxHealth * 0.1);
    const count = ship.hullDamage!.removedIndices.length; expect(count).toBeGreaterThan(0);
    ship.takeDamage(-10); expect(ship.hullDamage!.removedIndices.length).toBe(count);
  });
  it('pooled bullets and beam combat helpers supply the actual trajectory to fighters', () => {
    const state = new GameState();
    const fighter = new FighterShip(new Vec2(0, 0), Team.Enemy, ShipGroup.Red);
    fighter.docked = false; state.addEntity(fighter);
    const hit = vi.spyOn(fighter.hullDamage!, 'hit');
    state.applyDirectBulletHit(fighter, 1, 0, -20, 0, 100, null);
    expect(hit.mock.calls[0][2]).toMatchObject({ kind: 'bullet', dx: 0, dy: 100 });
    damageLaserLine(state, null, state.player, new Vec2(0, -200), new Vec2(0, 200), 1);
    expect(hit.mock.calls.at(-1)?.[2]).toMatchObject({ kind: 'laser', dx: 0, dy: 400 });
  });
});

describe('core-outward structural repair', () => {
  it('regrows only polygons touching attached geometry, nearest the core first', () => {
    const { body, hull, geo, hit } = fixture();
    hit('explosion', 34);
    const shed = new Set(hull.removedIndices);
    expect(shed.size).toBeGreaterThan(8);

    const restoreOrder: number[] = [];
    for (let step = 0; step < 600 && hull.removedIndices.length > 0; step++) {
      const before = new Set(hull.removedIndices);
      // Candidates are exactly the gone polygons touching still-attached geometry.
      const candidates = [...before].filter((i) => geo.polygons[i].neighbors.some((n) => !before.has(n)));
      expect(candidates.length).toBeGreaterThan(0);
      const nearestCandidate = Math.min(...candidates.map((i) => geo.polygons[i].coreDistance));

      hull.repair(body, body.maxHealth * 1e-6);
      const after = new Set(hull.removedIndices);
      const restored = [...before].filter((i) => !after.has(i));
      expect(restored.length).toBe(1);
      // Core-outward: the regrowth front always advances at its point closest to the core.
      expect(geo.polygons[restored[0]].coreDistance).toBe(nearestCandidate);
      expect(candidates).toContain(restored[0]);
      restoreOrder.push(restored[0]);
    }

    expect(restoreOrder.length).toBeGreaterThan(8);
    expect(new Set(restoreOrder).size).toBe(restoreOrder.length);
    // The very first thing to come back is the innermost survivor of the blast.
    const shedDistances = [...shed].map((i) => geo.polygons[i].coreDistance);
    expect(geo.polygons[restoreOrder[0]].coreDistance).toBe(Math.min(...shedDistances.filter(
      (_, k) => geo.polygons[[...shed][k]].neighbors.some((n) => !shed.has(n)))));
    expect(hull.removedIndices.length).toBe(0);
    expect(body.health).toBeCloseTo(body.maxHealth, 5);
  });

  it('leaves the hull alone when component restoration is switched off', () => {
    const { body, hull, hit } = fixture();
    hit('bullet', 20);
    const shed = [...hull.removedIndices];
    expect(shed.length).toBeGreaterThan(0);
    const hurt = body.health;
    hull.repair(body, 5, false);
    expect([...hull.removedIndices]).toEqual(shed);
    // HP may not climb past the ceiling the surviving connected mass supports.
    expect(body.health).toBeLessThanOrEqual(hurt + 1e-6);
  });

  it('gated repair is unlocked by shipRepair research', () => {
    const ship = new PlayerShip(new Vec2(0, 0));
    expect(ship.repairLevel).toBe(0);
    ship.syncResearchUpgrades(new Set(['shipRepair1', 'shipRepair2']));
    expect(ship.repairLevel).toBe(2);
    ship.syncResearchUpgrades(new Set());
    expect(ship.repairLevel).toBe(0);
  });
});

describe('wing-mounted engine modules and speed', () => {
  it('gives wing designs one engine module per wing pair, at most two', () => {
    for (let team = 1; team <= 8; team++) {
      const geo = getShipGeometry(fleetDesign(team, 'hero'));
      expect(geo.engineModules.length).toBeLessThanOrEqual(2);
      for (const members of geo.engineModules) expect(members.length).toBeGreaterThan(0);
    }
    // Lance carries two wing surfaces (four wings) = two modules; Manta one surface
    // (two wings) = one; wingless Arrow carries one aft-mounted module.
    expect(getShipGeometry(fleetDesign(1, 'hero')).engineModules.length).toBe(2);
    expect(getShipGeometry(fleetDesign(2, 'hero')).engineModules.length).toBe(1);
    expect(getShipGeometry(fleetDesign(4, 'hero')).engineModules.length).toBe(1);
  });

  it('sheds thrust as wings are lost and bottoms out at the floor', () => {
    const ship = new PlayerShip(new Vec2(0, 0), 1 as Team);
    const geo = getShipGeometry(ship.design!);
    expect(geo.engineModules.length).toBe(2);
    const full = ship.maxSpeed;
    expect(ship.engineThrustFraction).toBe(1);
    expect(ship.effectiveMaxSpeed).toBeCloseTo(full, 6);

    // Shoot away every polygon of the first wing group: one module gone.
    const hull = ship.hullDamage!;
    hull.applySnapshot({ removed: [...geo.engineModules[0]] }, ship);
    expect(hull.engineModules).toEqual({ intact: 1, total: 2 });
    const oneWing = SHIP_ENGINE_LOSS_FLOOR + (1 - SHIP_ENGINE_LOSS_FLOOR) * 0.5;
    expect(ship.engineThrustFraction).toBeCloseTo(oneWing, 6);
    expect(ship.effectiveMaxSpeed).toBeCloseTo(full * oneWing, 6);
    expect(ship.effectiveMaxSpeed).toBeLessThan(full);

    hull.applySnapshot({ removed: [...geo.engineModules[0], ...geo.engineModules[1]] }, ship);
    expect(hull.engineModules).toEqual({ intact: 0, total: 2 });
    expect(ship.engineThrustFraction).toBeCloseTo(SHIP_ENGINE_LOSS_FLOOR, 6);
    expect(ship.effectiveMaxSpeed).toBeCloseTo(full * SHIP_ENGINE_LOSS_FLOOR, 6);
  });

  it('restores thrust when the wing is repaired back on', () => {
    const ship = new PlayerShip(new Vec2(0, 0), 1 as Team);
    const geo = getShipGeometry(ship.design!);
    const hull = ship.hullDamage!;
    hull.applySnapshot({ removed: [...geo.engineModules[0]] }, ship);
    expect(ship.engineThrustFraction).toBeLessThan(1);
    hull.applySnapshot({ removed: [] }, ship);
    expect(ship.engineThrustFraction).toBe(1);
  });

  it('gives wingless ships an aft engine while leaving design-less ships unchanged', () => {
    const wingless = new PlayerShip(new Vec2(0, 0), 4 as Team); // Arrow: wingPairs 0
    const winglessGeometry = getShipGeometry(wingless.design!);
    expect(winglessGeometry.engineModules.length).toBe(1);
    wingless.hullDamage!.applySnapshot({ removed: [...winglessGeometry.engineModules[0]] }, wingless);
    expect(wingless.engineThrustFraction).toBeCloseTo(SHIP_ENGINE_LOSS_FLOOR, 6);
    expect(wingless.effectiveMaxSpeed).toBeCloseTo(wingless.maxSpeed * SHIP_ENGINE_LOSS_FLOOR, 6);

    const plain = new PlayerShip(new Vec2(0, 0));
    plain.setDesign(null);
    expect(plain.design).toBe(null);
    expect(plain.engineThrustFraction).toBe(1);
    expect(plain.effectiveMaxSpeed).toBeCloseTo(plain.maxSpeed, 6);
  });

  it('composes with speed research instead of fighting it', () => {
    const ship = new PlayerShip(new Vec2(0, 0), 1 as Team);
    const base = ship.maxSpeed;
    ship.syncResearchUpgrades(new Set(['shipSpeedEnergy1', 'shipSpeedEnergy2']));
    expect(ship.maxSpeed).toBeCloseTo(base * 1.5, 6);
    const geo = getShipGeometry(ship.design!);
    ship.hullDamage!.applySnapshot({ removed: [...geo.engineModules[0], ...geo.engineModules[1]] }, ship);
    // Research multiplier is untouched; wing loss scales the result.
    expect(ship.maxSpeed).toBeCloseTo(base * 1.5, 6);
    expect(ship.effectiveMaxSpeed).toBeCloseTo(base * 1.5 * SHIP_ENGINE_LOSS_FLOOR, 6);
  });

  it('fighters lose thrust the same way', () => {
    const f = new FighterShip(new Vec2(0, 0), 1 as Team, ShipGroup.Red);
    const geo = getShipGeometry(f.design!);
    if (geo.engineModules.length === 0) return;
    expect(f.engineThrustFraction).toBe(1);
    f.hullDamage!.applySnapshot({ removed: geo.engineModules.flat() }, f);
    expect(f.engineThrustFraction).toBeCloseTo(SHIP_ENGINE_LOSS_FLOOR, 6);
  });
});
