/** Game constants for Sign99 */

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

// World dimensions
export const WORLD_WIDTH = 8000;
export const WORLD_HEIGHT = 6000;

// Entity radii
export const ENTITY_RADIUS = {
  fighter: 3.5,
  bomber: 8,
  mainguy: 7,
  bullet: 3,
  missile: 3,
  building: 13,
  commandpost: 16,
  jumpgate: 20,
  signalstation: 12,
  explosion: 26,
} as const;

// Building costs (resource units)
export const BUILDING_COST = {
  factory: 50,
  researchlab: 150,
  powergenerator: 40,
  wall: 8,
  shieldgenerator: 120,
  gatlingturret: 70,
  missileturret: 80,
  synonymousminelayer: 90,
  exciterturret: 100,
  massdriverturret: 220,
  regenturret: 110,
  tetherturret: 60,
  timebomb: 60,
  signalstation: 70,
  fighteryard: 200,
  bomberyard: 250,
  swarmyard: 300,
} as const;

// Build times (in ticks at 60fps)
export const BUILD_TIME = {
  factory: 300,
  researchlab: 360,
  powergenerator: 240,
  wall: 120,
  shieldgenerator: 300,
  gatlingturret: 170,
  missileturret: 180,
  synonymousminelayer: 210,
  exciterturret: 210,
  massdriverturret: 200,
  regenturret: 220,
  tetherturret: 190,
  timebomb: 120,
  signalstation: 150,
  fighteryard: 420,
  bomberyard: 480,
  swarmyard: 540,
} as const;

// Research mode switch:
//  - 'classic': research is done at the (single, 9x9) Research Lab. Selecting
//    an item deducts its cost and starts a timer; once it finishes the player
//    keeps the upgrade permanently, even if the Research Lab is later
//    destroyed. Losing the lab only pauses in-progress research and blocks
//    starting new research until it's rebuilt.
//  - 'building': each upgrade must be physically built as its own 3x3
//    Research Node; losing that node revokes the upgrade.
// Flip this one flag to switch the whole game between the two systems.
export const RESEARCH_MODE: 'classic' | 'building' = 'classic';

// Research costs
export const RESEARCH_COST = {
  shipHp1: 220,
  shipHp2: 260,
  shipHp3: 300,
  shipHp4: 340,
  shipSpeedEnergy1: 240,
  shipSpeedEnergy2: 280,
  shipSpeedEnergy3: 320,
  shipSpeedEnergy4: 360,
  shipShield1: 280,
  shipShield2: 340,
  shipRepair1: 240,
  shipRepair2: 300,
  shipRepair3: 360,
  shipDash: 280,
  synonymousPierce: 260,
  synonymousSpeed: 260,
  synonymousFireSpeed1: 180,
  synonymousFireSpeed2: 220,
  synonymousFireSpeed3: 260,
  synonymousFireSpeed4: 300,
  synonymousVitality: 300,
  weaponCannon: 220,
  weaponGatling: 180,
  weaponLaser: 320,
  weaponGuidedMissile: 420,
  synonymousminelayer: 190,
  missileturret: 80,
  exciterturret: 250,
  massdriverturret: 220,
  regenturret: 240,
  advancedRegenTurrets: 300,
  timebomb: 150,
  bomberyard: 300,
  swarmyard: 340,
  cloak: 350,
  fighterTargeting: 240,
  fighterWeapon1: 220,
  fighterWeapon2: 280,
  fighterSpeed1: 220,
  fighterSpeed2: 280,
  fighterHp1: 220,
  fighterHp2: 280,
  fighterYard1: 200,
  fighterYard2: 260,
  poweredWalls: 260,
} as const;

// Research times (in ticks)
export const RESEARCH_TIME = {
  shipHp1: 540,
  shipHp2: 600,
  shipHp3: 660,
  shipHp4: 720,
  shipSpeedEnergy1: 560,
  shipSpeedEnergy2: 620,
  shipSpeedEnergy3: 680,
  shipSpeedEnergy4: 740,
  shipShield1: 660,
  shipShield2: 780,
  shipRepair1: 580,
  shipRepair2: 660,
  shipRepair3: 740,
  shipDash: 660,
  synonymousPierce: 620,
  synonymousSpeed: 600,
  synonymousFireSpeed1: 420,
  synonymousFireSpeed2: 480,
  synonymousFireSpeed3: 540,
  synonymousFireSpeed4: 600,
  synonymousVitality: 720,
  weaponCannon: 560,
  weaponGatling: 420,
  weaponLaser: 780,
  weaponGuidedMissile: 900,
  synonymousminelayer: 560,
  missileturret: 540,
  exciterturret: 720,
  massdriverturret: 660,
  regenturret: 680,
  advancedRegenTurrets: 780,
  timebomb: 480,
  bomberyard: 900,
  swarmyard: 960,
  cloak: 840,
  fighterTargeting: 620,
  fighterWeapon1: 560,
  fighterWeapon2: 700,
  fighterSpeed1: 560,
  fighterSpeed2: 700,
  fighterHp1: 560,
  fighterHp2: 700,
  fighterYard1: 500,
  fighterYard2: 660,
  poweredWalls: 660,
} as const;

