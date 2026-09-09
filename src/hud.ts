/** Heads-up display for Sign99 — minimal, message-based */

import { Colors, colorToCSS, Color } from './colors.js';
import { gameFont, menuFont } from './fonts.js';
import { t as tr } from './i18n.js';

// ---------------------------------------------------------------------------
// HUD message
// ---------------------------------------------------------------------------

interface HudMessage {
  text: string;
  color: Color;
  /** Time remaining before the message is removed (seconds). */
  timeLeft: number;
  /** Total display time, used to compute fade. */
  duration: number;
}

const FADE_IN_TIME = 0.3;
const FADE_OUT_TIME = 0.8;
const DEFAULT_DURATION = 4.0;
const MAX_MESSAGES = 5;
const HUD_FONT_SIZE = 30;
const MESSAGE_LINE_HEIGHT = 34;

// ---------------------------------------------------------------------------
// AI chat panel — narrates AI thinking in a smaller panel on the right side
// ---------------------------------------------------------------------------

interface AIChatEntry {
  prefix: string;
  text: string;
  /** Color for the prefix badge (e.g. enemy red or allied cyan). */
  prefixColor: Color;
  timeLeft: number;
  duration: number;
}

const CHAT_FONT_SIZE = 18;
const CHAT_LINE_HEIGHT = 22;
const CHAT_MAX_ENTRIES = 5;
const CHAT_DEFAULT_DURATION = 8.0;
const CHAT_FADE_OUT = 1.2;
const HUD_CYAN = 'rgba(118,242,255,';
const HUD_GOLD = 'rgba(255,218,116,';

// ---------------------------------------------------------------------------
// HUD class
// ---------------------------------------------------------------------------

export class HUD {
  private messages: HudMessage[] = [];
  private animTime: number = 0;
  private playerBarsCompact = 0;
  private lastPlayerBarsAnimTime = 0;
  private chatEntries: AIChatEntry[] = [];

  /** Queue a new message to display. */
  showMessage(text: string, color: Color = Colors.general_building, duration: number = DEFAULT_DURATION): void {
    if (this.messages.length >= MAX_MESSAGES) {
      this.messages.shift();
    }
    this.messages.push({ text, color, timeLeft: duration, duration });
  }

  /**
   * Post an AI commentary line to the chat panel in the lower-right.
   *
   * @param prefix  Short badge like "RIVAL" or "BASE" — shown in prefixColor.
   * @param text    The message body.
   * @param prefixColor  Color for the badge text.
   * @param duration  How long the message stays visible (default 8 s).
   */
  showAIChat(
    prefix: string,
    text: string,
    prefixColor: Color = Colors.general_building,
    duration: number = CHAT_DEFAULT_DURATION,
  ): void {
    if (this.chatEntries.length >= CHAT_MAX_ENTRIES) {
      this.chatEntries.shift();
    }
    this.chatEntries.push({ prefix, text, prefixColor, timeLeft: duration, duration });
  }

  update(dt: number): void {
    this.animTime += dt;
    for (const msg of this.messages) {
      msg.timeLeft -= dt;
    }
    this.messages = this.messages.filter((m) => m.timeLeft > 0);
    for (const e of this.chatEntries) {
      e.timeLeft -= dt;
    }
    this.chatEntries = this.chatEntries.filter((e) => e.timeLeft > 0);
  }

