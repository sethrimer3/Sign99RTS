export type VisualQuality = 'ultraLow' | 'low' | 'medium' | 'high' | 'ultraHigh';

export interface VisualQualityPreset {
  readonly glowEnabled: boolean;
  readonly glowScale: number;
  readonly conduitShimmer: boolean;
  readonly shockwaveScale: number;
  readonly scanlines: boolean;
  readonly fluidLowGraphics: boolean;
  /** Adds glow halos to individual bullets and gatling rounds. */
  readonly bulletGlow: boolean;
  /** Draws an animated engine trail glow behind thrusting ships in the glow layer. */
  readonly engineGlow: boolean;
  /** Renders a subtle color-fringe gradient on screen edges (CRT lens effect). */
  readonly colorFringe: boolean;
  /**
   * Fraction (0–1) of the full particle budget to emit for explosions and
   * sparks.  Low mode emits roughly 35 %, medium 65 %, high 100 %.
   */
  readonly particleScale: number;
  /** Enable animated shooting-star streaks in the background starfield. */
  readonly shootingStarsEnabled: boolean;
  /**
   * Enable small screen-shake impulses for large explosions and heavy weapon
   * impacts.  Always false in Low mode; enabled for medium/high.
   */
  readonly cameraShakeEnabled: boolean;
  /**
   * Enable traveling energy-pulse dots along powered conduits in High graphics.
   * Too CPU-intensive for Low; partial in Medium; full in High.
   */
  readonly conduitPulseEnabled: boolean;
  /**
   * Enable the Crystal Nebula Clouds overlay — tiny angular crystal motes
   * scattered across the world that react to ships, bullets, and explosions.
   */
  readonly crystalNebulaEnabled: boolean;
  /**
   * Fraction (0–1) of the base mote count to spawn per cloud.
   * 0 = no particles; 1 = full density.
   */
  readonly crystalNebulaDensityScale: number;
  /**
   * Route the brightest glints and disturbed motes into the GlowLayer for
   * a subtle halo effect.
   */
  readonly crystalNebulaGlow: boolean;
  /**
   * Multiplier (0–1) for how strongly ships, bullets, and explosions push
   * crystal motes.  0 = no interaction; 1 = full.
   */
  readonly crystalNebulaInteractionScale: number;
  /**
   * Spawn dense, very tight clumps of crystal motes (50–300 each) in
   * natural nebula-like clusters, in addition to the diffuse clouds.
   * Only enabled on the top ("Very High") graphics tier; the clumps are
   * further gated at runtime to Cinematic level 2 and above.
   */
  readonly crystalNebulaClumps: boolean;

  // --- Distant Suns / Solar Backdrop ---

  /**
   * Enable the distant-suns solar backdrop layer.
   * Even at Low quality this just blits a pre-baked gradient — very cheap.
   */
  readonly distantSunsEnabled: boolean;
  /**
   * Enable volumetric light rays emanating from the sun (medium / high).
   * Rays are thin tapered triangles; no blur.
   */
  readonly distantSunsRays: boolean;
  /**
   * Enable solar corona arcs and stronger corona shimmer (high only).
   * Drawn as a few stroked partial ellipses.
   */
  readonly distantSunsCorona: boolean;
  /**
   * Enable rare warm lens-glint sparkles near the sun (high only).
   * Each glint is a tiny cross + dot that fades in and out.
   */
  readonly distantSunsGlints: boolean;

  // --- Asteroid Field ---

  /**
   * Number of asteroid field parallax layers to render.
   *   0 = disabled (Low quality)
   *   2 = far + mid layers (Medium quality)
   *   3 = far + mid + foreground (High quality)
   * Sprites are always generated at startup; this only gates drawing.
   */
  readonly asteroidFieldLayers: number;

  /**
   * Enable the warm amber dust haze baked from an offscreen canvas.
   * The haze is drawn with screen blend at low opacity in front of the
   * starfield, simulating illuminated dust around the distant sun.
   */
  readonly dustHazeEnabled: boolean;

  // --- Star Nest WebGL Volumetric Background ---

  /**
   * Enable the GPU-rendered "Star Nest" deep-space volumetric starfield.
   * Disabled on Low to avoid WebGL overhead on slower devices.
   */
  readonly starNestEnabled: boolean;
  /**
   * Fraction (0–1) of the full canvas resolution at which the Star Nest
   * shader renders internally.  The output is upscaled with drawImage().
   * Lower values are cheaper; 0.35–0.60 covers medium/high quality tiers.
   */
  readonly starNestRenderScale: number;
  /**
   * Compositing opacity (0–1) when drawing the Star Nest output onto the
   * 2D canvas.  Keep low to preserve gameplay readability.
   */
  readonly starNestOpacity: number;
  /**
   * Number of ray-marching iterations (compile-time constant baked into GLSL).
   * Higher = denser volumetric detail.  8–12 is the practical range.
   */
  readonly starNestIterations: number;
  /**
   * Number of volumetric-step samples per ray (compile-time constant).
   * Higher = more depth / brightness.  8–12 is the practical range.
   */
  readonly starNestVolsteps: number;
}

