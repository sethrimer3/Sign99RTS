import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHIP_PRESETS } from './proceduralShipPresets.js';
import { componentsShedBetween, DAMAGE_STAGES, drawProceduralShip, getComponentPath,
  getShipGeometry, getStageBuckets, invalidateShipGeometryCache, seededRandom } from './proceduralShips.js';
import { ShipDebrisSystem } from './shipDebris.js';
import { Camera } from './camera.js';
import { Vec2 } from './math.js';
import { Colors } from './colors.js';

class TestPath {
  moveTo() {} lineTo() {} closePath() {} addPath() {}
}

beforeEach(() => {
  vi.stubGlobal('Path2D', TestPath);
  invalidateShipGeometryCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('procedural component damage', () => {
  it.each(SHIP_PRESETS)('$name sheds whole groups with monotonic, shared stages', ({ def }) => {
    const geo = getShipGeometry(def);
    expect(getShipGeometry({ seed: def.seed, params: { ...def.params } })).toBe(geo);
    const gone = new Set<number>();
    for (let stage = 1; stage < DAMAGE_STAGES; stage++) {
      for (const index of componentsShedBetween(geo, stage - 1, stage)) {
        expect(gone.has(index)).toBe(false);
        gone.add(index);
      }
      for (const poly of geo.polygons) {
        if (poly.group > 0) {
          const group = geo.polygons.filter(p => p.group === poly.group);
          expect(group.every(p => gone.has(p.index))).toBe(group.some(p => gone.has(p.index)));
        }
      }
      const buckets = getStageBuckets(geo, stage);
      expect(getStageBuckets(geo, stage)).toBe(buckets);
      expect(buckets.reduce((n, b) => n + b.polyCount, 0)).toBe(geo.polyCount - gone.size);
      expect(componentsShedBetween(geo, stage, 0)).toEqual([]);
    }
    expect([...gone]).toEqual(componentsShedBetween(geo, 0, 7));
    expect(gone.size).toBeGreaterThan(0);
    expect(gone.size).toBeLessThanOrEqual(Math.floor(geo.polyCount * 0.62));
  });

  it('uses the damaged shape for distant LOD, rims and glow', () => {
    const def = { ...SHIP_PRESETS[0].def, params: { ...SHIP_PRESETS[0].def.params, lineThickness: 1, glowAmount: 1 } };
    const geo = getShipGeometry(def);
    const camera = new Camera();
    camera.zoom = 0.0001;
    const ctx = { save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, fill: vi.fn(), stroke: vi.fn() };
    drawProceduralShip(ctx as unknown as CanvasRenderingContext2D, camera, def,
      { position: new Vec2(0, 0), rotation: 0, damageStage: 7 });
    expect(ctx.fill).toHaveBeenCalledWith(geo.stageSilhouettes[7]);
    expect(ctx.stroke).toHaveBeenCalledWith(geo.stageSilhouettes[7]);
    expect(ctx.stroke).not.toHaveBeenCalledWith(geo.silhouette);
  });

  it('keeps flying fragments stable through lab edits, caps the pool and releases it', () => {
    const def = { ...SHIP_PRESETS[0].def, params: { ...SHIP_PRESETS[0].def.params } };
    const geo = getShipGeometry(def);
    const system = new ShipDebrisSystem();
    const emit = (indices: number[]) => system.emitShedComponents(def, indices, new Vec2(0, 0), 0, 1, Colors.mainguy, null, seededRandom(42));
    emit([0]);
    expect(system.activeCount).toBe(1);
    const path = getComponentPath(geo, 0);
    def.params = { ...def.params, length: 240 };
    invalidateShipGeometryCache();
    const camera = new Camera();
    camera.setScreenSize(1280, 720);
    const ctx = { save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, fill: vi.fn() };
    system.draw(ctx as unknown as CanvasRenderingContext2D, camera);
    expect(ctx.fill).toHaveBeenCalledWith(path);
    for (let i = 0; i < 4; i++) emit(geo.shedOrder);
    expect(system.activeCount).toBe(system.poolCapacity);
    system.update(31);
    expect(system.activeCount).toBe(0);
    emit([0]);
    system.clear();
    expect(system.activeCount).toBe(0);
    expect(system.drawnCount).toBe(0);
    emit([0]);
    expect(system.activeCount).toBe(1);
  });
});
