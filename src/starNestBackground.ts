/**
 * Star Nest — GPU-rendered deep-space volumetric starfield background.
 *
 * Adapted from "Star Nest" by Pablo Roman Andrioli (2013).
 * Original: https://www.shadertoy.com/view/XlfGRj
 * License: MIT
 *
 * Changes from the original Shadertoy:
 *  - Mouse-driven rotation replaced with time drift + camera parallax.
 *  - Colors darkened and desaturated toward deep navy / violet / blue-white
 *    to act as a subtle backdrop rather than a dominant foreground element.
 *  - ITER and VOLSTEPS are compile-time constants generated from quality
 *    presets; the shader is recompiled only when quality changes.
 *  - Renders to an offscreen WebGL canvas at a reduced render scale, then
 *    blitted onto the main 2D canvas with drawImage() — no shared context.
 */

import type { Camera } from './camera.js';
import type { VisualQualityPreset } from './visualquality.js';

// ---------------------------------------------------------------------------
// Vertex shader — full-screen quad
// ---------------------------------------------------------------------------

const VERT_SRC = `#version 100
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Fragment shader factory — ITER and VOLSTEPS baked in at compile time
// ---------------------------------------------------------------------------

function buildFragSrc(iter: number, volsteps: number): string {
  return `#version 100
precision mediump float;

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_camOffset;   // camera world position * parallax scale

// --- Star Nest constants (tuned for Sign99 deep-space aesthetic) ---
#define BRIGHTNESS   0.0015
#define DARKMATTER   0.300
#define DISTFADING   0.730
#define SATURATION   0.850

