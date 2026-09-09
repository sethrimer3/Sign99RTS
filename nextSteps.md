# Sign99RTS — Next Steps

---

## Survival Scale Performance Pass - Remaining Work

This pass added a reusable spatial hash, F3 performance metrics, nearby-only
fighter separation, broadphase projectile collision, spatial turret targeting,
conservative render culling, and partial survival-base planner LOD. The polish
pass tightened the risky broadphase edges by adding segment-safe spatial
queries for beam/laser paths, drift-mine projectile hits, and projectile
interception, plus swept exact checks for fast projectile-to-entity contact.
It also moved more hot combat queries onto reusable scratch arrays and made the
F3 spatial stats distinguish raw candidates from returned entities.

### Deferred / intentionally avoided

**1. Path blocker spatial index for ship routing - completed**

`GameState` now exposes a building-collision version counter that changes when
buildings are added, removed, cleaned up, or finish construction. `src/shippath.ts`
reuses blocking rectangles until that version or the requested inflate value
changes, and indexes cached `WallRect`s by navigation cell so route-corridor
checks query nearby blockers instead of repeatedly scanning the full building
list.

**2. Fuller survival base simulation LOD**

Current LOD only throttles planner updates for extra survival bases that are far
from the player and not near active combat. The nearby-combat wake check now
uses `GameState.queryEntitiesInRange(...)` instead of scanning all fighters and
projectiles for every base. Actual buildings, turrets, fighters, projectiles,
power, construction completion, and defeat state remain live. A deeper LOD
could also stagger distant shipyard production checks, expensive base audits,
and nonessential effects, but should first add per-base engagement state so
bases wake immediately when attacked or when their launched wave reaches the
player.

Files/functions: `src/practicemode.ts -> survivalPlannerCadence`,
`updateEnemyShipyards`, `updateEnemyFighters`; `src/enemybaseplanner.ts ->
update`, audit helpers.

**3. PowerGraph clean-tick cost**

`src/power.ts -> PowerGraph.recompute` correctly avoids BFS when clean, but it
still reapplies `powered` to every building each tick so newly completed
buildings and power-loss transitions stay correct. This is safe but still
O(buildings). A future optimization should track construction-completion and
dirty-power versioning so clean ticks only touch buildings that need a power
state refresh.

**4. Remaining all-entity scans**

The hottest combat/collision paths now use the spatial index and reusable
scratch arrays, but some strategic and UI scans remain intentionally simple.
Good follow-up targets are player threat evaluation, shipyard caps, Synonymous
mine targeting/counts, debug overlay entity counts, and helper paths that still
call `state.allEntities()` for rare effects.

Files/functions: `src/practicemode.ts -> evaluatePlayerThreat`,
`enemyWaveLaunchThreshold`; `src/turret.ts -> SynonymousMineLayer.tickMineLayer`;
`src/synonymousMine.ts -> findTarget`; `src/gameRender.ts -> drawDebugOverlay`;
`src/commandMode.ts`.

**5. Static/dynamic broadphase split**

`src/spatialIndex.ts` now reuses bucket arrays and numeric cell keys, but
`GameState` still rebuilds one combined index at the major tick boundaries.
A future split should keep completed buildings in a mostly-static building
index that rebuilds only when buildings are added, removed, destroyed, finish
construction, or change collision/targetability state. Dynamic ships, fighters,
and projectiles can keep the current per-tick rebuild path; a projectile-only
index may help if projectile counts become the dominant collision cost.

Files/functions: `src/gamestate.ts -> rebuildSpatialIndex`, `addEntity`,
`cleanupDead`, building construction/deletion completion paths.

### Validation steps for survival with 5+ bases

1. Start Survival or Ranked Survival and let the match reach at least five live
   enemy Command Posts.
2. Press F3 and record: frame/fixed/render time, `sim state`, `practice`,
   `planners`, `hotspots`, `spatial q/raw/returned/cells/indexed`, and `ship
   paths` lines.
3. Fly near a distant base and confirm its planner wakes up: buildings should
   continue to complete, turrets should fire, and shipyards should still launch
   fighters.
4. Stress-test dense fights around the player base and verify projectiles still
   hit buildings, fighters, ships, walls, mines, interceptable missiles, Mass
   Driver pulses, Nova bombs, and Regen healing targets correctly.
5. Specifically fire or observe beams/lasers crossing drift mines, bullets
   intercepting Swarm/Guided missiles, and fast shots crossing small fighters
   or walls to confirm segment broadphase did not miss hits.
