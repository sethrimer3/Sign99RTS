import { describe, it, expect } from 'vitest';
import {
  GhostShipEffect,
  GHOST_FRAGMENT_CAP,
  GHOST_COOL_MIN,
  GHOST_COOL_MAX,
  ghostRecursionLevels,
} from './ghostShipEffect.js';

const TEAM = { r: 60, g: 140, b: 220, intensity: 1 };
const DT = 1 / 60;

/** Run the ghost along a fixed anchor path so two effects see identical input. */
function drive(effect: GhostShipEffect, seconds: number, speed = 300): void {
  let x = 1000, y = 1000;
  for (let t = 0; t < seconds; t += DT) {
    x += speed * DT;
    y += Math.sin(t * 1.3) * speed * 0.4 * DT;
    effect.update(DT, x, y, Math.atan2(Math.sin(t * 1.3) * 0.4, 1));
  }
}

function make(seed: number): GhostShipEffect {
  const effect = new GhostShipEffect();
  effect.reset(1000, 1000, 0, seed, 22, TEAM);
  return effect;
}

describe('GhostShipEffect', () => {
  it('grows identical geometry and parameters from the same seed', () => {
    const a = make(12345);
    const b = make(12345);
    drive(a, 3);
    drive(b, 3);
    expect(a.writtenCount).toBeGreaterThan(20);
    expect(a.writtenCount).toBe(b.writtenCount);
    for (let i = 0; i < a.writtenCount; i++) {
      expect(a.fragmentVertices(i)).toEqual(b.fragmentVertices(i));
      expect(a.fragmentCoolDuration(i)).toBe(b.fragmentCoolDuration(i));
    }
  });

  it('varies with the seed', () => {
    const a = make(1);
    const b = make(2);
    drive(a, 1);
    drive(b, 1);
    const n = Math.min(a.writtenCount, b.writtenCount);
    let differing = 0;
    for (let i = 0; i < n; i++) {
      const va = a.fragmentVertices(i), vb = b.fragmentVertices(i);
      if (va.some((v, k) => v !== vb[k])) differing++;
    }
    expect(differing).toBeGreaterThan(n * 0.5);
  });

  it('never moves a fragment after it is born', () => {
    const effect = make(777);
    drive(effect, 1);
    const snapshot = Array.from({ length: effect.writtenCount }, (_, i) => effect.fragmentVertices(i));
    // Keep driving, but not so long that the ring wraps and legitimately overwrites slots.
    const before = effect.writtenCount;
    drive(effect, 0.5, 60);
    expect(effect.writtenCount).toBeLessThan(GHOST_FRAGMENT_CAP);
    for (let i = 0; i < before; i++) expect(effect.fragmentVertices(i)).toEqual(snapshot[i]);
  });

  it('draws every white-to-faction transition from the 1–4 s range', () => {
    const effect = make(99);
    drive(effect, 4, 500);
    expect(effect.writtenCount).toBeGreaterThan(100);
    for (let i = 0; i < effect.writtenCount; i++) {
      const cool = effect.fragmentCoolDuration(i);
      expect(cool).toBeGreaterThanOrEqual(GHOST_COOL_MIN);
      expect(cool).toBeLessThanOrEqual(GHOST_COOL_MAX);
    }
  });

  it('eases alpha in at birth and cleanly to zero at the tail', () => {
    const effect = make(5);
    const slot = 0; // the very first fragment, born at reset()
    expect(effect.fragmentAlpha(slot)).toBe(0);
    effect.update(DT, 1000, 1000, 0);
    const early = effect.fragmentAlpha(slot);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(1);
    // Hold the anchor still; the head still curls so emission continues but the slot lives.
    let peak = 0;
    let last = 1;
    let reachedZero = false;
    let monotoneTail = true;
    for (let t = 0; t < 12; t += DT) {
      effect.update(DT, 1000, 1000, 0);
      const a = effect.fragmentAlpha(slot);
      peak = Math.max(peak, a);
      if (a > last + 1e-6 && peak >= 0.999) monotoneTail = false;
      if (peak >= 0.999) last = a;
      if (a === 0 && peak > 0) { reachedZero = true; break; }
    }
    expect(peak).toBeGreaterThanOrEqual(0.999);
    expect(reachedZero).toBe(true);
    expect(monotoneTail).toBe(true);
  });

  it('never exceeds the fragment cap even when driven hard', () => {
    const effect = make(31337);
    for (let t = 0; t < 30; t += DT) {
      effect.update(DT, 1000 + t * 1200, 1000, 0);
      expect(effect.activeCount).toBeLessThanOrEqual(GHOST_FRAGMENT_CAP);
      expect(effect.writtenCount).toBeLessThanOrEqual(GHOST_FRAGMENT_CAP);
    }
    expect(effect.activeCount).toBeGreaterThan(0);
  });

  it('emits fewer fragments at lower density scale', () => {
    const full = make(8);
    const low = make(8);
    low.setParticleScale(0.35);
    drive(full, 3);
    drive(low, 3);
    expect(low.writtenCount).toBeLessThan(full.writtenCount * 0.6);
    expect(ghostRecursionLevels(1)).toBe(3);
    expect(ghostRecursionLevels(0.6)).toBe(2);
    expect(ghostRecursionLevels(0.2)).toBe(1);
  });

  it('clears all visual state on reset/respawn', () => {
    const effect = make(4);
    drive(effect, 2);
    expect(effect.activeCount).toBeGreaterThan(0);
    effect.clear();
    expect(effect.active).toBe(false);
    expect(effect.activeCount).toBe(0);
    expect(effect.writtenCount).toBe(0);
    expect(effect.fragmentAlpha(0)).toBe(0);
    // A cleared effect ignores updates until reset() begins a new ghost.
    effect.update(DT, 5, 5, 0);
    expect(effect.writtenCount).toBe(0);
  });
});
