/**
 * Adaptive render-performance budget for Sign99.
 *
 * Tracks smoothed moving averages of frame timing and exposes a
 * `renderLoadScale` that ranges from 1.0 (fully healthy) down to
 * MIN_SCALE (0.35) when frame time is consistently above TARGET_FRAME_MS.
 *
 * The scale degrades quickly under load and recovers slowly when load
 * drops — hysteresis prevents frame-to-frame flickering of visual density.
 *
 * This scale ONLY influences optional visual density (particle emission
 * counts, bullet glow density, engine glow, crystal mote decimation, glow
 * primitive caps). It never touches gameplay simulation.
 */

export class RenderBudget {
  // --- Configuration ---

  /** Frame time above this threshold (ms) is considered overloaded. */
  private static readonly TARGET_FRAME_MS = 22; // ~45 fps threshold

  /** Minimum value renderLoadScale is allowed to reach. */
  private static readonly MIN_SCALE = 0.35;

  /** EMA coefficient for frame-time smoothing (lower = smoother). */
  private static readonly EMA_ALPHA = 0.12;

  /**
   * How much to degrade renderLoadScale per update when overloaded.
   * Fast degrade: ~0.04 per frame → reaches 0.35 in ~16 frames (~0.27 s).
   */
  private static readonly DEGRADE_RATE = 0.035;

  /**
   * How much to recover per update when healthy.
   * Slow recover: ~0.004 per frame → full recovery in ~165 frames (~2.75 s).
   */
  private static readonly RECOVER_RATE = 0.004;

  // --- Smoothed timing values ---

  /** Smoothed frame duration (ms). */
  frameMs: number = 16.67;

  /** Smoothed fixed-update cost (ms). */
  fixedUpdateMs: number = 1;

  /** Smoothed render cost (ms). */
  renderMs: number = 5;

  // --- Particle stats (set by ParticleSystem each frame) ---

  activeParticles: number = 0;
  drawnParticles: number = 0;
  culledParticles: number = 0;
  emittedThisFrame: number = 0;
  recycledParticles: number = 0;
  particleCapacity: number = 0;

  // --- Glow stats (set by GlowLayer each frame) ---

  glowDrawn: number = 0;
  glowSkipped: number = 0;

  // --- Crystal stats (set by CrystalNebula each frame) ---

  crystalVisible: number = 0;

  // --- Gatling field stats (set by GatlingField.draw each frame) ---

  /** Live pooled gatling-turret bullets. */
  gatlingFieldActive: number = 0;

  // --- Adaptive scale ---

  private _renderLoadScale: number = 1.0;

  /** 0.35 (heavy load) … 1.0 (healthy). Drives optional visual density. */
  get renderLoadScale(): number {
    return this._renderLoadScale;
  }

  /**
   * Call once per frame with raw (unsmoothed) timing values.
   * Updates moving averages and adjusts renderLoadScale.
   */
  update(rawFrameMs: number, rawFixedUpdateMs: number, rawRenderMs: number): void {
    const a = RenderBudget.EMA_ALPHA;
    const oma = 1 - a;
    this.frameMs = this.frameMs * oma + rawFrameMs * a;
    this.fixedUpdateMs = this.fixedUpdateMs * oma + rawFixedUpdateMs * a;
    this.renderMs = this.renderMs * oma + rawRenderMs * a;

    // Hysteresis: degrade quickly on overload, recover slowly on health
    if (this.frameMs > RenderBudget.TARGET_FRAME_MS) {
      this._renderLoadScale = Math.max(
        RenderBudget.MIN_SCALE,
        this._renderLoadScale - RenderBudget.DEGRADE_RATE,
      );
    } else {
      this._renderLoadScale = Math.min(
        1.0,
        this._renderLoadScale + RenderBudget.RECOVER_RATE,
      );
    }
  }
}

/** Singleton export — all modules may import this for read access. */
export const renderBudget = new RenderBudget();