6. Compare against an older build by watching fixed-update spikes and path stats
   after the fifth base spawns.

### Known behavior changes

- Extra survival bases far from the player and away from active combat run their
  `EnemyBasePlanner` less frequently. Their saved-up planner `dt` is applied on
  the next update, so escalation continues, but construction/audit decisions can
  be delayed by up to roughly 0.5s at reduced tier or 2.0s at dormant tier.
- Turret target acquisition is staggered by turret id. Existing targets keep
  updating normally; brand-new target acquisition can be delayed by a fraction
  of a second when many turrets exist.
- Offscreen entity drawing now uses conservative camera margins. Extremely long
  beams or unusual effects should be watched for pop-in during manual testing.
- Fast projectile contact is now resolved against the projectile's swept motion
  from the previous fixed tick to the current position. This should reduce
  tunneling without changing friendly-fire, Mass Driver burst, Nova pulse, or
  Regen healing rules.

---

## Fighter Control Group Status UI — Build 048 — Known Limitations

Build 048 implemented the fighter control group status UI in `src/fighterGroupStatus.ts`.

### Limitation: "assigned" count uses a running-maximum heuristic

The `alive/assigned` fraction displayed per icon type tracks "assigned" as the highest
alive count observed since the group was last cleared.  This is because
`GameState.fighters` is pruned to only alive ships each tick (see
`gamestate.ts` line ~1238: `this.fighters = this.fighters.filter((f) => f.alive)`),
so the true original-assignment count is not retained after ships die.

**Impact:** If 6 fighters are in group 1 and 2 die, the display correctly shows "4/6".
If those 6 fighters are later reassigned from group 1 to group 2, group 1 may briefly
show its old high-water-mark until the decay timer (8 seconds of zero alive) resets it.

**To fix properly:** Add an explicit `assignedCount` field to the group tracking system
that is incremented at shipyard spawn time and decremented on reassignment.  This
requires hooking into `Shipyard.shouldSpawnShip()` (in `building.ts`) and the group
reassignment path in `commandMode.ts → updateNumberGroupHotkeys`.

---

## Rendering Performance — Build 037 — Remaining / Deferred Work

Build 037 implemented:
- `src/renderBudget.ts`: adaptive EMA-smoothed performance budget; `renderLoadScale` 1.0→0.35 with fast degrade / slow recover hysteresis.
- `src/particles.ts`: full active-list pool rewrite — `acquire()` O(1) via free stack, `update()` and `draw()` iterate only active particles, viewport culling with world-space bounds computed once per draw call.
- `src/glowlayer.ts`: per-frame primitive budget via `beginFrame(maxPrimitives)`; `lineScreen`/`circleScreen` check and count against the budget; stats exposed to `renderBudget`.
- `src/gameOverlays.ts`: `drawGlowLayer` accepts `renderLoadScale`; prioritized glow rendering (explosions → lasers → player ships → buildings → fighter engine → bullet trails); bullet glow decimation by projectile count; fighter engine glow cap.
- `src/crystalnebula.ts`: replaced `new Array` allocation inside cloud update loop with fixed reusable `nearDistBuf`; adaptive draw decimation (every 1/2/3rd mote based on load scale).
- `src/gameRender.ts`: debug overlay (F3) extended with smoothed perf stats, renderLoadScale, particle pool stats, glow drawn/skipped, crystal mote count, visual quality preset.
- `src/game.ts`: fighter exhaust rate-limited to ~30 Hz with on-screen culling; `renderBudget.update()` called each frame; `setAdaptiveScale()` wired into particle system; `renderLoadScale` passed to `drawGlowLayer`.

### Deferred items

**1. Per-frame particle emission priority levels**

The problem statement requested formal priority categories (Critical / Medium / Low) with a per-frame spawn budget that skips Low before Medium before Critical. Currently the adaptive scale reduces emission counts uniformly. A future pass could:
- Add a `ParticlePriority` enum (critical=0, medium=1, low=2) to each emitter call.
- Maintain a `frameBudget` counter reset each fixed update.
- Skip lower-priority emitters once the budget is exhausted.
- Files: `src/particles.ts`, all emitter call sites in `src/game.ts`, `src/gamestate.ts`, `src/weaponFiring.ts`, `src/fighterCombat.ts`.

**2. fillRect / tiny-shape optimization for small particles at low zoom**

