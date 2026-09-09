/** Input manager – tracks keyboard and mouse state for Sign99 */

import { Vec2 } from './math.js';

const DOUBLE_TAP_WINDOW_MS = 200;
const KEYBIND_STORAGE_KEY = 'sign99:keybinds';

export const KEYBIND_DEFINITIONS = [
  { key: 'w', label: 'Move Up' }, { key: 's', label: 'Move Down' },
  { key: 'a', label: 'Move Left' }, { key: 'd', label: 'Move Right' },
  { key: 'Shift', label: 'Boost / Brake' }, { key: 'Tab', label: 'Full-screen Radar' },
  { key: 'c', label: 'Command Mode' }, { key: 'q', label: 'Action Menu' },
  { key: 'z', label: 'Alternate Action' },
  { key: '1', label: 'Command / Build Slot 1' }, { key: '2', label: 'Command / Build Slot 2' },
  { key: '3', label: 'Command / Build Slot 3' }, { key: '4', label: 'Command / Build Slot 4' },
  { key: 'n', label: 'Next Target / Unit' }, { key: 'Escape', label: 'Menu / Pause' },
] as const;
export type BindableKey = typeof KEYBIND_DEFINITIONS[number]['key'];

class InputManager {
  private keysDown = new Set<string>();
  private keysPressed = new Set<string>();
  private keysReleased = new Set<string>();

  /** Printable characters typed this frame (for text input fields). */
  typedChars: string = '';

  /** Timestamps of the last key-up per key, used for double-tap detection. */
  private lastReleaseTimes = new Map<string, number>();
  private doubleTapped = new Set<string>();
  /** Fired when a key is pressed for the second time within the double-tap window (double-tap-then-hold). */
  private doubleTapDown = new Set<string>();
  private bindings = new Map<string, string>();

  mousePos = new Vec2(0, 0);
  mouseDown = false;
  mousePressed = false;
  mouseReleased = false;
  /** Right mouse button */
  mouse2Down = false;
  mouse2Pressed = false;
  mouse2Released = false;
  /** Middle mouse button / wheel click */
  mouse3Down = false;
  mouse3Pressed = false;
  mouse3Released = false;
  wheelDelta = 0;

  private touchMoveVec = new Vec2(0, 0);
  private touchFireVec = new Vec2(0, 0);
  private touchPrimaryCenter = new Vec2(0, 0);
  private touchSecondaryCenter = new Vec2(0, 0);
  private touchPrimaryActive = false;
  private touchSecondaryActive = false;
  private touchPrimaryIdMutable: number | null = null;
  private touchSecondaryIdMutable: number | null = null;
  private readonly touchDeadZone = 0.2;
  private readonly touchStickMaxRadiusPx = 72;

