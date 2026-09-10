# Music loudness

Run `npm run music:scan` after adding music under `ASSETS/music/Music-InGame` or `ASSETS/music/Music-Menu`. The same scan runs before `npm run dev` and `npm run build`.

The scanner uses bundled FFmpeg to measure integrated LUFS and true peak. SHA-256 measurements are cached in `ASSETS/music/loudness-cache.json`; unchanged audio is not reanalyzed. Commit that cache and `src/musicLoudness.ts` with music changes. Supported extensions: MP3, OGG, WAV, M4A, FLAC. Files are copied byte-for-byte into the corresponding public folders; source recordings are never rewritten.

Playback applies a constant gain per track, targeting -18 LUFS, capped so measured true peaks stay at or below -2 dBTP. Tracks with large peaks can remain quieter than the target to preserve dynamics without clipping or compression. These limits describe individual tracks before the existing music volume control. Crossfades and the volume slider remain independent of normalization.

All five threat folders participate in gameplay playlists. Music starts at level 1. Level 2 requires 20 enemy turrets or 5 fighters; level 3 requires 40 or 15; level 4 requires 60 or 30. Level 5 requires at least 10 enemy fighters, at least twice the local player's fighter count, and a Command Post at 75% health or less (a destroyed post counts as zero health). The highest matching level must persist for 5 seconds to escalate or 30 seconds to decrease. Timers advance only during gameplay and reset when the candidate changes. New matches reset to level 1.

Counts include living, completed hostile turrets and living fighter-type units, including docked fighters; bombers and neutral entities are excluded. Multiplayer evaluates all opposing teams relative to the local player. Each switch picks a random track from the new level with an eight-second crossfade, preserving existing fading tracks if another switch occurs mid-transition. Normal song endings and skips remain within the current level. All menu tracks are normalized; menu selection still uses the existing menu song.

The first scan can take several minutes. Later scans only measure new or changed content. Deleted sources are omitted from the manifest; the scanner does not delete old public assets.