The problem statement requested using `fillRect` or tiny diamond shapes for very small particles when zoomed out, reserving `ctx.arc` for larger or higher-priority particles. This would reduce arc/bezier overhead at low zoom. Files: `src/particles.ts` draw() method.

**3. Crystal nebula mote draw budget cap**

Current adaptive decimation is modular (every Nth mote). A hard cap on total motes drawn per frame (e.g. max 300) with prioritization toward disturbed/active motes would give more predictable frame cost. File: `src/crystalnebula.ts` draw().

**4. GlowLayer: reduce colorToCSS string allocations inside tight loops**

`circleScreen`/`lineScreen` call `colorToCSS` every time. A future pass could batch same-color primitives or cache the CSS string per Color object reference. File: `src/glowlayer.ts`, `src/colors.ts`.

**5. Crystal nebula laser-kill disturbances**

Kills via `damageLaserLine` and `damageLaserLineLimited` do not yet inject crystal disturbances. See the Build 035 section below for wiring instructions.

---

## Visual Overhaul Pass 2 — Build 030 — Remaining Work

Build 030 implemented the highest-impact parts of the second-pass visual overhaul. The following items were deferred because they are either complex, require deeper architectural changes, or need more content art direction before implementation.

### High Priority

**1. Per-building layered rendering (building.ts)**
The building draw methods are currently dense one-liners (legacy style). A proper
second-pass overhaul would expand each building class's `draw()` method into
multi-layer rendering:
- `PowerGenerator`: glowing energy orb core with emanating spokes and pulsing outer shell
- `ResearchLab`: multi-ring scanning animation with orbiting node dots
- `Factory`: animated gear with coolant pipes and intake vents
- `Shipyard`: launch bay opening animation; ship silhouettes docking/undocking
- `CommandPost`: satellite dish animation or antenna cross with rotating radar sweep
- `Turrets`: distinct barrel/mount shapes per type (gatling = multi-barrel, missile = launch tubes, exciter = antenna array)

Each building should use the warm color constants added in Build 030
(`building_glow_power`, `building_glow_research`, etc.).

**2. Fighter damage flicker and death breakup (fighter.ts)**
When a fighter takes heavy damage:
- Add a `damageFraction`-based flicker to the outline alpha
- Add a small random "twist" to the angle when near death

When a fighter dies at high speed:
- Emit a short spinning fragment arc from `emitExplosion`
- Already partially handled by `emitExplosion` but could be richer

**3. Player ship visual polish (ship.ts)**
The player ship already has good thruster trails but could benefit from:
- A more elaborate 3-layer silhouette (hull + wing outlines + engine pod)
- Weapon-specific muzzle positions (cannon = bow tip, gatling = side pods)
- Shield hit flash when shield absorbs damage

**4. Synonymous faction visual overhaul (fighter.ts / building.ts)**
The Synonymous faction drones share the same triangle silhouette as standard fighters.
Give them a distinctive swarm-style visual:
- Hexagonal core dot surrounded by small orbiting flecks
- Nova-bomber: larger glowing sphere with drone count indicator arcs

**5. Build placement and command indicator polish (actionmenu.ts / game.ts)**
- Build placement ghost: add a warm pulsing outer ring at `buildRadius` to show influence area
- Invalid placement: red cross-hatch overlay (not just the current red tint)
- Rally point: animated radiating ring at the rally position
- Attack command: briefly draw a crosshair/reticle at the target position

### Medium Priority

**6. Directional conduit energy flow (grid.ts)**
The `drawConduitPulses()` method added in Build 030 draws individual pulses per cell.
A more satisfying version would:
- Precompute energy flow direction per conduit cell using the PowerGraph BFS tree
- Animate pulses traveling FROM generator cells TOWARD powered buildings
- Only recalculate directions when the power graph is invalidated

**7. Selection and hover feedback (commandMode / game.ts)**
- Selected units: draw elegant bracket corners (not just a circle)
- Hovered buildings: draw a subtle warm outline highlight
- Drag selection box: replace the plain rectangle with a polished semi-transparent box
  with corner brackets

**8. Range and targeting indicator polish (turret.ts / gameOverlays.ts)**
- Gatling turret: draw a narrow scanning arc when no target is acquired
- Exciter turret: add a brief targeting bracket animation around the lock-on target
  before firing (currently only has the lock-on circle in High mode)
- Mass driver turret: draw a heavy kinetic reticle with range ring

