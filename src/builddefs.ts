/**
 * Central building definitions for Sign99.
 *
 * Single source of truth for everything the menu, HUD, placement, and AI
 * need to know about each placeable building type. Replaces the scattered
 * cost / build-time / display tables previously inlined across
 * `actionmenu.ts`, `game.ts`, `hud.ts`, and `constants.ts`.
 *
 * Each `BuildDef` includes a `factory(pos, team)` that returns the proper
 * concrete entity, so callers can place a building purely by key:
 *
 *     const def = getBuildDef('factory');
 *     const ent = def.factory(worldPos, Team.Player);
 *
 * `tier` lets the action-menu radial group buildings into "general" vs
 * "turret" submenus without hard-coding a list.
 */

import { Vec2 } from './math.js';
import { Team, EntityType } from './entities.js';
import {
  BuildingBase,
  CommandPost,
  PowerGenerator,
  Wall,
  ShieldGenerator,
  Shipyard,
  ResearchLab,
  Factory,
} from './building.js';
import {
  GatlingTurret,
  MissileTurret,
  ExciterTurret,
  MassDriverTurret,
  RegenTurret,
  TetherTurret,
  SynonymousMineLayer,
} from './turret.js';
import { BUILDING_COST, BUILD_TIME } from './constants.js';
import { TICK_RATE } from './constants.js';
import { footprintForBuildingType } from './buildingfootprint.js';

export type BuildTier = 'structure' | 'turret' | 'yard';

export interface BuildDef {
  /** Unique key — what `selectedBuildType`, menus, and placement use. */
  key: string;
  /** Human display name, e.g. "Power Generator". */
  label: string;
  /** Optional one-line subtitle (currently unused — reserved for HUD). */
  description?: string;
  /** Resource cost to place. */
  cost: number;
  /** Square grid footprint side length, in cells. */
  footprintCells: number;
  /** Build time in ticks (60 ticks = 1 second). */
  buildTime: number;
  /** Action-menu submenu this building lives in. */
  tier: BuildTier;
  /**
   * Multi-line label for the radial menu — `\n` splits onto multiple lines
   * inside the item circle. Falls back to {@link label} if absent.
   */
  radialLabel?: string;
  /**
   * If true, item is hidden from the build menu (e.g. command post is only
   * shown when the player has none).
   */
  hidden?: boolean;
  /** Research item required before this build menu entry is exposed. */
  researchKey?: string;
  /** Construct the concrete building entity at `pos` for `team`. */
  factory: (pos: Vec2, team: Team) => BuildingBase;
}

export function buildTicksToSeconds(buildTimeTicks: number): number {
  return Math.max(0, buildTimeTicks) / TICK_RATE;
}

export function createBuildingFromDef(def: BuildDef, pos: Vec2, team: Team): BuildingBase {
  const building = def.factory(pos, team);
  building.buildDurationSeconds = buildTicksToSeconds(def.buildTime);
  building.buildProgress = def.buildTime <= 0 ? 1 : 0;
  return building;
}

/**
 * Cost to rebuild the command post. Not in `BUILDING_COST` because the CP
 * starts pre-built; only relevant after the player loses theirs.
 */
export const COMMANDPOST_REBUILD_COST = 300;
/** Build time for a rebuilt command post (matches power generator pacing). */
export const COMMANDPOST_REBUILD_TIME = BUILD_TIME.powergenerator;