export const PLAYER_SHIP_SCALE = 1.75;

// Hit points
export const HP_VALUES = {
  playerShip: 40,
  fighter: 5,
  synonymousFighterDrone: 3,
  bomber: 15,
  swarm: 5,
  builderDrone: 10,
  commandPost: 200,
  powerGenerator: 40,
  shieldGenerator: 50,
  wall: 80,
  factory: 40,
  researchLab: 40,
  fighterYard: 50,
  bomberYard: 80,
  swarmYard: 70,
  turret: 30,
  destructibleProjectile: 10,
  mine: 10,
  synonymousDriftMine: 10,
} as const;

export const ACTIVE_RESEARCH_ITEMS = [
  'shipHp1',
  'shipHp2',
  'shipHp3',
  'shipHp4',
  'shipSpeedEnergy1',
  'shipSpeedEnergy2',
  'shipSpeedEnergy3',
  'shipSpeedEnergy4',
  'shipShield1',
  'shipShield2',
  'shipRepair1',
  'shipRepair2',
  'shipRepair3',
  'shipDash',
  'synonymousPierce',
  'synonymousSpeed',
  'synonymousFireSpeed1',
  'synonymousFireSpeed2',
  'synonymousFireSpeed3',
  'synonymousFireSpeed4',
  'synonymousVitality',
  'weaponCannon',
  'weaponGatling',
  'weaponLaser',
  'weaponGuidedMissile',
  'missileturret',
  'synonymousminelayer',
  'exciterturret',
  'massdriverturret',
  'regenturret',
  'advancedRegenTurrets',
  'bomberyard',
  'swarmyard',
  'fighterTargeting',
  'fighterWeapon1',
  'fighterWeapon2',
  'fighterSpeed1',
  'fighterSpeed2',
  'fighterHp1',
  'fighterHp2',
  'fighterYard1',
  'fighterYard2',
  'poweredWalls',
] as const;

// Weapon stats
export const WEAPON_STATS = {
  fire: {
    damage: 3,
    speed: 400,
    fireRate: 10,   // ticks between shots
    range: 500,
  },
  gatling: {
    damage: 0.5,
    speed: 520,
    fireRate: 3,
    range: 260,
  },
  guidedmissile: {
    damage: 15,
    speed: 480,
    fireRate: 110,
    range: 1000,
  },
  laser: {
    damage: 3,
    speed: 0,
    fireRate: 32,
    range: 900,
  },
  synonymousLaser: {
    damage: 3,
    speed: 0,
    fireRate: 56,
    range: 760,
    pierce: 4,
  },
  missile: {
    damage: 10,
    speed: 300,
    fireRate: 40,
    range: 800,
  },
  gatlingturret: {
    damage: 0.25,
    speed: 170,
    fireRate: 3,
    range: 560,
    spread: 0.42,
  },
  bigfire: {
    damage: 6,
    speed: 350,
    fireRate: 20,
    range: 550,
  },
  bigmissile: {
    damage: 18,
    speed: 180,
    fireRate: 120,
    range: 900,
  },
  exciterbullet: {
    damage: 3,
    speed: 500,
    fireRate: 5,
    range: 400,
  },
  exciterbeam: {
    damage: 30,
    speed: 0,      // instant
    fireRate: 180,
    range: 720,
  },
  massdriverbullet: {
    damage: 6,
    speed: 135,
    fireRate: 480,
    range: 520,
  },
  regenbullet: {
    damage: -1,    // heals
    speed: 400,
    fireRate: 20,
    range: 500,
  },
  bigregenbullet: {
    damage: -10,
    speed: 350,
    fireRate: 30,
    range: 600,
  },
  shortbullet: {
    damage: 2,
    speed: 450,
    fireRate: 8,
    range: 300,
  },
  minilaser: {
    damage: 2,
    speed: 550,
    fireRate: 12,
    range: 450,
  },
  firebomb: {
    damage: 10,
    speed: 200,
    fireRate: 90,
    range: 400,
  },
} as const;

// Ship stats
export const SHIP_STATS = {
  fighter: {
    health: HP_VALUES.fighter,
    speed: 250,
    turnRate: 4.0,
  },
  bomber: {
    health: HP_VALUES.bomber,
    speed: 180,
    turnRate: 2.5,
  },
  mainguy: {
    health: HP_VALUES.playerShip,
    speed: 280,
    turnRate: 5.0,
  },
} as const;

// Resource gain rate (per second per factory, as bonus)
export const RESOURCE_GAIN_RATE = 1.0;

// Baseline resource gain per second (player auto-gains resources over time)
export const BASELINE_RESOURCE_GAIN = 5.0;

