/** Core entity types and base classes for Sign99 */

import { Vec2 } from './math.js';
import { Camera } from './camera.js';

export enum Team {
  Neutral = 0,
  Player1 = 1,
  Player2 = 2,
  Player3 = 3,
  Player4 = 4,
  Player5 = 5,
  Player6 = 6,
  Player7 = 7,
  Player8 = 8,
  /**
   * Backward-compat alias for the local single-player team (= Player1).
   * Use Team.Player1 in new code.
   */
  Player = 1, // eslint-disable-line @typescript-eslint/no-duplicate-enum-values
  /**
   * Backward-compat alias for the first AI/enemy team (= Player2).
   * Use Team.Player2 in new code.
   */
  Enemy = 2,  // eslint-disable-line @typescript-eslint/no-duplicate-enum-values
}

/**
 * Tactical orders that can be issued to fighter groups via the Command menu.
 *
 * ProtectBase tracks the player's Command Post, SetWaypoint uses the cursor,
 * FollowPlayer tracks the player ship, and Dock returns ships to their yard.
 */
export enum TacticalOrder {
  ProtectBase = 'protect',
  SetWaypoint = 'waypoint',
  FollowPlayer = 'follow',
  Dock = 'dock',
}

export enum ShipGroup {
  Red = 0,
  Green = 1,
  Blue = 2,
}

export enum EntityType {
  // Player & AI ships
  PlayerShip,
  Fighter,
  Bomber,
  // Buildings
  CommandPost,
  PowerGenerator,
  Wall,
  FighterYard,
  BomberYard,
  ResearchLab,
  Factory,
  // Turrets
  GatlingTurret,
  MissileTurret,
  ExciterTurret,
  MassDriverTurret,
  RegenTurret,
  TimeBomb,
  // Projectiles
  Bullet,
  Missile,
  Laser,
  ExciterBullet,
  ExciterBeam,
  MassDriverBullet,
  RegenBullet,
  FireBomb,
  // Effects
  Explosion,
  SwarmYard,
  TetherTurret,
}

let nextEntityId = 0;

export abstract class Entity {
  readonly id: number;
  type: EntityType;
  team: Team;
  position: Vec2;
  velocity: Vec2;
  angle: number;
  angularVel: number;
  health: number;
  maxHealth: number;
  radius: number;
  alive: boolean;
  lastDamageSource: Entity | null = null;

  /**
   * Sum of all active Tether-turret slow fractions applied to this entity this
   * frame (0 = unaffected, 0.2 per fully-charged Tether, >= 1 = frozen).
   * Reset to 0 each tick by GameState before Tethers re-accumulate.
   */
  tetherSlowFrac = 0;
  /**
   * Incremented every time this entity performs a dash. Tether turrets watch
   * this to detect a dash and halve their hold on the target.
   */
  dashCount = 0;

  /** Speed-cap multiplier from Tether turrets. 0 => frozen in place. */
  tetherSpeedMultiplier(): number {
    return Math.max(0, 1 - this.tetherSlowFrac);
  }

  constructor(
    type: EntityType,
    team: Team,
    position: Vec2,
    health: number,
    radius: number,
  ) {
    this.id = nextEntityId++;
    this.type = type;
    this.team = team;
    this.position = position.clone();
    this.velocity = new Vec2(0, 0);
    this.angle = 0;
    this.angularVel = 0;
    this.health = health;
    this.maxHealth = health;
    this.radius = radius;
    this.alive = true;
  }

  abstract update(dt: number): void;
  abstract draw(ctx: CanvasRenderingContext2D, camera: Camera): void;

  takeDamage(amount: number, _source?: Entity): void {
    if (!this.alive) return;
    if (amount > 0 && _source) this.lastDamageSource = _source;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.destroy();
    }
    if (this.health > this.maxHealth) {
      this.health = this.maxHealth;
    }
  }

  destroy(): void {
    this.alive = false;
  }

  /** Fraction of health remaining in [0, 1]. */
  get healthFraction(): number {
    return this.maxHealth > 0 ? this.health / this.maxHealth : 0;
  }
}

