# Repository Guide

## Purpose
This document maps the repository structure and gives a concise, broad summary of every tracked file.

## Agent Maintenance Instructions
- Any new file added to the repository **must** be added to this guide in the relevant section.
- Any substantive update to an existing file should add/update a short note here with the **approximate location** changed (for example: `src/game.ts` mid-file update loop, `docs/LAN.md` setup section).
- Keep entries concise: one-line file summary + one-line broad “contains” statement.
- When files are removed/renamed, update this guide in the same commit.

## Repository Structure
- `src/`: main game/client TypeScript code
- `server/`: LAN server/discovery TypeScript code
- `public/`: static assets served by Vite
- `ASSETS/`: source asset library (music, sound, fonts)
- `docs/`: project documentation
- `ORIGINAL/`: preserved original Sign99 distribution artifacts
- Root configs/docs: build tooling, specs, and project metadata

## Full File Inventory

| File | Short summary | Broad contents |
|---|---|---|
| `.env.example` | Environment variable template. | Documents `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` placeholders for online multiplayer setup. |
| `.github/copilot-instructions.md` | Markdown project documentation/spec. | Headings, prose guidance, constraints, and reference details for contributors/users. |
| `.github/workflows/static.yml` | Repository file. | File-specific data/content. |
| `.gitignore` | Repository file. | File-specific data/content. |
| `ASSETS/fonts/BJ_Cree/BJCree-Bold.ttf` | Source asset file (audio/font/license) used to populate public assets. | Binary font glyph and metrics data. |
| `ASSETS/fonts/BJ_Cree/BJCree-Medium.ttf` | Source asset file (audio/font/license) used to populate public assets. | Binary font glyph and metrics data. |
| `ASSETS/fonts/BJ_Cree/BJCree-Regular.ttf` | Source asset file (audio/font/license) used to populate public assets. | Binary font glyph and metrics data. |
| `ASSETS/fonts/BJ_Cree/BJCree-SemiBold.ttf` | Source asset file (audio/font/license) used to populate public assets. | Binary font glyph and metrics data. |
| `ASSETS/fonts/BJ_Cree/OFL.txt` | Source asset file (audio/font/license) used to populate public assets. | Human-readable text such as licenses/readme/guidelines. |
| `ASSETS/fonts/BJ_Cree_guidelines.txt` | Source asset file (audio/font/license) used to populate public assets. | Human-readable text such as licenses/readme/guidelines. |
| `ASSETS/fonts/Poiret_One/OFL.txt` | Source asset file (audio/font/license) used to populate public assets. | Human-readable text such as licenses/readme/guidelines. |
| `ASSETS/fonts/Poiret_One/PoiretOne-Regular.ttf` | Source asset file (audio/font/license) used to populate public assets. | Binary font glyph and metrics data. |
| `ASSETS/music/Music-InGame/*.mp3` | Source in-game soundtrack files used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/music/Music-Menu/*.mp3` | Source menu soundtrack files used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/bhit0.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/bigfire.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/bigmissile.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/bigregenbullet.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/build.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/changespecial.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/cloak.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/drive.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/enemydrive.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/enemyhere.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/exciterbeam.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/exciterbullet.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/explode0.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/explode1.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/explode2.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/fire.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/firebomb.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/genericcollision.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/heavy.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/laser.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/massdriverbullet.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/menucursor.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/menuselection.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/minilaser.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/missile.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/missile2.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/openradar.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/regenbullet.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/researchcomplete.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/selfregen.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `ASSETS/sound/shortbullet.wav` | Source asset file (audio/font/license) used to populate public assets. | Encoded audio waveform data; no source code. |
| `FEATURES.md` | Markdown project documentation/spec. | Headings, prose guidance, constraints, and reference details for contributors/users. |
| `GAMEPLAY_CONTRACT.md` | Markdown project documentation/spec. | Headings, prose guidance, constraints, and reference details for contributors/users. |
| `ORIGINAL/Sign99_Mar19_05/Colour Test.bat` | Original legacy Sign99 distribution/reference artifact. | Windows shell commands for launching utilities. |
| `ORIGINAL/Sign99_Mar19_05/Dedicated Server.bat` | Original legacy Sign99 distribution/reference artifact. | Windows shell commands for launching utilities. |
| `ORIGINAL/Sign99_Mar19_05/LGPL_license.txt` | Original legacy Sign99 distribution/reference artifact. | Human-readable text such as licenses/readme/guidelines. |
| `ORIGINAL/Sign99_Mar19_05/SDL.dll` | Original legacy Sign99 distribution/reference artifact. | Compiled binary artifact. |
| `ORIGINAL/Sign99_Mar19_05/SDL_mixer.dll` | Original legacy Sign99 distribution/reference artifact. | Compiled binary artifact. |
| `ORIGINAL/Sign99_Mar19_05/SDL_net.dll` | Original legacy Sign99 distribution/reference artifact. | Compiled binary artifact. |
| `ORIGINAL/Sign99_Mar19_05/audio.conf` | Original legacy Sign99 distribution/reference artifact. | Key/value or section-based legacy runtime configuration parameters. |
| `ORIGINAL/Sign99_Mar19_05/coloreditor.exe` | Original legacy Sign99 distribution/reference artifact. | Compiled binary artifact. |
| `ORIGINAL/Sign99_Mar19_05/colours.conf` | Original legacy Sign99 distribution/reference artifact. | Key/value or section-based legacy runtime configuration parameters. |
| `ORIGINAL/Sign99_Mar19_05/debug.conf` | Original legacy Sign99 distribution/reference artifact. | Key/value or section-based legacy runtime configuration parameters. |
| `ORIGINAL/Sign99_Mar19_05/sign99.exe` | Original legacy Sign99 distribution/reference artifact. | Compiled binary artifact. |
| `ORIGINAL/Sign99_Mar19_05/irc_client.conf` | Original legacy Sign99 distribution/reference artifact. | Key/value or section-based legacy runtime configuration parameters. |
| `ORIGINAL/Sign99_Mar19_05/irc_connection.conf` | Original legacy Sign99 distribution/reference artifact. | Key/value or section-based legacy runtime configuration parameters. |
| `ORIGINAL/Sign99_Mar19_05/license.txt` | Original legacy Sign99 distribution/reference artifact. | Human-readable text such as licenses/readme/guidelines. |
| `ORIGINAL/Sign99_Mar19_05/manual.html` | Original legacy Sign99 distribution/reference artifact. | HTML markup defining document structure/content. |
| `ORIGINAL/Sign99_Mar19_05/masterserver.conf` | Original legacy Sign99 distribution/reference artifact. | Key/value or section-based legacy runtime configuration parameters. |
| `ORIGINAL/Sign99_Mar19_05/multiplayer.conf` | Original legacy Sign99 distribution/reference artifact. | Key/value or section-based legacy runtime configuration parameters. |
| `ORIGINAL/Sign99_Mar19_05/practice.conf` | Original legacy Sign99 distribution/reference artifact. | Key/value or section-based legacy runtime configuration parameters. |
| `ORIGINAL/Sign99_Mar19_05/readme.txt` | Original legacy Sign99 distribution/reference artifact. | Human-readable text such as licenses/readme/guidelines. |
| `ORIGINAL/Sign99_Mar19_05/server.conf` | Original legacy Sign99 distribution/reference artifact. | Key/value or section-based legacy runtime configuration parameters. |
| `ORIGINAL/Sign99_Mar19_05/textcolours.conf` | Original legacy Sign99 distribution/reference artifact. | Key/value or section-based legacy runtime configuration parameters. |
| `ORIGINAL/Sign99_Mar19_05/video.conf` | Original legacy Sign99 distribution/reference artifact. | Key/value or section-based legacy runtime configuration parameters. |
| `docs/LAN.md` | Project documentation. | Headings, prose guidance, constraints, and reference details for contributors/users. |
| `docs/ONLINE_MULTIPLAYER.md` | Online multiplayer architecture, Supabase setup, WebRTC notes, and testing checklist. | Describes host-authoritative snapshot model, phase status table, Supabase SQL schema, and nextStep guidance. |
| `docs/visual-polish.md` | Project documentation. | Headings, prose guidance, constraints, and reference details for contributors/users. |
| `index.html` | HTML entry or reference document. | HTML markup defining document structure/content. |
| `package-lock.json` | JSON configuration/metadata file. | Structured key/value settings consumed by npm, TypeScript, or tooling. |
| `package.json` | JSON configuration/metadata file. | Structured key/value settings consumed by npm, TypeScript, or tooling. |
| `public/favicon.svg` | Runtime-served static asset for web build. | XML vector path data for icon rendering. |
| `public/music/Music-InGame/*.mp3` | Runtime-served in-game soundtrack files for web and Electron builds. | Encoded audio waveform data; no source code. |
| `public/music/Music-Menu/*.mp3` | Runtime-served menu soundtrack files for web and Electron builds. | Encoded audio waveform data; no source code. |
| `public/sound/bhit0.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/bigfire.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/bigmissile.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/bigregenbullet.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/build.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/changespecial.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/cloak.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/drive.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/enemydrive.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/enemyhere.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/exciterbeam.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/exciterbullet.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/explode0.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/explode1.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/explode2.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/fire.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/firebomb.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/genericcollision.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/heavy.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/laser.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/massdriverbullet.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/menucursor.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/menuselection.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/minilaser.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/missile.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/missile2.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/openradar.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/regenbullet.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/researchcomplete.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/selfregen.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `public/sound/shortbullet.wav` | Runtime-served static asset for web build. | Encoded audio waveform data; no source code. |
| `server/lanDiscovery.ts` | TypeScript LAN server module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `server/lanServer.ts` | TypeScript LAN server module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/actionmenu.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/aibaseplan.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/aidoctrine.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/airaids.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/aiscore.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/audio.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/builddefs.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/builderdrone.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/building.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/camera.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/colors.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/constants.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/crystalnebula.ts` | Crystal Nebula Clouds visual layer. | Pooled angular crystal-mote particles organized in seeded cloud regions. Reacts to ships, projectiles, and explosions via disturbance/spring physics. Drawn additively between starfield and gameplay, quality-scaled via `VisualQualityPreset`. |
| `src/decodeText.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/enemyai.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/enemybaseplanner.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/entities.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/fighter.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/fonts.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/game.ts` | Main client game coordinator. | Owns loop, mode transitions, input, spawning, LAN snapshots, and high-level render orchestration; heavyweight draw helpers live in `src/gameRender.ts`. |
| `src/gameOverlays.ts` | Overlay and glow-pass drawing helpers extracted from `src/game.ts`. | Screen overlays, loss banner, radar/edge indicators, `drawGhostSpectator` (delegates to `GhostShipEffect`), and `drawGlowLayer`, whose priority-3 tier now includes the dead player's spirit-ship glow. |
| `src/gameRender.ts` | Extracted game render helpers. | Draws waypoint markers, debug overlay, and Concentroid territory visuals for `src/game.ts`. |
| `src/ghostShipEffect.ts` | Dead-player "spirit ship" visual: a fractal organism of triangular fragments. | `GhostShipEffect` pooled ring buffer (struct-of-arrays, hard cap); head curls procedurally around the spectator anchor and buds seeded Julia-like triangle clusters that never move after birth and age white -> faction -> black -> transparent; source-over triangle pass plus a GlowLayer halo pass; quality/adaptive density scaling. Visual only. |
| `src/ghostShipEffect.test.ts` | Vitest coverage for the spirit-ship effect. | Seed determinism, seed variation, fragment immutability, 1–4 s cooling range, tail alpha reaching zero, cap enforcement, density scaling, and clear/reset behaviour. |
| `src/gamestate.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/glowlayer.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/grid.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/hud.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/input.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/lan/lanClient.ts` | TypeScript gameplay/client module. | WebSocket client for the LAN relay; exposes callbacks for lobby updates, match start, snapshots, and inputs. |
| `src/lan/lanTransport.ts` | LAN transport adapter implementing `MultiplayerTransport`. | Wraps `LanClient` to satisfy the `MultiplayerTransport` interface; converts between LAN protocol and `src/net/protocol.ts` types. |
| `src/lan/protocol.ts` | TypeScript gameplay/client module. | LAN WebSocket message types (lobby, slots, snapshots, inputs) used by `LanClient` and `lanServer.ts`. |
| `src/main.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/math.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/menu.ts` | TypeScript gameplay/client module. | All menu screens: title, play, LAN lobby, online multiplayer stub, pause, settings, VS AI setup, practice setup. |
| `src/mine.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/nebula.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/net/protocol.ts` | Versioned canonical network protocol types (Phase 2). | `NetInputSnapshot`, `NetGameSnapshot`, and all sub-types with `protocolVersion`, seq, timestamps. Includes `validateInputSnapshot`/`validateGameSnapshot` helpers. |
| `src/net/transport.ts` | `MultiplayerTransport` interface and snapshot-rate constants (Phase 1). | Interface defining the contract between game logic and any multiplayer transport (LAN, WebRTC, etc.). `NET_SNAPSHOT_HZ = 20`, `NET_SNAPSHOT_INTERVAL`. |
| `src/particles.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/power.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/practiceconfig.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/practicemode.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/projectile.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/radar.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/ringeffects.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/respawnRuntime.ts` | Player/AI death, respawn, and ghost-spectator runtime. | `PlayerRespawnRuntime` (ghost position/velocity/facing plus the owned `GhostShipEffect`), respawn timers/penalties, WASD/Shift spectator movement; the former GhostLight ribbon trail was replaced by `src/ghostShipEffect.ts` (top-of-file state + `beginGhostEffect` near the spectator update). |
| `src/ship.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/spacefluid.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/special.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/starfield.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/suns.ts` | Distant Suns / Solar Backdrop visual layer. | Pre-baked screen-space warm radial glow plus optional volumetric rays, solar corona arcs, and lens-glint sparkles. Drawn after background fill and before nebula. Quality-scaled via `VisualQualityPreset`. |
| `src/teamutils.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/theme.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/turret.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/tutorial.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/version.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/visualquality.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/vsaibot.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `src/vsaiconfig.ts` | TypeScript gameplay/client module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
| `tsconfig.json` | JSON configuration/metadata file. | Structured key/value settings consumed by npm, TypeScript, or tooling. |
| `tsconfig.server.json` | JSON configuration/metadata file. | Structured key/value settings consumed by npm, TypeScript, or tooling. |
| `vite.config.ts` | TypeScript configuration or source module. | Exports constants/types/functions/classes implementing this subsystem; may include interfaces and update/render/control logic. |