// Build zone radii
/**
 * Speed retained when every wing-mounted engine module has been shot off. A ship at
 * its full wing complement always flies at 1.0 — wings never grant a bonus over
 * today's speed, they only cost speed when lost, so match-start balance is unchanged.
 * Wingless designs (and `design === null`) carry no modules and never slow down.
 */
export const SHIP_ENGINE_LOSS_FLOOR = 0.65;

export const COMMANDPOST_BUILD_RADIUS = 260;
export const POWERGENERATOR_COVERAGE_RADIUS = 195;

/** Resource cost to paint one conduit cell. */
export const CONDUIT_COST = 1;

// ---------------------------------------------------------------------------
// Special ability tuning constants
// ---------------------------------------------------------------------------

/** Duration (seconds) of the player spawn-invincibility shield. */
export const PLAYER_SPAWN_INVINCIBILITY_SECS = 5.0;

/** Duration (seconds) of the Gatling overdrive burst (auto-fires at high rate). */
export const GATLING_OVERDRIVE_DURATION_SECS = 2.0;

/** Duration (seconds) of the post-overdrive overheat lockdown (no movement). */
export const GATLING_OVERHEAT_DURATION_SECS = 4.0;

/**
 * During overdrive the gatling fire-interval is divided by this value,
 * making it fire far faster than normal.
 */
export const GATLING_OVERDRIVE_FIRE_RATE_DIVISOR = 8;

/** Maximum laser charge duration in seconds. */
export const LASER_MAX_CHARGE_SECS = 2.5;

/** Cooldown (seconds) after a charged laser burst fires. */
export const LASER_CHARGE_COOLDOWN_SECS = 1.5;

/** Number of missiles launched in one rocket swarm. */
export const ROCKET_SWARM_COUNT = 7;

/** Total angular spread (degrees) of the rocket swarm fan. */
export const ROCKET_SWARM_SPREAD_DEGREES = 20;

/** Battery energy cost to trigger the rocket swarm. */
export const ROCKET_SWARM_ENERGY_COST = 30;

/** Cooldown (seconds) between rocket swarm uses. */
export const ROCKET_SWARM_COOLDOWN_SECS = 4.0;

/**
 * Energy cost for the cannon homing special.
 * Equals 3 × the normal cannon shot cost (BATTERY_FIRE_COST = 5).
 */
export const CANNON_HOMING_ENERGY_COST = 15;

/** Cooldown multiplier for cannon homing shots; matches normal cannon cadence. */
export const CANNON_HOMING_COOLDOWN_MULTIPLIER = 1;

/** Damage multiplier applied to BomberMissile damage for each swarm missile. */
export const SWARM_MISSILE_DAMAGE_MULTIPLIER = 0.55; // ~19 hp per missile at default bomber damage

/** Base damage multiplier for the charged laser burst at minimum charge/energy. */
export const LASER_BURST_BASE_MULTIPLIER = 3.0;

/** Maximum additional damage multiplier from full energy × full charge. */
export const LASER_BURST_ENERGY_SCALING = 8.0;

// ---------------------------------------------------------------------------
// Cross-Laser Mine special ability constants
// ---------------------------------------------------------------------------

/** Number of mines deployed per use. */
export const MINE_COUNT = 5;

/** Lifetime of each mine before it auto-detonates (seconds). */
export const MINE_LIFETIME_SECS = 20;

/** Length of each detection laser beam (world units). */
export const MINE_LASER_RANGE = 300;

/**
 * Half-width of the laser beam detection zone (world units).
 * A target whose edge comes within this distance of the beam segment triggers the mine.
 */
export const MINE_LASER_THICKNESS = 9;

/** Speed of the trap missile launched when a mine is triggered (world units/sec). */
export const MINE_MISSILE_SPEED = 900;

/** AOE blast radius for mine detonation and triggered trap missiles. */
export const MINE_BLAST_RADIUS = 40;

/** Damage dealt by mine explosions and trap missiles. */
export const MINE_DAMAGE = 28;

/** Cooldown (seconds) between mine deployments. */
export const MINE_COOLDOWN_SECS = 15;

/** Battery cost to deploy the mine cluster. */
export const MINE_BATTERY_COST = 25;

/**
 * Deceleration applied to mines after deployment (world units/sec²).
 * High value so mines slow to a stop quickly.
 */
export const MINE_DECELERATION = 480;

/** Minimum initial outward launch speed of each mine (world units/sec). */
export const MINE_INITIAL_SPEED_MIN = 90;

/** Maximum initial outward launch speed of each mine (world units/sec). */
export const MINE_INITIAL_SPEED_MAX = 160;

/** Minimum visual rotation speed for a mine (radians/sec). */
export const MINE_ROTATION_SPEED_MIN = 0.8;

/** Maximum visual rotation speed for a mine (radians/sec). */
export const MINE_ROTATION_SPEED_MAX = 2.0;