void main() {
  vec2 uv = (gl_FragCoord.xy / u_resolution.xy) - 0.5;
  uv.y *= u_resolution.y / u_resolution.x;

  // Camera-position driven (no time drift).
  // Slowed down by 5x and inverted Y-axis to match 2D canvas coordinates
  float a1 = 0.45 + u_camOffset.x * 0.0000036;
  float a2 = 0.75 + u_camOffset.y * -0.0000036;

  mat2 rot1 = mat2(cos(a1), sin(a1), -sin(a1), cos(a1));
  mat2 rot2 = mat2(cos(a2), sin(a2), -sin(a2), cos(a2));

  // Increased zoom (2.5) to make stars smaller
  vec3 dir = vec3(uv * 2.5, 1.0);
  dir.xz = rot1 * dir.xz;
  dir.xy = rot2 * dir.xy;

  vec3 from = vec3(1.0, 0.5, 0.5);
  // Replaced time offset with camera offset to drive parallax through space
  // Slowed down by 5x and inverted Y-axis to match 2D canvas coordinates
  from += vec3(u_camOffset.x * 0.0001, u_camOffset.y * -0.0001, -2.0);
  from.xz = rot1 * from.xz;
  from.xy = rot2 * from.xy;

  float s  = 0.1;
  float fade = 1.0;
  vec3  v   = vec3(0.0);

  for (int r = 0; r < ${volsteps}; r++) {
    vec3 p = from + s * dir * 0.5;
    p = abs(vec3(0.850) - mod(p, vec3(1.700)));

    float pa = 0.0;
    float a  = 0.0;
    for (int i = 0; i < ${iter}; i++) {
      p  = abs(p) / dot(p, p) - 0.530;
      a += abs(length(p) - pa);
      pa = length(p);
    }

    // Dark matter - mutes interior bloom
    float dm = max(0.0, DARKMATTER - a * a * 0.001);
    a *= a * a;
    if (r > 6) fade *= 1.0 - dm;

    v += fade;
    v += vec3(s, s * s, s * s * s * s) * a * BRIGHTNESS * fade;
    fade *= DISTFADING;
    s += 0.1;
  }

  v = mix(vec3(length(v)), v, SATURATION);
  gl_FragColor = vec4(v * 0.01, 1.0);
}
`;
}

// ---------------------------------------------------------------------------
// Helper — compile and link a WebGL program
// ---------------------------------------------------------------------------

function compileProgram(
  gl: WebGLRenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram | null {
  function makeShader(type: number, src: string): WebGLShader | null {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[StarNest] shader compile error:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }
  const vert = makeShader(gl.VERTEX_SHADER, vertSrc);
  const frag = makeShader(gl.FRAGMENT_SHADER, fragSrc);
  if (!vert || !frag) return null;

  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[StarNest] program link error:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

// ---------------------------------------------------------------------------
// StarNestBackground
// ---------------------------------------------------------------------------

interface CompiledShader {
  prog: WebGLProgram;
  aPos: number;
  uTime: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uCamOffset: WebGLUniformLocation | null;
}

export class StarNestBackground {
  /** Offscreen canvas owned by this module. */
  private offscreen: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private quadBuf: WebGLBuffer | null = null;
  private shader: CompiledShader | null = null;

  /** Current preset values — used to detect when recompile is needed. */
  private curIter = 0;
  private curVolsteps = 0;
  private curOpacity = 0;
  private curEnabled = false;

  /** Accumulated game time in seconds. */
  private time = 0;

  /** Latest camera world position. */
  private camX = 0;
  private camY = 0;

  /** Current logical screen size and render scale. */
  private logicalW = 1;
  private logicalH = 1;
  private renderScale = 0.35;

  /** True if WebGL init succeeded; false means fallback (no-op). */
  private ready = false;

  constructor() {
    this.offscreen = document.createElement('canvas');
    this.offscreen.style.display = 'none';
    this._initGL();
  }

  // -------------------------------------------------------------------------
  // WebGL initialisation
  // -------------------------------------------------------------------------

  private _initGL(): void {
    const canvas = this.offscreen;
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = (canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false }) as WebGLRenderingContext | null)
        ?? (canvas.getContext('experimental-webgl', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false }) as WebGLRenderingContext | null);
    } catch {
      // context creation can throw on some browsers
    }
    if (!gl) {
      console.warn('[StarNest] WebGL unavailable — disabling Star Nest background.');
      return;
    }
    this.gl = gl;

    // Full-screen triangle-strip quad: two triangles covering NDC [-1,1]
    const verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const buf = gl.createBuffer();
    if (!buf) { this.gl = null; return; }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    this.quadBuf = buf;

    this.ready = true;
  }

  // -------------------------------------------------------------------------
  // Shader compilation (called when quality preset changes)
  // -------------------------------------------------------------------------

  private _compileForPreset(iter: number, volsteps: number): boolean {
    const gl = this.gl;
    if (!gl) return false;

    if (this.shader) {
      gl.deleteProgram(this.shader.prog);
      this.shader = null;
    }

    const prog = compileProgram(gl, VERT_SRC, buildFragSrc(iter, volsteps));
    if (!prog) return false;

    this.shader = {
      prog,
      aPos: gl.getAttribLocation(prog, 'a_pos'),
      uTime: gl.getUniformLocation(prog, 'u_time'),
      uResolution: gl.getUniformLocation(prog, 'u_resolution'),
      uCamOffset: gl.getUniformLocation(prog, 'u_camOffset'),
    };
    this.curIter = iter;
    this.curVolsteps = volsteps;
    return true;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Apply a visual quality preset.  Recompiles shaders only when iteration
   *  counts change (or on first enable). */
  configure(preset: VisualQualityPreset): void {
    this.curEnabled = preset.starNestEnabled;
    this.renderScale = preset.starNestRenderScale;
    this.curOpacity  = preset.starNestOpacity;

    if (!this.curEnabled || !this.ready) return;

    const needRecompile =
      preset.starNestIterations !== this.curIter ||
      preset.starNestVolsteps   !== this.curVolsteps;

    if (needRecompile) {
      const ok = this._compileForPreset(
        preset.starNestIterations,
        preset.starNestVolsteps,
      );
      if (!ok) {
        console.warn('[StarNest] Shader compilation failed — disabling.');
        this.ready = false;
      }
    }
  }

  /** Resize the offscreen canvas to match the new logical screen dimensions. */
  resize(logicalW: number, logicalH: number): void {
    this.logicalW = logicalW;
    this.logicalH = logicalH;
    this._updateCanvasSize();
  }

  private _updateCanvasSize(): void {
    const w = Math.max(1, Math.round(this.logicalW * this.renderScale));
    const h = Math.max(1, Math.round(this.logicalH * this.renderScale));
    if (this.offscreen.width !== w || this.offscreen.height !== h) {
      this.offscreen.width  = w;
      this.offscreen.height = h;
      if (this.gl) this.gl.viewport(0, 0, w, h);
    }
  }

  /** Advance internal time and record latest camera position. */
  update(dt: number, camera: Camera): void {
    this.time += dt;
    this.camX = camera.position.x;
    this.camY = camera.position.y;
  }

  /**
   * Render the Star Nest shader to the offscreen canvas and composite it
   * onto the main 2D canvas using drawImage.  Should be called once per
   * frame, after the solid background fill and before drawing stars / suns.
   */
  drawTo(ctx: CanvasRenderingContext2D, logicalW: number, logicalH: number): void {
    if (!this.curEnabled || !this.ready || !this.gl || !this.shader || !this.quadBuf) return;

    const gl = this.gl;
    const sh = this.shader;

    const rw = this.offscreen.width;
    const rh = this.offscreen.height;

    gl.viewport(0, 0, rw, rh);
    gl.useProgram(sh.prog);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(sh.aPos);
    gl.vertexAttribPointer(sh.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1f(sh.uTime, this.time);
    gl.uniform2f(sh.uResolution, rw, rh);
    gl.uniform2f(sh.uCamOffset, this.camX, this.camY);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Composite onto 2D canvas
    ctx.save();
    ctx.globalAlpha = this.curOpacity;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.offscreen, 0, 0, logicalW, logicalH);
    ctx.restore();
  }
}
