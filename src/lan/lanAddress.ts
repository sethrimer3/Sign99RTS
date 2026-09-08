/**
 * Pure helpers for normalizing user-entered LAN join targets into a
 * WebSocket URL, and for building the local LAN server's own URL.
 *
 * Kept dependency-free (no `ws`, no DOM) so it can be unit tested and
 * reused from both the renderer (menu.ts) and Node-side tooling.
 */

import { DEFAULT_LAN_PORT } from './protocol.js';

export interface NormalizedLanTarget {
  ok: true;
  url: string;
}

export interface InvalidLanTarget {
  ok: false;
  error: string;
}

export type LanTargetResult = NormalizedLanTarget | InvalidLanTarget;

/**
 * Normalize a user-entered LAN join target into a `ws://` or `wss://` URL.
 *
 * Accepts, in order of preference:
 *   - A full WebSocket URL: "ws://192.168.1.25:8787"
 *   - An HTTP(S) URL, converted to the matching WS scheme: "http://host:1234"
 *   - A bare host or host:port: "192.168.1.25", "192.168.1.25:8787", "myhost"
 *   - An IPv6 literal, with or without brackets: "fe80::1", "[fe80::1]:8787"
 *
 * A bare host (no explicit port) is given `defaultPort` (the well-known LAN
 * relay port). Whitespace is trimmed. Empty input is rejected.
 */
export function normalizeLanTarget(input: string, defaultPort: number = DEFAULT_LAN_PORT): LanTargetResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: 'Enter a host IP address or ws:// URL.' };
  }

  // Already a WebSocket URL — validate and pass through.
  if (/^wss?:\/\//i.test(trimmed)) {
    return validateUrl(trimmed);
  }

  // HTTP(S) URL — translate the scheme to the WebSocket equivalent.
  if (/^https?:\/\//i.test(trimmed)) {
    const translated = trimmed.replace(/^http/i, 'ws');
    return validateUrl(translated);
  }

  // Reject other schemes explicitly rather than silently mangling them.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { ok: false, error: 'Unsupported URL scheme — use ws://, wss://, or just the host IP.' };
  }

  // Bare host, optionally bracketed IPv6, optionally with a :port suffix.
  const bracketed = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    const host = bracketed[1];
    const port = bracketed[2] ? Number(bracketed[2]) : defaultPort;
    if (!host) return { ok: false, error: 'Enter a valid host or IP address.' };
    if (!isValidPort(port)) return { ok: false, error: 'Port must be between 1 and 65535.' };
    return { ok: true, url: `ws://[${host}]:${port}` };
  }

  // Plain IPv6 literal with no brackets and no port (contains 2+ colons and
  // no dots — a dotted string with multiple colons is a malformed
  // host:port, not IPv6, and falls through to be rejected below).
  if (!trimmed.includes('.') && (trimmed.match(/:/g) ?? []).length >= 2) {
    return { ok: true, url: `ws://[${trimmed}]:${defaultPort}` };
  }

  // host[:port] for IPv4 addresses and hostnames.
  const parts = trimmed.split(':');
  if (parts.length > 2) {
    return { ok: false, error: 'Enter a valid host or IP address.' };
  }
  const host = parts[0];
  if (!host || /\s/.test(host)) {
    return { ok: false, error: 'Enter a valid host or IP address.' };
  }
  let port = defaultPort;
  if (parts.length === 2) {
    if (!/^\d+$/.test(parts[1])) {
      return { ok: false, error: 'Port must be a number.' };
    }
    port = Number(parts[1]);
    if (!isValidPort(port)) {
      return { ok: false, error: 'Port must be between 1 and 65535.' };
    }
  }
  return { ok: true, url: `ws://${host}:${port}` };
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function validateUrl(candidate: string): LanTargetResult {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return { ok: false, error: 'URL must use ws:// or wss://.' };
    }
    if (!parsed.hostname) {
      return { ok: false, error: 'Enter a valid host or IP address.' };
    }
    return { ok: true, url: parsed.toString().replace(/\/$/, '') };
  } catch {
    return { ok: false, error: 'That does not look like a valid URL.' };
  }
}
