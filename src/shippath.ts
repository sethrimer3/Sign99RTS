import { Team, type Entity } from './entities.js';
import type { GameState } from './gamestate.js';
import { GRID_CELL_SIZE, cellKey } from './grid.js';
import { Vec2, pointToSegmentDistance } from './math.js';
import { WORLD_HEIGHT, WORLD_WIDTH } from './constants.js';
import { TurretBase } from './turret.js';
import { FighterShip } from './fighter.js';
import { buildingBlocksShips, buildingShipCollisionRect } from './buildingCollision.js';

export interface ShipPathOptions {
  team: Team;
  intelligence: number;
  radius: number;
  preferBreach?: boolean;
}

interface NavCell {
  cx: number;
  cy: number;
}

interface WallRect {
  id: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  center: Vec2;
  hp: number;
}

export interface ShipPathDebugStats {
  resolvesPerSecond: number;
  resolvesThisFrame: number;
  fullAStarThisFrame: number;
  cachedReusesThisFrame: number;
  skippedThisFrame: number;
  sharedPathUsesThisFrame: number;
  blockerCount: number;
  mobilePathMsThisFrame: number;
  avgMsLast60: number;
  maxMsLast60: number;
  adjustedTargetLastSecond: boolean;
}

const NAV_CELL = GRID_CELL_SIZE * 4;
const MAX_EXPANSIONS = 900;
const WALL_MARGIN = GRID_CELL_SIZE * 1.35;
const pathTimings: number[] = [];
let frameTimings: number[] = [];
let resolveCountThisSecond = 0;
let resolvesPerSecond = 0;
let secondBucket = Math.floor(performance.now() * 0.001);
let adjustedTargetUntil = 0;
let lastFrameToken = -1;
let resolvesThisFrame = 0;
let fullAStarThisFrame = 0;
let cachedReusesThisFrame = 0;
let skippedThisFrame = 0;
let sharedPathUsesThisFrame = 0;
let lastBlockerCount = 0;
let wallCacheVersion = -1;
let wallCacheInflate = -1;
let wallCache: WallRect[] = [];
let wallCacheBuckets = new Map<number, WallRect[]>();
const wallQueryScratch: WallRect[] = [];
const wallQuerySeen = new Set<number>();

export function beginShipPathFrame(frameToken: number): void {
  if (frameToken === lastFrameToken) return;
  lastFrameToken = frameToken;
  resolvesThisFrame = 0;
  fullAStarThisFrame = 0;
  cachedReusesThisFrame = 0;
  skippedThisFrame = 0;
  sharedPathUsesThisFrame = 0;
  frameTimings = [];
}

export function noteShipPathCacheReuse(shared = false): void {
  cachedReusesThisFrame++;
  if (shared) sharedPathUsesThisFrame++;
}

export function noteShipPathSkipped(): void {
  skippedThisFrame++;
}

export function isNavigationTargetBlocked(state: GameState, target: Vec2, radius: number): boolean {
  return collectWalls(state, radius + WALL_MARGIN).some((wall) => pointInRect(target, wall));
}

export function adjustNavigationTargetOutOfBlockers(state: GameState, target: Vec2, radius: number): Vec2 {
  return nudgeOutsideBlockingRect(target, collectWalls(state, radius + WALL_MARGIN), radius + GRID_CELL_SIZE * 0.35).pos;
}

