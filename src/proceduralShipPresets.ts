/** Example procedural ship designs demonstrating the design space. */

import type { ProceduralShipDefinition, ProceduralShipParams } from './proceduralShips.js';
import { DEFAULT_PARAMS } from './proceduralShips.js';

function p(overrides: Partial<ProceduralShipParams>): ProceduralShipParams {
  return { ...DEFAULT_PARAMS, ...overrides };
}

export const SHIP_PRESETS: { name: string; def: ProceduralShipDefinition }[] = [
  {
    name: 'Needle',
    def: {
      seed: 1001,
      params: p({
        length: 220, maxWidth: 18, noseSharpness: 4.5, tailWidth: 0.15, widestPoint: 0.7,
        edgeCurve: 1.4, ribCount: 2, ribCurvature: 0.15, ribInset: 0.2, spineThickness: 0.6,
        corePosition: 0.6, coreSize: 3, innerStructureDensity: 3, lineThickness: 1, glowAmount: 0.6,
        hullFillOpacity: 0.08, interiorLineOpacity: 0.35,
      }),
    },
  },
  {
    name: 'Spear',
    def: {
      seed: 2002,
      params: p({
        length: 160, maxWidth: 46, noseSharpness: 3.2, tailWidth: 0.2, widestPoint: 0.55,
        edgeCurve: 1.0, ribCount: 5, ribCurvature: 0.4, ribInset: 0.12, spineThickness: 1.2,
        corePosition: 0.5, coreSize: 7, innerStructureDensity: 8, lineThickness: 1.5, glowAmount: 0.4,
        hullFillOpacity: 0.14, interiorLineOpacity: 0.5,
      }),
    },
  },
  {
    name: 'Cathedral',
    def: {
      seed: 3003,
      params: p({
        length: 190, maxWidth: 70, noseSharpness: 1.6, tailWidth: 0.45, widestPoint: 0.4,
        edgeCurve: 0.7, edgeWaveAmplitude: 0.06, edgeWaveFrequency: 4, ribCount: 8, ribCurvature: 0.6,
        ribInset: 0.08, spineThickness: 1.5, corePosition: 0.45, coreSize: 12, innerStructureDensity: 16,
        lineThickness: 1.6, glowAmount: 0.5, hullFillOpacity: 0.18, interiorLineOpacity: 0.65,
      }),
    },
  },
  {
    name: 'Manta',
    def: {
      seed: 4004,
      params: p({
        length: 130, maxWidth: 110, noseSharpness: 1.1, tailWidth: 0.6, widestPoint: 0.3,
        edgeCurve: 0.6, edgeWaveAmplitude: 0.03, edgeWaveFrequency: 2, ribCount: 6, ribCurvature: -0.5,
        ribInset: 0.1, spineThickness: 1, corePosition: 0.35, coreSize: 9, innerStructureDensity: 10,
        lineThickness: 1.3, glowAmount: 0.45, hullFillOpacity: 0.2, interiorLineOpacity: 0.55,
      }),
    },
  },
  {
    name: 'Fractal',
    def: {
      seed: 5005,
      params: p({
        length: 150, maxWidth: 55, noseSharpness: 2.6, tailWidth: 0.3, widestPoint: 0.6,
        edgeCurve: 1.1, edgeWaveAmplitude: 0.12, edgeWaveFrequency: 7, edgeWavePhase: 0.8,
        ribCount: 10, ribCurvature: 0.25, ribInset: 0.05, spineThickness: 1, corePosition: 0.55,
        coreSize: 6, innerStructureDensity: 22, asymmetry: 0.04, lineThickness: 1.1, glowAmount: 0.55,
        hullFillOpacity: 0.1, interiorLineOpacity: 0.7,
      }),
    },
  },
];
