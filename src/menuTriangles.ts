type Point = { x: number; y: number };
export interface MenuTriangle {
  col: number;
  row: number;
  points: Point[];
  area: number;
  parent: number;
  phase: number;
  subdivided?: boolean;
  edgeTriangles?: Point[][];
}

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const samePoint = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001;

/** Three corner triangles and one inverted center tile exactly fill the parent. */
export function subdivideTriangle([a, b, c]: Point[]): Point[][] {
  const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
  return [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]];
}

function triangleCenter(points: Point[]): Point {
  return { x: points.reduce((sum, p) => sum + p.x, 0) / 3, y: points.reduce((sum, p) => sum + p.y, 0) / 3 };
}

/** Fixed spatial fade, independent of growth order and animation progress. */
export function createTriangleOpacityField(tiles: MenuTriangle[]): (points: Point[]) => number {
  const seed = tiles.find(tile => tile.parent === -1);
  if (!seed) return () => 0.9;
  const origin = triangleCenter(seed.points);
  const distance = (points: Point[]) => {
    const p = triangleCenter(points);
    return Math.hypot(p.x - origin.x, p.y - origin.y);
  };
  const shapes = tiles.flatMap(tile => [
    ...(tile.subdivided ? subdivideTriangle(tile.points) : [tile.points]),
    ...(tile.edgeTriangles ?? []),
  ]);
  const extent = Math.max(1, ...shapes.map(distance));
  return points => 0.9 - 0.85 * Math.min(1, distance(points) / extent);
}

