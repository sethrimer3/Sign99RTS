import { describe, it, expect } from 'vitest';
import {
  generateHostToken,
  appendHostTokenToUrl,
  extractHostTokenFromRequestUrl,
  hostTokensMatch,
} from './hostToken.js';

describe('generateHostToken', () => {
  it('produces a hex string of the requested byte length', () => {
    const token = generateHostToken(24);
    expect(token).toMatch(/^[0-9a-f]+$/);
    expect(token).toHaveLength(48);
  });

  it('is different every time (no accidental determinism)', () => {
    const a = generateHostToken();
    const b = generateHostToken();
    expect(a).not.toBe(b);
  });
});

describe('appendHostTokenToUrl / extractHostTokenFromRequestUrl round trip', () => {
  it('round-trips a token through a ws:// URL', () => {
    const url = appendHostTokenToUrl('ws://127.0.0.1:8787', 'abc123');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('hostToken')).toBe('abc123');
    // Simulate what the server sees as `req.url` (path + query only).
    const requestUrl = parsed.pathname + parsed.search;
    expect(extractHostTokenFromRequestUrl(requestUrl)).toBe('abc123');
  });

  it('preserves other query parameters already on the URL', () => {
    const url = appendHostTokenToUrl('ws://127.0.0.1:8787/?foo=bar', 'tok');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('foo')).toBe('bar');
    expect(parsed.searchParams.get('hostToken')).toBe('tok');
  });

  it('returns null when there is no token on the request URL', () => {
    expect(extractHostTokenFromRequestUrl('/')).toBeNull();
    expect(extractHostTokenFromRequestUrl('/?other=1')).toBeNull();
  });

  it('returns null for undefined/empty input', () => {
    expect(extractHostTokenFromRequestUrl(undefined)).toBeNull();
    expect(extractHostTokenFromRequestUrl('')).toBeNull();
  });

  it('tolerates a malformed request URL without throwing', () => {
    expect(extractHostTokenFromRequestUrl('::not a url::')).toBeNull();
  });
});

describe('hostTokensMatch', () => {
  it('matches identical tokens', () => {
    expect(hostTokensMatch('abcdef', 'abcdef')).toBe(true);
  });

  it('rejects different tokens of the same length', () => {
    expect(hostTokensMatch('abcdef', 'abcdeg')).toBe(false);
  });

  it('rejects tokens of different lengths', () => {
    expect(hostTokensMatch('abc', 'abcdef')).toBe(false);
  });
});