export function resolveShipNavigationTarget(
  state: GameState,
  from: Vec2,
  target: Vec2,
  options: ShipPathOptions,
): Vec2 {
  const startedAt = performance.now();
  const nowSecond = Math.floor(startedAt * 0.001);
  if (nowSecond !== secondBucket) {
    resolvesPerSecond = resolveCountThisSecond;
    resolveCountThisSecond = 0;
    secondBucket = nowSecond;
  }
  resolveCountThisSecond++;
  resolvesThisFrame++;

  const walls = collectWalls(state, options.radius + WALL_MARGIN);
  const adjustedTarget = nudgeOutsideBlockingRect(target, walls, options.radius + GRID_CELL_SIZE * 0.35);
  if (adjustedTarget.adjusted) adjustedTargetUntil = performance.now() + 1000;
  const finalTarget = adjustedTarget.pos;
  try {
    if (walls.length === 0 || hasClearLine(from, finalTarget, walls)) return finalTarget.clone();

    const breach = options.intelligence >= 2
      ? findBestBreachPoint(state, from, finalTarget, walls, options)
      : null;
    const routeTarget = breach?.worthIt ? breach.pos : finalTarget;
    if (hasClearLine(from, routeTarget, walls)) return routeTarget.clone();
    const cheap = findCheapDetour(from, routeTarget, walls, options.radius);
    if (cheap) return cheap;
    const route = findRoute(state, from, routeTarget, walls, options);
    if (route) return route;
    if (breach) return breach.pos;
    return finalTarget.clone();
  } finally {
    recordPathTiming(performance.now() - startedAt);
  }
}

export function scoreShipRoute(
  state: GameState,
  from: Vec2,
  target: Vec2,
  options: ShipPathOptions,
): number {
  const walls = collectWalls(state, options.radius + WALL_MARGIN);
  const adjustedTarget = nudgeOutsideBlockingRect(target, walls, options.radius + GRID_CELL_SIZE * 0.35).pos;
  if (walls.length === 0 || hasClearLine(from, adjustedTarget, walls)) {
    return from.distanceTo(adjustedTarget) + routeThreat(state, options.team, from, adjustedTarget) * threatWeight(options.intelligence);
  }
  const waypoint = resolveShipNavigationTarget(state, from, adjustedTarget, options);
  const direct = from.distanceTo(waypoint) + waypoint.distanceTo(adjustedTarget);
  const blockedPenalty = waypoint.distanceTo(adjustedTarget) < GRID_CELL_SIZE * 8 ? 0 : GRID_CELL_SIZE * 80;
  return direct + blockedPenalty + routeThreat(state, options.team, from, waypoint) * threatWeight(options.intelligence);
}

export function getShipPathDebugStats(): ShipPathDebugStats {
  const count = pathTimings.length;
  const total = pathTimings.reduce((sum, ms) => sum + ms, 0);
  const frameTotal = frameTimings.reduce((sum, ms) => sum + ms, 0);
  return {
    resolvesPerSecond,
    resolvesThisFrame,
    fullAStarThisFrame,
    cachedReusesThisFrame,
    skippedThisFrame,
    sharedPathUsesThisFrame,
    blockerCount: lastBlockerCount,
    mobilePathMsThisFrame: frameTotal,
    avgMsLast60: count > 0 ? total / count : 0,
    maxMsLast60: count > 0 ? Math.max(...pathTimings) : 0,
    adjustedTargetLastSecond: performance.now() < adjustedTargetUntil,
  };
}

function collectWalls(state: GameState, inflate: number): WallRect[] {
  const version = state.buildingCollisionVersion;
  if (wallCacheVersion === version && Math.abs(wallCacheInflate - inflate) < 0.001) {
    lastBlockerCount = wallCache.length;
    return wallCache;
  }
  const walls: WallRect[] = [];
  for (const b of state.buildings) {
    if (!b.alive || b.buildProgress < 1 || !buildingBlocksShips(b)) continue;
    const rect = buildingShipCollisionRect(b, inflate);
    walls.push({
      id: b.id,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      center: b.position.clone(),
      hp: Math.max(1, b.health + ('shield' in b ? Number(b.shield) || 0 : 0)),
    });
  }
  wallCacheVersion = version;
  wallCacheInflate = inflate;
  wallCache = walls;
  wallCacheBuckets = buildWallBuckets(walls);
  lastBlockerCount = walls.length;
  return walls;
}

