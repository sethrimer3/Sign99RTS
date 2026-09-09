import type { BuildingBase } from './building.js';
import { Camera } from './camera.js';
import { Colors, colorToCSS, type Color } from './colors.js';
import { WORLD_HEIGHT, WORLD_WIDTH } from './constants.js';
import { Team } from './entities.js';
import { GRID_CELL_SIZE } from './grid.js';
import { clamp, pointToSegmentDistance, Vec2 } from './math.js';
import { teamColor } from './teamutils.js';

export const SYNONYMOUS_DRONE_DIAMETER = GRID_CELL_SIZE * 0.75;
export const SYNONYMOUS_DRONE_RADIUS = SYNONYMOUS_DRONE_DIAMETER * 0.5;
export const SYNONYMOUS_DRONE_HP = 4;
export const SYNONYMOUS_BASE_PRODUCTION = 1;
export const SYNONYMOUS_FACTORY_PRODUCTION = 1;
export const SYNONYMOUS_CURRENCY_SYMBOL = 'ᐃ';

export const SYNONYMOUS_BUILD_COST: Record<string, number> = {
  factory: 50,
  researchlab: 50,
  fighteryard: 80,
  bomberyard: 120,
  missileturret: 50,
  synonymousminelayer: 65,
  powergenerator: 30,
  wall: 15,
  gatlingturret: 55,
  exciterturret: 80,
  massdriverturret: 170,
  regenturret: 85,
  tetherturret: 48,
};

export type SynonymousShapeKind = 'swarm' | 'factory' | 'researchlab' | 'laserturret' | 'minelayer';

const FREE_DRONE_MAX_SPEED = 105;
const ALLOCATED_MAX_SPEED = 225;
const RETURN_MAX_SPEED = 185;
const FREE_DRONE_DAMPING = 0.965;
const TARGET_DAMPING = 0.78;
const BASE_ATTRACTION_STRENGTH = 12;
const NEIGHBOR_ATTRACTION_STRENGTH = 5.5;
const SEPARATION_STRENGTH = 520;
const SEPARATION_RADIUS = SYNONYMOUS_DRONE_DIAMETER * 1.1;
const NEIGHBOR_ATTRACTION_RADIUS = SYNONYMOUS_DRONE_DIAMETER * 5.5;
const MANUAL_CONTROL_GRACE_SECONDS = 0.45;
const TARGET_DEAD_ZONE = SYNONYMOUS_DRONE_RADIUS * 0.45;
const SPAWN_CHAIN_DURATION = 0.42;
const SPAWN_FLASH_DURATION = 0.5;
const MAX_CHAIN_SEGMENTS = 12;
const BUILDING_ABSORB_RADIUS = SYNONYMOUS_DRONE_DIAMETER * 2.5;
const SHAPE_POINT_SPACING = SYNONYMOUS_DRONE_RADIUS * 1.2;
const SHAPE_MIN_POINT_DISTANCE = SYNONYMOUS_DRONE_RADIUS * 0.65;
const SHAPE_ERASE_RADIUS = SYNONYMOUS_DRONE_DIAMETER * 2.4;

interface Drone {
  id: number;
  pos: Vec2;
  vel: Vec2;
  target: Vec2;
  hp: number;
  bornAt: number;
  awakenedAt: number;
  allocatedTo?: number;
  formationIndex?: number;
  returning?: boolean;
  soldReturn?: boolean;
  manualShapeUntil?: number;
  manualShaped?: boolean;
}

interface Formation {
  buildingId: number;
  kind: SynonymousShapeKind;
  team: Team;
  center: Vec2;
  cost: number;
  visibleRequired: number;
  visibleDroneIds: number[];
  reserveCount: number;
  destroyedCount: number;
  createdAt: number;
}

interface SpawnChainEffect {
  team: Team;
  points: Vec2[];
  bornAt: number;
  duration: number;
}

interface SpawnFlashEffect {
  team: Team;
  pos: Vec2;
  bornAt: number;
  duration: number;
}

interface ShapeStroke {
  points: Vec2[];
  createdAt: number;
}

export class SynonymousSwarmSystem {
  private dronesByTeam = new Map<Team, Drone[]>();
  private formationsByBuilding = new Map<number, Formation>();
  private baseByTeam = new Map<Team, Vec2>();
  private spawnChains: SpawnChainEffect[] = [];
  private spawnFlashes: SpawnFlashEffect[] = [];
  private shapeStrokesByTeam = new Map<Team, ShapeStroke[]>();
  private collapsedBuildingIds = new Set<number>();
  private nextDroneId = 1;

  setBase(team: Team, center: Vec2): void {
    this.baseByTeam.set(team, center.clone());
    if (!this.dronesByTeam.has(team)) this.dronesByTeam.set(team, []);
  }

  clearTeam(team: Team): void {
    this.dronesByTeam.delete(team);
    this.baseByTeam.delete(team);
    for (const [id, f] of this.formationsByBuilding) {
      if (f.team === team) this.formationsByBuilding.delete(id);
    }
    this.spawnChains = this.spawnChains.filter((e) => e.team !== team);
    this.spawnFlashes = this.spawnFlashes.filter((e) => e.team !== team);
    this.shapeStrokesByTeam.delete(team);
  }