**9. Warmer background atmosphere (nebula.ts)**
- The current nebula is blue/purple/red. Add a golden/amber mid-section nebula
  centered around the contested border zone
- Add very subtle slow-moving dust particles in the background in High mode
  (use the existing StarField's twinkling infrastructure for performance)

### Low Priority / Stretch

**10. Death spin for large ships**
When a large ship (Synonymous nova bomber, player ship) dies, briefly emit a
spinning angular fragment arc before the explosion.

**11. Weapon charge-up feedback for player**
When the laser is charging (RMB hold), add an expanding glow ring around the
player ship that fills in as charge completes. Already has some charge visuals
but could be dramatically improved.

**12. Warm ambient scan-line for buildings**
Add a very slow vertical "scan" highlight that travels up each powered building,
suggesting an active status readout. Should be on a ~4-second cycle and very subtle.

---



This PR (Build 020) addressed the most critical breakage in the Terran enemy AI
base-construction system.

### What was fixed

**1. True 4-connected conduit path generation (`src/aibaseplan.ts`)**

`traceLine()` previously used Bresenham's line algorithm without guarding
against diagonal steps.  When the algorithm's error term crossed zero in both
axes in the same iteration, both x *and* y changed, producing a step where
consecutive cells shared only a corner — not an edge.  Sign99's power graph
propagates energy only through 4-adjacent (orthogonal) neighbours, so these
diagonal steps silently broke power flow through every ring and every spoke.

The fix inserts an intermediate orthogonal cell whenever a diagonal step would
occur: the x-axis step fires first (pushing the intermediate), then the y-axis
step.  The result is a staircase path that is guaranteed 4-connected.

A new `assert4Connected(path, label)` helper is exported from `aibaseplan.ts`.
It logs a console warning on the first violated pair so future regressions are
immediately visible in debug mode.

**2. Building placement adjacent to ring conduit (`src/enemybaseplanner.ts`)**

`findBestBuildingCell()` used `minOffset = ceil(fp/2) + ringThickness + 1`
which placed buildings one cell too far from the ring outer edge.  The
footprint's inner border ended up 2–3 cells from the ring, so the
`isNearPlannedPower` check consistently failed for buildings between spokes.

Changed to `minOffset = floor(fp/2) + ringThickness` so buildings are placed
with their inner footprint border exactly adjacent to the ring outer edge:

- fp=3 building: footprint starts at R+2, inner border at R+1 (ring outer edge) ✓
- fp=4 building: footprint starts at R+2, inner border at R+1 ✓

**3. Connector conduit paths (`src/enemybaseplanner.ts`)**

Added `computeConnectorPath()` which, after a building candidate is locked in,
searches the ring conduit cells and spoke cells for the nearest planned/active
conduit cell and generates a 4-connected traceLine path to the building's inner
border (up to 5 cells max).  The path is stored in `BuildingSlot.connectorCells`
and dispatched as individual conduit orders before the building order itself.

`BuildingSlot` now carries two new fields: `connectorCells` (the path) and
`connectorQueuePtr` (current dispatch index; -1 = candidate not yet locked).

`nextBuildingSlotOrder()` is now a two-phase state machine:
- Phase A: drain pending connector conduit orders for an already-locked slot.
- Phase B: find candidate, compute connectors, lock slot, dispatch first connector
  or building if no connectors are needed.

**4. Ring advancement based on real construction progress (`src/enemybaseplanner.ts`)**

`maybeAdvanceRing()` previously advanced rings when enough building slots were
*queued* (`s.queued || s.placed`), meaning ring 1 could open before a single
conduit or building in ring 0 was actually constructed.

Changed to count:
- `placedConduit / totalConduit` — fraction of ring conduit cells actually in
  the grid (using `state.grid.hasConduit`).
- `placed / slots.length` — fraction of building slots actually constructed.

Thresholds scale with difficulty (Easy: 45% / 20%, Nightmare: 85% / 60%).  A
90-second stuck-safety timer forces advancement if a ring is completely blocked
so the AI never stalls indefinitely on unplaceable slots.

---

## What was NOT implemented (remaining work)

### Connector conduit: relay stuck-slot retry

When a building slot fails `getStructureFootprintStatus` at Phase B dispatch
time (e.g. a player built over the reserved area), `slot.queued` stays false but
`slot.connectorQueuePtr >= 0`, so it will loop back through Phase A (no-op) and
then Phase B indefinitely, skipping each time.  A per-slot "skip cooldown" and
retry counter should be added so the planner eventually gives up on a slot and
resets it.

### F3 / debug overlay for AI construction

The problem statement requested a debug visualization showing:
- planned conduit cells, queued conduit cells, active conduits, energized conduits
- unpowered active conduits
- planned / blocked building slots
- active builder targets
- ring index, ring completion %, connected-to-CP status
- powered vs total buildings

**File to modify:** `src/game.ts` drawDebugOverlay (or create a new
`src/aibasedebug.ts`).  The data is available via `EnemyBasePlanner.snapshot()`
and the new `rings`, `spokes`, `claimedConduitKeys`, and `reservedCells`.
Expose getters for these or pass the planner reference to the debug renderer.

### Bastion back-spoke connection

`generateBastions()` sets `bastion.spokeBackCells = []` and never populates it.
Bastions should have a conduit spoke back to the nearest ring so power actually
reaches them.  Add a `traceLine` from the bastion anchor to the nearest ring
cell, and queue those cells via a new `nextBastionSpokeOrder()` sub-method.

### Adaptive ring-gap topology

Currently, `gapProbability` randomly omits ring segments.  On Easy difficulty,
this can accidentally disconnect an entire ring half from all spokes.  A
post-generation pass should verify each ring arc segment has at least one spoke
touching it and re-join the segment if not.

### `isNearPlannedPower` semantic split

The function checks `claimedConduitKeys` (queued/planned) alongside actual grid
conduits and energized cells.  For placement-time decisions this is correct
(future-looking), but the distinction between "planned" and "actually powered"
is now more important after the ring-advancement fix.  A future pass could
rename the function `hasPowerConnector()` and add a separate
`isActuallyPowered(state, cx, cy)` for diagnostics and more precise validation.

### Player conduit painting vs. AI footprint rejection

`getStructureFootprintStatus` correctly rejects building placements that would
overlap an enemy conduit.  But when the AI generates connector paths, it does
not yet reserve those connector cells in `reservedCells` before calling
`canAIPlaceConduit`.  Two connector orders for adjacent slots could therefore
race for the same cell.  Fix: call `reserveCells([cell])` for all connector
cells when locking the slot, not lazily per-dispatch.

---

## Crystal Nebula — Build 035 — Remaining / Deferred Work

### Wire laser-kill explosions into CrystalNebula

Kills via `damageLaserLine` and `damageLaserLineLimited` in `src/combatUtils.ts` do not yet call `crystalNebula.addExplosion()`.  Wiring them in requires adding an optional `crystalNebula?: CrystalNebula` parameter to both functions and updating their callers in:
- `src/weaponFiring.ts` — update `WeaponFiringCtx` interface and the three call sites
- `src/turretCombat.ts` — add optional parameter to `damageLaserLine` call
- `src/fighterCombat.ts` — add optional parameter to `damageLaserLineLimited` call

### Add more explosion hook sites in mine.ts and combatUtils.ts

`src/mine.ts` calls `this.gameState.particles.emitExplosion(...)` on mine detonation without producing a `pendingCrystalExplosions` entry. Add a `pendingCrystalExplosions.push(...)` alongside the existing `emitExplosion` call.

---


### Online Multiplayer — PR 19 Implementation Summary

**Phase 7 — Full Supabase lobby integration**

**Files to create/modify:**
- `src/online/supabaseLobby.ts` — Supabase client init, lobby CRUD, heartbeat.
- `src/online/onlineClient.ts` — Online transport adapter implementing `MultiplayerTransport`.
- `src/menu.ts` — Wire up `drawOnlineMultiplayer` to real lobby list/create/join flows.

**Phase 8 — WebRTC DataChannel transport**

**Files to create:**
- `src/online/webrtcTransport.ts` — `WebRtcTransport` implementing `MultiplayerTransport`.
- `src/online/signalingClient.ts` — Supabase-based offer/answer/ICE exchange.

### Confluence follow-up work

- Add full save/load + LAN snapshot serialization for `factionByTeam` and `territoryCirclesByTeam` so matches restore in-progress circle growth exactly.
- Branch enemy/practice AI base planner to intentionally use confluence ring-band placement instead of conduit/planner assumptions.
- Add cached offscreen territory compositing + exterior-boundary-only arc extraction to further reduce overdraw with very high circle counts.
- Add faction selection UI in main/practice setup (currently player faction is initialized to Confluence in start flow).
- Add confluence-specific visual polish for building bases (orbital sockets/motes) and optional deterministic boundary motes.

### Synonymous ship notes

- The Synonymous player ship now uses a 50-slot deterministic circle renderer in `src/synonymousShipRenderer.ts`; full health shows 40 particles, or 50 after `synonymousVitality`, and damaged health scales down to 20 visible particles.
- Current Synonymous balance values are in `src/constants.ts`: basic laser damage 11, cooldown 56 ticks, range 760, pierce 4. `synonymousPierce` doubles pierce to 8. `synonymousFireSpeed1..4` add +25% base fire-rate per level by dividing the base cooldown by `1 + 0.25 * level`.
- `synonymousSpeed` currently applies `maxSpeed * 1.16` and `thrustPower * 1.18`; `synonymousVitality` applies `maxHealth * 1.4`, heals to full, unlocks 50 full-health particles, and adds 2.2 HP/s regeneration.
- Manual visual QA still needs an in-browser pass for the morph states: idle pentagon, Q/build circle, movement triangle, firing aperture, and damaged particle-count reduction.

### Synonymous mine layer notes

- `synonymousminelayer` is a Synonymous-only offensive turret that costs 65 nanobots, builds in 210 ticks, and maintains up to 9 drifting mines. Each mine drifts toward a 250 world-unit radius, explodes at that radius, and accelerates toward enemies inside 125 world units.
- Mine balance lives in `src/synonymousMine.ts`: 32 damage, 58 AOE radius, 6 mine HP, 23 initial drift speed, and 245 max chase speed. Mine AOE excludes same-team targets through the existing blast-damage team filter.
- Manual visual QA should confirm the 20-nanobot spinning circle reads clearly and that both friendly and hostile projectiles can detonate mines.

### Synonymous Fighter Follow-up

- LAN snapshot reconciliation still reconstructs remote fighters as generic `FighterShip`/`BomberShip`; extend the network snapshot with faction/unit-variant metadata before relying on Synonymous fighter visuals in multiplayer clients.
- Nova Bomber sub-drone damage is currently assigned by a conservative adapter in `src/fighter.ts`: incoming damage is applied to one living drone at a time, biased by source angle when available. Future hitbox work could target the nearest visible drone offset directly.

### Ship Pathfinding Follow-up

- Mobile-unit navigation now budgets fighter path resolves, shares nearby fighter route results, caches blocking rects per frame, tries cheap detours before full A*, and uses a heap-backed A* open set. If F3 still shows high mobile pathfinding time in dense-base playtests, add a true building-collision version counter so blocker caches can persist across frames until a collision-enabled structure is added, completed, destroyed, moved, or removed.


## Ship Pathfinding Follow-up

- Manual playtest still recommended: build a wall loop with a bottom opening, command fighters from inside/right side to the left outside target, and confirm they route through the opening without pushing into the left wall.
- Dynamic obstacle handling remains intentionally lightweight: ship routes are cached and throttled, then refreshed on target movement, waypoint progress, stuck detection, or blocked cached waypoints rather than fully replanned every frame.
- Squad path sharing currently shares the next navigation waypoint by nearby start/target buckets. If very large groups still bunch at narrow openings, add a small corridor-slot offset around successive A* waypoints rather than increasing the per-frame path budget.

---

---

## Visual Polish Pass — Build 041 — Future Cleanup

### Minor API Cleanup

**1. Remove unused `team` parameter from emitExhaust / emitSideExhaust (particles.ts)**

All ship exhaust now uses warm thrust colours regardless of team. The `team` parameter
(currently prefixed `_team`) in `emitExhaust()` and `emitSideExhaust()` is vestigial and
can be removed in a future refactor along with all call-site changes:
- `src/particles.ts` — remove `_team: Team` from both signatures
- `src/game.ts` — remove `Team.Player` argument from exhaust emission calls
- `src/entities.ts` / other files — any other call sites passing team to these methods

This is low-risk but touches several files; best batched with a broader API cleanup pass.

## Validation blocker: cinematic level changes

- Commands: `npm run typecheck` and `npm run build`.
- Error: `src/suns.ts(317,23): error TS2367: This comparison appears to be unintentional because the types '-1 | -3 | -2' and '6' have no overlap.`
- Likely cause: the cinematic level type is being changed in the working tree while the sun renderer still compares against level 6 and higher.
- Recommended fix: finish reconciling the sun renderer with the intended cinematic level range, then rerun both commands. This overlaps ongoing cinematic edits and was left untouched by the menu animation timing change.