function hasClearLine(from: Vec2, to: Vec2, walls: WallRect[]): boolean {
  const minX = Math.min(from.x, to.x);
  const maxX = Math.max(from.x, to.x);
  const minY = Math.min(from.y, to.y);
  const maxY = Math.max(from.y, to.y);
  for (const wall of queryWalls(walls, minX, maxX, minY, maxY)) {
    if (segmentIntersectsRect(from, to, wall)) return false;
  }
  return true;
}

function segmentIntersectsRect(a: Vec2, b: Vec2, r: WallRect): boolean {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const corners = [
    new Vec2(r.left, r.top),
    new Vec2(r.right, r.top),
    new Vec2(r.right, r.bottom),
    new Vec2(r.left, r.bottom),
  ];
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

function pointInRect(p: Vec2, r: WallRect): boolean {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

function nudgeOutsideBlockingRect(target: Vec2, walls: WallRect[], margin: number): { pos: Vec2; adjusted: boolean } {
  let pos = target.clone();
  let adjusted = false;
  for (let i = 0; i < 4; i++) {
    const wall = queryWalls(walls, pos.x, pos.x, pos.y, pos.y).find((w) => pointInRect(pos, w));
    if (!wall) break;
    const candidates = [
      new Vec2(wall.left - margin, pos.y),
      new Vec2(wall.right + margin, pos.y),
      new Vec2(pos.x, wall.top - margin),
      new Vec2(pos.x, wall.bottom + margin),
    ];
    let best = candidates[0];
    let bestDist = best.distanceTo(target);
    for (const candidate of candidates) {
      const d = candidate.distanceTo(target);
      if (d < bestDist) {
        best = candidate;
        bestDist = d;
      }
    }
    pos = new Vec2(
      Math.max(0, Math.min(WORLD_WIDTH, best.x)),
      Math.max(0, Math.min(WORLD_HEIGHT, best.y)),
    );
    adjusted = true;
  }
  return { pos, adjusted };
}

function recordPathTiming(ms: number): void {
  pathTimings.push(ms);
  frameTimings.push(ms);
  if (pathTimings.length > 60) pathTimings.splice(0, pathTimings.length - 60);
}

function findCheapDetour(from: Vec2, target: Vec2, walls: WallRect[], radius: number): Vec2 | null {
  let nearest: WallRect | null = null;
  let nearestDist = Infinity;
  const minX = Math.min(from.x, target.x);
  const maxX = Math.max(from.x, target.x);
  const minY = Math.min(from.y, target.y);
  const maxY = Math.max(from.y, target.y);
  for (const wall of queryWalls(walls, minX, maxX, minY, maxY)) {
    if (!segmentIntersectsRect(from, target, wall)) continue;
    const d = pointToSegmentDistance(wall.center, from, target);
    if (d < nearestDist) {
      nearest = wall;
      nearestDist = d;
    }
  }
  if (!nearest) return null;
  const margin = radius + GRID_CELL_SIZE * 1.4;
  const candidates = [
    new Vec2(nearest.left - margin, nearest.top - margin),
    new Vec2(nearest.right + margin, nearest.top - margin),
    new Vec2(nearest.right + margin, nearest.bottom + margin),
    new Vec2(nearest.left - margin, nearest.bottom + margin),
    new Vec2(nearest.left - margin, nearest.center.y),
    new Vec2(nearest.right + margin, nearest.center.y),
    new Vec2(nearest.center.x, nearest.top - margin),
    new Vec2(nearest.center.x, nearest.bottom + margin),
  ];
  let best: Vec2 | null = null;
  let bestScore = Infinity;
  for (const raw of candidates) {
    const candidate = new Vec2(
      Math.max(0, Math.min(WORLD_WIDTH, raw.x)),
      Math.max(0, Math.min(WORLD_HEIGHT, raw.y)),
    );
    if (isBlocked(candidate, walls)) continue;
    if (!hasClearLine(from, candidate, walls)) continue;
    const score = from.distanceTo(candidate) + candidate.distanceTo(target);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const ccw = (p1: Vec2, p2: Vec2, p3: Vec2) => (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

function findRoute(
  state: GameState,
  from: Vec2,
  target: Vec2,
  walls: WallRect[],
  options: ShipPathOptions,
): Vec2 | null {
  const start = nearestOpenCell(toNavCell(from), walls, 5);
  const goal = nearestOpenCell(toNavCell(target), walls, 10);
  if (!start || !goal) return null;
  const minCx = Math.max(0, Math.min(start.cx, goal.cx) - 28);
  const maxCx = Math.min(Math.floor(WORLD_WIDTH / NAV_CELL), Math.max(start.cx, goal.cx) + 28);
  const minCy = Math.max(0, Math.min(start.cy, goal.cy) - 28);
  const maxCy = Math.min(Math.floor(WORLD_HEIGHT / NAV_CELL), Math.max(start.cy, goal.cy) + 28);
  fullAStarThisFrame++;
  const open = new MinHeap<NavCell & { g: number; f: number }>((a, b) => a.f - b.f);
  open.push({ ...start, g: 0, f: heuristic(start, goal) });
  const cameFrom = new Map<string, string>();
  const costSoFar = new Map<string, number>([[cellKey(start.cx, start.cy), 0]]);
  let expansions = 0;

  while (open.size > 0 && expansions++ < MAX_EXPANSIONS) {
    const cur = open.pop()!;
    if (cur.cx === goal.cx && cur.cy === goal.cy) {
      return firstUsefulWaypoint(reconstruct(start, goal, cameFrom), from, target, walls);
    }
    for (const n of neighbors(cur)) {
      if (n.cx < minCx || n.cx > maxCx || n.cy < minCy || n.cy > maxCy) continue;
      if (isBlockedCell(n, walls)) continue;
      if (cur.cx !== n.cx && cur.cy !== n.cy) {
        if (isBlockedCell({ cx: n.cx, cy: cur.cy }, walls) || isBlockedCell({ cx: cur.cx, cy: n.cy }, walls)) {
          continue;
        }
      }
      const pos = navCenter(n);
      const step = cur.cx !== n.cx && cur.cy !== n.cy ? 1.414 : 1;
      const threat = options.intelligence >= 3
        ? routeThreat(state, options.team, navCenter(cur), pos) * threatWeight(options.intelligence)
        : 0;
      const newCost = cur.g + step * NAV_CELL + threat;
      const nk = cellKey(n.cx, n.cy);
      if (newCost >= (costSoFar.get(nk) ?? Infinity)) continue;
      costSoFar.set(nk, newCost);
      cameFrom.set(nk, cellKey(cur.cx, cur.cy));
      open.push({ ...n, g: newCost, f: newCost + heuristic(n, goal) * NAV_CELL });
    }
  }
  return null;
}

class MinHeap<T> {
  private items: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.items[index], this.items[parent]) >= 0) break;
      [this.items[index], this.items[parent]] = [this.items[parent], this.items[index]];
      index = parent;
    }
  }

  private sinkDown(index: number): void {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.items.length && this.compare(this.items[left], this.items[smallest]) < 0) smallest = left;
      if (right < this.items.length && this.compare(this.items[right], this.items[smallest]) < 0) smallest = right;
      if (smallest === index) break;
      [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
      index = smallest;
    }
  }
}

