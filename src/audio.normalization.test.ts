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
  Audio.stopMusic();
  expect(sources.every(n => n.disconnect.mock.calls.length === 1)).toBe(true);
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