  droneCount(team: Team): number {
    return this.getUnallocatedCount(team);
  }

  getUnallocatedCount(team: Team): number {
    return this.liveDrones(team).filter((d) => !d.allocatedTo).length;
  }

  totalDroneCount(team: Team): number {
    let count = this.liveDrones(team).length;
    for (const f of this.formationsByBuilding.values()) {
      if (f.team === team) count += f.reserveCount;
    }
    return count;
  }

  canSpend(team: Team, amount: number): boolean {
    return this.getUnallocatedCount(team) >= amount;
  }

  spendFreeDrones(team: Team, amount: number, near?: Vec2): boolean {
    const drones = this.dronesByTeam.get(team) ?? [];
    const free = drones
      .filter((d) => d.hp > 0 && !d.allocatedTo)
      .sort((a, b) => (near ? a.pos.distanceTo(near) - b.pos.distanceTo(near) : a.id - b.id));
    if (free.length < amount) return false;
    const spendIds = new Set(free.slice(0, amount).map((d) => d.id));
    this.dronesByTeam.set(team, drones.filter((d) => !spendIds.has(d.id)));
    return true;
  }

  spawnAtBase(team: Team, amount: number, time: number): void {
    const base = this.baseByTeam.get(team);
    if (!base) return;
    for (let i = 0; i < amount; i++) {
      const a = ((this.nextDroneId * 137.508) % 360) * Math.PI / 180;
      const r = 20 + Math.sqrt(this.totalDroneCount(team) + i) * 4.5;
      this.addDrone(team, base.add(new Vec2(Math.cos(a) * r, Math.sin(a) * r)), time);
    }
  }

  produce(team: Team, amount: number, origin: Vec2, time: number): void {
    const start = this.baseByTeam.get(team) ?? origin;
    for (let i = 0; i < amount; i++) {
      const spawn = this.findOpenSpawnPosition(team, start, i);
      this.spawnChains.push({ team, points: this.buildSpawnChain(team, start, spawn), bornAt: time, duration: SPAWN_CHAIN_DURATION });
      this.spawnFlashes.push({ team, pos: spawn.clone(), bornAt: time, duration: SPAWN_FLASH_DURATION });
      const d = this.addDrone(team, spawn, time);
      d.awakenedAt = time + 0.08;
    }
  }

  shapeLine(team: Team, target: Vec2, time: number = 0): void {
    const base = this.baseByTeam.get(team);
    const drones = this.dronesByTeam.get(team);
    if (!base || !drones) return;
    const free = drones.filter((d) => d.hp > 0 && !d.allocatedTo);
    const dist = Math.max(1, base.distanceTo(target));
    const dir = target.sub(base).normalize();
    const perp = new Vec2(-dir.y, dir.x);
    const wanted = Math.min(free.length, Math.max(8, Math.floor(dist / (SYNONYMOUS_DRONE_RADIUS * 1.35))));
    for (let i = 0; i < wanted; i++) {
      const t = wanted <= 1 ? 0 : i / (wanted - 1);
      const width = Math.max(SYNONYMOUS_DRONE_RADIUS * 0.6, SYNONYMOUS_DRONE_RADIUS * 4.5 * (1 - t));
      const wave = Math.sin(i * 2.17 + dist * 0.01) * width;
      const d = free[i];
      d.target = base.add(dir.scale(dist * t)).add(perp.scale(wave));
      d.returning = false;
      d.soldReturn = false;
      d.manualShapeUntil = time + MANUAL_CONTROL_GRACE_SECONDS;
      d.manualShaped = true;
    }
  }

  beginShapeStroke(team: Team, pos: Vec2, time: number): void {
    const strokes = this.shapeStrokesByTeam.get(team) ?? [];
    strokes.push({ points: [this.clampToWorld(pos)], createdAt: time });
    this.shapeStrokesByTeam.set(team, strokes);
    this.updateShapeCoverage(team, time);
  }

  addShapePoint(team: Team, pos: Vec2, time: number): void {
    const strokes = this.shapeStrokesByTeam.get(team) ?? [];
    if (strokes.length === 0) {
      this.beginShapeStroke(team, pos, time);
      return;
    }
    const stroke = strokes[strokes.length - 1];
    const point = this.clampToWorld(pos);
    const last = stroke.points[stroke.points.length - 1];
    if (last && last.distanceTo(point) < SHAPE_MIN_POINT_DISTANCE) {
      this.updateShapeCoverage(team, time);
      return;
    }
    stroke.points.push(point);
    this.updateShapeCoverage(team, time);
  }