function firstUsefulWaypoint(path: NavCell[], from: Vec2, target: Vec2, walls: WallRect[]): Vec2 | null {
  if (path.length < 2) return target.clone();
  for (let i = path.length - 1; i >= 1; i--) {
    const p = i === path.length - 1 ? target : navCenter(path[i]);
    if (hasClearLine(from, p, walls)) return p;
  }
  return navCenter(path[1]);
}

function reconstruct(start: NavCell, goal: NavCell, cameFrom: Map<string, string>): NavCell[] {
  const result: NavCell[] = [goal];
  let cur = cellKey(goal.cx, goal.cy);
  const startKey = cellKey(start.cx, start.cy);
  while (cur !== startKey) {
    const prev = cameFrom.get(cur);
    if (!prev) break;
    const comma = prev.indexOf(',');
    result.push({ cx: Number(prev.slice(0, comma)), cy: Number(prev.slice(comma + 1)) });
    cur = prev;
  }
  result.reverse();
  return result;
}

function findBestBreachPoint(
  state: GameState,
  from: Vec2,
  target: Vec2,
  walls: WallRect[],
  options: ShipPathOptions,
): { pos: Vec2; worthIt: boolean } | null {
  let best: { pos: Vec2; score: number; wallHp: number } | null = null;
  const corridor = NAV_CELL * 4;
  const minX = Math.min(from.x, target.x) - corridor;
  const maxX = Math.max(from.x, target.x) + corridor;
  const minY = Math.min(from.y, target.y) - corridor;
  const maxY = Math.max(from.y, target.y) + corridor;
  for (const wall of queryWalls(walls, minX, maxX, minY, maxY)) {
    const lineDist = pointToSegmentDistance(wall.center, from, target);
    if (lineDist > NAV_CELL * 4) continue;
    const fire = localThreat(state, options.team, wall.center);
    const distance = from.distanceTo(wall.center) + wall.center.distanceTo(target);
    const score = distance + wall.hp * (options.preferBreach ? 16 : 34) + fire * 34;
    if (!best || score < best.score) best = { pos: wall.center.clone(), score, wallHp: wall.hp };
  }
  if (!best) return null;
  const around = scoreShipRouteNoBreach(state, from, target, options);
  const breachScore = best.score + best.wallHp * 18;
  return { pos: best.pos, worthIt: breachScore < around * 0.86 };
}