  constructor() {
    this.loadBindings();
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('mousemove', this.onMouseMove);
      window.addEventListener('mousedown', this.onMouseDown);
      window.addEventListener('mouseup', this.onMouseUp);
      window.addEventListener('wheel', this.onWheel, { passive: false });
      window.addEventListener('contextmenu', (e) => e.preventDefault());
      window.addEventListener('touchstart', this.onTouchStart, { passive: false });
      window.addEventListener('touchmove', this.onTouchMove, { passive: false });
      window.addEventListener('touchend', this.onTouchEnd, { passive: false });
      window.addEventListener('touchcancel', this.onTouchEnd, { passive: false });
    }
  }

  private loadBindings(): void {
    for (const item of KEYBIND_DEFINITIONS) this.bindings.set(item.key, this.normalizeKey(item.key));
    try {
      const saved = JSON.parse(window.localStorage?.getItem(KEYBIND_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
      for (const item of KEYBIND_DEFINITIONS) {
        if (typeof saved[item.key] === 'string' && saved[item.key]) this.bindings.set(item.key, this.normalizeKey(saved[item.key]));
      }
    } catch { /* Invalid or unavailable storage: defaults remain active. */ }
  }

  private resolveKey(key: string): string {
    return this.bindings.get(key) ?? this.normalizeKey(key);
  }

  getBinding(key: BindableKey): string { return this.bindings.get(key) ?? this.normalizeKey(key); }

  setBinding(key: BindableKey, value: string): void {
    const normalized = this.normalizeKey(value);
    // Keep bindings unambiguous: swap with whichever action already owns this key.
    const previous = this.getBinding(key);
    for (const [action, bound] of this.bindings) if (action !== key && bound === normalized) this.bindings.set(action, previous);
    this.bindings.set(key, normalized);
    try { window.localStorage?.setItem(KEYBIND_STORAGE_KEY, JSON.stringify(Object.fromEntries(this.bindings))); } catch { /* optional */ }
  }

  resetBindings(): void {
    for (const item of KEYBIND_DEFINITIONS) this.bindings.set(item.key, this.normalizeKey(item.key));
    try { window.localStorage?.removeItem(KEYBIND_STORAGE_KEY); } catch { /* optional */ }
  }

  /** Raw physical keys pressed this frame, used by the key-capture settings UI. */
  pressedKeys(): string[] { return [...this.keysPressed]; }

  private clampStickVector(dx: number, dy: number): Vec2 {
    const mag = Math.hypot(dx, dy);
    if (mag <= 0) return new Vec2(0, 0);
    const clamped = Math.min(1, mag / this.touchStickMaxRadiusPx);
    return new Vec2((dx / mag) * clamped, (dy / mag) * clamped);
  }

  private onTouchStart = (e: TouchEvent): void => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches.item(i);
      if (!t) continue;
      if (this.touchPrimaryIdMutable === null) {
        this.touchPrimaryIdMutable = t.identifier;
        this.touchPrimaryCenter.set(t.clientX, t.clientY);
        this.touchMoveVec.set(0, 0);
        this.touchPrimaryActive = true;
      } else if (this.touchSecondaryIdMutable === null) {
        this.touchSecondaryIdMutable = t.identifier;
        this.touchSecondaryCenter.set(t.clientX, t.clientY);
        this.touchFireVec.set(0, 0);
        this.touchSecondaryActive = true;
      }
    }
    e.preventDefault();
  };

  private onTouchMove = (e: TouchEvent): void => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches.item(i);
      if (!t) continue;
      if (t.identifier === this.touchPrimaryIdMutable) {
        this.touchMoveVec = this.clampStickVector(t.clientX - this.touchPrimaryCenter.x, t.clientY - this.touchPrimaryCenter.y);
      } else if (t.identifier === this.touchSecondaryIdMutable) {
        this.touchFireVec = this.clampStickVector(t.clientX - this.touchSecondaryCenter.x, t.clientY - this.touchSecondaryCenter.y);
      }
    }
    e.preventDefault();
  };

  private onTouchEnd = (e: TouchEvent): void => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches.item(i);
      if (!t) continue;
      if (t.identifier === this.touchPrimaryIdMutable) {
        this.touchPrimaryIdMutable = null;
        this.touchMoveVec.set(0, 0);
        this.touchPrimaryActive = false;
      } else if (t.identifier === this.touchSecondaryIdMutable) {
        this.touchSecondaryIdMutable = null;
        this.touchFireVec.set(0, 0);
        this.touchSecondaryActive = false;
        // Clear mouseDown immediately on finger-lift so fire stops the same
        // frame rather than waiting until update() runs.  On a touch-only
        // device the mouse button is never set by hardware, so this is safe.
        this.mouseDown = false;
      }
    }
    e.preventDefault();
  };

  /**
   * Normalize a key name so that modifier-shifted letter keys (e.g. 'W' when
   * Shift is held) are stored the same way as their unshifted counterpart
   * ('w'). This prevents the well-known browser quirk where releasing Shift
   * while a letter key is still held fires a keyup for the *unshifted* key
   * ('w') even though the *shifted* name ('W') is what was pressed — leaving
   * 'W' permanently stuck in keysDown until the next keydown cycle.
   */
  private normalizeKey(key: string): string {
    if (key.length === 1) return key.toLowerCase();
    return key;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const key = this.normalizeKey(e.key);
    // Tab and certain keys would otherwise move browser focus / scroll the page.
    // We use Tab as the full-screen radar hold key, so suppress its default.
    if (e.key === 'Tab') e.preventDefault();
    if (!this.keysDown.has(key)) {
      this.keysPressed.add(key);
      // Detect second press within the double-tap window (for double-tap-then-hold)
      const now = performance.now();
      const prevRelease = this.lastReleaseTimes.get(key);
      if (prevRelease !== undefined && now - prevRelease < DOUBLE_TAP_WINDOW_MS) {
        this.doubleTapDown.add(key);
      }
    }
    this.keysDown.add(key);
    // Capture printable characters for text input fields.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      this.typedChars += e.key;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const key = this.normalizeKey(e.key);
    this.keysDown.delete(key);
    this.keysReleased.add(key);

    const now = performance.now();
    const prev = this.lastReleaseTimes.get(key);
    if (prev !== undefined && now - prev < DOUBLE_TAP_WINDOW_MS) {
      this.doubleTapped.add(key);
    }
    this.lastReleaseTimes.set(key, now);
  };

  private onMouseMove = (e: MouseEvent): void => {
    this.mousePos.set(e.clientX, e.clientY);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.mouseDown = true;
      this.mousePressed = true;
    } else if (e.button === 2) {
      this.mouse2Down = true;
      this.mouse2Pressed = true;
    } else if (e.button === 1) {
      e.preventDefault();
      this.mouse3Down = true;
      this.mouse3Pressed = true;
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.mouseDown = false;
      this.mouseReleased = true;
    } else if (e.button === 2) {
      this.mouse2Down = false;
      this.mouse2Released = true;
    } else if (e.button === 1) {
      this.mouse3Down = false;
      this.mouse3Released = true;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    this.wheelDelta += e.deltaY;
    e.preventDefault();
  };

  /** True while the key is held down. */
  isDown(key: string): boolean {
    // When the movement joystick is actively being used, map w/a/s/d to the
    // stick vector so touch drives the ship just like keyboard.  The keyboard
    // fallback below remains active so desktop users (or touchscreen-laptop
    // users who aren't currently touching) always get normal key responses.
    if (this.touchPrimaryActive) {
      const k = this.normalizeKey(key);
      if (k === 'a') return this.touchMoveVec.x < -this.touchDeadZone;
      if (k === 'd') return this.touchMoveVec.x > this.touchDeadZone;
      if (k === 'w') return this.touchMoveVec.y < -this.touchDeadZone;
      if (k === 's') return this.touchMoveVec.y > this.touchDeadZone;
    }
    return this.keysDown.has(this.resolveKey(key));
  }

  getMoveVector(): Vec2 {
    return this.touchMoveVec.clone();
  }

  drawTouchJoysticks(ctx: CanvasRenderingContext2D): void {
    if (!this.touchPrimaryActive && !this.touchSecondaryActive) return;
    const drawStick = (center: Vec2, vec: Vec2, color: string): void => {
      const baseR = this.touchStickMaxRadiusPx;
      const knobR = 28;
      const knobX = center.x + vec.x * baseR;
      const knobY = center.y + vec.y * baseR;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = `${color}33`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(center.x, center.y, baseR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = `${color}99`;
      ctx.beginPath();
      ctx.arc(knobX, knobY, knobR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    if (this.touchPrimaryActive) drawStick(this.touchPrimaryCenter, this.touchMoveVec, '#52d0ff');
    if (this.touchSecondaryActive) drawStick(this.touchSecondaryCenter, this.touchFireVec, '#ff7a52');
  }

  /** True only on the frame the key was first pressed. */
  wasPressed(key: string): boolean {
    return this.keysPressed.has(this.resolveKey(key));
  }

  /** True only on the frame the key was released. */
  wasReleased(key: string): boolean {
    return this.keysReleased.has(this.resolveKey(key));
  }

  /** True if the key was released twice within the double-tap window this frame. */
  isDoubleTapped(key: string): boolean {
    return this.doubleTapped.has(this.resolveKey(key));
  }

  /** True on the frame the key is pressed for the second time quickly (double-tap-then-hold). */
  isDoubleTapDown(key: string): boolean {
    return this.doubleTapDown.has(this.resolveKey(key));
  }

  /**
   * Consume a mouse button's state so it doesn't bleed through to other
   * subsystems on the same frame (e.g. closing a radial menu with RMB should
   * not also fire a special ability).
   */
  consumeMouseButton(button: 0 | 1 | 2): void {
    if (button === 0) {
      this.mouseDown = false;
      this.mousePressed = false;
    } else if (button === 2) {
      this.mouse2Down = false;
      this.mouse2Pressed = false;
    } else {
      this.mouse3Down = false;
      this.mouse3Pressed = false;
    }
  }

  /**
   * Remove a key from the held/pressed sets so it doesn't bleed through to
   * other subsystems on the same frame (e.g. after a menu consumes an arrow-key press).
   */
  consumeKey(key: string): void {
    const k = this.normalizeKey(key);
    this.keysDown.delete(k);
    this.keysPressed.delete(k);
  }

  /** Call once per frame after processing input to reset per-frame states. */
  update(): void {
    // When any touch is active, let the joysticks drive mouse state so the
    // rest of the game (weapon firing, aim) works without changes.  We only
    // do this while touches are live so desktop keyboard+mouse is never
    // overridden on devices where maxTouchPoints > 0 but touch is not in use.
    if (this.touchPrimaryActive || this.touchSecondaryActive) {
      const fireMag = Math.hypot(this.touchFireVec.x, this.touchFireVec.y);
      this.mouseDown = this.touchSecondaryActive && fireMag > this.touchDeadZone;
      if (this.touchSecondaryActive) {
        this.mousePos.set(
          this.touchSecondaryCenter.x + this.touchFireVec.x * this.touchStickMaxRadiusPx,
          this.touchSecondaryCenter.y + this.touchFireVec.y * this.touchStickMaxRadiusPx,
        );
      }
    }
    this.keysPressed.clear();
    this.keysReleased.clear();
    this.doubleTapped.clear();
    this.doubleTapDown.clear();
    this.mousePressed = false;
    this.mouseReleased = false;
    this.mouse2Pressed = false;
    this.mouse2Released = false;
    this.mouse3Pressed = false;
    this.mouse3Released = false;
    this.wheelDelta = 0;
    this.typedChars = '';
  }

  destroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('mousemove', this.onMouseMove);
      window.removeEventListener('mousedown', this.onMouseDown);
      window.removeEventListener('mouseup', this.onMouseUp);
      window.removeEventListener('wheel', this.onWheel);
      window.removeEventListener('touchstart', this.onTouchStart);
      window.removeEventListener('touchmove', this.onTouchMove);
      window.removeEventListener('touchend', this.onTouchEnd);
      window.removeEventListener('touchcancel', this.onTouchEnd);
    }
  }
}

export const Input = new InputManager();
