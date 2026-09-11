/** Example procedural ship designs demonstrating the design space. */

import type { ProceduralShipDefinition, ProceduralShipParams } from './proceduralShips.js';
import { DEFAULT_PARAMS } from './proceduralShips.js';

function p(overrides: Partial<ProceduralShipParams>): ProceduralShipParams {
  return { ...DEFAULT_PARAMS, ...overrides };
}

export const SHIP_PRESETS: { name: string; def: ProceduralShipDefinition }[] = [
  {
    name: 'Manta',
    def: {
      seed: 1101,
      params: p({
        length: 120, spanToLength: 1.9, tipSweep: 0.26, tailNotch: 0.22,
        structureDepth: 3, gasketBias: 0.52,
        budCount: 2, budScale: 0.13, budFalloff: 2.2, budTwist: 0.18, budDepth: 0, budEmbed: 0.5,
        wingPairs: 1, wingStation: 0.42, wingSweep: 0.12, wingChord: 0.3, wingSpan: 0.12,
        finCount: 2, finLength: 0.2, finSpread: 0.14,
        shadeDepthMix: 0.6, hueSpread: 38, accentAmount: 0.65, coreSize: 0.06,
      }),
    },
  },
  {
    name: 'Seahorse',
    def: {
      seed: 2202,
      params: p({
        length: 130, spanToLength: 1.3, tipSweep: 0.34, tailNotch: 0.16,
        structureDepth: 2, gasketBias: 0.42,
        budCount: 5, budScale: 0.13, budFalloff: 2.1, budTwist: 0.62, budDepth: 2, budEmbed: 0.5,
        wingPairs: 0, wingStation: 0.4, wingSweep: 0.16, wingChord: 0.25, wingSpan: 0.14,
        finCount: 1, finLength: 0.22, finSpread: 0.4,
        shadeDepthMix: 0.72, hueSpread: 48, accentAmount: 0.9, coreSize: 0.05,
      }),
    },
  },
  {
    name: 'Gasket',
    def: {
      seed: 3303,
      params: p({
        length: 120, spanToLength: 1.55, tipSweep: 0.2, tailNotch: 0.1,
        structureDepth: 4, gasketBias: 0.5,
        budCount: 1, budScale: 0.1, budFalloff: 2.4, budTwist: 0, budDepth: 0, budEmbed: 0.45,
        wingPairs: 0, wingStation: 0.4, wingSweep: 0.14, wingChord: 0.24, wingSpan: 0.12,
        finCount: 0, finLength: 0.2, finSpread: 0.12,
        shadeBands: 8, shadeDepthMix: 0.82, hueSpread: 30, accentAmount: 0.5, coreSize: 0.045,
      }),
    },
  },
  {
    name: 'Dart',
    def: {
      seed: 4404,
      params: p({
        length: 170, spanToLength: 0.62, tipSweep: 0.2, tailNotch: 0.1,
        structureDepth: 3, gasketBias: 0.6,
        budCount: 3, budScale: 0.14, budFalloff: 2.3, budTwist: 0.22, budDepth: 1, budEmbed: 0.5,
        wingPairs: 1, wingStation: 0.55, wingSweep: 0.2, wingChord: 0.22, wingSpan: 0.3,
        finCount: 1, finLength: 0.18, finSpread: 0.08,
        shadeDepthMix: 0.58, hueSpread: 26, accentAmount: 0.8, coreSize: 0.05,
      }),
    },
  },
  {
    name: 'Cathedral',
    def: {
      seed: 5505,
      params: p({
        length: 135, spanToLength: 1.6, tipSweep: 0.36, tailNotch: 0.26,
        structureDepth: 3, gasketBias: 0.44,
        budCount: 3, budScale: 0.15, budFalloff: 2.0, budTwist: 0.35, budDepth: 1, budEmbed: 0.55,
        wingPairs: 2, wingStation: 0.3, wingSweep: 0.14, wingChord: 0.26, wingSpan: 0.1,
        finCount: 3, finLength: 0.2, finSpread: 0.3,
        shadeBands: 8, shadeDepthMix: 0.55, hueSpread: 44, accentAmount: 1, coreSize: 0.095,
      }),
    },
  },
  {
    name: 'Spearhead',
    def: {
      seed: 6606,
      params: p({
        length: 200, spanToLength: 0.45, tipSweep: 0.14, tailNotch: 0.06,
        structureDepth: 4, gasketBias: 0.66,
        budCount: 4, budScale: 0.11, budFalloff: 2.6, budTwist: -0.3, budDepth: 1, budEmbed: 0.45,
        wingPairs: 1, wingStation: 0.62, wingSweep: 0.1, wingChord: 0.18, wingSpan: 0.45,
        finCount: 2, finLength: 0.16, finSpread: 0.12,
        shadeDepthMix: 0.7, hueSpread: 32, accentAmount: 0.75, coreSize: 0.04,
      }),
    },
  },
];