export const BUILD_DEFS: Record<string, BuildDef> = {
  commandpost: {
    key: 'commandpost',
    label: 'Command Post',
    description: 'Your command center. Allows construction within its radius. Losing this ends the game.',
    cost: COMMANDPOST_REBUILD_COST,
    footprintCells: 6,
    buildTime: COMMANDPOST_REBUILD_TIME,
    tier: 'structure',
    radialLabel: 'Command\nPost',
    hidden: true, // shown by menu only when no player CP exists
    factory: (pos, team) => new CommandPost(pos, team),
  },
  powergenerator: {
    key: 'powergenerator',
    label: 'Power Generator',
    description: 'Powers all buildings within its coverage radius via conduit connections.',
    cost: BUILDING_COST.powergenerator,
    footprintCells: 3,
    buildTime: BUILD_TIME.powergenerator,
    tier: 'structure',
    radialLabel: 'Power\nGenerator',
    factory: (pos, team) => new PowerGenerator(pos, team),
  },
  wall: {
    key: 'wall',
    label: 'Wall',
    description: 'Durable defensive barrier. Blocks enemy movement and projectiles.',
    cost: BUILDING_COST.wall,
    footprintCells: 2,
    buildTime: BUILD_TIME.wall,
    tier: 'structure',
    factory: (pos, team) => new Wall(pos, team),
  },
  shieldgenerator: {
    key: 'shieldgenerator',
    label: 'Shield Generator',
    description: 'Projects a shared 90 HP square shield across a 9x9 area. Regenerates 5 HP/s and restarts 5 seconds after depletion.',
    cost: BUILDING_COST.shieldgenerator,
    footprintCells: 3,
    buildTime: BUILD_TIME.shieldgenerator,
    tier: 'structure',
    radialLabel: 'Shield\nGenerator',
    researchKey: 'shipShield1',
    factory: (pos, team) => new ShieldGenerator(pos, team),
  },
  fighteryard: {
    key: 'fighteryard',
    label: 'Fighter Yard',
    description: 'Continuously produces fighter ships for your fleet.',
    cost: BUILDING_COST.fighteryard,
    footprintCells: 5,
    buildTime: BUILD_TIME.fighteryard,
    tier: 'yard',
    radialLabel: 'Fighter\nYard',
    factory: (pos, team) => new Shipyard(EntityType.FighterYard, pos, team),
  },
  bomberyard: {
    key: 'bomberyard',
    label: 'Bomber Yard',
    description: 'Produces nova bombers with devastating area-of-effect attacks.',
    cost: BUILDING_COST.bomberyard,
    footprintCells: 6,
    buildTime: BUILD_TIME.bomberyard,
    tier: 'yard',
    radialLabel: 'Bomber\nYard',
    researchKey: 'bomberyard',
    factory: (pos, team) => new Shipyard(EntityType.BomberYard, pos, team),
  },
  swarmyard: {
    key: 'swarmyard',
    label: 'Swarm Yard',
    description: 'Produces small Swarm ships that strike nearby targets with instant lasers.',
    cost: BUILDING_COST.swarmyard,
    footprintCells: 7,
    buildTime: BUILD_TIME.swarmyard,
    tier: 'yard',
    radialLabel: 'Swarm\nYard',
    researchKey: 'swarmyard',
    factory: (pos, team) => new Shipyard(EntityType.SwarmYard, pos, team),
  },
  researchlab: {
    key: 'researchlab',
    label: 'Research Lab',
    description: 'Enables research of new technologies and Main Ship upgrades.',
    cost: BUILDING_COST.researchlab,
    footprintCells: 9,
    buildTime: BUILD_TIME.researchlab,
    tier: 'structure',
    radialLabel: 'Research\nLab',
    factory: (pos, team) => new ResearchLab(pos, team),
  },
  factory: {
    key: 'factory',
    label: 'Factory',
    description: 'Passively increases your resource income rate.',
    cost: BUILDING_COST.factory,
    footprintCells: 4,
    buildTime: BUILD_TIME.factory,
    tier: 'structure',
    factory: (pos, team) => new Factory(pos, team),
  },
  missileturret: {
    key: 'missileturret',
    label: 'Missile',
    description: 'Fires guided missiles that track targets. High single-target damage.',
    cost: BUILDING_COST.missileturret,
    footprintCells: 3,
    buildTime: BUILD_TIME.missileturret,
    tier: 'turret',
    radialLabel: 'Missile',
    researchKey: 'missileturret',
    factory: (pos, team) => new MissileTurret(pos, team),
  },
  gatlingturret: {
    key: 'gatlingturret',
    label: 'Gatling',
    description: 'Long-range suppressive bullet turret. Consistent damage output at range.',
    cost: BUILDING_COST.gatlingturret,
    footprintCells: 3,
    buildTime: BUILD_TIME.gatlingturret,
    tier: 'turret',
    radialLabel: 'Gatling',
    factory: (pos, team) => new GatlingTurret(pos, team),
  },
  tetherturret: {
    key: 'tetherturret',
    label: 'Tether',
    description: 'Latches onto the first enemy ship in range and drags its speed down over 3s; multiple Tethers stack and can freeze a ship outright.',
    cost: BUILDING_COST.tetherturret,
    footprintCells: 4,
    buildTime: BUILD_TIME.tetherturret,
    tier: 'turret',
    radialLabel: 'Tether',
    factory: (pos, team) => new TetherTurret(pos, team),
  },
  synonymousminelayer: {
    key: 'synonymousminelayer',
    label: 'Mine Layer',
    description: 'Deploys proximity mines that detonate on enemy contact.',
    cost: BUILDING_COST.synonymousminelayer,
    footprintCells: 5,
    buildTime: BUILD_TIME.synonymousminelayer,
    tier: 'turret',
    radialLabel: 'Mine\nLayer',
    researchKey: 'synonymousminelayer',
    factory: (pos, team) => new SynonymousMineLayer(pos, team),
  },
  exciterturret: {
    key: 'exciterturret',
    label: 'Prism',
    description: 'Locks onto a target, then fires a heavy energy beam.',
    cost: BUILDING_COST.exciterturret,
    footprintCells: 4,
    buildTime: BUILD_TIME.exciterturret,
    tier: 'turret',
    radialLabel: 'Prism',
    researchKey: 'exciterturret',
    factory: (pos, team) => new ExciterTurret(pos, team),
  },
  massdriverturret: {
    key: 'massdriverturret',
    label: 'Singularity',
    description: 'Fires a kinetic slug that detonates into a gravity well — the first blast drags in nearby ships, harder the closer they are.',
    cost: BUILDING_COST.massdriverturret,
    footprintCells: 6,
    buildTime: BUILD_TIME.massdriverturret,
    tier: 'turret',
    radialLabel: 'Singularity',
    researchKey: 'massdriverturret',
    factory: (pos, team) => new MassDriverTurret(pos, team),
  },
  regenturret: {
    key: 'regenturret',
    label: 'Repair',
    description: 'Emits a healing field that slowly repairs nearby allied buildings.',
    cost: BUILDING_COST.regenturret,
    footprintCells: 3,
    buildTime: BUILD_TIME.regenturret,
    tier: 'turret',
    radialLabel: 'Repair',
    researchKey: 'regenturret',
    factory: (pos, team) => new RegenTurret(pos, team),
  },
};

