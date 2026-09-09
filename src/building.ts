/** Building types for Sign99 */

import { Vec2 } from './math.js';
import { Camera } from './camera.js';
import { Entity, EntityType, ShipGroup, Team } from './entities.js';
import { Colors, colorToCSS, type Color } from './colors.js';
import {
  ENTITY_RADIUS,
  COMMANDPOST_BUILD_RADIUS,
  POWERGENERATOR_COVERAGE_RADIUS,
  HP_VALUES,
} from './constants.js';
import { GRID_CELL_SIZE } from './grid.js';
import { footprintForBuilding } from './buildingfootprint.js';
import { teamColor } from './teamutils.js';
import { getDistantSunScreenPosition } from './suns.js';
import { Input } from './input.js';
import { getCinematicLevel } from './cinematic.js';
import { isLegacyGraphics } from './graphicsmode.js';
import { researchCategory, researchIcon } from './research.js';
import { renderProjectileTrail, type TrailSample, type ProjectileTrailStyle } from './projectileTrail.js';
import { renderBuildingCoreEffect } from './buildingCoreEffect.js';

interface BaseVisual {
  side: number;
  half: number;
  simple: boolean;
  powerAlpha: number;
}

const SHIP_GROUP_LABEL_COLORS: Record<ShipGroup, Color> = {
  [ShipGroup.Red]: { r: 233, g: 51, b: 77, intensity: 1 },
  [ShipGroup.Green]: { r: 51, g: 192, b: 104, intensity: 1 },
  [ShipGroup.Blue]: { r: 51, g: 77, b: 192, intensity: 1 },
};

export abstract class BuildingBase extends Entity {
  powered = false;
  buildProgress = 1;
  buildDurationSeconds = 0;
  /** Instance override used by 3x3 Research Nodes sharing the lab entity type. */
  footprintCells: number | null = null;
  /** Exact amount paid when this construction was placed (for full cancellation refunds). */
  placementCost: number | null = null;
  deletionProgress = 0;
  deletionDurationSeconds = 3;
  deleting = false;
  synonymousVisualKind: 'base' | 'factory' | 'researchlab' | 'laserturret' | 'minelayer' | 'shipyard' | null = null;
  animationTime = 0;
  /**
   * Set to `true` by `update()` the moment `buildProgress` first reaches 1.
   * Cleared externally (e.g. by game.ts) after the completion effect is emitted
   * so the effect fires exactly once per construction event.
   */
  completionEffectPending = false;

  constructor(type: EntityType, team: Team, position: Vec2, health: number, radius: number = ENTITY_RADIUS.building) {
    super(type, team, position, health, radius);
    this.velocity.set(0, 0);
  }
  update(dt: number): void {
    if (!this.alive) return;
    this.animationTime += dt;
    // Construction consumes power just like a completed building's active
    // behavior. Power sources and walls are self-powered by PowerGraph, while
    // Synonymous structures are marked powered by their faction rules.
    // Therefore an ordinary Terran structure pauses here whenever its conduit
    // connection is interrupted, and resumes from the same progress later.
    if (this.buildProgress < 1 && this.powered) {
      this.buildProgress = this.buildDurationSeconds <= 0 ? 1 : Math.min(1, this.buildProgress + dt / this.buildDurationSeconds);
      if (this.buildProgress >= 1) {
        this.completionEffectPending = true;
      }
    }
    if (this.deleting) this.deletionProgress = Math.min(1, this.deletionProgress + dt / this.deletionDurationSeconds);
  }
  startDeleting(): void { if (!this.deleting) { this.deleting = true; this.deletionProgress = 0; } }

  protected getBaseVisual(camera: Camera): BaseVisual {
    const side = footprintForBuilding(this) * GRID_CELL_SIZE * camera.zoom;
    return { side, half: side * 0.5, simple: side < 22, powerAlpha: this.powered ? 1 : 0.3 };
  }

  protected drawBuildingBase(ctx: CanvasRenderingContext2D, screen: Vec2, detailColor: string, camera: Camera): BaseVisual {
    const v = this.getBaseVisual(camera);
    if (this.synonymousVisualKind) {
      this.drawSynonymousBuildingBase(ctx, screen, camera, v);
      return v;
    }
    const x = screen.x - v.half;
    const y = screen.y - v.half;
    ctx.save();
    ctx.globalAlpha = Math.max(0.15, this.buildProgress);
    const damage = 1 - Math.max(0, Math.min(1, this.healthFraction));
    this.drawCinematicBuildingFill(ctx, x, y, v.side, camera, damage);
    // Legacy-only: yellow sun-edge glare bands on the two sun-facing sides.
    if (isLegacyGraphics()) this.drawSunEdgeGlare(ctx, x, y, v.side, v.simple, camera);
    if (damage > 0.02) this.drawDamageWear(ctx, x, y, v.side, damage);
    this.drawDimPanelLines(ctx, x, y, v.side);
    const legacyCore = isLegacyGraphics();
    // Corner nodes. Legacy: small footprint-relative squares. New look: each node
    // is exactly one conduit cell regardless of building size, and doubles as the
    // mask for the fiery core effect below.
    const c = legacyCore
      ? v.side * 0.12
      : Math.min(v.side * 0.45, GRID_CELL_SIZE * camera.zoom);
    ctx.fillStyle = colorToCSS(Colors.menu_background_detail, 0.45);
    ctx.fillRect(x, y, c, c); ctx.fillRect(x + v.side - c, y, c, c); ctx.fillRect(x, y + v.side - c, c, c); ctx.fillRect(x + v.side - c, y + v.side - c, c, c);
    if (!legacyCore) {
      // Thin connecting lines between the corner nodes (kept even at 0% so the
      // building still reads like its base art), then the core effect masked to
      // nodes + lines, scaled by HP fraction and gated on power / construction.
      const gap = v.side - 2 * c;
      if (gap > 0) {
        const bw = Math.max(1, c * 0.4);
        ctx.fillStyle = colorToCSS(Colors.menu_background_detail, 0.3);
        ctx.fillRect(x + c, y, gap, bw);
        ctx.fillRect(x + c, y + v.side - bw, gap, bw);
        ctx.fillRect(x, y + c, bw, gap);
        ctx.fillRect(x + v.side - bw, y + c, bw, gap);
      }
      const intensity = this.powered && this.buildProgress >= 1 && !this.deleting
        ? Math.max(0, Math.min(1, this.healthFraction))
        : 0;
      if (intensity > 0.001) {
        renderBuildingCoreEffect(ctx, {
          x, y, side: v.side, nodeSize: c, intensity,
          timeSec: this.animationTime, seed: this.id,
          glow: true,
        });
      }
    }
    // Legacy-only: the centre cross/plus that split the building into quadrants.
    if (!v.simple && isLegacyGraphics()) {
      ctx.strokeStyle = colorToCSS(Colors.advanced_building, 0.45 * v.powerAlpha);
      ctx.beginPath();
      ctx.moveTo(screen.x, y + v.side * 0.15); ctx.lineTo(screen.x, y + v.side * 0.85);
      ctx.moveTo(x + v.side * 0.15, screen.y); ctx.lineTo(x + v.side * 0.85, screen.y);
      ctx.stroke();
    }
    this.drawSquareHealthFrame(ctx, x, y, v.side);
    // Legacy-only: the bright top/left "power strip" tabs. The new look conveys
    // power state through overall dimming + drawUnpoweredWarning instead.
    if (isLegacyGraphics()) this.drawPowerStrip(ctx, x, y, v.side);
    this.drawUnpoweredWarning(ctx, x, y, v.side);
    if (this.powered && this.buildProgress >= 1 && !v.simple) this.drawPoweredScanLine(ctx, x, y, v.side);
    if (getCinematicLevel() >= 2 && this.buildProgress >= 1) this.drawCinematicBloom(ctx, x, y, v.side, camera);
    if (this.buildProgress < 1 && !this.synonymousVisualKind) this.drawConstructionOverlay(ctx, x, y, v.side);
    if (this.deleting) this.drawDeletionOverlay(ctx, x, y, v.side);
    ctx.restore();
    return v;
  }

