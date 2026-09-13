/**
 * Visuals for the Bright Matter network (see src/bright.ts).
 *
 * Draws a single smooth, glowing line connecting every Particle Accelerator
 * that is directly linked to the Command Post, plus fast glowing particles
 * with long trails traveling along that line — a visible, literal read of
 * "exotic matter flowing in from the accelerators."
 */

import { Vec2 } from './math.js';
import { Camera } from './camera.js';
import { Colors, colorToCSS } from './colors.js';
import { Team } from './entities.js';
import type { GameState } from './gamestate.js';

/** Catmull-Rom spline through `points`, `segmentsPerSpan` subdivisions between each pair. */
function smoothPath(points: Vec2[], segmentsPerSpan: number = 10): Vec2[] {
  if (points.length < 2) return points.slice();
  const out: Vec2[] = [];
  const get = (i: number): Vec2 => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let s = 0; s < segmentsPerSpan; s++) {
      const t = s / segmentsPerSpan;
      const t2 = t * t, t3 = t2 * t;
      const x = 0.5 * (
        2 * p1.x + (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      );
      const y = 0.5 * (
        2 * p1.y + (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      );
      out.push(new Vec2(x, y));
    }
  }
  out.push(points[points.length - 1].clone());
  return out;
}

function pathLengthOf(points: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += points[i].distanceTo(points[i - 1]);
  return len;
}

/** Point at fractional arc-length `frac` (0..1) along `points`, by cumulative distance. */
function pointAtFrac(points: Vec2[], cumLen: number[], totalLen: number, frac: number): Vec2 {
  if (totalLen <= 0 || points.length === 0) return points[0] ?? new Vec2(0, 0);
  const target = ((frac % 1) + 1) % 1 * totalLen;
  let lo = 0, hi = cumLen.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumLen[mid] < target) lo = mid + 1; else hi = mid;
  }
  const i = Math.max(1, lo);
  const segLen = cumLen[i] - cumLen[i - 1];
  const t = segLen > 0 ? (target - cumLen[i - 1]) / segLen : 0;
  const a = points[i - 1], b = points[i];
  return new Vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
}

const PARTICLES_PER_LINK = 3;
const PARTICLE_SPEED_WORLD_PER_SEC = 90;
const TRAIL_SAMPLES = 10;
const TRAIL_SPACING_FRAC = 0.012;

export function drawBrightPaths(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  state: GameState,
  time: number,
): void {
  const snapshot = state.bright.current();
  for (const [team, links] of snapshot.linksByTeam) {
    if (links.length === 0) continue;
    const color = team === Team.Player ? Colors.bright_matter : { r: 255, g: 150, b: 220, intensity: 1.0 };

    for (const link of links) {
      if (link.path.length < 2) continue;
      const smooth = smoothPath(link.path);
      const cum: number[] = [0];
      for (let i = 1; i < smooth.length; i++) cum.push(cum[i - 1] + smooth[i].distanceTo(smooth[i - 1]));
      const totalLen = cum[cum.length - 1];
      if (totalLen <= 0) continue;

      // Smooth glowing line.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < smooth.length; i++) {
        const s = camera.worldToScreen(smooth[i]);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      }
      ctx.strokeStyle = colorToCSS(color, 0.10);
      ctx.lineWidth = 6 * camera.zoom;
      ctx.stroke();
      ctx.strokeStyle = colorToCSS(color, 0.55);
      ctx.lineWidth = 2 * camera.zoom;
      ctx.stroke();
      ctx.restore();

      // Traveling glowing particles with fading trails.
      const speedFrac = PARTICLE_SPEED_WORLD_PER_SEC / totalLen;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let p = 0; p < PARTICLES_PER_LINK; p++) {
        const headFrac = time * speedFrac + p / PARTICLES_PER_LINK;
        for (let tIdx = 0; tIdx < TRAIL_SAMPLES; tIdx++) {
          const frac = headFrac - tIdx * TRAIL_SPACING_FRAC;
          const worldPos = pointAtFrac(smooth, cum, totalLen, frac);
          const screenPos = camera.worldToScreen(worldPos);
          const trailT = 1 - tIdx / TRAIL_SAMPLES;
          const alpha = 0.6 * trailT * trailT;
          const r = (tIdx === 0 ? 3.2 : 1.6 * trailT + 0.4) * camera.zoom;
          ctx.fillStyle = colorToCSS(color, alpha);
          ctx.beginPath();
          ctx.arc(screenPos.x, screenPos.y, Math.max(0.5, r), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }
}
