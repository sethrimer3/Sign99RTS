/** Color definitions parsed from the original Sign99 colours.conf and textcolours.conf */

export interface Color {
  r: number;
  g: number;
  b: number;
  intensity: number;
}

/** Convert a Color to a CSS rgba string, applying intensity as a multiplier and clamping to 255. */
export function colorToCSS(color: Color, alpha: number = 1.0): string {
  const r = Math.min(255, Math.round(color.r * color.intensity));
  const g = Math.min(255, Math.round(color.g * color.intensity));
  const b = Math.min(255, Math.round(color.b * color.intensity));
  return `rgba(${r},${g},${b},${alpha})`;
}

function c(r: number, g: number, b: number, intensity: number): Color {
  return { r, g, b, intensity };
}

export const Colors = {
  menu_background:            c(0, 50, 130, 1.0),
  menu_background_detail:     c(107, 0, 1, 1.0),
  friendly_background:        c(0, 1, 3, 1.0),
  enemy_background:           c(25, 15, 8, 1.0),
  friendly_starfield:         c(11, 80, 124, 0.65),
  enemy_starfield:            c(121, 57, 57, 0.63),
  general_building:           c(174, 198, 175, 1.0),
  advanced_building:          c(174, 198, 175, 1.0),
  shipyard:                   c(205, 190, 163, 1.0),
  fighters:                   c(168, 193, 207, 1.0),
  mainguy:                    c(205, 190, 163, 1.24),
  enemy_status:               c(107, 0, 1, 1.0),
  friendly_status:            c(0, 53, 0, 1.3),
  allied_status:              c(0, 50, 130, 1.0),
  explosion:                  c(103, 59, 54, 2.0),
  friendly_explosion:         c(89, 0, 38, 1.0),
  factory_detail:             c(107, 70, 0, 1.8),
  researchlab_detail:         c(40, 86, 47, 2.0),
  powergenerator_detail:      c(70, 81, 30, 3.1),
  powergenerator_coverage:    c(11, 80, 124, 1.0),
  particleaccelerator_detail: c(120, 60, 140, 2.4),
  bright_matter:              c(200, 140, 255, 1.0),
  timebomb_detail:            c(111, 65, 37, 2.0),
  missileturret_detail:       c(163, 193, 205, 1.2),
  gatlingturret_detail:       c(190, 210, 120, 1.4),
  exciterturret_detail:       c(65, 35, 0, 3.9),
  massdriverturret_detail:    c(60, 40, 18, 2.0),
  regenturret_detail:         c(174, 198, 175, 1.0),
  signalstation_detail:       c(173, 219, 197, 1.0),
  jumpgate_detail:            c(0, 50, 130, 1.0),
  fighteryard_detail:         c(205, 190, 163, 1.0),
  bomberyard_detail:          c(205, 190, 163, 1.0),
  fighter_detail:             c(70, 81, 30, 1.0),
  bomber_detail:              c(65, 35, 0, 1.0),
  aifighter_detail:           c(111, 65, 37, 1.0),
  aibomber_detail:            c(107, 0, 1, 1.0),
  airepairdood_detail:        c(107, 0, 1, 1.0),
  aibigfireturret_detail:     c(107, 0, 1, 1.0),
  aispreadfireturret_detail:  c(107, 0, 1, 1.0),
  redgroup:                   c(228, 0, 33, 1.0),
  greengroup:                 c(0, 176, 66, 1.0),
  bluegroup:                  c(0, 33, 176, 1.0),
  friendlyfire:               c(0, 176, 66, 1.0),
  enemyfire:                  c(228, 0, 33, 1.0),
  alliedfire:                 c(0, 66, 176, 1.0),
  cloak:                      c(205, 190, 163, 1.24),
  radar_tint:                         c(40, 86, 47, 0.3),
  radar_gridlines:                    c(40, 86, 47, 1.0),
  radar_signalstation_coverage:       c(40, 86, 47, 1.0),
  radar_enemy_status:                 c(107, 0, 1, 1.8),
  radar_friendly_status:              c(0, 234, 0, 1.0),
  radar_allied_status:                c(0, 50, 130, 1.8),
  particles_friendly_exhaust:   c(56, 132, 68, 1.0),
  particles_enemy_exhaust:      c(132, 56, 68, 1.0),
  particles_allied_exhaust:     c(56, 68, 132, 1.0),
  particles_neutral_exhaust:    c(255, 246, 230, 0.67),
  // Warm thrust / engine exhaust colours (used for all ships' main engine fire)
  thrust_core_hot:              c(255, 255, 210, 1.0),  // white-hot core
  thrust_warm_yellow:           c(255, 230, 80,  1.0),  // warm yellow
  thrust_warm_orange:           c(255, 148, 28,  1.0),  // orange
  thrust_burnt_orange:          c(220, 82,  20,  1.0),  // burnt orange
  thrust_deep_red:              c(200, 40,  15,  1.0),  // deep red burnoff
  particles_switch:             c(255, 246, 230, 1.0),
  particles_healing:            c(174, 198, 175, 1.0),
  particles_explosion1:         c(107, 0, 1, 2.0),
  particles_explosion2:         c(130, 110, 0, 1.0),
  particles_explosion3:         c(255, 255, 255, 1.0),
  particles_spark:              c(0, 210, 255, 1.0),
  particles_ember:              c(255, 140, 20, 1.0),
  particles_nova:               c(255, 240, 180, 1.0),
  // Impact flash — used for non-lethal projectile hits
  particles_impact:             c(255, 220, 100, 1.0),
  // Muzzle flash — brief bright burst at weapon muzzle
  particles_muzzle:             c(255, 250, 180, 1.0),
  // Weapon-type projectile trail/core colors
  bullet_player_cannon:         c(180, 255, 230, 1.1),  // cyan-green streaks for player cannon
  bullet_enemy_cannon:          c(255, 110, 60, 1.0),   // warm orange-red for enemy cannon
  bullet_player_gatling:        c(200, 255, 90, 1.0),   // bright lime for player gatling
  bullet_enemy_gatling:         c(255, 80, 80, 1.0),    // hot red for enemy gatling
  bullet_player_turret:         c(130, 230, 255, 1.0),  // cool cyan for player turret bullets
  bullet_enemy_turret:          c(255, 140, 40, 1.0),   // amber-orange for enemy turret bullets
  missile_trail:                c(255, 160, 40, 1.0),   // warm orange ember trail (all missiles)
  // Building ambient glow
  building_glow_power:          c(180, 220, 60, 1.0),   // yellow-green power generator glow
  building_glow_research:       c(60, 220, 180, 1.0),   // teal research lab glow
  building_glow_factory:        c(200, 130, 30, 1.0),   // amber factory glow
  building_glow_shipyard:       c(140, 200, 255, 1.0),  // cool blue shipyard glow
  healthbar:                    c(0, 53, 0, 4.0),
  batterybar:                   c(107, 0, 1, 2.0),
  alert1:                       c(255, 0, 0, 1.0),
  alert2:                       c(255, 255, 0, 1.0),
} as const;

export const TextColors = {
  normal:     c(174, 198, 175, 1.0),
  highlight:  c(174, 198, 175, 1.287),
  shadow:     c(173, 193, 219, 0.33),
  title:      c(173, 193, 219, 1.287),
  titledark:  c(173, 193, 219, 0.33),
  enemy:      c(222, 182, 180, 1.0),
  ally:       c(173, 193, 219, 1.0),
  private:    c(205, 190, 163, 1.0),
  admin:      c(174, 198, 175, 1.0),
  system:     c(224, 255, 226, 1.0),
} as const;

