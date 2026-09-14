/** Stable player-colour identities. Never seed these from entity IDs, time or faction. */
import { loadDevShipDesign, DEFAULT_PARAMS, type ProceduralShipDefinition, type ProceduralShipParams, type CoreShapeKind } from './proceduralShips.js';

export type FleetRole = 'hero' | 'fighter' | 'bomber' | 'swarm';
// wingPairs is uniformly 2 across every family: it's the full-growth wing count a ship
// reaches once fully speed-upgraded (see withWingTier), not a fixed silhouette trait.
const SHAPES: ReadonlyArray<{ name: string; seed: number; coreShape: CoreShapeKind; params: Partial<ProceduralShipParams> }> = [
  { name: 'Lance', seed: 1101, coreShape: 'circle', params: { spanToLength: 0.55, wingPairs: 2, wingElements: 2, wingSpan: 0.3, finCount: 2 } },
  { name: 'Manta', seed: 2207, coreShape: 'triangle', params: { spanToLength: 1.5, wingPairs: 2, wingElements: 1, wingSpan: 0.48, wingSweep: 0.35, finCount: 0 } },
  { name: 'Trident', seed: 3313, coreShape: 'diamond', params: { spanToLength: 0.7, wingPairs: 2, wingElements: 1, wingStation: 0.5, wingGroupGap: 0.22, wingRake: 0.85, wingSpan: 0.36, finCount: 1 } },
  { name: 'Arrow', seed: 4421, coreShape: 'square', params: { spanToLength: 0.42, wingPairs: 2, finCount: 2, finLength: 0.36, budCount: 2, budScale: 0.08 } },
  { name: 'Crescent', seed: 5527, coreShape: 'pentagon', params: { spanToLength: 1.1, wingPairs: 2, wingElements: 1, wingRake: 1, wingSpan: 0.6, wingSweep: -0.08, finCount: 0 } },
  { name: 'Kestrel', seed: 6637, coreShape: 'ringCircle', params: { spanToLength: 0.75, wingPairs: 2, wingElements: 2, wingGroupGap: 0.19, wingSpan: 0.44, wingSweep: 0.4, finCount: 3 } },
  { name: 'Spindle', seed: 7741, coreShape: 'hexagon', params: { spanToLength: 0.45, wingPairs: 2, finCount: 0, budCount: 6, budScale: 0.2, budTwist: 0.65 } },
  { name: 'Crown', seed: 8849, coreShape: 'cross', params: { spanToLength: 0.95, wingPairs: 2, wingElements: 1, wingStation: 0.42, wingGroupGap: 0.16, wingSpan: 0.36, wingRake: 0.65, finCount: 4 } },
];
const cache = new Map<string, ProceduralShipDefinition>();
export function fleetFamilyName(team: number): string { return SHAPES[Math.max(0, Math.min(7, team - 1))].name; }
/** Faction-identifying core glyph for `team`, independent of colour (colour-blind readability). */
export function fleetCoreShape(team: number): CoreShapeKind { return SHAPES[Math.max(0, Math.min(7, team - 1))].coreShape; }
export function fleetDesign(team: number, role: FleetRole): ProceduralShipDefinition {
  const slot = Math.max(0, Math.min(7, Math.floor(team) - 1));
  const key = `${slot}:${role}`;
  let def = cache.get(key);
  if (!def) {
    const family = SHAPES[slot];
    const params = { ...DEFAULT_PARAMS, length: 150, ...family.params };
    if (role !== 'hero') {
      // Keep the family silhouette; simplify the small escort's interior and edge detail.
      params.structureDepth = 2;
      params.wingDetail = 1;
      params.budDepth = 0;
      params.wingBuds = 0;
      params.wingSerration = 0;
      params.budCount = Math.min(3, params.budCount);
      params.coreSize = 0.06;
      if (role === 'bomber') {
        // Kite/diamond silhouette: wide beam plus a pinched tail notch and forward sweep.
        params.spanToLength *= 1.18;
        params.wingChord = Math.min(0.6, params.wingChord * 1.3);
        params.tipSweep = Math.min(0.75, params.tipSweep + 0.2);
        params.tailNotch = Math.min(0.6, params.tailNotch + 0.22);
      }
      if (role === 'swarm') {
        // Smaller, thinner triangle: narrow beam, no interior detail beyond the core dart.
        params.spanToLength = Math.max(0.32, params.spanToLength * 0.62);
        params.structureDepth = 1;
        params.budCount = 0;
        params.finCount = 0;
      }
    }
    def = { seed: family.seed, params };
    cache.set(key, def);
  }
  return def;
}

const customEscorts = new WeakMap<ProceduralShipDefinition, Partial<Record<FleetRole, ProceduralShipDefinition>>>();
/** The lab override belongs to P1, and its escorts inherit it. Other player colours keep their families. */
export function gameplayFleetDesign(team: number, role: FleetRole): ProceduralShipDefinition {
  const custom = team === 1 ? loadDevShipDesign() : null;
  if (!custom) return fleetDesign(team, role);
  if (role === 'hero') return custom;
  let variants = customEscorts.get(custom);
  if (!variants) { variants = {}; customEscorts.set(custom, variants); }
  return variants[role] ??= { seed: custom.seed, params: {
    ...custom.params, structureDepth: 2, wingDetail: 1, budDepth: 0, wingBuds: 0, wingSerration: 0,
    budCount: Math.min(3, custom.params.budCount),
    spanToLength: custom.params.spanToLength * (role === 'bomber' ? 1.18 : 1),
  } };
}
