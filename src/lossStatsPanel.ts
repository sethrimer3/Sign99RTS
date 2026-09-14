/**
 * Post-defeat stats screen. Shown once the player has lost their last
 * Command Post (see `PlayerRespawnRuntime.loss` in respawnRuntime.ts) — the
 * match keeps simulating and rendering behind this panel so the ghost
 * spectator camera can keep flying around while the player reviews stats.
 */

import { Colors, colorToCSS } from './colors.js';
import { Input } from './input.js';
import { drawDecodedText } from './decodeText.js';
import { gameFont } from './fonts.js';
import { t } from './i18n.js';
import type { GameState, MatchStats } from './gamestate.js';

interface ButtonRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ROW_STAGGER = 0.22;
const ROW_REVEAL_DURATION = 0.35;

function easeOutCubic(p: number): number {
  const c = Math.min(1, Math.max(0, p));
  return 1 - Math.pow(1 - c, 3);
}

function pointInButton(px: number, py: number, r: ButtonRect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class LossStatsPanel {
  open = false;
  private wasLoss = false;
  private openedAt = 0;
  private gameButton: ButtonRect = { x: 0, y: 0, w: 0, h: 0 };
  private menuButton: ButtonRect = { x: 0, y: 0, w: 0, h: 0 };

  /** Call once per tick with the current loss state; opens the panel on the rising edge. */
  notify(loss: boolean): void {
    if (loss && !this.wasLoss) {
      this.open = true;
      this.openedAt = performance.now() * 0.001;
    }
    if (!loss) this.open = false;
    this.wasLoss = loss;
  }

  /** Processes clicks on the panel's buttons. Returns the requested action, if any. */
  update(screenW: number, screenH: number): 'menu' | 'game' | null {
    if (!this.open) return null;
    this.layoutButtons(screenW, screenH);
    if (!Input.mousePressed) return null;
    if (pointInButton(Input.mousePos.x, Input.mousePos.y, this.gameButton)) {
      Input.consumeMouseButton(0);
      this.open = false;
      return 'game';
    }
    if (pointInButton(Input.mousePos.x, Input.mousePos.y, this.menuButton)) {
      Input.consumeMouseButton(0);
      this.open = false;
      return 'menu';
    }
    return null;
  }

  private layoutButtons(screenW: number, screenH: number): void {
    const w = 160;
    const h = 44;
    const gap = 14;
    const margin = 24;
    this.menuButton = { x: screenW - margin - w, y: screenH - margin - h, w, h };
    this.gameButton = { x: this.menuButton.x - gap - w, y: this.menuButton.y, w, h };
  }

  draw(ctx: CanvasRenderingContext2D, state: GameState, screenW: number, screenH: number): void {
    if (!this.open) return;
    this.layoutButtons(screenW, screenH);
    const elapsed = performance.now() * 0.001 - this.openedAt;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, screenW, screenH);

    const cx = screenW * 0.5;
    const panelW = Math.min(620, screenW - 48);
    let y = Math.max(50, screenH * 0.1);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = gameFont(42);
    ctx.shadowColor = colorToCSS(Colors.alert1, 0.7);
    ctx.shadowBlur = 16;
    ctx.fillStyle = colorToCSS(Colors.alert1, 0.95);
    drawDecodedText(ctx, t('loss.heading'), cx, y, 42, this.openedAt, 'center');
    ctx.shadowBlur = 0;
    y += 64;

    const stats = state.matchStats;
    const rows = [
      t('loss.timeSurvived', { value: formatTime(state.gameTime) }),
      t('loss.kills', { value: stats.kills }),
      t('loss.buildingsBuilt', { value: stats.buildingsBuilt }),
      t('loss.resourcesEarned', { value: Math.floor(stats.resourcesEarned) }),
    ];
    ctx.textAlign = 'left';
    const rowH = 30;
    for (let i = 0; i < rows.length; i++) {
      const rowElapsed = elapsed - i * ROW_STAGGER;
      if (rowElapsed < 0) continue;
      const reveal = easeOutCubic(rowElapsed / ROW_REVEAL_DURATION);
      ctx.save();
      ctx.globalAlpha = reveal;
      ctx.fillStyle = colorToCSS(Colors.general_building, 0.9);
      drawDecodedText(ctx, rows[i], cx - panelW * 0.5, y + i * rowH, 19, this.openedAt + i * ROW_STAGGER);
      ctx.restore();
    }
    y += rows.length * rowH + 30;

    const chartsStart = rows.length * ROW_STAGGER + 0.25;
    const chartH = 160;
    this.drawBarChart(ctx, stats, cx - panelW * 0.5, y, panelW * 0.42, chartH, elapsed - chartsStart);
    this.drawLineChart(ctx, stats, cx + panelW * 0.06, y, panelW * 0.52, chartH, elapsed - chartsStart - 0.2);

    this.drawButton(ctx, this.gameButton, t('loss.backToGame'), elapsed - chartsStart - 0.5);
    this.drawButton(ctx, this.menuButton, t('loss.backToMenu'), elapsed - chartsStart - 0.4);

    ctx.restore();
  }

  private drawBarChart(
    ctx: CanvasRenderingContext2D,
    stats: MatchStats,
    x: number,
    y: number,
    w: number,
    h: number,
    localElapsed: number,
  ): void {
    if (localElapsed < 0) return;
    const values = [stats.kills, stats.buildingsBuilt, Math.floor(stats.resourcesEarned / 10)];
    const labels = ['Kills', 'Built', 'Res/10'];
    const max = Math.max(1, ...values);
    const slot = w / values.length;
    const barW = slot * 0.5;

    ctx.save();
    ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.stroke();

    for (let i = 0; i < values.length; i++) {
      const barElapsed = localElapsed - i * 0.18;
      if (barElapsed < 0) continue;
      const reveal = easeOutCubic(barElapsed / 0.7);
      const targetH = (values[i] / max) * (h - 24);
      const barH = targetH * reveal;
      const bx = x + slot * i + (slot - barW) * 0.5;
      const by = y + h - barH;
      ctx.fillStyle = colorToCSS(Colors.radar_friendly_status, 0.25 + reveal * 0.5);
      ctx.fillRect(bx, by, barW, barH);
      ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, 0.85 * reveal);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, by, barW, barH);

      ctx.textAlign = 'center';
      ctx.font = gameFont(12, false);
      ctx.fillStyle = colorToCSS(Colors.general_building, reveal);
      ctx.fillText(String(values[i]), bx + barW * 0.5, by - 14);
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.85 * reveal);
      ctx.fillText(labels[i], bx + barW * 0.5, y + h + 16);
    }
    ctx.restore();
  }

  private drawLineChart(
    ctx: CanvasRenderingContext2D,
    stats: MatchStats,
    x: number,
    y: number,
    w: number,
    h: number,
    localElapsed: number,
  ): void {
    if (localElapsed < 0) return;

    ctx.save();
    ctx.textAlign = 'left';
    ctx.font = gameFont(13, false);
    ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.85);
    ctx.fillText(t('loss.resourceGraphTitle'), x, y - 18);

    ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.4);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.stroke();

    const history = stats.resourceHistory;
    if (history.length < 2) {
      ctx.restore();
      return;
    }
    const maxRes = Math.max(1, ...history.map((p) => p.resources));
    const minT = history[0].time;
    const maxT = history[history.length - 1].time;
    const span = Math.max(1, maxT - minT);

    const revealDuration = 1.4;
    const revealIndex = Math.min(1, localElapsed / revealDuration) * (history.length - 1);
    const lastWholeIndex = Math.floor(revealIndex);

    ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, 0.9);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= lastWholeIndex; i++) {
      const p = history[i];
      const px = x + ((p.time - minT) / span) * w;
      const py = y + h - (p.resources / maxRes) * h;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    const frac = revealIndex - lastWholeIndex;
    if (frac > 0 && lastWholeIndex + 1 < history.length) {
      const a = history[lastWholeIndex];
      const b = history[lastWholeIndex + 1];
      const px = x + ((a.time + (b.time - a.time) * frac - minT) / span) * w;
      const py = y + h - ((a.resources + (b.resources - a.resources) * frac) / maxRes) * h;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawButton(ctx: CanvasRenderingContext2D, rect: ButtonRect, label: string, localElapsed: number): void {
    if (localElapsed < 0) return;
    const reveal = easeOutCubic(localElapsed / 0.4);
    const hovered = pointInButton(Input.mousePos.x, Input.mousePos.y, rect);

    ctx.save();
    ctx.globalAlpha = reveal;
    ctx.fillStyle = hovered ? colorToCSS(Colors.radar_friendly_status, 0.22) : colorToCSS(Colors.friendly_background, 0.6);
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, hovered ? 0.95 : 0.55);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.font = gameFont(16);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colorToCSS(Colors.general_building, 0.95);
    ctx.fillText(label, rect.x + rect.w * 0.5, rect.y + rect.h * 0.5 + 1);
    ctx.restore();
  }
}