function scoreShipRouteNoBreach(state: GameState, from: Vec2, target: Vec2, options: ShipPathOptions): number {
  const walls = collectWalls(state, options.radius + WALL_MARGIN);
  const route = findRoute(state, from, target, walls, { ...options, intelligence: Math.max(0, options.intelligence) });
  return route ? from.distanceTo(route) + route.distanceTo(target) : Infinity;
}

function routeThreat(state: GameState, team: Team, from: Vec2, to: Vec2): number {
  const steps = Math.max(1, Math.ceil(from.distanceTo(to) / 120));
  let total = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    total += localThreat(state, team, from.lerp(to, t));
  }
  return total / (steps + 1);
}

// localThreat is called once per sampled route point, once per A* edge at
// higher intelligence — a single findRoute resolve can invoke it thousands of
// times. Scanning the full (potentially 100+) state.fighters array on every
// call made this scale with total fighter count regardless of how many were
// actually near the sampled point; route the fighter half of the scan through
// the spatial index (already sized for ~250-1000 unit queries) instead.
const localThreatQueryScratch: Entity[] = [];

function localThreat(state: GameState, team: Team, pos: Vec2): number {
  let threat = 0;
  for (const b of state.buildings) {
    if (!b.alive || b.team === team || b.team === Team.Neutral) continue;
    if (!(b instanceof TurretBase)) continue;
    const d = b.position.distanceTo(pos);
    if (d <= b.range * 1.2) threat += 1 - d / (b.range * 1.2);
  }
  for (const e of state.queryEntitiesInRange(pos, 280, localThreatQueryScratch)) {
    if (!(e instanceof FighterShip) || !e.alive || e.docked || e.team === team || e.team === Team.Neutral) continue;
    const d = e.position.distanceTo(pos);
    if (d <= 280) threat += 0.35 * (1 - d / 280);
  }
  return threat;
}

function threatWeight(intelligence: number): number {
  return intelligence >= 3 ? 260 : intelligence >= 2 ? 120 : intelligence >= 1 ? 35 : 0;
}

function isBlocked(pos: Vec2, walls: WallRect[]): boolean {
  return queryWalls(walls, pos.x, pos.x, pos.y, pos.y).some((w) => pointInRect(pos, w));
}