  draw(ctx: CanvasRenderingContext2D, screenW: number, screenH: number): void {
    if (this.messages.length === 0) return;

    ctx.font = `${HUD_FONT_SIZE}px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const baseY = screenH * 0.25;

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      const elapsed = msg.duration - msg.timeLeft;

      // Compute alpha with fade-in and fade-out
      let alpha: number;
      if (elapsed < FADE_IN_TIME) {
        alpha = elapsed / FADE_IN_TIME;
      } else if (msg.timeLeft < FADE_OUT_TIME) {
        alpha = msg.timeLeft / FADE_OUT_TIME;
      } else {
        alpha = 1;
      }

      const y = baseY + i * MESSAGE_LINE_HEIGHT;
      const textW = ctx.measureText(msg.text).width;
      this.drawGlassPanel(ctx, screenW * 0.5 - textW * 0.5 - 34, y - 19, textW + 68, 36, alpha * 0.72);
      ctx.fillStyle = colorToCSS(msg.color, alpha);
      ctx.shadowColor = colorToCSS(msg.color, alpha * 0.72);
      ctx.shadowBlur = 14;
      ctx.fillText(msg.text, screenW * 0.5, y);
      ctx.shadowBlur = 0;
    }
  }

  /**
   * Draw the AI chat panel — a small log of AI commentary in the
   * lower-right of the screen, above the resource counter.
   *
   * Each line has a colored prefix badge (e.g. "[RIVAL]") followed by
   * the message body in a dimmer neutral color.  Lines fade out gradually
   * as they age.
   */
  drawAIChat(ctx: CanvasRenderingContext2D, screenW: number, screenH: number): void {
    if (this.chatEntries.length === 0) return;

    ctx.font = `${CHAT_FONT_SIZE}px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'right';

    const rightX = screenW - 12;
    // Start just above the resources line (which is ~44px from bottom for
    // income text + another ~34px for the resource value).
    const bottomY = screenH - 90;
    const panelH = this.chatEntries.length * CHAT_LINE_HEIGHT + 20;
    this.drawGlassPanel(ctx, screenW - 430, bottomY - panelH + CHAT_LINE_HEIGHT - 6, 418, panelH, 0.62);

    for (let i = this.chatEntries.length - 1; i >= 0; i--) {
      const entry = this.chatEntries[i];
      const age = entry.duration - entry.timeLeft;
      let alpha: number;
      if (age < 0.25) {
        alpha = age / 0.25;
      } else if (entry.timeLeft < CHAT_FADE_OUT) {
        alpha = entry.timeLeft / CHAT_FADE_OUT;
      } else {
        alpha = 1;
      }
      // Older lines are dimmer to distinguish from recent ones.
      const lineIndex = this.chatEntries.length - 1 - i; // 0 = newest
      const ageDim = Math.max(0.35, 1.0 - lineIndex * 0.12);

      const y = bottomY - lineIndex * CHAT_LINE_HEIGHT;

      // Message body (right-aligned, drawn first so prefix can overdraw)
      ctx.fillStyle = colorToCSS(Colors.general_building, alpha * ageDim * 0.7);
      ctx.fillText(entry.text, rightX, y);

      // Measure body width so we can place the prefix to the left of it
      const bodyW = ctx.measureText(entry.text).width;
      const prefixStr = `[${entry.prefix}] `;
      ctx.fillStyle = colorToCSS(entry.prefixColor, alpha * ageDim);
      ctx.fillText(prefixStr, rightX - bodyW, y);
    }
  }

  /** Draw the resource count display at the bottom of the screen. */
  drawResources(
    ctx: CanvasRenderingContext2D,
    resources: number,
    incomePerSecond: number,
    screenW: number,
    screenH: number,
    options: { currencySymbol?: string; symbolOnRight?: boolean; symbolFont?: 'menu' | 'main' } = {},
  ): void {
    const panelW = 220;
    const panelH = 70;
    const panelX = screenW - panelW - 8;
    const panelY = screenH - panelH - 8;
    this.drawGlassPanel(ctx, panelX, panelY, panelW, panelH, 0.66);

    ctx.font = options.symbolFont === 'menu' ? menuFont(HUD_FONT_SIZE) : gameFont(HUD_FONT_SIZE);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = colorToCSS(Colors.general_building, 0.68);
    ctx.fillText(tr('hud.income', { n: Math.round(incomePerSecond) }), screenW - 10, screenH - 44);
    const symbol = options.currencySymbol ?? '$';
    const amount = Math.floor(resources);
    ctx.shadowColor = HUD_GOLD + '0.55)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = colorToCSS(Colors.general_building, 0.92);
    ctx.fillText(options.symbolOnRight ? `${amount} ${symbol}` : `${symbol}${amount}`, screenW - 10, screenH - 10);
    ctx.shadowBlur = 0;
  }

