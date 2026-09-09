# Gameplay Contract

This build targets a small playable Sign99 loop: direct ship control, grid-snapped base construction, conduits, research unlocks, shipyards, turrets, and command post destruction.

## Races

- Terran is the original conduit faction. It uses the Q conduit brush, conduit-graph power, and automatic conduit blueprints that form a full one-cell perimeter ring, including corners, around placed buildings.
- Concentroid is the circle-territory faction. It does not use conduits; buildings extend territory circles and must be placed on the Concentroid frontier band.
- The Synonymous is the nanobot-swarm faction. It does not use conduits or grid power; the Command Post and Factories produce nanobot drones, Q exposes a free Shape tool, and the first playable structures are Factory, Research Lab, and a weak fast Laser Turret represented through the Missile Turret slot.
- Practice, Vs. AI, and LAN setup expose race selection. Random resolves to Terran, Concentroid, or The Synonymous when the match starts.

## Controls

- WASD moves the player ship. Mouse aims. Left mouse fires the primary weapon.
- Shift boosts the player ship only while it has at least 10% energy. After Main Ship Dash research, first pressing Shift while above 75% energy spends 25% maximum energy and bursts the ship forward in its facing direction with a bright trail for roughly 1.6 seconds. Passive hull regeneration is doubled while the energy bar is full.
- Right mouse fires the equipped special. Cannon drops a cross-laser mine, Gatling triggers overdrive, Laser charges a deterministic vermiculate burst (one piercing worm laser per complete 10 energy spent), and Guided Missile fires a missile swarm.
- Hold Q for the build menu, choose a building from the left palette, then left click or drag over valid footprints to place it. Right mouse deletes player buildings.
- Hold Z for the ship menu, view ship stats/upgrades, and select the active primary weapon by clicking or using the mouse wheel.
- Hold Q for the quick-build palette. Conduit is first; mouse wheel or clicking a left-side palette icon selects what to place. With Conduit selected, left mouse queues player conduits with a 2x2 brush and right mouse erases with the same brush. With a building selected, left mouse places that building.
- For The Synonymous, Q replaces Conduit with Shape. Holding left mouse draws freeform swarm trails from the Command Post; right mouse recalls nearby free drones back toward the base. Buildings consume nanobots instead of money, and deleting a Synonymous building releases its nanobots back into the swarm.
- Hold X for research. Hold C for ship commands for groups 1, 2, 3, or ALL. Hold 1, 2, or 3 and click a shipyard to assign that number; hold a number and click elsewhere to set that group's waypoint; hold a number and right click to dock that group. Hold Tab for radar. F3 toggles the debug overlay. Escape pauses.

## Win And Loss

- Tutorial has no enemies and no win/loss.
- Practice and Vs. AI are won by destroying the enemy Command Post.
- Practice/Vs. AI defeat depends on setup, but the default is losing the player Command Post.
- The player ship can respawn after destruction if the match is not otherwise lost.
- Ranked Vs. AI difficulties progress through Easy, Normal, Hard, Expert, Nightmare, and Zenith. Ranked APM scales over the full rank ladder from 10 APM at rank 0 to 500 APM at the top of Zenith.
- In Survival, each newly spawned enemy base escalates by 100 AI-rank points from the starting Survival rank before deriving that base planner's difficulty. Once the time-based escalation would exceed rank 3000, new bases stay at rank 3000 with cheater-style resource income enabled and then continue spawning with increasingly developed starts: more starting resources, faster build speed, and more builders over later post-cap tiers.
- Ranked Survival score is whole seconds survived multiplied by the difficulty multiplier (AI rank / 100), then floored to the nearest 100 points.
- Ranked Vs. AI can opt into the existing full-map-knowledge and 1.25x-resource AI modifiers. Each adds +0.25 to the score multiplier; both together score at x1.5 total.

## Resources

- The player gains a small baseline income over time.
- Finished, powered Factories add bonus income.
- Buildings, conduits, and research spend resources only when the action succeeds. Conduits cost $1 per cell.
- The Synonymous player does not gain money income. Its visible free nanobot count is the spendable resource; Command Posts and Factories each produce 1 nanobot per second.

## Building Placement

- The grid cell size is one third of the original port grid.
- Buildings snap to grid footprints: most buildings are 3x3, Factories and Research Labs are 4x4, and Command Posts are 6x6.
- Placement requires enough resources, an empty cell, world bounds, and adjacency to the player power network.
- Concentroid placement instead requires the building footprint to sit on the race's frontier band.
- Synonymous placement is freeform and does not require grid power or frontier bands, but the player must have enough free nanobots for the selected structure.
- The player power network means a Command Post, Power Generator, powered conduit, existing conduit, or pending conduit next to the target cell.
- Command Post rebuild is hidden until the player has no Command Post.
- Invalid placement shows a red cursor and does not spend resources or fire weapons.