function isBlockedCell(cell: NavCell, walls: WallRect[]): boolean {
  const left = cell.cx * NAV_CELL;
  const right = left + NAV_CELL;
  const top = cell.cy * NAV_CELL;
  const bottom = top + NAV_CELL;
  return queryWalls(walls, left, right, top, bottom).some((w) => rectsOverlap(left, right, top, bottom, w));
}

function rectsOverlap(left: number, right: number, top: number, bottom: number, wall: WallRect): boolean {
  return left < wall.right && right > wall.left && top < wall.bottom && bottom > wall.top;
}

function nearestOpenCell(start: NavCell, walls: WallRect[], maxRadius: number): NavCell | null {
  if (!isBlockedCell(start, walls)) return start;
  let best: NavCell | null = null;
  let bestDist = Infinity;
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const candidate = clampNavCell({ cx: start.cx + dx, cy: start.cy + dy });
        if (isBlockedCell(candidate, walls)) continue;
        const d = heuristic(start, candidate);
        if (d < bestDist) {
          best = candidate;
          bestDist = d;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

function toNavCell(pos: Vec2): NavCell {
  return clampNavCell({
    cx: Math.floor(pos.x / NAV_CELL),
    cy: Math.floor(pos.y / NAV_CELL),
  });
}

function clampNavCell(cell: NavCell): NavCell {
  return {
    cx: Math.max(0, Math.min(Math.floor(WORLD_WIDTH / NAV_CELL), cell.cx)),
    cy: Math.max(0, Math.min(Math.floor(WORLD_HEIGHT / NAV_CELL), cell.cy)),
  };
}

function navCenter(c: NavCell): Vec2 {
  return new Vec2((c.cx + 0.5) * NAV_CELL, (c.cy + 0.5) * NAV_CELL);
}

function heuristic(a: NavCell, b: NavCell): number {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy);
}

function neighbors(c: NavCell): NavCell[] {
  return [
    { cx: c.cx + 1, cy: c.cy },
    { cx: c.cx - 1, cy: c.cy },
    { cx: c.cx, cy: c.cy + 1 },
    { cx: c.cx, cy: c.cy - 1 },
    { cx: c.cx + 1, cy: c.cy + 1 },
    { cx: c.cx + 1, cy: c.cy - 1 },
    { cx: c.cx - 1, cy: c.cy + 1 },
    { cx: c.cx - 1, cy: c.cy - 1 },
  ];
}

function buildWallBuckets(walls: WallRect[]): Map<number, WallRect[]> {
  const buckets = new Map<number, WallRect[]>();
  for (const wall of walls) {
    const minCx = Math.floor(wall.left / NAV_CELL);
    const maxCx = Math.floor(wall.right / NAV_CELL);
    const minCy = Math.floor(wall.top / NAV_CELL);
    const maxCy = Math.floor(wall.bottom / NAV_CELL);
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = wallBucketKey(cx, cy);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = [];
          buckets.set(key, bucket);
        }
        bucket.push(wall);
      }
    }
  }
  return buckets;
}

function queryWalls(walls: WallRect[], left: number, right: number, top: number, bottom: number): WallRect[] {
  if (walls !== wallCache || wallCacheBuckets.size === 0) return walls;
  wallQueryScratch.length = 0;
  wallQuerySeen.clear();
  const minCx = Math.floor(left / NAV_CELL);
  const maxCx = Math.floor(right / NAV_CELL);
  const minCy = Math.floor(top / NAV_CELL);
  const maxCy = Math.floor(bottom / NAV_CELL);
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const bucket = wallCacheBuckets.get(wallBucketKey(cx, cy));
      if (!bucket) continue;
      for (const wall of bucket) {
        if (wallQuerySeen.has(wall.id)) continue;
        wallQuerySeen.add(wall.id);
        wallQueryScratch.push(wall);
      }
    }
  }
  return wallQueryScratch;
}

function wallBucketKey(cx: number, cy: number): number {
  return (cx + 32768) * 65536 + (cy + 32768);
}