  private drawCinematicBuildingFill(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, camera: Camera, damage: number): void {
    const sun = getDistantSunScreenPosition(camera, ctx.canvas.width, ctx.canvas.height);
    const cx = x + s * 0.5;
    const cy = y + s * 0.5;
    const toSunX = sun.x - cx;
    const toSunY = sun.y - cy;
    const dist = Math.max(1, Math.hypot(toSunX, toSunY));
    const lx = toSunX / dist;
    const ly = toSunY / dist;
    const shade = Math.max(0.55, 1 - damage * 0.24);
    const grad = ctx.createLinearGradient(
      cx + lx * s * 0.72,
      cy + ly * s * 0.72,
      cx - lx * s * 0.78,
      cy - ly * s * 0.78,
    );
    grad.addColorStop(0, `rgba(126, 78, 37, ${(0.98 * shade).toFixed(3)})`);
    grad.addColorStop(0.22, `rgba(83, 91, 70, ${(0.96 * shade).toFixed(3)})`);
    grad.addColorStop(0.62, `rgba(34, 48, 45, ${(0.96 * shade).toFixed(3)})`);
    grad.addColorStop(1, `rgba(12, 18, 22, ${(0.98 * shade).toFixed(3)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, s, s);

    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    const shadow = ctx.createLinearGradient(
      cx - lx * s * 0.34,
      cy - ly * s * 0.34,
      cx + lx * s * 0.62,
      cy + ly * s * 0.62,
    );
    shadow.addColorStop(0, 'rgba(0, 2, 5, 0.38)');
    shadow.addColorStop(0.72, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shadow;
    ctx.fillRect(x, y, s, s);
    ctx.restore();
  }

  private drawSunEdgeGlare(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, simple: boolean, camera: Camera): void {
    const band = Math.max(3, s * (simple ? 0.28 : 0.22));
    const sun = getDistantSunScreenPosition(camera, ctx.canvas.width, ctx.canvas.height);
    const cx = x + s * 0.5;
    const cy = y + s * 0.5;
    const toSunX = sun.x - cx;
    const toSunY = sun.y - cy;
    const dist = Math.max(1, Math.hypot(toSunX, toSunY));
    const lx = toSunX / dist;
    const ly = toSunY / dist;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const sides = [
      { nx: 0, ny: -1, x: x, y: y, w: s, h: band, gx0: x, gy0: y, gx1: x, gy1: y + band, line: [x + 1, y + 0.5, x + s - 1, y + 0.5] },
      { nx: 1, ny: 0, x: x + s - band, y: y, w: band, h: s, gx0: x + s, gy0: y, gx1: x + s - band, gy1: y, line: [x + s - 0.5, y + 1, x + s - 0.5, y + s - 1] },
      { nx: 0, ny: 1, x: x, y: y + s - band, w: s, h: band, gx0: x, gy0: y + s, gx1: x, gy1: y + s - band, line: [x + s - 1, y + s - 0.5, x + 1, y + s - 0.5] },
      { nx: -1, ny: 0, x: x, y: y, w: band, h: s, gx0: x, gy0: y, gx1: x + band, gy1: y, line: [x + 0.5, y + s - 1, x + 0.5, y + 1] },
    ] as const;

    for (const side of sides) {
      const facing = side.nx * lx + side.ny * ly;
      if (facing <= 0.02) continue;
      const alpha = Math.min(1, 0.30 + facing * 0.92);
      const grad = ctx.createLinearGradient(side.gx0, side.gy0, side.gx1, side.gy1);
      grad.addColorStop(0, `rgba(255, 249, 190, ${(alpha * 0.86).toFixed(3)})`);
      grad.addColorStop(0.18, `rgba(255, 178, 54, ${(alpha * 0.86).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(177, 45, 11, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(side.x, side.y, side.w, side.h);
    }

    ctx.strokeStyle = 'rgba(255, 237, 152, 0.98)';
    ctx.lineWidth = Math.max(1.2, s * 0.026);
    ctx.shadowColor = 'rgba(255, 151, 40, 0.8)';
    ctx.shadowBlur = Math.max(3, s * 0.07);
    ctx.beginPath();
    for (const side of sides) {
      const facing = side.nx * lx + side.ny * ly;
      if (facing <= 0.18) continue;
      const line = side.line;
      ctx.moveTo(line[0], line[1]);
      ctx.lineTo(line[2], line[3]);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawDimPanelLines(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
    ctx.save();
    ctx.strokeStyle = colorToCSS(Colors.enemy_background, 0.38);
    ctx.lineWidth = Math.max(1, s * 0.01);
    ctx.strokeRect(x + s * 0.12, y + s * 0.12, s * 0.76, s * 0.76);

    ctx.strokeStyle = 'rgba(8, 13, 14, 0.55)';
    ctx.lineWidth = Math.max(1, s * 0.012);
    ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
    ctx.restore();
  }

  protected drawDamageWear(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, damage: number): void {
    const cracks = Math.min(9, Math.max(2, Math.ceil(damage * 10)));
    ctx.save();
    ctx.strokeStyle = colorToCSS(Colors.enemy_background, 0.22 + damage * 0.45);
    ctx.lineWidth = Math.max(1, s * 0.012);
    ctx.beginPath();
    for (let i = 0; i < cracks; i++) {
      const seed = (this.id * 31 + i * 17) % 97;
      const px = x + s * (0.16 + ((seed * 37) % 68) / 100);
      const py = y + s * (0.16 + ((seed * 53) % 68) / 100);
      const len = s * (0.07 + damage * 0.12);
      const a = seed * 0.41;
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len);
      if (damage > 0.45) {
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(a + 1.8) * len * 0.55, py + Math.sin(a + 1.8) * len * 0.55);
      }
    }
    ctx.stroke();
    ctx.fillStyle = colorToCSS(Colors.alert1, damage * 0.18);
    ctx.fillRect(x, y, s, s);
    ctx.restore();
  }

  private drawSynonymousBuildingBase(ctx: CanvasRenderingContext2D, screen: Vec2, camera: Camera, v: BaseVisual): void {
    const sides = this.synonymousVisualKind === 'base' ? 6 : this.synonymousVisualKind === 'factory' ? 8 : this.synonymousVisualKind === 'researchlab' ? 5 : 3;
    const r = v.half * (this.synonymousVisualKind === 'base' ? 1.08 : 0.88);
    const color = teamColor(this.team);
    ctx.save();
    const integrityAlpha = 0.32 + 0.48 * this.healthFraction;
    ctx.globalAlpha = Math.max(0.15, this.buildProgress * integrityAlpha);
    ctx.fillStyle = this.synonymousVisualKind === 'base' ? 'rgba(7,10,12,0.96)' : 'rgba(14,17,18,0.46)';
    ctx.strokeStyle = colorToCSS(color, 0.35 + 0.43 * this.healthFraction);
    ctx.lineWidth = Math.max(1, v.side * 0.025);
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = -Math.PI / 2 + (Math.PI * 2 * i) / sides;
      const x = screen.x + Math.cos(a) * r;
      const y = screen.y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = colorToCSS(color, 0.42);
    ctx.lineWidth = Math.max(1, v.side * 0.012);
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = -Math.PI / 2 + (Math.PI * 2 * i) / sides;
      const x = screen.x + Math.cos(a) * r * 0.78;
      const y = screen.y + Math.sin(a) * r * 0.78;
      ctx.moveTo(screen.x, screen.y);
      ctx.lineTo(x, y);
      const b = a + Math.PI * 2 / sides;
      ctx.moveTo(x, y);
      ctx.lineTo(screen.x + Math.cos(b) * r * 0.58, screen.y + Math.sin(b) * r * 0.58);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    const x = screen.x - v.half;
    const y = screen.y - v.half;
    this.drawSquareHealthFrame(ctx, x, y, v.side);
    if (this.deleting) this.drawDeletionOverlay(ctx, x, y, v.side);
    ctx.restore();
  }

  private drawSquareHealthFrame(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
    const p = Math.max(0, Math.min(1, this.healthFraction));
    const per = s * 4;
    const len = per * p;
    ctx.strokeStyle = colorToCSS(Colors.healthbar, 0.9);
    ctx.lineWidth = Math.max(1.5, s * 0.03);
    ctx.beginPath();
    const seg = (from: number, to: number, sx: number, sy: number, ex: number, ey: number) => {
      if (len <= from) return; const t = Math.min(1, (len - from) / (to - from)); ctx.moveTo(sx, sy); ctx.lineTo(sx + (ex - sx) * t, sy + (ey - sy) * t);
    };
    seg(0, s, x, y, x + s, y); seg(s, s * 2, x + s, y, x + s, y + s); seg(s * 2, s * 3, x + s, y + s, x, y + s); seg(s * 3, s * 4, x, y + s, x, y);
    ctx.stroke();
  }
  private drawPowerStrip(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
    const col = this.powered ? Colors.powergenerator_detail : Colors.alert1;
    const a = this.powered ? 0.85 : 0.35;
    const w = Math.max(2, s * 0.06);
    ctx.fillStyle = colorToCSS(col, a);
    ctx.fillRect(x + s * 0.06, y + s * 0.44, w, s * 0.12);
    ctx.fillRect(x + s * 0.44, y + s * 0.06, s * 0.12, w);
  }

  private drawCinematicBloom(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, camera: Camera): void {
    const sun = getDistantSunScreenPosition(camera, ctx.canvas.width, ctx.canvas.height);
    const cx = x + s * 0.5;
    const cy = y + s * 0.5;
    const dx = sun.x - cx;
    const dy = sun.y - cy;
    const d = Math.max(1, Math.hypot(dx, dy));
    const lx = dx / d;
    const ly = dy / d;
    const pulse = 0.55 + 0.45 * Math.sin(this.animationTime * 1.8 + this.position.x * 0.004);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = 'rgba(227,138,74,0.42)';
    ctx.shadowBlur = Math.max(5, s * 0.11);
    ctx.strokeStyle = `rgba(227,138,74,${(0.18 + pulse * 0.16).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, s * 0.018);
    ctx.strokeRect(x - s * 0.035, y - s * 0.035, s * 1.07, s * 1.07);

    const glint = ctx.createLinearGradient(cx + lx * s * 0.65, cy + ly * s * 0.65, cx - lx * s * 0.35, cy - ly * s * 0.35);
    glint.addColorStop(0, `rgba(227,138,74,${(0.16 + pulse * 0.08).toFixed(3)})`);
    glint.addColorStop(0.22, `rgba(198,90,46,${(0.08 + pulse * 0.05).toFixed(3)})`);
    glint.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glint;
    ctx.fillRect(x, y, s, s);

    // Level 3: animated holographic scan line sweeps across the building face.
    if (getCinematicLevel() >= 3) {
      const scanT   = (this.animationTime * 0.40 + this.id * 0.29) % 1;
      const scanY   = y + scanT * s;
      const lineH   = Math.max(1, s * 0.045);
      const scanA   = 0.22 * Math.sin(scanT * Math.PI);  // fade at edges of sweep
      const scanGrad = ctx.createLinearGradient(x, scanY, x + s, scanY);
      scanGrad.addColorStop(0.00, `rgba(180,220,255,0)`);
      scanGrad.addColorStop(0.18, `rgba(180,220,255,${scanA.toFixed(3)})`);
      scanGrad.addColorStop(0.50, `rgba(210,240,255,${(scanA * 1.35).toFixed(3)})`);
      scanGrad.addColorStop(0.82, `rgba(180,220,255,${scanA.toFixed(3)})`);
      scanGrad.addColorStop(1.00, `rgba(180,220,255,0)`);
      ctx.fillStyle = scanGrad;
      ctx.fillRect(x, scanY, s, lineH);
    }

    // Level 4: second scan line sweeps upward (counter-phase), creating a
    // bi-directional sweep unique to this level.  Also adds a brief amber
    // energy pulse that travels along the building border when the two lines
    // are close to crossing.
    if (getCinematicLevel() >= 4) {
      // Counter-direction sweep — starts at a 0.5 phase offset.
      const scanT2  = (this.animationTime * 0.40 + this.id * 0.29 + 0.5) % 1;
      const scanY2  = y + (1 - scanT2) * s;   // travels bottom-to-top
      const lineH2  = Math.max(1, s * 0.035);
      const scanA2  = 0.18 * Math.sin(scanT2 * Math.PI);
      const scanGrad2 = ctx.createLinearGradient(x, scanY2, x + s, scanY2);
      scanGrad2.addColorStop(0.00, `rgba(255,200,100,0)`);
      scanGrad2.addColorStop(0.22, `rgba(255,200,100,${scanA2.toFixed(3)})`);
      scanGrad2.addColorStop(0.50, `rgba(255,220,140,${(scanA2 * 1.30).toFixed(3)})`);
      scanGrad2.addColorStop(0.78, `rgba(255,200,100,${scanA2.toFixed(3)})`);
      scanGrad2.addColorStop(1.00, `rgba(255,200,100,0)`);
      ctx.fillStyle = scanGrad2;
      ctx.fillRect(x, scanY2, s, lineH2);

      // Energy border flash: when the two scan lines are within 20% of crossing,
      // an amber glow traces the building outline — a new effect type not in level 3.
      const scanT1  = (this.animationTime * 0.40 + this.id * 0.29) % 1;
      const proximity = 1 - Math.abs(scanT1 - (1 - scanT2));
      if (proximity > 0.80) {
        const flashA = (proximity - 0.80) / 0.20 * 0.30;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(255,190,60,${flashA.toFixed(3)})`;
        ctx.lineWidth = Math.max(1, s * 0.025);
        ctx.strokeRect(x, y, s, s);
        ctx.restore();
      }
    }

    // Level 5: corner beacon tracers that orbit the frame.
    if (getCinematicLevel() >= 5) {
      const orbit = (this.animationTime * 0.26 + this.id * 0.17) % 1;
      const corners = [
        { cx: x, cy: y },
        { cx: x + s, cy: y },
        { cx: x + s, cy: y + s },
        { cx: x, cy: y + s },
      ];
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < corners.length; i++) {
        const phase = (orbit + i * 0.25) % 1;
        const edge = Math.floor(phase * 4);
        const t = (phase * 4) % 1;
        const a = corners[edge];
        const b = corners[(edge + 1) % 4];
        const px = a.cx + (b.cx - a.cx) * t;
        const py = a.cy + (b.cy - a.cy) * t;
        const beaconA = 0.14 + 0.10 * Math.sin(this.animationTime * 2.2 + i * 1.5);
        ctx.fillStyle = `rgba(190,232,255,${beaconA.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.9, s * 0.016), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.restore();
  }
  private drawUnpoweredWarning(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
    if (this.powered || this.buildProgress < 1 || this.deleting) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.animationTime * 5.8 + this.id * 0.7);
    const alpha = 0.20 + pulse * 0.22;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = colorToCSS(Colors.alert2, alpha);
    ctx.lineWidth = Math.max(2, s * 0.035);
    ctx.strokeRect(x - 3, y - 3, s + 6, s + 6);
    ctx.strokeStyle = colorToCSS(Colors.particles_spark, alpha * 0.55);
    ctx.lineWidth = Math.max(1, s * 0.015);
    ctx.strokeRect(x - 7, y - 7, s + 14, s + 14);

    const sparkGate = (this.animationTime * 1.55 + this.id * 0.37) % 1;
    if (sparkGate < 0.18) {
      const sparkAlpha = (1 - sparkGate / 0.18) * 0.78;
      const sparkCount = s > 34 ? 3 : 2;
      ctx.strokeStyle = colorToCSS(Colors.particles_spark, sparkAlpha);
      ctx.lineWidth = Math.max(1.2, s * 0.018);
      ctx.beginPath();
      for (let i = 0; i < sparkCount; i++) {
        const seed = this.id * 13 + i * 29;
        const edge = seed % 4;
        const t = ((seed * 37) % 100) / 100;
        const sx = edge === 0 ? x + s * t : edge === 1 ? x + s : edge === 2 ? x + s * (1 - t) : x;
        const sy = edge === 0 ? y : edge === 1 ? y + s * t : edge === 2 ? y + s : y + s * (1 - t);
        const len = s * (0.08 + (((seed * 17) % 40) / 1000));
        const a = this.animationTime * 9 + seed;
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + Math.cos(a) * len, sy + Math.sin(a) * len);
        ctx.moveTo(sx + Math.cos(a + 1.9) * len * 0.35, sy + Math.sin(a + 1.9) * len * 0.35);
        ctx.lineTo(sx + Math.cos(a - 0.8) * len * 0.7, sy + Math.sin(a - 0.8) * len * 0.7);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  protected drawConstructionOverlay(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
    const progress = Math.max(0, Math.min(1, this.buildProgress));
    const points = [
      { x: x + s * 0.5, y },
      { x: x + s, y },
      { x: x + s, y: y + s },
      { x, y: y + s },
      { x, y },
      { x: x + s * 0.5, y },
    ];

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.42);
    ctx.lineWidth = Math.max(1.2, s * 0.025);
    ctx.strokeRect(x, y, s, s);

    let remaining = progress * s * 4;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length && remaining > 0; i++) {
      const from = points[i - 1];
      const to = points[i];
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      const drawn = Math.min(length, remaining);
      const ratio = length > 0 ? drawn / length : 0;
      ctx.lineTo(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio);
      remaining -= drawn;
    }
    ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, this.powered ? 0.95 : 0.62);
    ctx.lineWidth = Math.max(2, s * 0.045);
    ctx.stroke();
    ctx.restore();
  }
  private drawDeletionOverlay(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
    const t = this.deletionProgress;
    ctx.setLineDash([6, 4]); ctx.strokeStyle = colorToCSS(Colors.alert2, 0.85); ctx.strokeRect(x - 2, y - 2, s + 4, s + 4); ctx.setLineDash([]);
    ctx.strokeStyle = colorToCSS(Colors.alert1, 0.9); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + s * t, y); ctx.stroke();
  }
  /** Subtle vertical scan-line that sweeps through a powered building on a ~4 s cycle. */
  private drawPoweredScanLine(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
    const CYCLE = 4.0;
    const phase = (this.animationTime % CYCLE) / CYCLE;       // 0 → 1
    const sy = y + s * (1 - phase);                           // sweeps bottom-to-top
    const h = Math.max(2, s * 0.08);
    const a = Math.sin(phase * Math.PI) * 0.09;               // fade in/out at edges
    if (a < 0.005) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.createLinearGradient(x, sy, x, sy + h);
    grad.addColorStop(0, `rgba(255,255,255,0)`);
    grad.addColorStop(0.5, `rgba(255,255,255,${a.toFixed(3)})`);
    grad.addColorStop(1, `rgba(255,255,255,0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x, sy, s, h);
    ctx.restore();
  }
}

export class CommandPost extends BuildingBase {
  readonly buildRadius = COMMANDPOST_BUILD_RADIUS;
  constructor(position: Vec2, team: Team) {
    super(EntityType.CommandPost, team, position, HP_VALUES.commandPost, ENTITY_RADIUS.commandpost);
    this.powered = true;
  }
  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const screen = camera.worldToScreen(this.position);
    const v = this.drawBuildingBase(ctx, screen, colorToCSS(Colors.general_building), camera);
    if (v.simple) return;
    const x = screen.x - v.half;
    const y = screen.y - v.half;
    if (isLegacyGraphics()) {
      // Legacy-only cross antenna.
      const pulse = 0.45 + 0.18 * Math.sin(this.animationTime * 2.4);
      ctx.strokeStyle = colorToCSS(Colors.friendly_status, 0.55 + pulse * 0.25);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(screen.x, y + v.side * 0.18); ctx.lineTo(screen.x, y + v.side * 0.82);
      ctx.moveTo(x + v.side * 0.18, screen.y); ctx.lineTo(x + v.side * 0.82, screen.y);
      ctx.stroke();
    }
    ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.22);
    ctx.strokeRect(x + v.side * 0.27, y + v.side * 0.27, v.side * 0.46, v.side * 0.46);
  }
}

