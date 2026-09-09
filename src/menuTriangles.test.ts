import { describe, expect, it } from 'vitest';
import { growMenuTriangles } from './menuTriangles.js';

describe('menu triangle formations', () => {
  it('covers 20–50% with a connected, reversible growth order across screen shapes', () => {
    for (const [w, h] of [[1920, 1080], [800, 1200], [640, 360]]) {
      for (let seed = 1; seed <= 20; seed++) {
        let state = seed;
        const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
        const tiles = growMenuTriangles(w, h, random);
        const coverage = tiles.reduce((sum, tile) => sum + tile.area, 0) / (w * h);
        expect(coverage).toBeGreaterThanOrEqual(0.2);
        expect(coverage).toBeLessThanOrEqual(0.5);
        expect(new Set(tiles.map(t => `${t.col},${t.row}`)).size).toBe(tiles.length);
        for (let i = 1; i < tiles.length; i++) {
          const tile = tiles[i];
          expect(tile.parent).toBeLessThan(i);
          expect(tile.parent).toBeGreaterThanOrEqual(0);
          const parent = tiles[tile.parent];
          expect(tile.points.filter(p => parent.points.some(q => Math.abs(p.x - q.x) < 0.001 && Math.abs(p.y - q.y) < 0.001))).toHaveLength(2);
        }
      }
    }
  });
});
