import { describe, it, expect, beforeEach } from 'vitest';
import { ResearchLab, CommandPost } from './building.js';
import { Vec2 } from './math.js';
import { Team } from './entities.js';
import { GameState } from './gamestate.js';
import { Camera } from './camera.js';

describe('ResearchLab visual effects, speeds, and orbital dots', () => {
  let lab: ResearchLab;

  beforeEach(() => {
    lab = new ResearchLab(new Vec2(100, 100), Team.Player);
    lab.powered = true;
    lab.buildProgress = 1;
  });

  it('initializes exactly 6 orbital dots with valid configurations', () => {
    expect(lab.orbitalDots).toBeDefined();
    expect(lab.orbitalDots.length).toBe(6);

    for (let i = 0; i < 6; i++) {
      const dot = lab.orbitalDots[i];
      expect(dot.pos).toBeDefined();
      expect(dot.trail).toEqual([]);
      expect(dot.config.speed).not.toBe(0);
      expect(dot.config.lobes).toBeGreaterThanOrEqual(2);
      expect(dot.config.meanR).toBeGreaterThan(0);
    }
  });

  it('runs at 50% idle speed when nothing is being researched', () => {
    expect(lab.isResearching).toBe(false);
    expect(lab.getActivityRate()).toBeCloseTo(0.5, 2);

    const initialSpin = lab.getSpinPhase();
    const initialDot = lab.getDotPhase();

    // Step 1 second at idle
    lab.update(1.0);

    // activityRate remains at 0.5
    expect(lab.getActivityRate()).toBeCloseTo(0.5, 2);

    // Spin rate should be 1.0 rad/s (50% of 2.0 rad/s)
    const spinDelta = lab.getSpinPhase() - initialSpin;
    expect(spinDelta).toBeCloseTo(1.0, 1);

    // Dot phase rate should be 1.35 rad/s (50% of 2.7 rad/s)
    const dotDelta = lab.getDotPhase() - initialDot;
    expect(dotDelta).toBeCloseTo(1.35, 1);
  });

  it('smoothly accelerates to 100% speed when research starts', () => {
    lab.isResearching = true;

    // After a small timestep, speed factor has begun increasing from 0.5
    lab.update(0.2);
    expect(lab.getActivityRate()).toBeGreaterThan(0.5);

    // Over 2 seconds, speed factor smoothly converges to 1.0 (100% speed)
    for (let i = 0; i < 20; i++) {
      lab.update(0.1);
    }
    expect(lab.getActivityRate()).toBeCloseTo(1.0, 1);

    // At full speed, spin rate is ~2.0 rad/s (current fast speed) and dot rate is ~2.7 rad/s
    const spinBefore = lab.getSpinPhase();
    const dotBefore = lab.getDotPhase();
    lab.update(1.0);
    expect(lab.getSpinPhase() - spinBefore).toBeCloseTo(2.0, 1);
    expect(lab.getDotPhase() - dotBefore).toBeCloseTo(2.7, 1);
  });

  it('smoothly decelerates back to 50% speed when research ends', () => {
    // Ramp up to 1.0 first
    lab.isResearching = true;
    for (let i = 0; i < 25; i++) lab.update(0.1);
    expect(lab.getActivityRate()).toBeCloseTo(1.0, 1);

    // Research ends
    lab.isResearching = false;
    lab.update(0.2);
    expect(lab.getActivityRate()).toBeLessThan(1.0);

    // Over 2 seconds, speed factor smoothly converges back to 0.5
    for (let i = 0; i < 25; i++) lab.update(0.1);
    expect(lab.getActivityRate()).toBeCloseTo(0.5, 1);
  });

  it('generates, moves, and caps world-space trails for all 6 dots', () => {
    // Run for several frames so dots traverse world coordinates and build trails
    for (let i = 0; i < 40; i++) {
      lab.update(0.05);
    }

    // All 6 dots should have moved away from lab center and accumulated trails
    for (const dot of lab.orbitalDots) {
      expect(dot.pos.distanceTo(lab.position)).toBeGreaterThan(5);
      expect(dot.trail.length).toBeGreaterThan(0);
      expect(dot.trail.length).toBeLessThanOrEqual(10);

      // Verify each trail point is stored in world coordinates
      for (const sample of dot.trail) {
        expect(sample.pos.x).toBeTypeOf('number');
        expect(sample.pos.y).toBeTypeOf('number');
        expect(sample.age).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('cleans up trail history immediately on destruction', () => {
    for (let i = 0; i < 30; i++) lab.update(0.05);
    expect(lab.orbitalDots.some((d) => d.trail.length > 0)).toBe(true);

    lab.destroy();
    for (const dot of lab.orbitalDots) {
      expect(dot.trail.length).toBe(0);
    }
  });

  it('renders dots and trails without error using Camera transform', () => {
    const camera = new Camera();
    camera.setScreenSize(1280, 720);
    camera.position = new Vec2(100, 100);

    for (let i = 0; i < 20; i++) lab.update(0.05);

    const mockCtx = {
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      beginPath: () => {},
      closePath: () => {},
      arc: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      fill: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      strokeText: () => {},
      fillText: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      canvas: { width: 1280, height: 720 },
    } as unknown as CanvasRenderingContext2D;

    expect(() => lab.draw(mockCtx, camera)).not.toThrow();
  });
});

describe('GameState research activity sync with ResearchLab', () => {
  it('sets isResearching on player ResearchLab when research is queued and active', () => {
    const state = new GameState();
    state.gameMode = 'playing';
    state.factionByTeam.set(Team.Player, 'synonymous');

    const lab = new ResearchLab(new Vec2(200, 200), Team.Player);
    lab.buildProgress = 1;
    state.addEntity(lab);

    expect(lab.isResearching).toBe(false);

    // Queue a research item (e.g. missileturret with valid RESEARCH_TIME)
    state.queueResearch('missileturret');
    state.update(0.1);

    expect(lab.isResearching).toBe(true);

    // Cancel active research
    state.cancelActiveResearch();
    state.update(0.1);

    expect(lab.isResearching).toBe(false);
  });
});