export class PowerGenerator extends BuildingBase {
  readonly coverageRadius = POWERGENERATOR_COVERAGE_RADIUS;
  private pulsePhase = 0;
  constructor(position: Vec2, team: Team) {
    super(EntityType.PowerGenerator, team, position, HP_VALUES.powerGenerator);
    this.powered = true;
  }
  update(dt: number): void { super.update(dt); this.pulsePhase += dt * 3; }
  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const screen = camera.worldToScreen(this.position);
    const v = this.drawBuildingBase(ctx, screen, colorToCSS(Colors.powergenerator_detail), camera);
    if (v.simple) return;
    const glowColor = Colors.building_glow_power;
    const pulseA = 0.9 + 0.1 * Math.sin(this.pulsePhase);
    const coreR = v.side * 0.16 * pulseA;
    // Circular glowing orb core
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = colorToCSS(glowColor, this.powered ? 0.55 * v.powerAlpha : 0.15);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, coreR, 0, Math.PI * 2);
    ctx.fill();
    // Energy spokes — 6 radiating arms
    const spokeCount = 6;
    const spokeLen = v.side * 0.26;
    ctx.strokeStyle = colorToCSS(glowColor, this.powered ? 0.38 * v.powerAlpha : 0.10);
    ctx.lineWidth = Math.max(1, v.side * 0.022);
    ctx.beginPath();
    for (let i = 0; i < spokeCount; i++) {
      const a = this.pulsePhase * 0.4 + (Math.PI * 2 * i) / spokeCount;
      const inner = coreR * 0.9;
      const outer = inner + spokeLen * (0.8 + 0.2 * Math.sin(this.pulsePhase * 1.3 + i));
      ctx.moveTo(screen.x + Math.cos(a) * inner, screen.y + Math.sin(a) * inner);
      ctx.lineTo(screen.x + Math.cos(a) * outer, screen.y + Math.sin(a) * outer);
    }
    ctx.stroke();
    ctx.restore();
    // Outer coverage ring (subtle)
    ctx.strokeStyle = colorToCSS(Colors.powergenerator_coverage, 0.15);
    ctx.lineWidth = 1;
    ctx.strokeRect(screen.x - v.half - 2, screen.y - v.half - 2, v.side + 4, v.side + 4);
  }
}

