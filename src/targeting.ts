import { Vec2, wrapAngle } from './math.js';
import { Entity, Team } from './entities.js';
import { ProjectileBase } from './projectile.js';

const EPSILON = 1e-5;
const DEFAULT_MAX_PREDICTION_TIME = 1.2;
const FALLBACK_PREDICTION_TIME = 0.28;
const MAX_DEBUG_SAMPLES = 80;

export interface PredictiveAimOptions {
  maxPredictionTime?: number;
  fallback?: 'current' | 'shortPrediction';
}

export interface PredictiveAimResult {
  aimPoint: Vec2;
  direction: Vec2;
  interceptTime: number | null;
  valid: boolean;
  usedFallback: boolean;
}

export interface CombatAimDebugSample {
  shooterId: number;
  targetId: number;
  shooter: Vec2;
  target: Vec2;
  targetVelocity: Vec2;
  aimPoint: Vec2;
  spawn: Vec2;
  range: number;
  interceptValid: boolean;
  createdAt: number;
}

const debugSamples: CombatAimDebugSample[] = [];

// Recording a sample means cloning 5 Vec2s + allocating a sample object per
// fighter shot — real GC pressure at combat scale (dozens of fighters firing
// several times a second) for data almost nobody reads: only the debug
// overlay (toggled off by default) ever consumes `debugSamples`. Callers on
// the hot fire path should check this before building the sample argument at
// all, not just before calling recordCombatAimSample.
let debugCaptureEnabled = false;

/** Toggle whether recordCombatAimSample actually records anything. Call this from the debug-overlay toggle. */
export function setCombatAimDebugCapture(enabled: boolean): void {
  debugCaptureEnabled = enabled;
}

/** Cheap check for hot-path callers to skip building a CombatAimDebugSample entirely when nobody's watching. */
export function isCombatAimDebugCaptureEnabled(): boolean {
  return debugCaptureEnabled;
}

export function isFiniteVec(v: Vec2 | null | undefined): v is Vec2 {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y);
}

export function isHostileTeam(a: Team, b: Team): boolean {
  return a !== Team.Neutral && b !== Team.Neutral && a !== b;
}

export function isCombatTargetValid(shooter: Entity, target: Entity | null | undefined, range: number): target is Entity {
  if (!target || !target.alive || target === shooter) return false;
  if (!isHostileTeam(shooter.team, target.team)) return false;
  // Non-interceptable projectiles (plain bullets, lasers, etc.) cannot be meaningfully
  // targeted or damaged; skip them. Interceptable projectiles (SwarmMissiles, mines)
  // remain valid targets so they can be shot down.
  if (target instanceof ProjectileBase && !target.interceptable) return false;
  if (!isFiniteVec(shooter.position) || !isFiniteVec(target.position)) return false;
  if (!Number.isFinite(range) || range <= 0) return false;
  return shooter.position.distanceTo(target.position) <= range;
}