export const VISUAL_QUALITY_PRESETS: Record<VisualQuality, VisualQualityPreset> = {
  ultraLow: {
    glowEnabled: false,
    glowScale: 0.1,
    conduitShimmer: false,
    shockwaveScale: 0.25,
    scanlines: false,
    fluidLowGraphics: true,
    bulletGlow: false,
    engineGlow: false,
    colorFringe: false,
    particleScale: 0.12,
    shootingStarsEnabled: false,
    cameraShakeEnabled: false,
    conduitPulseEnabled: false,
    crystalNebulaEnabled: false,
    crystalNebulaDensityScale: 0,
    crystalNebulaGlow: false,
    crystalNebulaInteractionScale: 0,
    crystalNebulaClumps: false,
    distantSunsEnabled: false,
    distantSunsRays: false,
    distantSunsCorona: false,
    distantSunsGlints: false,
    asteroidFieldLayers: 0,
    dustHazeEnabled: false,
    starNestEnabled: false,
    starNestRenderScale: 0.25,
    starNestOpacity: 0,
    starNestIterations: 8,
    starNestVolsteps: 8,
  },
  low: {
    glowEnabled: false,
    glowScale: 0.2,
    conduitShimmer: false,
    shockwaveScale: 0.55,
    scanlines: false,
    fluidLowGraphics: true,
    bulletGlow: false,
    engineGlow: false,
    colorFringe: false,
    particleScale: 0.35,
    shootingStarsEnabled: false,
    cameraShakeEnabled: false,
    conduitPulseEnabled: false,
    crystalNebulaEnabled: false,
    crystalNebulaDensityScale: 0,
    crystalNebulaGlow: false,
    crystalNebulaInteractionScale: 0,
    crystalNebulaClumps: false,
    distantSunsEnabled: true,
    distantSunsRays: false,
    distantSunsCorona: false,
    distantSunsGlints: false,
    asteroidFieldLayers: 0,
    dustHazeEnabled: false,
    starNestEnabled: false,
    // Remaining star nest values are inert when disabled; kept for type completeness.
    starNestRenderScale: 0.35,
    starNestOpacity: 0.10,
    starNestIterations: 8,
    starNestVolsteps: 8,
  },
  medium: {
    glowEnabled: true,
    glowScale: 0.25,
    conduitShimmer: true,
    shockwaveScale: 1,
    scanlines: false,
    fluidLowGraphics: true,
    bulletGlow: true,
    engineGlow: true,
    colorFringe: true,
    particleScale: 0.65,
    shootingStarsEnabled: true,
    cameraShakeEnabled: true,
    conduitPulseEnabled: false,
    crystalNebulaEnabled: true,
    crystalNebulaDensityScale: 0.55,
    crystalNebulaGlow: false,
    crystalNebulaInteractionScale: 0.7,
    crystalNebulaClumps: false,
    distantSunsEnabled: true,
    distantSunsRays: true,
    distantSunsCorona: false,
    distantSunsGlints: false,
    asteroidFieldLayers: 0,
    dustHazeEnabled: false,
    starNestEnabled: true,
    starNestRenderScale: 0.35,
    starNestOpacity: 0.055,
    starNestIterations: 8,
    starNestVolsteps: 8,
  },
  high: {
    glowEnabled: true,
    glowScale: 0.33,
    conduitShimmer: true,
    shockwaveScale: 1.2,
    scanlines: true,
    fluidLowGraphics: false,
    bulletGlow: true,
    engineGlow: true,
    colorFringe: true,
    particleScale: 1.0,
    shootingStarsEnabled: true,
    cameraShakeEnabled: true,
    conduitPulseEnabled: true,
    crystalNebulaEnabled: true,
    crystalNebulaDensityScale: 1.0,
    crystalNebulaGlow: true,
    crystalNebulaInteractionScale: 1.0,
    crystalNebulaClumps: true,
    distantSunsEnabled: true,
    distantSunsRays: true,
    distantSunsCorona: true,
    distantSunsGlints: true,
    asteroidFieldLayers: 0,
    dustHazeEnabled: false,
    starNestEnabled: true,
    starNestRenderScale: 0.50,
    starNestOpacity: 0.085,
    starNestIterations: 11,
    starNestVolsteps: 11,
  },
  ultraHigh: {
    glowEnabled: true,
    glowScale: 0.4,
    conduitShimmer: true,
    shockwaveScale: 1.5,
    scanlines: true,
    fluidLowGraphics: false,
    bulletGlow: true,
    engineGlow: true,
    colorFringe: true,
    particleScale: 1.2,
    shootingStarsEnabled: true,
    cameraShakeEnabled: true,
    conduitPulseEnabled: true,
    crystalNebulaEnabled: true,
    crystalNebulaDensityScale: 1.5,
    crystalNebulaGlow: true,
    crystalNebulaInteractionScale: 1.2,
    crystalNebulaClumps: true,
    distantSunsEnabled: true,
    distantSunsRays: true,
    distantSunsCorona: true,
    distantSunsGlints: true,
    asteroidFieldLayers: 0,
    dustHazeEnabled: false,
    starNestEnabled: true,
    starNestRenderScale: 0.75,
    starNestOpacity: 0.1,
    starNestIterations: 17,
    starNestVolsteps: 20,
  },
};

export const DEFAULT_VISUAL_QUALITY: VisualQuality = 'high';

const VISUAL_QUALITY_STORAGE_KEY = 'sign99_visual_quality';

/** Load the persisted visual quality from localStorage, falling back to the default. */
export function loadVisualQuality(): VisualQuality {
  try {
    const raw = window.localStorage?.getItem(VISUAL_QUALITY_STORAGE_KEY);
    if (raw === 'ultraLow' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'ultraHigh') return raw;
  } catch {
    // localStorage unavailable (e.g. private browsing with strict settings)
  }
  return DEFAULT_VISUAL_QUALITY;
}

/** Persist the given visual quality to localStorage. */
export function saveVisualQuality(quality: VisualQuality): void {
  try {
    window.localStorage?.setItem(VISUAL_QUALITY_STORAGE_KEY, quality);
  } catch {
    // Ignore write failures
  }
}