export class Wall extends BuildingBase { shield=0; maxShield=0; private shieldRegenDelay=0; poweredWallUpgrade=false; constructor(position: Vec2, team: Team){ super(EntityType.Wall, team, position, HP_VALUES.wall); this.powered=true; } enablePoweredWall():void{this.poweredWallUpgrade=true;this.maxShield=20;this.shield=this.maxShield;this.shieldRegenDelay=0;} override update(dt:number):void{super.update(dt); if(this.poweredWallUpgrade&&this.alive){this.shieldRegenDelay=Math.max(0,this.shieldRegenDelay-dt); if(this.shieldRegenDelay<=0&&this.shield<this.maxShield)this.shield=Math.min(this.maxShield,this.shield+5*dt);}} override takeDamage(amount:number,source?:Entity):void{if(amount>0&&this.poweredWallUpgrade&&this.shield>0){this.shieldRegenDelay=5;const absorbed=Math.min(this.shield,amount);this.shield-=absorbed;amount-=absorbed;if(amount<=0)return;}super.takeDamage(amount,source);} draw(ctx:CanvasRenderingContext2D,camera:Camera):void{ const screen=camera.worldToScreen(this.position); const v=this.drawBuildingBase(ctx,screen,colorToCSS(Colors.advanced_building),camera); const x=screen.x-v.half,y=screen.y-v.half; const pulse=0.55+0.35*Math.sin(this.animationTime*4); ctx.save(); if(this.poweredWallUpgrade){ctx.globalCompositeOperation='lighter';ctx.strokeStyle=colorToCSS(Colors.radar_friendly_status,0.22+0.28*(this.shield/Math.max(1,this.maxShield)));ctx.lineWidth=Math.max(2,v.side*0.06);ctx.strokeRect(x+2,y+2,v.side-4,v.side-4);} ctx.globalCompositeOperation='source-over'; ctx.strokeStyle=colorToCSS(Colors.powergenerator_detail,0.68+0.22*pulse); ctx.lineWidth=Math.max(2,v.side*0.05); ctx.beginPath(); ctx.moveTo(x+v.side*0.15,y+v.side*0.5); ctx.lineTo(x+v.side*0.85,y+v.side*0.5); ctx.moveTo(x+v.side*0.5,y+v.side*0.15); ctx.lineTo(x+v.side*0.5,y+v.side*0.85); ctx.stroke(); ctx.restore(); }}