function clippedArea(points: Point[], w: number, h: number): number {
  let polygon = points;
  for (const [axis, bound, sign] of [['x', 0, 1], ['x', w, -1], ['y', 0, 1], ['y', h, -1]] as const) {
    const result: Point[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const insideA = (a[axis] - bound) * sign >= 0;
      const insideB = (b[axis] - bound) * sign >= 0;
      if (insideA) result.push(a);
      if (insideA !== insideB) {
        const t = (bound - a[axis]) / (b[axis] - a[axis]);
        result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    polygon = result;
  }
  return Math.abs(polygon.reduce((sum, a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    return sum + a.x * b.y - b.x * a.y;
  }, 0)) / 2;
}

/** Frontier growth guarantees every tile shares an edge with an earlier tile. */
export function growMenuTriangles(w: number, h: number, random = Math.random): MenuTriangle[] {
  const side = Math.max(44, Math.min(w, h) / 10);
  const height = side * Math.sqrt(3) / 2;
  const tiles = new Map<string, MenuTriangle>();
  for (let row = -1; row <= Math.ceil(h / height); row++) {
    for (let col = -2; col <= Math.ceil(w * 2 / side); col++) {
      const x = col * side / 2, y = row * height;
      const up = (col + row) % 2 === 0;
      const points = up
        ? [{ x, y: y + height }, { x: x + side / 2, y }, { x: x + side, y: y + height }]
        : [{ x, y }, { x: x + side, y }, { x: x + side / 2, y: y + height }];
      const area = clippedArea(points, w, h);
      if (area > 0.01) tiles.set(`${col},${row}`, { col, row, points, area, parent: -1, phase: random() * Math.PI * 2 });
    }
  }
  // Uniform position around the screen perimeter, then choose its nearest tile.
  let edge = random() * 2 * (w + h);
  const origin = edge < w ? { x: edge, y: 0 }
    : (edge -= w) < h ? { x: w, y: edge }
    : (edge -= h) < w ? { x: w - edge, y: h } : { x: 0, y: h - (edge - w) };
  const center = (tile: MenuTriangle) => ({ x: tile.points.reduce((s, p) => s + p.x, 0) / 3, y: tile.points.reduce((s, p) => s + p.y, 0) / 3 });
  const distance = (tile: MenuTriangle) => { const p = center(tile); return Math.hypot(p.x - origin.x, p.y - origin.y); };
  const seed = [...tiles.values()].sort((a, b) => distance(a) - distance(b))[0];
  if (!seed) return [];
  const frontier = new Map<string, MenuTriangle>([[`${seed.col},${seed.row}`, seed]]);
  const result: MenuTriangle[] = [];
  const target = w * h * (0.20 + random() * 0.29);
  let area = 0;
  while (frontier.size && area < target) {
    const options = [...frontier.values()];
    const weights = options.map(tile => 1 / (1 + distance(tile) / Math.max(w, h)));
    let choice = random() * weights.reduce((a, b) => a + b, 0);
    let index = 0;
    while (index < options.length - 1 && (choice -= weights[index]) > 0) index++;
    const tile = options[index], key = `${tile.col},${tile.row}`;
    frontier.delete(key);
    tiles.delete(key);
    result.push(tile);
    area += tile.area;
    const up = (tile.col + tile.row) % 2 === 0;
    for (const [col, row] of [[tile.col - 1, tile.row], [tile.col + 1, tile.row], [tile.col, tile.row + (up ? 1 : -1)]]) {
      const nextKey = `${col},${row}`, next = tiles.get(nextKey);
      if (next && !frontier.has(nextKey)) {
        next.parent = result.length - 1;
        frontier.set(nextKey, next);
      }
    }
  }
  for (const tile of result) tile.subdivided = random() < 0.24;

  // Use corner quarters of unoccupied frontier cells. They attach along half
  // an exposed edge, cannot overlap the mass, and remain tied to their parent.
  const candidates: { parent: MenuTriangle; points: Point[]; area: number }[] = [];
  const used = new Set<string>();
  for (const empty of frontier.values()) {
    for (const parent of result) {
      const shared = empty.points.filter(p => parent.points.some(q => samePoint(p, q)));
      if (shared.length !== 2) continue;
      for (const points of subdivideTriangle(empty.points).slice(0, 3)) {
        if (!points.some(p => shared.some(q => samePoint(p, q)))) continue;
        const key = points.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).sort().join(';');
        const smallArea = clippedArea(points, w, h);
        if (used.has(key) || smallArea < side * height / 8 * 0.95) continue;
        used.add(key);
        candidates.push({ parent, points, area: smallArea });
      }
    }
  }
  const count = Math.floor(random() * 21);
  for (let i = 0; i < count && candidates.length; i++) {
    const index = Math.floor(random() * candidates.length);
    const [candidate] = candidates.splice(index, 1);
    if (area + candidate.area > w * h * 0.5) continue;
    (candidate.parent.edgeTriangles ??= []).push(candidate.points);
    area += candidate.area;
  }
  return result;
}

const DEFAULT_PALETTE: number[][] = [[15, 35, 89], [58, 22, 101], [155, 30, 113], [255, 178, 112]];
let activePalette: number[][] = DEFAULT_PALETTE;

/**
 * Override the triangle palette (4 RGB triplets blended across the heat range),
 * or pass null to restore the default. Driven by the selected space colour.
 */
export function setMenuTrianglePalette(palette: readonly (readonly [number, number, number])[] | null): void {
  activePalette = palette ? palette.map((c) => [c[0], c[1], c[2]]) : DEFAULT_PALETTE;
}

function color(value: number): string {
  const v = Math.max(0, Math.min(0.9999, value)) * 3;
  const i = Math.floor(v), t = v - i;
  return `rgb(${activePalette[i].map((n, c) => Math.round(n + (activePalette[i + 1][c] - n) * t)).join(',')})`;
}

export class MenuTriangleBackground {
  private tiles: MenuTriangle[] = [];
  private opacityAt: (points: Point[]) => number = () => 0.9;
  private width = 0;
  private height = 0;
  private state = '';
  private visible = 0;
  private retracting = false;
  private time = 0;

  update(dt: number, w: number, h: number, state: string): void {
    this.time += dt;
    if (w !== this.width || h !== this.height) {
      this.width = w; this.height = h;
      this.tiles = growMenuTriangles(w, h);
      this.opacityAt = createTriangleOpacityField(this.tiles);
      this.visible = 0; this.retracting = false;
    }
    if (state !== this.state) {
      if (this.state) this.retracting = true;
      this.state = state;
    }
    if (this.retracting) {
      this.visible = Math.max(0, this.visible - dt * Math.max(1, this.tiles.length) / 0.15);
      if (this.visible === 0) {
        this.tiles = growMenuTriangles(w, h);
        this.opacityAt = createTriangleOpacityField(this.tiles);
        this.retracting = false;
      }
    } else this.visible = Math.min(this.tiles.length, this.visible + dt * this.tiles.length / 0.72);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    const radius = Math.max(44, Math.min(this.width, this.height) / 10) * 0.065;
    // Equal pixel radii keep hotspots circular at every screen aspect ratio.
    const hotspotRadius = Math.max(1, Math.min(this.width, this.height) * 0.14);
    for (let i = 0; i < Math.ceil(this.visible); i++) {
      const tile = this.tiles[i];
      const amount = Math.min(1, this.visible - i);
      const cx = tile.points.reduce((s, p) => s + p.x, 0) / 3;
      const cy = tile.points.reduce((s, p) => s + p.y, 0) / 3;
      let heat = 0;
      for (let j = 0; j < 3; j++) {
        const t = this.time * (0.10 + j * 0.025) + j * 2.1;
        const x = this.width * (0.5 + 0.48 * Math.sin(t));
        const y = this.height * (0.5 + 0.48 * Math.cos(t * 0.73 + j));
        const dx = (cx - x) / hotspotRadius, dy = (cy - y) / hotspotRadius;
        heat = Math.max(heat, Math.exp(-(dx * dx + dy * dy) * 1.5));
      }
      const value = 0.12 + 0.19 * (0.5 + 0.5 * Math.sin(this.time * 0.35 + tile.phase)) + heat * 0.78;
      const gradient = ctx.createLinearGradient(cx - 28, cy - 30, cx + 30, cy + 40);
      gradient.addColorStop(0, color(value + 0.07));
      gradient.addColorStop(1, color(value - 0.09));
      ctx.fillStyle = gradient;
      // Collapse the newest tile toward its attachment edge; its parent remains
      // present until this tile is gone, including during interrupted growth.
      const parent = this.tiles[tile.parent];
      const shared = parent ? tile.points.filter(p => parent.points.some(q => Math.abs(p.x - q.x) < 0.001 && Math.abs(p.y - q.y) < 0.001)) : [];
      const anchor = shared.length === 2
        ? { x: (shared[0].x + shared[1].x) / 2, y: (shared[0].y + shared[1].y) / 2 }
        : { x: cx, y: cy };
      const scale = amount * amount * (3 - 2 * amount);
      const shapes = tile.subdivided ? subdivideTriangle(tile.points) : [tile.points];
      shapes.push(...(tile.edgeTriangles ?? []));
      for (const shape of shapes) {
        // Sample final world positions, never placement index or scaled geometry.
        ctx.globalAlpha = this.opacityAt(shape);
        ctx.beginPath();
        const points = shape.map(p => ({ x: anchor.x + (p.x - anchor.x) * scale, y: anchor.y + (p.y - anchor.y) * scale }));
        ctx.moveTo((points[2].x + points[0].x) / 2, (points[2].y + points[0].y) / 2);
        for (let k = 0; k < 3; k++) {
          const p = points[k], next = points[(k + 1) % 3];
          ctx.arcTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2, radius * scale);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(8,8,24,0.42)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