  eraseShapeAt(team: Team, pos: Vec2, time: number): boolean {
    const strokes = this.shapeStrokesByTeam.get(team);
    if (!strokes || strokes.length === 0) return false;
    let changed = false;
    const nextStrokes: ShapeStroke[] = [];

    for (const stroke of strokes) {
      let segment: Vec2[] = [];
      const flushSegment = () => {
        if (segment.length > 0) nextStrokes.push({ points: segment, createdAt: stroke.createdAt });
        segment = [];
      };

      for (let i = 0; i < stroke.points.length; i++) {
        const point = stroke.points[i];
        const prev = stroke.points[i - 1];
        const next = stroke.points[i + 1];
        const touchesPoint = point.distanceTo(pos) <= SHAPE_ERASE_RADIUS;
        const touchesPrevSegment = prev ? pointToSegmentDistance(pos, prev, point) <= SHAPE_ERASE_RADIUS : false;
        const touchesNextSegment = next ? pointToSegmentDistance(pos, point, next) <= SHAPE_ERASE_RADIUS : false;
        if (touchesPoint || touchesPrevSegment || touchesNextSegment) {
          changed = true;
          flushSegment();
        } else {
          segment.push(point);
        }
      }
      flushSegment();
    }

    this.shapeStrokesByTeam.set(team, nextStrokes);
    if (changed) this.updateShapeCoverage(team, time);
    return changed;
  }