export class ShieldGenerator extends BuildingBase {
  static readonly FIELD_CELLS = 9;
  readonly maxShield = 90;
  shield = this.maxShield;
  restartDelay = 0;

  constructor(position: Vec2, team: Team) {
    super(EntityType.ShieldGenerator, team, position, HP_VALUES.shieldGenerator);
  }

  get fieldActive(): boolean {
    return this.alive && this.powered && this.buildProgress >= 1 && this.shield > 0;
  }

  contains(pos: Vec2): boolean {
    const half = ShieldGenerator.FIELD_CELLS * GRID_CELL_SIZE * 0.5;
    return Math.abs(pos.x - this.position.x) <= half && Math.abs(pos.y - this.position.y) <= half;
  }

  absorbDamage(amount: number, source?: Entity): number {
    if (!this.fieldActive || amount <= 0) return amount;
    const absorbed = Math.min(this.shield, amount);
    this.shield -= absorbed;
    if (source) this.lastDamageSource = source;
    if (this.shield <= 0) {
      this.shield = 0;
      this.restartDelay = 5;
    }
    return amount - absorbed;
  }

  override update(dt: number): void {
    super.update(dt);
    if (!this.alive || !this.powered || this.buildProgress < 1 || this.shield >= this.maxShield) return;
    if (this.shield <= 0 && this.restartDelay > 0) {
      this.restartDelay = Math.max(0, this.restartDelay - dt);
      if (this.restartDelay > 0) return;
    }
    this.shield = Math.min(this.maxShield, this.shield + 5 * dt);
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const screen = camera.worldToScreen(this.position);
    const v = this.drawBuildingBase(ctx, screen, colorToCSS(Colors.radar_friendly_status), camera);
    const ratio = this.shield / this.maxShield;
    ctx.save();
    const fieldSide = ShieldGenerator.FIELD_CELLS * GRID_CELL_SIZE * camera.zoom;
    if (this.buildProgress >= 1 && this.powered) {
      ctx.fillStyle = colorToCSS(Colors.radar_friendly_status, 0.025 + ratio * 0.035);
      ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, 0.18 + ratio * 0.42);
      ctx.lineWidth = Math.max(1.5, 2.5 * camera.zoom);
      ctx.fillRect(screen.x - fieldSide / 2, screen.y - fieldSide / 2, fieldSide, fieldSide);
      ctx.strokeRect(screen.x - fieldSide / 2, screen.y - fieldSide / 2, fieldSide, fieldSide);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, 0.45 + ratio * 0.45);
    ctx.lineWidth = Math.max(2, v.side * 0.045);
    ctx.strokeRect(screen.x - v.side * 0.28, screen.y - v.side * 0.28, v.side * 0.56, v.side * 0.56);
    ctx.restore();
  }
}

