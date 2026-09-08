import { describe, it, expect } from 'vitest';
import { normalizeLanTarget } from './lanAddress.js';

describe('normalizeLanTarget', () => {
  it('rejects empty input', () => {
    const r = normalizeLanTarget('   ');
    expect(r.ok).toBe(false);
  });

  it('passes through a well-formed ws:// URL unchanged', () => {
    const r = normalizeLanTarget('ws://192.168.1.25:8787');
    expect(r).toEqual({ ok: true, url: 'ws://192.168.1.25:8787' });
  });

  it('accepts wss:// URLs', () => {
    const r = normalizeLanTarget('wss://example.com:9999');
    expect(r).toEqual({ ok: true, url: 'wss://example.com:9999' });
  });

  it('converts an http:// URL to ws://', () => {
    const r = normalizeLanTarget('http://192.168.1.25:8787');
    expect(r).toEqual({ ok: true, url: 'ws://192.168.1.25:8787' });
  });

  it('converts https:// to wss://', () => {
    const r = normalizeLanTarget('https://myhost:8787');
    expect(r).toEqual({ ok: true, url: 'wss://myhost:8787' });
  });

  it('rejects unsupported schemes', () => {
    const r = normalizeLanTarget('ftp://192.168.1.25');
    expect(r.ok).toBe(false);
  });

  it('defaults the port for a bare IPv4 address', () => {
    const r = normalizeLanTarget('192.168.1.25', 8787);
    expect(r).toEqual({ ok: true, url: 'ws://192.168.1.25:8787' });
  });

  it('honors an explicit port on a bare IPv4 address', () => {
    const r = normalizeLanTarget('192.168.1.25:9001', 8787);
    expect(r).toEqual({ ok: true, url: 'ws://192.168.1.25:9001' });
  });

  it('supports a bare hostname', () => {
    const r = normalizeLanTarget('my-host');
    expect(r).toEqual({ ok: true, url: 'ws://my-host:8787' });
  });

  it('rejects a non-numeric port', () => {
    const r = normalizeLanTarget('192.168.1.25:abc');
    expect(r.ok).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    const r = normalizeLanTarget('192.168.1.25:70000');
    expect(r.ok).toBe(false);
  });

  it('supports bracketed IPv6 literals with a port', () => {
    const r = normalizeLanTarget('[fe80::1]:8787');
    expect(r).toEqual({ ok: true, url: 'ws://[fe80::1]:8787' });
  });

  it('supports a bare IPv6 literal without brackets, defaulting the port', () => {
    const r = normalizeLanTarget('fe80::1');
    expect(r).toEqual({ ok: true, url: 'ws://[fe80::1]:8787' });
  });

  it('trims surrounding whitespace', () => {
    const r = normalizeLanTarget('  192.168.1.25  ');
    expect(r).toEqual({ ok: true, url: 'ws://192.168.1.25:8787' });
  });

  it('rejects a malformed host:port:extra string', () => {
    const r = normalizeLanTarget('192.168.1.25:8787:extra');
    expect(r.ok).toBe(false);
  });
});