## Power

- This port intentionally uses conduit-graph power rather than pure radius power.
- Command Posts and completed Power Generators are power sources.
- Same-team conduits carry power by 4-way adjacency from a source.
- Non-source buildings are powered when their cell or a neighboring cell is energized.
- Powered conduits are brighter; pending conduits are dashed. Unpowered buildings show a HUD warning, faint flashing yellow outline, and intermittent sparks.
- Shipyards, factories, labs, and turrets require construction completion and power for their active behavior.

## Fighters And Shipyards

- Fighter Yards produce fighters. Bomber Yards produce bombers after Bomber Yard research and are capped at 3 player yards. Swarm Yards are Terran-only 7x7 shipyards unlocked through Fighters research; each fields up to 20 tiny 5 HP Swarm ships with short-range instant lasers that linger visibly for 0.5 seconds. Swarm ships auto-break from waypoint/protect/idle movement toward nearby hostile ships, fighters, and buildings so they can close to laser range, and the player can place up to 5 Swarm Yards.
- Shipyards only produce while finished, powered, and below capacity.
- Advanced Fighters research raises player shipyard capacity and speeds player ship production.
- C-menu orders are active: Protect Base defends the player Command Post, Set Waypoint uses the cursor location, Follow Player follows the player ship, and Dock returns ships to their home yard. While holding C or a number key, player shipyards show a large group number.

## Enemy AI

- Enemy structures are queued by the base planner and then build visibly like player structures; the enemy main ship does not need to be nearby for queued structures to start placement.
- Terran/default enemy base doctrines can place Gatling Turrets through normal ring recipes and reactive turret replacement. Gatlings are common early close-defense and picket turrets, while Missile, Exciter, Mass Driver, and Regen Turrets remain mixed in by doctrine, role, difficulty, and observed player strategy.
- Hard+ Terran/default enemies run their own base-planner research for Bomber Yards and then push toward the 5-yard Bomber cap quickly. Expert+ enemies research Swarm Yards once Fighter Yard pressure is near saturation, around 8 queued or placed Fighter Yards, then add Swarm Yards through normal doctrine/backfill placement.
- Enemy fighter rally waypoints stay within 1000 world units of the enemy main ship when that ship exists.
- Higher difficulty enemies stage produced fighters near base before attacking. Nightmare timing waits for near-full shipyard output so ship production is not left capped and idle.
- Medium and higher enemies periodically audit power connectivity. Hard and Nightmare enemies prioritize reconnecting unpowered production, research, and turret areas before normal expansion, and add bounded redundant conduit links after repeated outages.
- Hard and Nightmare enemies avoid wasting Power Generators inside already-powered main rings, backfill safer inner rings with extra Fighter Yards, Bomber Yards, Research Labs, and Factories after outer defenses exist, and add protective wall patterns around key shipyards, labs, and turrets.
- Zenith enemies use a swarm-biased doctrine with compact placement, high shipyard targets, faster build execution, larger staged fighter waves, advanced shielded fighters, and target priorities that favor anti-fighter turrets, shipyards, research, and production. Zenith reacts to 4+ player shipyards by favoring Mass Driver Turrets and keeps the rival hero ship near attack waves after shield research while still retreating when endangered.

## Research

- Research requires at least one powered, finished Research Lab to progress.
- One active research item can run at a time.
- Active research items are turret unlocks, Bomber Yard, Advanced Fighters, and Main Ship upgrades including Dash.
- Mine Layer research and construction are exclusive to The Synonymous faction; Terran players do not see or unlock Mine Layers.
- Completed research is hidden from the research menu and summarized on the HUD.
- Gatling Turret is a starter long-range suppressive bullet turret. Missile Turret costs $80 to research before it appears in the build menu. Exciter Turret remains research-gated, uses a 4x4 footprint with a plus-shaped body, and fires a 2-second lock-on laser with a 3-second cooldown. Its target countdown shows converging arrows plus a clockwise-filling lock circle. It may lock ships, fighters, buildings, and interceptable hostile missiles, but it must not lock ordinary bullets.
- Advanced Regen Turrets research appears after Regen Turrets research and lets finished powered player Regen Turrets rebuild nearby destroyed player conduits for free.
- Player guided missiles and missile-swarm projectiles are interceptable hostile projectiles. Enemy shots and exciter beams can destroy them before impact.
- Cannon mine deployment can repeat quickly while right mouse is held. Each mine costs 75% of the player's baseline maximum energy, reduced to 50% after Cannon V.2 research.

## Hidden Or Not Implemented

- Time Bomb, Signal Station, Jump Gate, Cloak, and Vs. Player are intentionally hidden from active menus because they do not have complete coherent gameplay.
- Constants or entity enum entries for hidden items may remain for compatibility, but they are not part of the playable contract.