export class Shipyard extends BuildingBase { shipCapacity=5; activeShips=0; buildTimer=0; buildInterval=5; assignedGroup: ShipGroup=ShipGroup.Red; holdDocked=false; dockedShips=0; fightersReleased=false; launchFlashTimer=0;
constructor(type:EntityType.FighterYard|EntityType.BomberYard|EntityType.SwarmYard,position:Vec2,team:Team){super(type, team, position, type===EntityType.FighterYard ? HP_VALUES.fighterYard : type===EntityType.SwarmYard ? HP_VALUES.swarmYard : HP_VALUES.bomberYard);this.powered=false;if(type===EntityType.SwarmYard){this.shipCapacity=20;this.buildInterval=0.65;}} update(dt:number):void{super.update(dt);if(this.buildProgress>=1&&this.powered&&this.activeShips<this.shipCapacity)this.buildTimer-=dt;if(this.launchFlashTimer>0)this.launchFlashTimer=Math.max(0,this.launchFlashTimer-dt);} shouldSpawnShip():boolean{if(!this.alive||!this.powered||this.buildProgress<1)return false;if(this.buildTimer<=0&&this.activeShips<this.shipCapacity){this.buildTimer=this.buildInterval;this.launchFlashTimer=0.55;return true;}return false;} bayPosition():Vec2{return this.position.add(new Vec2(0, GRID_CELL_SIZE*1.15));} draw(ctx:CanvasRenderingContext2D,camera:Camera):void{ const screen=camera.worldToScreen(this.position); const isF=this.type===EntityType.FighterYard; const isSwarm=this.type===EntityType.SwarmYard; const detail=isF?Colors.fighteryard_detail:isSwarm?Colors.particles_switch:Colors.bomberyard_detail; if(this.synonymousVisualKind==='shipyard'){this.drawSynonymousShipyard(ctx,camera,screen);return;} const v=this.drawBuildingBase(ctx,screen,colorToCSS(detail),camera); const bayW=v.side*0.55,bayH=v.side*0.18; ctx.fillStyle=colorToCSS(Colors.enemy_background,0.8); ctx.fillRect(screen.x-bayW*0.5,screen.y+v.side*0.2,bayW,bayH); for(let i=0;i<Math.min(this.dockedShips,this.shipCapacity);i++){const col=i%5,row=Math.floor(i/5);const sx=screen.x-v.side*0.32+col*v.side*0.16;const sy=screen.y-v.side*0.23+row*v.side*0.115; ctx.strokeStyle=colorToCSS(detail, this.powered?0.9:0.45); ctx.beginPath(); if(isSwarm){ctx.arc(sx,sy,Math.max(1.2,v.side*0.025),0,Math.PI*2);} else if(isF){ctx.moveTo(sx+4,sy);ctx.lineTo(sx-3,sy-2);ctx.lineTo(sx-3,sy+2);} else {ctx.moveTo(sx+4,sy);ctx.lineTo(sx,sy-3);ctx.lineTo(sx-4,sy);ctx.lineTo(sx,sy+3);} ctx.closePath();ctx.stroke(); }
if(this.launchFlashTimer>0){const f=this.launchFlashTimer/0.55;ctx.save();ctx.globalCompositeOperation='lighter';ctx.strokeStyle=colorToCSS(detail,f*0.80);ctx.lineWidth=Math.max(1,v.side*0.042);ctx.strokeRect(screen.x-bayW*0.5-1,screen.y+v.side*0.19,bayW+2,bayH+2);ctx.fillStyle=colorToCSS(detail,f*0.22);ctx.fillRect(screen.x-bayW*0.5-1,screen.y+v.side*0.19,bayW+2,bayH+2);ctx.restore();}
this.drawAssignedGroupLabel(ctx, screen, v); }
private drawSynonymousShipyard(ctx:CanvasRenderingContext2D,camera:Camera,screen:Vec2):void{const v=this.getBaseVisual(camera);const color=teamColor(this.team);const nodeR=Math.max(2,v.side*0.055);const r=v.side*0.44;ctx.save();ctx.globalAlpha=Math.max(0.18,this.buildProgress);ctx.globalCompositeOperation='lighter';ctx.strokeStyle=colorToCSS(color,this.powered?0.42:0.18);ctx.lineWidth=Math.max(1,v.side*0.016);ctx.beginPath();const nodes:Array<{x:number;y:number}>=[];for(let i=0;i<11;i++){const a=-Math.PI*0.92+i*(Math.PI*1.84/10);const x=screen.x+Math.cos(a)*r;const y=screen.y+Math.sin(a)*r;nodes.push({x,y});if(i>0){ctx.moveTo(nodes[i-1].x,nodes[i-1].y);ctx.lineTo(x,y);}if(i%2===0){ctx.moveTo(screen.x,screen.y-v.side*0.05);ctx.lineTo(x,y);}}ctx.stroke();ctx.strokeStyle=colorToCSS(Colors.particles_switch,this.powered?0.22:0.10);ctx.beginPath();ctx.arc(screen.x,screen.y-v.side*0.02,r*0.62,Math.PI*1.08,Math.PI*1.92);ctx.stroke();ctx.fillStyle='rgba(4,8,10,0.88)';ctx.beginPath();ctx.ellipse(screen.x,screen.y+r*0.72,v.side*0.24,v.side*0.10,0,0,Math.PI*2);ctx.fill();for(const n of nodes){ctx.fillStyle=colorToCSS(color,this.powered?0.82:0.38);ctx.beginPath();ctx.arc(n.x,n.y,nodeR,0,Math.PI*2);ctx.fill();}const shown=Math.min(this.dockedShips,this.shipCapacity);for(let i=0;i<shown;i++){const x=screen.x-v.side*0.23+(i%5)*v.side*0.115;const y=screen.y+v.side*0.24+Math.floor(i/5)*v.side*0.10;ctx.strokeStyle=colorToCSS(color,0.72);ctx.beginPath();ctx.moveTo(x,y-v.side*0.028);ctx.lineTo(x-v.side*0.032,y+v.side*0.028);ctx.lineTo(x+v.side*0.032,y+v.side*0.028);ctx.closePath();ctx.stroke();}this.drawAssignedGroupLabel(ctx, screen, v);ctx.restore();}
private drawAssignedGroupLabel(ctx:CanvasRenderingContext2D,screen:Vec2,v:BaseVisual):void{if(this.team!==Team.Player)return;const label=`${this.assignedGroup+1}`;const labelColor=SHIP_GROUP_LABEL_COLORS[this.assignedGroup];const showLarge=Input.isDown('c')||Input.isDown('1')||Input.isDown('2')||Input.isDown('3')||Input.isDown('4');ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';if(showLarge){ctx.font=`bold ${Math.max(24,v.side*0.72)}px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif`;ctx.lineWidth=Math.max(3,v.side*0.075);ctx.strokeStyle='rgba(2,4,6,0.88)';ctx.strokeText(label,screen.x,screen.y);ctx.fillStyle=colorToCSS(labelColor,0.92);ctx.fillText(label,screen.x,screen.y);}else{ctx.fillStyle=colorToCSS(labelColor,0.9);ctx.font=`bold ${Math.max(10,v.side*0.15)}px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif`;ctx.fillText(label,screen.x+v.side*0.3,screen.y-v.side*0.32);}ctx.restore();}}

interface LabDotConfig {
  speed: number;
  lobes: number;
  meanR: number;
  modR: number;
  modPhase: number;
  aspect: number;
  precession: number;
  precessionPhase: number;
}

const LAB_DOT_CONFIGS: readonly LabDotConfig[] = [
  { speed: 1.15,  lobes: 3, meanR: 0.85, modR: 0.20, modPhase: 0.0, aspect: 0.65, precession: 0.22,  precessionPhase: 0.0 },
  { speed: -0.95, lobes: 4, meanR: 1.05, modR: 0.18, modPhase: 1.2, aspect: 0.60, precession: -0.18, precessionPhase: 1.5 },
  { speed: 1.30,  lobes: 5, meanR: 0.95, modR: 0.22, modPhase: 2.4, aspect: 0.70, precession: 0.26,  precessionPhase: 3.1 },
  { speed: -1.10, lobes: 2, meanR: 0.75, modR: 0.25, modPhase: 3.6, aspect: 0.55, precession: -0.30, precessionPhase: 4.2 },
  { speed: 1.05,  lobes: 3, meanR: 1.15, modR: 0.16, modPhase: 4.8, aspect: 0.65, precession: 0.15,  precessionPhase: 5.0 },
  { speed: -1.25, lobes: 4, meanR: 0.80, modR: 0.20, modPhase: 0.8, aspect: 0.75, precession: -0.24, precessionPhase: 2.1 },
];

export interface LabOrbitalDot {
  pos: Vec2;
  trail: TrailSample[];
  lastSamplePos: Vec2;
  config: LabDotConfig;
}

export class ResearchLab extends BuildingBase {
  private spinPhase = 0;
  private dotPhase = 0;
  private activityRate = 0.5; // 0.5 = idle (50% speed), 1.0 = active research (100% speed)
  isResearching = false;
  readonly orbitalDots: LabOrbitalDot[];
  researchItem: string | null;
  /** Rendering permission set from the local viewer's team on network clients. */
  showExactUpgrade: boolean;

  constructor(position: Vec2, team: Team, researchItem: string | null = null) {
    super(EntityType.ResearchLab, team, position, HP_VALUES.researchLab);
    this.researchItem = researchItem;
    this.footprintCells = researchItem ? 3 : null;
    this.showExactUpgrade = team === Team.Player;
    this.orbitalDots = LAB_DOT_CONFIGS.map((cfg) => ({
      pos: position.clone(),
      trail: [],
      lastSamplePos: position.clone(),
      config: cfg,
    }));
  }

  getActivityRate(): number { return this.activityRate; }
  getSpinPhase(): number { return this.spinPhase; }
  getDotPhase(): number { return this.dotPhase; }
  getDotOpacity(): number {
    const researchProgressFactor = Math.max(0, Math.min(1, (this.activityRate - 0.5) / 0.5));
    return 0.50 + 0.25 * researchProgressFactor;
  }

  override destroy(): void {
    super.destroy();
    for (const dot of this.orbitalDots) {
      dot.trail.length = 0;
    }
  }

  override update(dt: number): void {
    super.update(dt);
    if (this.powered) {
      const targetRate = this.isResearching ? 1.0 : 0.5;
      // Smoothly transition between 50% idle speed and 100% research speed
      const rampSpeed = 1.6;
      this.activityRate += (targetRate - this.activityRate) * Math.min(1, dt * rampSpeed);

      // Atomic symbol spins fast (2.0 rad/s = its current speed) when researching,
      // and smoothly decelerates to 50% speed (1.0 rad/s) when idle
      this.spinPhase += dt * (2.0 * this.activityRate);

      // Dots move faster (2.7 rad/s base rate) when researching, and 50% speed when idle
      this.dotPhase += dt * (2.7 * this.activityRate);
    } else {
      this.activityRate = Math.max(0.175, this.activityRate - dt * 1.5);
      this.spinPhase += dt * 0.35;
    }

    // Update the 6 orbital dots
    const worldSide = (this.footprintCells ?? footprintForBuilding(this)) * GRID_CELL_SIZE;
    const baseR = worldSide * 0.22;
    const fadeTime = 3.12; // 6x longer than previous 0.52s to show extended rosette loops
    const minSampleDist = Math.max(1.5, baseR * 0.08);
    const minSampleDistSq = minSampleDist * minSampleDist;
    const maxTrailSamples = 75; // Expanded capacity for 6x longer trail history

    for (let i = 0; i < this.orbitalDots.length; i++) {
      const dot = this.orbitalDots[i];
      const cfg = dot.config;

      // Natural compound harmonic / precessing rosette movement formula
      const theta = this.dotPhase * cfg.speed;
      const omega = this.dotPhase * cfg.precession + cfg.precessionPhase;
      const r = baseR * (cfg.meanR + cfg.modR * Math.cos(cfg.lobes * theta + cfg.modPhase));
      const u = r * Math.cos(theta);
      const v = r * Math.sin(theta) * cfg.aspect;
      const cosP = Math.cos(omega);
      const sinP = Math.sin(omega);
      const lx = u * cosP - v * sinP;
      const ly = (u * sinP + v * cosP) * 0.65;

      dot.pos.x = this.position.x + lx;
      dot.pos.y = this.position.y + ly;

      // Age existing trail points
      let write = 0;
      for (let j = 0; j < dot.trail.length; j++) {
        const point = dot.trail[j];
        point.age += dt;
        if (point.age <= fadeTime) {
          dot.trail[write++] = point;
        }
      }
      dot.trail.length = write;

      // When powered and alive, sample position history into the trail
      if (this.powered && this.alive && this.buildProgress >= 1) {
        const dx = dot.pos.x - dot.lastSamplePos.x;
        const dy = dot.pos.y - dot.lastSamplePos.y;
        const distSq = dx * dx + dy * dy;

        if (distSq >= minSampleDistSq) {
          const dist = Math.sqrt(distSq);
          // If moved rapidly, interpolate intermediate sample to prevent angular gaps
          if (dist > minSampleDist * 4) {
            const steps = Math.min(3, Math.floor(dist / minSampleDist));
            for (let s = 1; s < steps; s++) {
              const f = s / steps;
              const ix = dot.lastSamplePos.x + (dot.pos.x - dot.lastSamplePos.x) * f;
              const iy = dot.lastSamplePos.y + (dot.pos.y - dot.lastSamplePos.y) * f;
              if (dot.trail.length >= maxTrailSamples) {
                const recycled = dot.trail.shift()!;
                recycled.pos.x = ix;
                recycled.pos.y = iy;
                recycled.age = 0;
                dot.trail.push(recycled);
              } else {
                dot.trail.push({ pos: new Vec2(ix, iy), age: 0 });
              }
            }
          }

          // Append or recycle latest head point
          if (dot.trail.length >= maxTrailSamples) {
            const recycled = dot.trail.shift()!;
            recycled.pos.x = dot.pos.x;
            recycled.pos.y = dot.pos.y;
            recycled.age = 0;
            dot.trail.push(recycled);
          } else {
            dot.trail.push({ pos: dot.pos.clone(), age: 0 });
          }

          dot.lastSamplePos.x = dot.pos.x;
          dot.lastSamplePos.y = dot.pos.y;
        }
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const screen = camera.worldToScreen(this.position);
    const v = this.drawBuildingBase(ctx, screen, colorToCSS(Colors.researchlab_detail), camera);
    if (v.simple) return;
    const glowColor = Colors.building_glow_research;
    const ringA = this.powered ? 0.85 : 0.45;

    // Draw tech labels and atomic spinning rings (translated to building center)
    ctx.save();
    ctx.translate(screen.x, screen.y);
    if (this.researchItem) {
      const category = researchCategory(this.researchItem);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.max(13, v.side * 0.25)}px "Segoe UI", sans-serif`;
      ctx.lineWidth = Math.max(2, v.side * 0.035);
      ctx.strokeStyle = 'rgba(0,0,0,0.92)';
      ctx.strokeText(category, 0, 0);
      ctx.fillStyle = colorToCSS(Colors.researchlab_detail, 1);
      ctx.fillText(category, 0, 0);
      // Exact technology is friendly-only; opponents see the category letter alone.
      if (this.showExactUpgrade) {
        const icon = researchIcon(this.researchItem);
        ctx.font = `bold ${Math.max(8, v.side * 0.115)}px "Segoe UI", sans-serif`;
        ctx.strokeText(icon, 0, v.side * 0.27);
        ctx.fillStyle = colorToCSS(Colors.building_glow_research, 0.95);
        ctx.fillText(icon, 0, v.side * 0.27);
      }
    }
    // Three spinning elliptical rings (atomic symbol)
    ctx.strokeStyle = colorToCSS(Colors.researchlab_detail, ringA);
    ctx.lineWidth = Math.max(0.8, v.side * 0.018);
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.rotate(this.spinPhase + i * 2.094);
      ctx.scale(1, 0.45);
      ctx.beginPath();
      ctx.arc(0, 0, v.side * 0.22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // Orbiting node dots and luminous trails (drawn in world-to-screen untranslated coordinates)
    if (this.powered) {
      const worldSide = (this.footprintCells ?? footprintForBuilding(this)) * GRID_CELL_SIZE;
      const dotOpacity = this.getDotOpacity();

      const trailStyle: ProjectileTrailStyle = {
        color: colorToCSS(glowColor, 1.0),
        coreColor: 'rgba(215, 255, 245, 1.0)',
        fadeTime: 3.12, // 6x longer than previous 0.52s
        width: Math.max(1.8, worldSide * 0.022),
        outerWidthMultiplier: 2.2,
        outerAlpha: dotOpacity * 0.45,
        innerWidthMultiplier: 1.0,
        innerAlpha: dotOpacity,
        coreWidthMultiplier: 0.4,
        coreAlpha: dotOpacity,
        taperExponent: 0.85,
        opacityExponent: 0.85,
      };

      // 1. Draw glowing trails behind the 6 dots
      for (const dot of this.orbitalDots) {
        if (dot.trail.length > 0) {
          if (!isLegacyGraphics()) {
            renderProjectileTrail(ctx, camera, dot.trail, dot.pos, trailStyle);
          } else {
            ctx.save();
            ctx.strokeStyle = colorToCSS(glowColor, dotOpacity);
            ctx.lineWidth = Math.max(1, v.side * 0.018);
            ctx.beginPath();
            const p0 = camera.worldToScreen(dot.trail[0].pos);
            ctx.moveTo(p0.x, p0.y);
            for (let t = 1; t < dot.trail.length; t++) {
              const pt = camera.worldToScreen(dot.trail[t].pos);
              ctx.lineTo(pt.x, pt.y);
            }
            const head = camera.worldToScreen(dot.pos);
            ctx.lineTo(head.x, head.y);
            ctx.stroke();
            ctx.restore();
          }
        }
      }

      // 2. Draw the 6 dot heads (30% smaller, and 50% opaque fading to 75% when researching)
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = dotOpacity;
      const nodeR = Math.max(0.9, v.side * 0.038 * 0.7);
      for (const dot of this.orbitalDots) {
        const sx = camera.screenX(dot.pos.x);
        const sy = camera.screenY(dot.pos.y);

        // Soft outer glow
        ctx.fillStyle = colorToCSS(glowColor, 1.0);
        ctx.beginPath();
        ctx.arc(sx, sy, nodeR, 0, Math.PI * 2);
        ctx.fill();

        // Bright luminous core
        ctx.fillStyle = 'rgba(235, 255, 250, 1.0)';
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(0.5, nodeR * 0.45), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }
}

export class Factory extends BuildingBase {
  private gearPhase = 0;
  constructor(position: Vec2, team: Team) {
    super(EntityType.Factory, team, position, HP_VALUES.factory);
  }
  update(dt: number): void { super.update(dt); this.gearPhase += this.powered ? dt * 1.5 : dt * 0.2; }
  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const screen = camera.worldToScreen(this.position);
    const v = this.drawBuildingBase(ctx, screen, colorToCSS(Colors.factory_detail), camera);
    if (v.simple) return;
    const glowColor = Colors.building_glow_factory;
    const gearA = this.powered ? 0.80 : 0.45;
    ctx.save();
    ctx.translate(screen.x, screen.y);
    // Outer gear (8 teeth)
    ctx.rotate(this.gearPhase);
    ctx.strokeStyle = colorToCSS(Colors.factory_detail, gearA);
    ctx.lineWidth = Math.max(1, v.side * 0.025);
    const t = 8;
    const inner = v.side * 0.12;
    const outer = v.side * 0.21;
    ctx.beginPath();
    for (let i = 0; i < t; i++) {
      const a = (Math.PI * 2 * i) / t;
      ctx.lineTo(Math.cos(a) * inner, Math.sin(a) * inner);
      ctx.lineTo(Math.cos(a + 0.2) * outer, Math.sin(a + 0.2) * outer);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
    // Inner counter-rotating ring with 4 spokes
    if (!v.simple) {
      ctx.save();
      ctx.translate(screen.x, screen.y);
      ctx.rotate(-this.gearPhase * 1.5);
      ctx.strokeStyle = colorToCSS(glowColor, this.powered ? 0.45 : 0.18);
      ctx.lineWidth = Math.max(0.8, v.side * 0.016);
      ctx.beginPath();
      ctx.arc(0, 0, v.side * 0.08, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 4; i++) {
        const a = (Math.PI * 2 * i) / 4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * v.side * 0.085, Math.sin(a) * v.side * 0.085);
        ctx.lineTo(Math.cos(a) * v.side * 0.14, Math.sin(a) * v.side * 0.14);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}