  drawShapeTrails(ctx: CanvasRenderingContext2D, camera: Camera, team: Team, time: number): void {
    const strokes = this.shapeStrokesByTeam.get(team);
    if (!strokes || strokes.length === 0) return;
    const color = teamColor(team);
    const baseWidth = Math.max(2.4, SYNONYMOUS_DRONE_RADIUS * 0.42 * camera.zoom);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of strokes) {
      if (stroke.points.length === 0) continue;

      const screenPoints = stroke.points.map((point) => camera.worldToScreen(point));
      const pulse = 0.5 + 0.5 * Math.sin(time * 5.2 + stroke.createdAt * 2.1);
      const flicker = 0.72 + 0.28 * Math.sin(time * 11.0 + stroke.createdAt * 7.3);
      const drawRibbonPath = (): void => {
        const first = screenPoints[0];
        ctx.beginPath();
        ctx.moveTo(first.x, first.y);
        if (screenPoints.length === 1) {
          ctx.arc(first.x, first.y, baseWidth * 0.72, 0, Math.PI * 2);
          return;
        }
        for (let i = 1; i < screenPoints.length - 1; i++) {
          const p = screenPoints[i];
          const next = screenPoints[i + 1];
          ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) * 0.5, (p.y + next.y) * 0.5);
        }
        const last = screenPoints[screenPoints.length - 1];
        ctx.lineTo(last.x, last.y);
      };

      ctx.shadowColor = colorToCSS(color, 0.62);
      ctx.shadowBlur = Math.max(8, baseWidth * 3.6);
      ctx.strokeStyle = colorToCSS(color, 0.08 + pulse * 0.07);
      ctx.lineWidth = baseWidth * (4.1 + pulse * 1.4);
      drawRibbonPath();
      ctx.stroke();

      ctx.shadowBlur = Math.max(4, baseWidth * 1.8);
      ctx.strokeStyle = colorToCSS(color, 0.22 + pulse * 0.20);
      ctx.lineWidth = baseWidth * (1.55 + pulse * 0.24);
      ctx.setLineDash([baseWidth * 3.4, baseWidth * 1.8]);
      ctx.lineDashOffset = -(time * 34 + stroke.createdAt * 19) * camera.zoom;
      drawRibbonPath();
      ctx.stroke();

      ctx.shadowBlur = Math.max(2, baseWidth * 0.9);
      ctx.strokeStyle = colorToCSS(Colors.general_building, 0.22 + flicker * 0.24);
      ctx.lineWidth = Math.max(1.2, baseWidth * 0.36);
      ctx.setLineDash([]);
      drawRibbonPath();
      ctx.stroke();

      ctx.shadowBlur = Math.max(3, baseWidth * 1.1);
      const beadStride = Math.max(2, Math.round(5 - Math.min(2, camera.zoom)));
      const beadOffset = Math.floor((time * 18 + stroke.createdAt * 11) % beadStride);
      for (let i = beadOffset; i < screenPoints.length; i += beadStride) {
        const p = screenPoints[i];
        const phase = time * 7.5 + i * 0.9 + stroke.createdAt * 4.0;
        const radius = baseWidth * (0.34 + 0.20 * (0.5 + 0.5 * Math.sin(phase)));
        ctx.fillStyle = colorToCSS(Colors.particles_switch, 0.26 + 0.32 * (0.5 + 0.5 * Math.cos(phase)));
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      if (screenPoints.length < 2) {
        continue;
      }

      ctx.shadowBlur = Math.max(7, baseWidth * 2.1);
      ctx.strokeStyle = colorToCSS(Colors.particles_healing, 0.20 + pulse * 0.22);
      ctx.lineWidth = Math.max(1, baseWidth * 0.22);
      ctx.setLineDash([baseWidth * 0.7, baseWidth * 5.4]);
      ctx.lineDashOffset = -(time * 86 + stroke.createdAt * 31) * camera.zoom;
      ctx.beginPath();
      const first = screenPoints[0];
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < stroke.points.length; i++) {
        const p = screenPoints[i];
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  recallAt(team: Team, pos: Vec2): boolean {
    const drones = this.dronesByTeam.get(team);
    const base = this.baseByTeam.get(team);
    if (!drones || !base) return false;
    let changed = false;
    for (const d of drones) {
      if (d.allocatedTo) continue;
      if (d.pos.distanceTo(pos) <= SYNONYMOUS_DRONE_RADIUS * 2.5) {
        d.target = base.clone();
        d.returning = true;
        d.manualShapeUntil = 0;
        d.manualShaped = false;
        changed = true;
      }
    }
    return changed;
  }

  allocateToBuilding(team: Team, buildingId: number, kind: SynonymousShapeKind, center: Vec2, cost: number, time: number): boolean {
    const drones = this.dronesByTeam.get(team) ?? [];
    const free = drones
      .filter((d) => d.hp > 0 && !d.allocatedTo)
      .sort((a, b) => a.pos.distanceTo(center) - b.pos.distanceTo(center));
    if (free.length < cost) return false;
    const visibleRequired = Math.min(cost, this.visibleRequiredForKind(kind));
    const selected = free.slice(0, cost);
    const visible = selected.slice(0, visibleRequired);
    const reserveIds = new Set(selected.slice(visibleRequired).map((d) => d.id));
    const visibleIds: number[] = [];

    for (let i = 0; i < visible.length; i++) {
      const d = visible[i];
      d.allocatedTo = buildingId;
      d.formationIndex = i;
      d.returning = false;
      d.soldReturn = false;
      d.manualShapeUntil = 0;
      d.manualShaped = false;
      d.target = this.formationPoint(kind, center, i, visibleRequired);
      d.awakenedAt = time + i * 0.018;
      d.hp = SYNONYMOUS_DRONE_HP;
      visibleIds.push(d.id);
    }

    this.dronesByTeam.set(team, drones.filter((d) => !reserveIds.has(d.id)));
    this.formationsByBuilding.set(buildingId, {
      buildingId,
      kind,
      team,
      center: center.clone(),
      cost,
      visibleRequired,
      visibleDroneIds: visibleIds,
      reserveCount: cost - visibleRequired,
      destroyedCount: 0,
      createdAt: time,
    });
    return true;
  }

  releaseBuilding(buildingId: number, time: number, options: { sold?: boolean } = {}): number {
    const f = this.formationsByBuilding.get(buildingId);
    if (!f) return 0;
    this.formationsByBuilding.delete(buildingId);
    const base = this.baseByTeam.get(f.team) ?? f.center;
    const drones = this.dronesByTeam.get(f.team) ?? [];
    let reclaimed = 0;

    for (const d of drones) {
      if (d.allocatedTo !== buildingId) continue;
      d.allocatedTo = undefined;
      d.formationIndex = undefined;
      d.hp = Math.max(1, d.hp);
      d.target = options.sold ? base.clone() : d.pos.clone();
      d.returning = !!options.sold;
      d.soldReturn = !!options.sold;
      d.manualShapeUntil = 0;
      d.manualShaped = false;
      d.vel = d.vel.add(this.seededJitter(d.id, time, 24));
      reclaimed++;
    }

    for (let i = 0; i < f.reserveCount; i++) {
      const p = f.center.add(this.seededJitter(this.nextDroneId + i, time, SYNONYMOUS_DRONE_RADIUS * 1.5));
      const d = this.addDrone(f.team, p, time);
      d.target = options.sold ? base.clone() : p.clone();
      d.returning = !!options.sold;
      d.soldReturn = !!options.sold;
      d.vel = this.seededJitter(d.id, time, 28);
      reclaimed++;
    }
    return reclaimed;
  }

  update(dt: number, time: number): void {
    this.spawnChains = this.spawnChains.filter((e) => time - e.bornAt <= e.duration);
    this.spawnFlashes = this.spawnFlashes.filter((e) => time - e.bornAt <= e.duration);

    for (const f of this.formationsByBuilding.values()) {
      this.refreshFormationTargets(f);
    }

    for (const [team, drones] of this.dronesByTeam) {
      for (let i = drones.length - 1; i >= 0; i--) {
        if (drones[i].hp <= 0) drones.splice(i, 1);
      }
      const free = drones.filter((d) => d.hp > 0 && !d.allocatedTo);
      const swarmForces = this.computeFreeSwarmForces(team, free);

      for (const d of drones) {
        if (d.hp <= 0) continue;
        if (d.allocatedTo) {
          this.moveTowardTarget(d, dt, ALLOCATED_MAX_SPEED, TARGET_DAMPING);
        } else if (d.returning || d.manualShaped || (d.manualShapeUntil ?? 0) > time) {
          const speed = d.returning ? RETURN_MAX_SPEED : FREE_DRONE_MAX_SPEED * 1.55;
          this.moveTowardTarget(d, dt, speed, TARGET_DAMPING);
        } else {
          const force = swarmForces.get(d.id) ?? new Vec2(0, 0);
          d.vel = d.vel.add(force.scale(dt));
          d.vel = d.vel.scale(Math.pow(FREE_DRONE_DAMPING, dt * 60));
          d.vel = this.capVelocity(d.vel, FREE_DRONE_MAX_SPEED);
          if (Math.abs(d.vel.x) < 0.03 && Math.abs(d.vel.y) < 0.03) d.vel.set(0, 0);
          d.pos = d.pos.add(d.vel.scale(dt));
          d.target = d.pos.clone();
        }
        const base = this.baseByTeam.get(team);
        if (base && d.returning && d.pos.distanceTo(base) < 18) {
          d.returning = false;
          d.soldReturn = false;
        }
      }
      this.absorbFreeDronesIntoDamagedBuildings(team, time);
    }
  }

  updateBuildingIntegrity(buildings: BuildingBase[]): void {
    const byId = new Map<number, BuildingBase>();
    for (const b of buildings) byId.set(b.id, b);
    for (const id of this.collapsedBuildingIds) {
      byId.get(id)?.destroy();
    }
    this.collapsedBuildingIds.clear();
    for (const f of Array.from(this.formationsByBuilding.values())) {
      const b = byId.get(f.buildingId);
      if (!b || !b.alive) {
        this.formationsByBuilding.delete(f.buildingId);
        continue;
      }
      b.powered = true;
      const liveVisible = this.liveFormationDrones(f).length;
      const reserveMaxHp = this.maxReserve(f) * SYNONYMOUS_DRONE_HP;
      b.maxHealth = Math.max(1, reserveMaxHp);
      b.health = clamp(f.reserveCount * SYNONYMOUS_DRONE_HP, 0, b.maxHealth);
      if (liveVisible < f.visibleRequired && f.reserveCount <= 0) {
        this.collapseFormation(f, 0);
        b.destroy();
      }
    }
  }

  consumeCollapsedBuildingIds(): number[] {
    const ids = Array.from(this.collapsedBuildingIds);
    this.collapsedBuildingIds.clear();
    return ids;
  }

  damageDroneAt(team: Team, pos: Vec2, amount: number, options: { buildingId?: number; time?: number; fallbackToBuilding?: boolean } = {}): boolean {
    const drones = this.dronesByTeam.get(team);
    if (!drones) return false;
    let best: Drone | null = null;
    let bestDist = SYNONYMOUS_DRONE_RADIUS * 1.65;

    const consider = (d: Drone, radius: number) => {
      const dist = d.pos.distanceTo(pos);
      if (dist < bestDist && dist <= radius) {
        best = d;
        bestDist = dist;
      }
    };

    for (const d of drones) {
      if (d.hp <= 0 || !d.allocatedTo) continue;
      if (options.buildingId !== undefined && d.allocatedTo !== options.buildingId) continue;
      consider(d, SYNONYMOUS_DRONE_RADIUS * 1.65);
    }

    if (!best && options.fallbackToBuilding && options.buildingId !== undefined) {
      const f = this.formationsByBuilding.get(options.buildingId);
      const visible = f ? this.liveFormationDrones(f) : [];
      best = visible.sort((a, b) => a.pos.distanceTo(pos) - b.pos.distanceTo(pos))[0] ?? null;
    }

    if (!best) {
      for (const d of drones) {
        if (d.hp <= 0 || d.allocatedTo) continue;
        consider(d, SYNONYMOUS_DRONE_RADIUS * 1.25);
      }
    }

    if (!best) return false;
    best.hp -= amount;
    if (best.hp <= 0 && best.allocatedTo) {
      this.handleVisibleDroneDestroyed(best, options.time ?? 0);
    }
    return true;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera, time: number): void {
    this.drawSpawnEffects(ctx, camera, time);
    for (const [team, drones] of this.dronesByTeam) {
      const color = teamColor(team);
      for (const f of this.formationsByBuilding.values()) {
        if (f.team === team) this.drawFormationLines(ctx, camera, f, color);
      }
      for (const d of drones) this.drawDrone(ctx, camera, d, color, time);
    }
  }

  drawBuildingOverlay(ctx: CanvasRenderingContext2D, camera: Camera, buildingId: number): boolean {
    const f = this.formationsByBuilding.get(buildingId);
    if (!f) return false;
    this.drawFormationLines(ctx, camera, f, teamColor(f.team));
    return true;
  }

  private addDrone(team: Team, pos: Vec2, time: number): Drone {
    const base = this.baseByTeam.get(team) ?? pos;
    const d: Drone = {
      id: this.nextDroneId++,
      pos: pos.clone(),
      vel: new Vec2(0, 0),
      target: pos.clone(),
      hp: SYNONYMOUS_DRONE_HP,
      bornAt: time,
      awakenedAt: time + base.distanceTo(pos) / 320,
    };
    const drones = this.dronesByTeam.get(team) ?? [];
    drones.push(d);
    this.dronesByTeam.set(team, drones);
    return d;
  }

  private liveDrones(team: Team): Drone[] {
    return (this.dronesByTeam.get(team) ?? []).filter((d) => d.hp > 0);
  }

  private updateShapeCoverage(team: Team, time: number): void {
    const drones = this.dronesByTeam.get(team);
    if (!drones) return;
    const free = drones.filter((d) => d.hp > 0 && !d.allocatedTo);
    const targets = this.sampleShapeTargets(team);
    const count = Math.min(free.length, targets.length);
    if (count === 0) {
      for (const d of free) {
        if (d.manualShaped) {
          d.manualShapeUntil = 0;
          d.manualShaped = false;
        }
      }
      return;
    }

    const available = new Set(free.map((d) => d.id));
    for (let i = 0; i < count; i++) {
      const target = targets[Math.floor((i / Math.max(1, count - 1)) * (targets.length - 1))];
      let best: Drone | null = null;
      let bestDist = Infinity;
      for (const d of free) {
        if (!available.has(d.id)) continue;
        const dist = d.pos.distanceTo(target);
        if (dist < bestDist) {
          best = d;
          bestDist = dist;
        }
      }
      if (!best) continue;
      available.delete(best.id);
      best.target = target.clone();
      best.returning = false;
      best.soldReturn = false;
      best.manualShapeUntil = time + MANUAL_CONTROL_GRACE_SECONDS;
      best.manualShaped = true;
    }

    for (const d of free) {
      if (available.has(d.id) && d.manualShaped) {
        d.manualShapeUntil = 0;
        d.manualShaped = false;
      }
    }
  }

  private sampleShapeTargets(team: Team): Vec2[] {
    const strokes = this.shapeStrokesByTeam.get(team) ?? [];
    const targets: Vec2[] = [];
    for (const stroke of strokes) {
      if (stroke.points.length === 1) {
        targets.push(stroke.points[0].clone());
        continue;
      }
      for (let i = 0; i < stroke.points.length - 1; i++) {
        const a = stroke.points[i];
        const b = stroke.points[i + 1];
        const dist = a.distanceTo(b);
        const steps = Math.max(1, Math.floor(dist / SHAPE_POINT_SPACING));
        for (let step = 0; step < steps; step++) {
          targets.push(a.lerp(b, step / steps));
        }
      }
      targets.push(stroke.points[stroke.points.length - 1].clone());
    }
    return targets;
  }

  private visibleRequiredForKind(kind: SynonymousShapeKind): number {
    if (kind === 'factory') return 24;
    if (kind === 'researchlab') return 20;
    if (kind === 'laserturret') return 18;
    if (kind === 'minelayer') return 20;
    return 18;
  }

  private maxReserve(f: Formation): number {
    return Math.max(0, f.cost - f.visibleRequired);
  }

  private nextOpenFormationIndex(f: Formation): number {
    const used = new Set(this.liveFormationDrones(f).map((d) => d.formationIndex ?? 0));
    for (let i = 0; i < f.visibleRequired; i++) {
      if (!used.has(i)) return i;
    }
    return Math.min(f.visibleRequired - 1, used.size);
  }

  private liveFormationDrones(f: Formation): Drone[] {
    const ids = new Set(f.visibleDroneIds);
    return (this.dronesByTeam.get(f.team) ?? []).filter((d) => d.hp > 0 && d.allocatedTo === f.buildingId && ids.has(d.id));
  }

  private refreshFormationTargets(f: Formation): void {
    f.visibleDroneIds = this.liveFormationDrones(f).map((d) => d.id);
    for (const d of this.liveFormationDrones(f)) {
      const idx = clamp(d.formationIndex ?? 0, 0, f.visibleRequired - 1);
      d.target = this.formationPoint(f.kind, f.center, idx, f.visibleRequired);
    }
  }

  private handleVisibleDroneDestroyed(d: Drone, time: number): void {
    const f = d.allocatedTo !== undefined ? this.formationsByBuilding.get(d.allocatedTo) : undefined;
    if (!f) return;
    const missingIndex = d.formationIndex ?? this.nextOpenFormationIndex(f);
    f.visibleDroneIds = f.visibleDroneIds.filter((id) => id !== d.id);
    f.destroyedCount++;
    d.allocatedTo = undefined;
    d.formationIndex = undefined;
    if (f.reserveCount > 0) {
      f.reserveCount--;
      const idx = missingIndex;
      const replacement = this.addDrone(f.team, f.center.add(this.seededJitter(this.nextDroneId, time, SYNONYMOUS_DRONE_RADIUS * 1.5)), time);
      replacement.allocatedTo = f.buildingId;
      replacement.formationIndex = idx;
      replacement.target = this.formationPoint(f.kind, f.center, idx, f.visibleRequired);
      replacement.awakenedAt = time;
      f.visibleDroneIds.push(replacement.id);
      return;
    }
    if (this.liveFormationDrones(f).length < f.visibleRequired) {
      this.collapseFormation(f, time);
    }
  }

  private collapseFormation(f: Formation, time: number): void {
    this.formationsByBuilding.delete(f.buildingId);
    this.collapsedBuildingIds.add(f.buildingId);
    const drones = this.dronesByTeam.get(f.team) ?? [];
    for (const d of drones) {
      if (d.allocatedTo !== f.buildingId) continue;
      d.allocatedTo = undefined;
      d.formationIndex = undefined;
      d.returning = false;
      d.soldReturn = false;
      d.manualShapeUntil = 0;
      d.manualShaped = false;
      d.target = d.pos.clone();
      d.vel = d.vel.add(this.seededJitter(d.id, time, 36));
    }
  }

  private absorbFreeDronesIntoDamagedBuildings(team: Team, time: number): void {
    const drones = this.dronesByTeam.get(team);
    if (!drones) return;
    for (const f of this.formationsByBuilding.values()) {
      if (f.team !== team) continue;
      const needsVisible = this.liveFormationDrones(f).length < f.visibleRequired;
      const needsReserve = f.reserveCount < this.maxReserve(f);
      if (!needsVisible && !needsReserve) continue;
      for (let i = drones.length - 1; i >= 0; i--) {
        const d = drones[i];
        if (d.hp <= 0 || d.allocatedTo || d.returning || d.manualShaped) continue;
        if (d.pos.distanceTo(f.center) > BUILDING_ABSORB_RADIUS) continue;
        if (this.liveFormationDrones(f).length < f.visibleRequired) {
          const idx = this.nextOpenFormationIndex(f);
          d.allocatedTo = f.buildingId;
          d.formationIndex = idx;
          d.target = this.formationPoint(f.kind, f.center, idx, f.visibleRequired);
          d.awakenedAt = time;
          d.hp = SYNONYMOUS_DRONE_HP;
          f.visibleDroneIds.push(d.id);
        } else if (f.reserveCount < this.maxReserve(f)) {
          drones.splice(i, 1);
          f.reserveCount++;
        }
        if (this.liveFormationDrones(f).length >= f.visibleRequired && f.reserveCount >= this.maxReserve(f)) break;
      }
    }
  }

  private computeFreeSwarmForces(team: Team, free: Drone[]): Map<number, Vec2> {
    const forces = new Map<number, Vec2>();
    const base = this.baseByTeam.get(team);
    for (const d of free) forces.set(d.id, new Vec2(0, 0));
    if (base) {
      const surfaceRadius = 26 + Math.sqrt(Math.max(1, free.length)) * SYNONYMOUS_DRONE_RADIUS * 1.55;
      for (const d of free) {
        const toBase = base.sub(d.pos);
        const dist = Math.max(0.001, toBase.length());
        const dir = toBase.scale(1 / dist);
        const inward = dist > surfaceRadius ? (dist - surfaceRadius) * BASE_ATTRACTION_STRENGTH : 0;
        const outward = dist < surfaceRadius * 0.34 ? (surfaceRadius * 0.34 - dist) * BASE_ATTRACTION_STRENGTH * 0.2 : 0;
        forces.set(d.id, forces.get(d.id)!.add(dir.scale(inward - outward)));
      }
    }

    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        const a = free[i];
        const b = free[j];
        const delta = b.pos.sub(a.pos);
        const dist = Math.max(0.001, delta.length());
        if (dist > NEIGHBOR_ATTRACTION_RADIUS) continue;
        const dir = delta.scale(1 / dist);
        let strength = 0;
        if (dist < SEPARATION_RADIUS) {
          strength = -(SEPARATION_RADIUS - dist) * SEPARATION_STRENGTH;
        } else {
          strength = Math.min(36, (dist - SEPARATION_RADIUS) * NEIGHBOR_ATTRACTION_STRENGTH);
        }
        const force = dir.scale(strength);
        forces.set(a.id, forces.get(a.id)!.add(force));
        forces.set(b.id, forces.get(b.id)!.add(force.scale(-1)));
      }
    }
    return forces;
  }

  private moveTowardTarget(d: Drone, dt: number, maxSpeed: number, damping: number): void {
    const to = d.target.sub(d.pos);
    const dist = to.length();
    if (dist < TARGET_DEAD_ZONE) {
      d.vel = d.vel.scale(0.45);
      if (d.vel.length() < 0.08) d.vel.set(0, 0);
      d.pos = d.pos.add(d.vel.scale(dt));
      return;
    }
    const desiredSpeed = Math.min(maxSpeed, dist * 7);
    const desired = to.scale(desiredSpeed / Math.max(0.001, dist));
    d.vel = d.vel.scale(damping).add(desired.scale(1 - damping));
    d.vel = this.capVelocity(d.vel, maxSpeed);
    d.pos = d.pos.add(d.vel.scale(dt));
  }

  private capVelocity(v: Vec2, maxSpeed: number): Vec2 {
    const speed = v.length();
    return speed > maxSpeed ? v.scale(maxSpeed / speed) : v;
  }

  private findOpenSpawnPosition(team: Team, origin: Vec2, salt: number): Vec2 {
    const free = this.liveDrones(team).filter((d) => !d.allocatedTo);
    const center = free.length > 0
      ? free.reduce((sum, d) => sum.add(d.pos), new Vec2(0, 0)).scale(1 / free.length)
      : origin;
    const minDist = SYNONYMOUS_DRONE_DIAMETER * 1.1;
    const startRadius = 18 + Math.sqrt(Math.max(1, free.length)) * SYNONYMOUS_DRONE_RADIUS * 0.85;
    for (let i = 0; i < 140; i++) {
      const a = (i + salt * 0.37) * 2.399963;
      const r = startRadius + Math.sqrt(i) * SYNONYMOUS_DRONE_RADIUS * 1.35;
      const p = this.clampToWorld(center.add(new Vec2(Math.cos(a) * r, Math.sin(a) * r)));
      if (free.every((d) => d.pos.distanceTo(p) >= minDist)) return p;
    }
    return this.clampToWorld(origin.add(this.seededJitter(this.nextDroneId + salt, 0, startRadius + 20)));
  }

  private buildSpawnChain(team: Team, start: Vec2, target: Vec2): Vec2[] {
    const free = this.liveDrones(team).filter((d) => !d.allocatedTo);
    if (free.length === 0) return [start.clone(), target.clone()];
    const points = [start.clone()];
    const used = new Set<number>();
    let cur = start.clone();
    for (let step = 0; step < MAX_CHAIN_SEGMENTS; step++) {
      const curTargetDist = cur.distanceTo(target);
      let best: Drone | null = null;
      let bestScore = Infinity;
      for (const d of free) {
        if (used.has(d.id)) continue;
        const toTarget = d.pos.distanceTo(target);
        if (toTarget >= curTargetDist) continue;
        const score = cur.distanceTo(d.pos) + toTarget * 0.35;
        if (score < bestScore) {
          bestScore = score;
          best = d;
        }
      }
      if (!best) break;
      points.push(best.pos.clone());
      used.add(best.id);
      cur = best.pos;
      if (cur.distanceTo(target) <= SYNONYMOUS_DRONE_DIAMETER * 2) break;
    }
    points.push(target.clone());
    return points;
  }

  private clampToWorld(p: Vec2): Vec2 {
    return new Vec2(
      clamp(p.x, SYNONYMOUS_DRONE_RADIUS, WORLD_WIDTH - SYNONYMOUS_DRONE_RADIUS),
      clamp(p.y, SYNONYMOUS_DRONE_RADIUS, WORLD_HEIGHT - SYNONYMOUS_DRONE_RADIUS),
    );
  }

  private formationPoint(kind: SynonymousShapeKind, center: Vec2, i: number, n: number): Vec2 {
    const sides = kind === 'factory' ? 8 : kind === 'researchlab' ? 5 : kind === 'laserturret' ? 3 : kind === 'minelayer' ? 20 : 6;
    const ring = i % sides;
    const layer = Math.floor(i / sides);
    const a = (ring / sides) * Math.PI * 2 + layer * 0.13;
    const radius = kind === 'minelayer' ? 24 + layer * 7 : 18 + layer * 11 + (kind === 'laserturret' ? 10 : 0);
    if (i >= n - 1) return center.clone();
    return center.add(new Vec2(Math.cos(a) * radius, Math.sin(a) * radius));
  }

  private seededJitter(id: number, salt: number, radius: number): Vec2 {
    const a = ((id * 137.508 + salt * 61.3) % 360) * Math.PI / 180;
    const r = radius * (0.35 + (((id * 9301 + 49297) % 233280) / 233280) * 0.65);
    return new Vec2(Math.cos(a) * r, Math.sin(a) * r);
  }

  private drawSpawnEffects(ctx: CanvasRenderingContext2D, camera: Camera, time: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of this.spawnChains) {
      const t = clamp((time - e.bornAt) / e.duration, 0, 1);
      const color = teamColor(e.team);
      ctx.lineCap = 'round';
      for (let i = 0; i < e.points.length - 1; i++) {
        const a = camera.worldToScreen(e.points[i]);
        const b = camera.worldToScreen(e.points[i + 1]);
        const flicker = 0.45 + 0.35 * Math.sin(time * 54 + i * 1.7);
        ctx.strokeStyle = colorToCSS(color, (1 - t) * 0.22 * flicker);
        ctx.lineWidth = Math.max(1, camera.zoom * (1.2 + flicker));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    for (const e of this.spawnFlashes) {
      const t = clamp((time - e.bornAt) / e.duration, 0, 1);
      const p = camera.worldToScreen(e.pos);
      const r = SYNONYMOUS_DRONE_RADIUS * camera.zoom * (1.2 + t * 2.4);
      ctx.strokeStyle = colorToCSS(teamColor(e.team), (1 - t) * 0.55);
      ctx.lineWidth = Math.max(1, 1.4 * camera.zoom);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawDrone(ctx: CanvasRenderingContext2D, camera: Camera, d: Drone, color: Color, time: number): void {
    if (d.hp <= 0) return;
    const s = camera.worldToScreen(d.pos);
    const r = SYNONYMOUS_DRONE_RADIUS * camera.zoom;
    const awake = Math.max(0, Math.min(1, (time - d.awakenedAt) / 0.35));
    const blink = d.soldReturn ? 0.48 + 0.34 * Math.sin(time * 5 + d.id * 0.41) : 1;
    ctx.save();
    ctx.globalAlpha = blink;
    ctx.fillStyle = colorToCSS(Colors.general_building, 0.62);
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (awake > 0) {
      const ringR = r * (1 + awake * 0.42);
      ctx.strokeStyle = colorToCSS(Colors.general_building, 0.75);
      ctx.lineWidth = Math.max(1, r * 0.28);
      ctx.beginPath();
      ctx.arc(s.x, s.y, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = colorToCSS(color, 0.9 * awake);
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 0.52, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawFormationLines(ctx: CanvasRenderingContext2D, camera: Camera, f: Formation, color: Color): void {
    const drones = this.liveFormationDrones(f);
    if (drones.length < 2) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = colorToCSS(color, 0.45 + 0.18 * (f.reserveCount / Math.max(1, this.maxReserve(f))));
    ctx.lineWidth = Math.max(1, 1.2 * camera.zoom);
    ctx.beginPath();
    const sorted = drones.slice().sort((a, b) => (a.formationIndex ?? 0) - (b.formationIndex ?? 0));
    for (let i = 0; i < sorted.length; i++) {
      const a = camera.worldToScreen(sorted[i].pos);
      const b = camera.worldToScreen(sorted[(i + 1) % sorted.length].pos);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      if (i % 3 === 0) {
        const c = camera.worldToScreen(f.center);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(c.x, c.y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
}