export function buildCostForBuildingType(type: EntityType): number {
  switch (type) {
    case EntityType.CommandPost:
      return COMMANDPOST_REBUILD_COST;
    case EntityType.PowerGenerator:
      return BUILDING_COST.powergenerator;
    case EntityType.Wall:
      return BUILDING_COST.wall;
    case EntityType.ShieldGenerator:
      return BUILDING_COST.shieldgenerator;
    case EntityType.GatlingTurret:
      return BUILDING_COST.gatlingturret;
    case EntityType.FighterYard:
      return BUILDING_COST.fighteryard;
    case EntityType.BomberYard:
      return BUILDING_COST.bomberyard;
    case EntityType.SwarmYard:
      return BUILDING_COST.swarmyard;
    case EntityType.ResearchLab:
      return BUILDING_COST.researchlab;
    case EntityType.Factory:
      return BUILDING_COST.factory;
    case EntityType.MissileTurret:
      return BUILDING_COST.missileturret;
    case EntityType.TimeBomb:
      return BUILDING_COST.synonymousminelayer;
    case EntityType.ExciterTurret:
      return BUILDING_COST.exciterturret;
    case EntityType.MassDriverTurret:
      return BUILDING_COST.massdriverturret;
    case EntityType.RegenTurret:
      return BUILDING_COST.regenturret;
    case EntityType.TetherTurret:
      return BUILDING_COST.tetherturret;
    default:
      return 0;
  }
}

export function buildDefForEntityType(type: EntityType): BuildDef | undefined {
  switch (type) {
    case EntityType.CommandPost:
      return BUILD_DEFS.commandpost;
    case EntityType.PowerGenerator:
      return BUILD_DEFS.powergenerator;
    case EntityType.Wall:
      return BUILD_DEFS.wall;
    case EntityType.ShieldGenerator:
      return BUILD_DEFS.shieldgenerator;
    case EntityType.GatlingTurret:
      return BUILD_DEFS.gatlingturret;
    case EntityType.FighterYard:
      return BUILD_DEFS.fighteryard;
    case EntityType.BomberYard:
      return BUILD_DEFS.bomberyard;
    case EntityType.SwarmYard:
      return BUILD_DEFS.swarmyard;
    case EntityType.ResearchLab:
      return BUILD_DEFS.researchlab;
    case EntityType.Factory:
      return BUILD_DEFS.factory;
    case EntityType.MissileTurret:
      return BUILD_DEFS.missileturret;
    case EntityType.TimeBomb:
      return BUILD_DEFS.synonymousminelayer;
    case EntityType.ExciterTurret:
      return BUILD_DEFS.exciterturret;
    case EntityType.MassDriverTurret:
      return BUILD_DEFS.massdriverturret;
    case EntityType.RegenTurret:
      return BUILD_DEFS.regenturret;
    case EntityType.TetherTurret:
      return BUILD_DEFS.tetherturret;
    default:
      return undefined;
  }
}

/** Lookup helper that returns undefined for unknown keys. */
export function getBuildDef(key: string): BuildDef | undefined {
  return BUILD_DEFS[key];
}

/** All defs in the given tier, in stable insertion order. */
export function defsByTier(tier: BuildTier): BuildDef[] {
  return Object.values(BUILD_DEFS).filter((d) => d.tier === tier);
}

