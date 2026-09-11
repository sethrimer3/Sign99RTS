/** Example procedural ship designs demonstrating the design space. */

import type { ProceduralShipDefinition, ProceduralShipParams } from './proceduralShips.js';
import { DEFAULT_PARAMS } from './proceduralShips.js';

function p(overrides: Partial<ProceduralShipParams>): ProceduralShipParams {
  return { ...DEFAULT_PARAMS, ...overrides };
}

export const SHIP_PRESETS: { name: string; def: ProceduralShipDefinition }[] = [
  {
    name: 'Lance',
    def: {
      seed: 1101,
      params: p({
        length: 150, spanToLength: 0.6, tipSweep: 0.26, tailNotch: 0.16,
        structureDepth: 3, gasketBias: 0.52,
        budCount: 3, budScale: 0.12, budFalloff: 2.2, budTwist: 0.22, budDepth: 1, budEmbed: 0.5,
        wingPairs: 1, wingElements: 2, wingStation: 0.36, wingGroupGap: 0.1,
        wingSweep: 0.14, wingChord: 0.2, wingSpan: 0.32, wingRake: 0.35,
        wingDetail: 3, wingBuds: 2, wingSerration: 0.5,
        finCount: 2, finLength: 0.2, finSpread: 0.3,
        shadeDepthMix: 0.3, hueSpread: 38, accentAmount: 0.65, coreSize: 0.05,
      }),
    },
  },
  {
    name: 'Seahorse',
    def: {
      seed: 2202,
      params: p({
        length: 160, spanToLength: 0.55, tipSweep: 0.34, tailNotch: 0.14,
        structureDepth: 2, gasketBias: 0.42,
        budCount: 5, budScale: 0.16, budFalloff: 2.1, budTwist: 0.62, budDepth: 2, budEmbed: 0.5,
        wingPairs: 2, wingElements: 1, wingStation: 0.5, wingGroupGap: 0.14,
        wingSweep: 0.18, wingChord: 0.22, wingSpan: 0.26, wingRake: 0.3,
        wingDetail: 2, wingBuds: 3, wingSerration: 0.3,
        finCount: 1, finLength: 0.22, finSpread: 0.4,
        shadeDepthMix: 0.32, hueSpread: 48, accentAmount: 0.9, coreSize: 0.05,
      }),
    },
  },
  {
    name: 'Gasket',
    def: {
      seed: 3303,
      params: p({
        length: 145, spanToLength: 0.72, tipSweep: 0.2, tailNotch: 0.08,
        structureDepth: 4, gasketBias: 0.5,
        budCount: 2, budScale: 0.1, budFalloff: 2.4, budTwist: 0.1, budDepth: 0, budEmbed: 0.45,
        wingPairs: 1, wingElements: 2, wingStation: 0.42, wingGroupGap: 0.1,
        wingSweep: 0.1, wingChord: 0.22, wingSpan: 0.3, wingRake: 0.25,
        wingDetail: 3, wingBuds: 1, wingSerration: 0.35,
        finCount: 0, finLength: 0.2, finSpread: 0.3,
        shadeBands: 8, shadeDepthMix: 0.35, hueSpread: 30, accentAmount: 0.5, coreSize: 0.045,
      }),
    },
  },
  {
    name: 'Dart',
    def: {
      seed: 4404,
      params: p({
        length: 185, spanToLength: 0.44, tipSweep: 0.18, tailNotch: 0.08,
        structureDepth: 3, gasketBias: 0.6,
        budCount: 3, budScale: 0.12, budFalloff: 2.3, budTwist: 0.2, budDepth: 1, budEmbed: 0.5,
        wingPairs: 2, wingElements: 1, wingStation: 0.56, wingGroupGap: 0.16,
        wingSweep: 0.2, wingChord: 0.18, wingSpan: 0.34, wingRake: 0.5,
        wingDetail: 3, wingBuds: 2, wingSerration: 0.55,
        finCount: 1, finLength: 0.18, finSpread: 0.35,
        shadeDepthMix: 0.28, hueSpread: 26, accentAmount: 0.8, coreSize: 0.045,
      }),
    },
  },
  {
    name: 'Cathedral',
    def: {
      seed: 5505,
      params: p({
        length: 165, spanToLength: 0.78, tipSweep: 0.36, tailNotch: 0.22,
        structureDepth: 3, gasketBias: 0.44,
        budCount: 3, budScale: 0.13, budFalloff: 2.0, budTwist: 0.35, budDepth: 1, budEmbed: 0.55,
        wingPairs: 2, wingElements: 2, wingStation: 0.4, wingGroupGap: 0.1,
        wingSweep: 0.14, wingChord: 0.18, wingSpan: 0.3, wingRake: 0.4,
        wingDetail: 3, wingBuds: 2, wingSerration: 0.7,
        finCount: 3, finLength: 0.2, finSpread: 0.3,
        shadeBands: 8, shadeDepthMix: 0.3, hueSpread: 44, accentAmount: 1, coreSize: 0.075,
      }),
    },
  },
  {
    name: 'Manta (wide)',
    def: {
      seed: 6606,
      params: p({
        length: 120, spanToLength: 1.85, tipSweep: 0.28, tailNotch: 0.22,
        structureDepth: 3, gasketBias: 0.52,
        budCount: 2, budScale: 0.13, budFalloff: 2.2, budTwist: 0.18, budDepth: 0, budEmbed: 0.5,
        wingPairs: 1, wingElements: 2, wingStation: 0.34, wingGroupGap: 0.1,
        wingSweep: 0.12, wingChord: 0.24, wingSpan: 0.16, wingRake: 0.2,
        wingDetail: 3, wingBuds: 1, wingSerration: 0.4,
        finCount: 2, finLength: 0.18, finSpread: 0.3,
        shadeDepthMix: 0.3, hueSpread: 38, accentAmount: 0.65, coreSize: 0.055,
      }),
    },
  },
];
