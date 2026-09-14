/**
 * Structural "parts" budget shared by every faction's ship of a given role, so no
 * colour's hero/fighter/bomber/swarm is harder or easier to destroy than another's
 * purely because its family happens to look more detailed. A "part" is just a unit
 * of max health; keeping the count here (rather than scattering per-family numbers)
 * is what guarantees parity and gives future structural upgrades (shield, dash, ...)
 * one place to register their HP cost.
 */

export type ShipRole = 'hero' | 'fighter' | 'bomber' | 'swarm';

/** Every escort role shares one base — only the hero starts with more hull. */
export const HERO_BASE_PARTS = 60;
export const ESCORT_BASE_PARTS = 30;

/** One wing pair, once grown in, is worth this many extra parts. */
export const WING_PAIR_PARTS = 20;

function baseParts(role: ShipRole): number {
  return role === 'hero' ? HERO_BASE_PARTS : ESCORT_BASE_PARTS;
}

/**
 * Registry of structural upgrades that add parts on top of the base hull, keyed by
 * an id so future upgrades (shield plating, dash reinforcement, ...) can register
 * their own cost without touching every call site that computes max health.
 */
export interface StructuralModifier {
  id: string;
  /** Parts granted once this modifier's tier is active (0 = not unlocked). */
  partsPerTier: number;
  /** Highest tier this modifier supports for the given role. */
  maxTier(role: ShipRole): number;
}

export const WING_PAIR_MODIFIER: StructuralModifier = {
  id: 'wingPairs',
  partsPerTier: WING_PAIR_PARTS,
  // The hero grows two wing pairs (speed I, speed II); every escort grows one (speed I only).
  maxTier: (role) => (role === 'hero' ? 2 : 1),
};

/** All structural modifiers that currently affect a ship's part budget. */
export const STRUCTURAL_MODIFIERS: readonly StructuralModifier[] = [WING_PAIR_MODIFIER];

/**
 * Total part budget (== max health, in HP-per-part terms) for a ship of `role` given
 * how many tiers of each structural modifier it currently has unlocked. `tiers` maps
 * modifier id -> tier (defaults to 0, i.e. no bonus, for any omitted modifier).
 */
export function partsForRole(role: ShipRole, tiers: Readonly<Record<string, number>> = {}): number {
  let total = baseParts(role);
  for (const modifier of STRUCTURAL_MODIFIERS) {
    const tier = Math.max(0, Math.min(tiers[modifier.id] ?? 0, modifier.maxTier(role)));
    total += tier * modifier.partsPerTier;
  }
  return total;
}

/** Convenience for the common single-modifier (wing tier) case used by hero/fighter/bomber/swarm ships. */
export function partsForWingTier(role: ShipRole, wingTier: number): number {
  return partsForRole(role, { wingPairs: wingTier });
}
