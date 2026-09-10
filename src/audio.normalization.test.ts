import { afterEach, expect, it, vi } from 'vitest';
import { MUSIC_LOUDNESS_GAINS } from './musicLoudness';

it('keeps normalization, crossfade envelopes, and the music slider independent', async () => {
  const gains: any[] = [];
  const sources: any[] = [];
  const elements: any[] = [];
  let frame: FrameRequestCallback | undefined;
  class FakeAudio {
    volume = 1;
    loop = false;
    preload = '';
    constructor(public src: string) { elements.push(this); }
    addEventListener() {}
    play() { return Promise.resolve(); }
    pause() {}
    removeAttribute() {}
    load() {}
  }
  const node = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('AudioContext', class {
    state = 'running';
    destination = {};
    createGain() { const n = node(); gains.push(n); return n; }
    createMediaElementSource() { const n = node(); sources.push(n); return n; }
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.resetModules();
  const { Audio } = await import('./audio');
  Audio.playMenuMusic();
  expect(gains[2].gain.value).toBe(MUSIC_LOUDNESS_GAINS['music/Music-Menu/absolutesound-acoustic-guitar-chill-516783.mp3']);
  expect(elements[0].volume).toBe(1);
  Audio.startPlaylist();
  expect(sources[0].disconnect).toHaveBeenCalled();
  const firstTrack = decodeURI(elements[1].src).replace(/^.*?music\//, 'music/');
  expect(gains[3].gain.value).toBe(MUSIC_LOUDNESS_GAINS[firstTrack]);
  Audio.skipSong();
  frame!(4000);
  expect(elements[1].volume).toBe(0.5);
  expect(elements[2].volume).toBe(0.5);
  Audio.setMusicVolume(0.8);
  expect(gains[1].gain.value).toBeCloseTo(0.08);
  expect(elements[1].volume).toBe(0.5);
  expect(elements[2].volume).toBe(0.5);
  frame!(8000);
  expect(elements[2].volume).toBe(1);
  // A new game starts at level one; threat changes select the matching folder.
  Audio.startPlaylist();
  expect(elements.at(-1).src).toContain('ThreatLevel1/');
  const danger = { enemyTurrets: 60, enemyFighters: 30, playerFighters: 20, commandPostHealthRatio: 1 };
  const before = elements.length;
  Audio.updateMusicThreat(danger, 4.9);
  expect(elements.length).toBe(before);
  Audio.updateMusicThreat(danger, 0.1);
  expect(elements.at(-1).src).toContain('ThreatLevel4/');
  frame!(4000);
  const fading = elements.at(-2);
  expect(fading.volume).toBe(0.5);
  Audio.updateMusicThreat({ ...danger, playerFighters: 10, commandPostHealthRatio: 0.75 }, 5);
  expect(elements.at(-1).src).toContain('ThreatLevel5/');
  expect(fading.volume).toBe(0.5);
  frame!(4000);
  expect(fading.volume).toBe(0.25);
  frame!(8000);
  Audio.skipSong();
  expect(elements.at(-1).src).toContain('ThreatLevel5/');
  Audio.updateMusicThreat({ ...danger, enemyTurrets: 0, enemyFighters: 0 }, 30);
  expect(elements.at(-1).src).toContain('ThreatLevel1/');
  Audio.playMenuMusic();
  const menuCount = elements.length;
  Audio.updateMusicThreat(danger, 20);
  expect(elements.length).toBe(menuCount);
  Audio.stopMusic();
  expect(sources.every(n => n.disconnect.mock.calls.length === 1)).toBe(true);
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