  /** Draw the player energy/battery indicator at the bottom-left. */
  drawPlayerEnergy(
    ctx: CanvasRenderingContext2D,
    battery: number,
    maxBattery: number,
    health: number,
    maxHealth: number,
    shield: number,
    maxShield: number,
    healthRegenActive: boolean,
    screenW: number,
    screenH: number,
    compact: boolean = false,
  ): void {
    const frac = Math.max(0, Math.min(1, battery / maxBattery));
    const hpFrac = Math.max(0, Math.min(1, health / maxHealth));
    const shieldFrac = maxShield > 0 ? Math.max(0, Math.min(1, shield / maxShield)) : 0;
    // The shield capacity extends the health bar past its normal end rather
    // than occupying its own row — e.g. a 50%-of-max-HP shield adds 50% more
    // bar length beyond the HP portion.
    const shieldExtensionFrac = maxHealth > 0 && maxShield > 0 ? maxShield / maxHealth : 0;
    const elapsed = Math.max(0, Math.min(0.05, this.animTime - this.lastPlayerBarsAnimTime));
    this.lastPlayerBarsAnimTime = this.animTime;
    const targetCompact = compact ? 1 : 0;
    const step = Math.min(1, elapsed * 8);
    this.playerBarsCompact += (targetCompact - this.playerBarsCompact) * step;
    const t = this.playerBarsCompact;
    const lerp = (a: number, b: number) => a + (b - a) * t;
    const barW = 220;
    const shieldExtW = barW * shieldExtensionFrac;
    const barH = lerp(14, 8);
    const x = 10;
    const y = lerp(screenH - 24, screenH - 18);
    const compactBlockH = 2 * 8;
    const expandedPanelY = screenH - 24 - 86;
    const compactPanelY = screenH - 18 - compactBlockH - 7;
    const panelY = lerp(expandedPanelY, compactPanelY);
    const expandedPanelH = screenH - 24 - expandedPanelY + 8;
    const compactPanelH = compactBlockH + 16;
    this.drawGlassPanel(ctx, x - 8, panelY, barW + shieldExtW + 18, lerp(expandedPanelH, compactPanelH), 0.68);

    let barColor: string;
    let labelColor: string;
    if (frac > 0.6) {
      barColor = colorToCSS(Colors.powergenerator_detail, 0.9);
      labelColor = colorToCSS(Colors.powergenerator_detail, 0.6);
    } else if (frac > 0.3) {
      barColor = colorToCSS(Colors.alert2, 0.9);
      labelColor = colorToCSS(Colors.alert2, 0.8);
    } else {
      const flash = frac < 0.15 ? 0.5 + 0.5 * Math.sin(this.animTime * 10) : 1;
      barColor = colorToCSS(Colors.alert1, 0.9 * flash);
      labelColor = colorToCSS(Colors.alert1, 0.9 * flash);
    }

    const expandedEnergyY = screenH - 24 - 14;
    const expandedHpY = screenH - 24 - 14 - 30;
    const expandedHpBarY = expandedHpY - 14;
    const compactEnergyY = screenH - 18 - 8;
    const compactHpBarY = compactEnergyY - 8;
    const energyY = lerp(expandedEnergyY, compactEnergyY);
    const hpBarY = lerp(expandedHpBarY, compactHpBarY);
    const labelAlpha = 1 - t;

    if (labelAlpha > 0.04) {
      ctx.save();
      ctx.globalAlpha *= labelAlpha;
      ctx.font = `${Math.floor(HUD_FONT_SIZE * 0.5)}px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = labelColor;
      ctx.fillText(tr('hud.energy'), x, energyY - 8);
      ctx.fillStyle = colorToCSS(Colors.healthbar, 0.9);
      ctx.fillText(tr('hud.hp'), x, hpBarY - 6);
      if (maxShield > 0) {
        ctx.textAlign = 'right';
        ctx.fillStyle = colorToCSS(Colors.radar_allied_status, 0.86);
        ctx.fillText(tr('hud.shield'), x + barW + shieldExtW, hpBarY - 6);
        ctx.textAlign = 'left';
      }
      ctx.restore();
    }

    this.drawStatusBar(ctx, x, hpBarY, barW, barH, hpFrac, colorToCSS(Colors.healthbar, 0.92), 'rgba(118,255,178,0.95)');
    if (healthRegenActive && hpFrac > 0) {
      const shimmerW = 42;
      const shimmerX = x + ((this.animTime * 78) % (barW + shimmerW)) - shimmerW;
      const grad = ctx.createLinearGradient(shimmerX, 0, shimmerX + shimmerW, 0);
      grad.addColorStop(0, colorToCSS(Colors.particles_healing, 0));
      grad.addColorStop(0.5, colorToCSS(Colors.particles_healing, 0.72));
      grad.addColorStop(1, colorToCSS(Colors.particles_healing, 0));
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, hpBarY, barW * hpFrac, barH);
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = grad;
      ctx.fillRect(shimmerX, hpBarY - 4, shimmerW, barH + 8);
      const pulse = 0.5 + 0.5 * Math.sin(this.animTime * 8);
      ctx.strokeStyle = colorToCSS(Colors.particles_healing, 0.24 + pulse * 0.24);
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 1, hpBarY - 1, barW + 2, barH + 2);
      ctx.restore();
    }
    if (shieldExtW > 0.5) {
      // Shield fills the bar's extension past the HP portion, in blue.
      this.drawStatusBar(ctx, x + barW, hpBarY, shieldExtW, barH, shieldFrac, colorToCSS(Colors.radar_allied_status, 0.85), 'rgba(120,178,255,0.95)');
    }

    this.drawStatusBar(ctx, x, energyY, barW, barH, frac, barColor, colorToCSS(Colors.powergenerator_detail, 0.85));
  }

  /**
   * PR5: warn the player about disconnected (unpowered) buildings. Drawn
   * just above the ENERGY/BUILD column so it stays in the same eye-line.
   */
  drawPowerStatus(
    ctx: CanvasRenderingContext2D,
    unpoweredCount: number,
    screenH: number,
  ): void {
    if (unpoweredCount <= 0) return;
    const x = 10;
    const y = screenH - 142;
    const flash = 0.5 + 0.5 * Math.sin(this.animTime * 5);
    ctx.font = `${HUD_FONT_SIZE}px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = colorToCSS(Colors.alert2, 0.5 + 0.5 * flash);
    const label =
      unpoweredCount === 1
        ? tr('hud.buildingUnpowered', { count: unpoweredCount })
        : tr('hud.buildingsUnpowered', { count: unpoweredCount });
    ctx.fillText(`⚠ ${label}`, x, y);
  }

  drawResearchStatus(
    ctx: CanvasRenderingContext2D,
    current: { item: string | null; progress: number; timeNeeded: number },
    _completedCount: number,
    screenH: number,
  ): void {
    if (!current.item) return;
    const barW = 150;
    const barH = 14;
    const x = 242;
    const y = screenH - 24;
    const frac = Math.max(0, Math.min(1, current.progress / Math.max(0.001, current.timeNeeded)));
    ctx.font = `${Math.floor(HUD_FONT_SIZE * 0.5)}px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = colorToCSS(Colors.researchlab_detail, 0.75);
    const label = `${tr('hud.research')} (${Math.floor(current.progress)}/${Math.ceil(current.timeNeeded)} sec)`;
    ctx.fillText(label, x, y - barH - 8);
    const grad = ctx.createLinearGradient(x, 0, x + barW, 0);
    grad.addColorStop(0, colorToCSS(Colors.researchlab_detail, 0.58));
    grad.addColorStop(1, colorToCSS(Colors.radar_friendly_status, 0.88));
    this.drawStatusBar(ctx, x, y - barH, barW, barH, frac, grad, HUD_CYAN + '0.88)');
  }

  private drawGlassPanel(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    alpha: number,
  ): void {
    ctx.save();
    const fill = ctx.createLinearGradient(x, y, x + w, y + h);
    fill.addColorStop(0, `rgba(4,18,31,${0.42 * alpha})`);
    fill.addColorStop(0.58, HUD_CYAN + `${0.055 * alpha})`);
    fill.addColorStop(1, `rgba(2,8,18,${0.56 * alpha})`);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = HUD_CYAN + `${0.38 * alpha})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.strokeStyle = HUD_GOLD + `${0.22 * alpha})`;
    ctx.beginPath();
    ctx.moveTo(x + 8, y + h - 0.5);
    ctx.lineTo(x + Math.min(w * 0.42, 110), y + h - 0.5);
    ctx.moveTo(x + w - Math.min(w * 0.30, 86), y + 0.5);
    ctx.lineTo(x + w - 8, y + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  private drawStatusBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    frac: number,
    fillStyle: string | CanvasGradient,
    glintColor: string,
  ): void {
    const f = Math.max(0, Math.min(1, frac));
    ctx.fillStyle = 'rgba(2,10,18,0.72)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = fillStyle;
    ctx.fillRect(x, y, w * f, h);
    if (f > 0.02) {
      const shimmerW = 36;
      const shimmerX = x + ((this.animTime * 90) % (w + shimmerW)) - shimmerW;
      const grad = ctx.createLinearGradient(shimmerX, 0, shimmerX + shimmerW, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, glintColor);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w * f, h);
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = grad;
      ctx.fillRect(shimmerX, y - 3, shimmerW, h + 6);
      ctx.restore();
    }
    ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.48);
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.strokeStyle = HUD_CYAN + '0.34)';
    ctx.beginPath();
    ctx.moveTo(x, y + h + 2);
    ctx.lineTo(x + w * f, y + h + 2);
    ctx.stroke();
  }
}