export function predictiveAim2D(
  shooterPosition: Vec2,
  shooterVelocity: Vec2 | null | undefined,
  targetPosition: Vec2,
  targetVelocity: Vec2 | null | undefined,
  projectileSpeed: number,
  options: PredictiveAimOptions = {},
): PredictiveAimResult {
  const fallback = options.fallback ?? 'shortPrediction';
  const maxPredictionTime = Math.max(0, options.maxPredictionTime ?? DEFAULT_MAX_PREDICTION_TIME);
  if (
    !isFiniteVec(shooterPosition) ||
    !isFiniteVec(targetPosition) ||
    !Number.isFinite(projectileSpeed) ||
    projectileSpeed <= EPSILON
  ) {
    return invalidAim(shooterPosition, targetPosition);
  }

  const sv = isFiniteVec(shooterVelocity) ? shooterVelocity : new Vec2(0, 0);
  const tv = isFiniteVec(targetVelocity) ? targetVelocity : new Vec2(0, 0);
  const relPos = targetPosition.sub(shooterPosition);
  const relVel = tv.sub(sv);
  const a = relVel.dot(relVel) - projectileSpeed * projectileSpeed;
  const b = 2 * relPos.dot(relVel);
  const c = relPos.dot(relPos);
  let interceptTime: number | null = null;

  if (c <= EPSILON) {
    interceptTime = 0;
  } else if (Math.abs(a) <= EPSILON) {
    const t = Math.abs(b) > EPSILON ? -c / b : null;
    if (t !== null && t >= 0) interceptTime = t;
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const sqrtD = Math.sqrt(discriminant);
      const t1 = (-b - sqrtD) / (2 * a);
      const t2 = (-b + sqrtD) / (2 * a);
      const t1Valid = Number.isFinite(t1) && t1 >= 0;
      const t2Valid = Number.isFinite(t2) && t2 >= 0;
      if (t1Valid && t2Valid) interceptTime = Math.min(t1, t2);
      else if (t1Valid) interceptTime = t1;
      else if (t2Valid) interceptTime = t2;
    }
  }

  if (interceptTime !== null && interceptTime <= maxPredictionTime) {
    return aimAtPoint(shooterPosition, targetPosition.add(tv.scale(interceptTime)), interceptTime, false);
  }

  const fallbackTime = fallback === 'shortPrediction'
    ? Math.min(maxPredictionTime, FALLBACK_PREDICTION_TIME)
    : 0;
  return aimAtPoint(shooterPosition, targetPosition.add(tv.scale(fallbackTime)), null, true);
}

export function aimAtEntity(
  shooter: Entity,
  target: Entity,
  projectileSpeed: number,
  options: PredictiveAimOptions = {},
): PredictiveAimResult {
  return predictiveAim2D(
    shooter.position,
    shooter.velocity,
    target.position,
    target.velocity,
    projectileSpeed,
    options,
  );
}

export function aimAngle(result: PredictiveAimResult): number | null {
  if (!result.valid || !isFiniteVec(result.direction)) return null;
  return Math.atan2(result.direction.y, result.direction.x);
}

export function isFacingAim(currentAngle: number, aim: PredictiveAimResult, maxArcRadians: number): boolean {
  const angle = aimAngle(aim);
  if (angle === null || !Number.isFinite(currentAngle) || !Number.isFinite(maxArcRadians)) return false;
  return Math.abs(wrapAngle(angle - currentAngle)) <= maxArcRadians;
}

export function recordCombatAimSample(sample: CombatAimDebugSample): void {
  if (!debugCaptureEnabled) return;
  debugSamples.push(sample);
  if (debugSamples.length > MAX_DEBUG_SAMPLES) debugSamples.splice(0, debugSamples.length - MAX_DEBUG_SAMPLES);
}

export function recentCombatAimSamples(now: number, maxAgeSeconds: number = 2.0): CombatAimDebugSample[] {
  while (debugSamples.length > 0 && now - debugSamples[0].createdAt > maxAgeSeconds) debugSamples.shift();
  return debugSamples;
}

function aimAtPoint(shooterPosition: Vec2, aimPoint: Vec2, interceptTime: number | null, usedFallback: boolean): PredictiveAimResult {
  const toAim = aimPoint.sub(shooterPosition);
  const distance = toAim.length();
  if (!Number.isFinite(distance) || distance <= EPSILON) return invalidAim(shooterPosition, aimPoint);
  const direction = toAim.scale(1 / distance);
  if (!isFiniteVec(direction)) return invalidAim(shooterPosition, aimPoint);
  return { aimPoint, direction, interceptTime, valid: true, usedFallback };
}

function invalidAim(shooterPosition: Vec2, targetPosition: Vec2): PredictiveAimResult {
  const safeShooter = isFiniteVec(shooterPosition) ? shooterPosition.clone() : new Vec2(0, 0);
  const safeTarget = isFiniteVec(targetPosition) ? targetPosition.clone() : safeShooter.clone();
  return {
    aimPoint: safeTarget,
    direction: new Vec2(0, 0),
    interceptTime: null,
    valid: false,
    usedFallback: true,
  };
}
