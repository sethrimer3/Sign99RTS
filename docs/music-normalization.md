# Music loudness

Run `npm run music:scan` after adding music under `ASSETS/music/Music-InGame` or `ASSETS/music/Music-Menu`. The same scan runs before `npm run dev` and `npm run build`.

The scanner uses bundled FFmpeg to measure integrated LUFS and true peak. SHA-256 measurements are cached in `ASSETS/music/loudness-cache.json`; unchanged audio is not reanalyzed. Commit that cache and `src/musicLoudness.ts` with music changes. Supported extensions: MP3, OGG, WAV, M4A, FLAC. Files are copied byte-for-byte into the corresponding public folders; source recordings are never rewritten.

Playback applies a constant gain per track, targeting -18 LUFS, capped so measured true peaks stay at or below -2 dBTP. Tracks with large peaks can remain quieter than the target to preserve dynamics without clipping or compression. These limits describe individual tracks before the existing music volume control. Crossfades and the volume slider remain independent of normalization.

All five threat folders and all menu tracks are measured. Playlist selection still uses the existing eight in-game songs (now from ThreatLevel1) and the existing menu song. Threat-dependent selection and menu rotation are separate features. New tracks already have adjustments ready when selected by future playlist logic.

The first scan can take several minutes. Later scans only measure new or changed content. Deleted sources are omitted from the manifest; the scanner does not delete old public assets.
