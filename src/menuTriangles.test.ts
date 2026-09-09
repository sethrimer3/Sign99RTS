import { describe, expect, it } from 'vitest';
import { growMenuTriangles, subdivideTriangle } from './menuTriangles.js';

const area = (p: { x: number; y: number }[]) => Math.abs(
  (p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[2].x - p[0].x) * (p[1].y - p[0].y),
) / 2;

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
        const smallEdges = tiles.flatMap(t => t.edgeTriangles ?? []);
        expect(smallEdges.length).toBeLessThanOrEqual(20);
        expect(coverage + smallEdges.reduce((sum, p) => sum + area(p), 0) / (w * h)).toBeLessThanOrEqual(0.5);
        expect(tiles.some(t => t.subdivided)).toBe(true);
        for (const tile of tiles) {
          const quarters = subdivideTriangle(tile.points);
          expect(quarters).toHaveLength(4);
          for (const quarter of quarters) expect(area(quarter)).toBeCloseTo(area(tile.points) / 4);
          for (const small of tile.edgeTriangles ?? []) {
            expect(area(small)).toBeCloseTo(area(tile.points) / 4);
            // Two vertices lie on the same exposed parent edge.
            expect(tile.points.some((a, index) => {
              const b = tile.points[(index + 1) % 3];
              return small.filter(p => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < 0.001).length === 2;
            })).toBe(true);
          }
        }
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
