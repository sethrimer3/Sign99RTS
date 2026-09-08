/**
 * Deterministic local-host identity for the LAN relay.
 *
 * "First WebSocket connection becomes host" is a race: a remote machine on
 * the LAN could connect before the local renderer finishes its own
 * connection handshake and would then be (incorrectly) promoted to host.
 *
 * Instead, the process that starts hosting (the Electron main process, or
 * a test) generates a single-use, cryptographically random token and hands
 * it *only* to the local renderer via the existing IPC response. The local
 * renderer's WebSocket connection carries that token as a `hostToken` query
 * parameter; the relay only ever promotes a connection presenting the
 * matching token to host, regardless of connection order. The token is
 * never included in discovery advertisements or logged.
 *
 * Kept dependency-free (uses the standard `crypto.getRandomValues`, which
 * exists in both the browser/renderer and modern Node/Electron main) so it
 * can be unit tested without `ws` or `dgram`.
 */

const HOST_TOKEN_PARAM = 'hostToken';

/** Generate a cryptographically strong random token, hex-encoded. */
export function generateHostToken(byteLength: number = 24): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Append `?hostToken=...` to a ws:// / wss:// URL, preserving any existing query params. */
export function appendHostTokenToUrl(wsUrl: string, token: string): string {
  const u = new URL(wsUrl);
  u.searchParams.set(HOST_TOKEN_PARAM, token);
  return u.toString();
}

/**
 * Extract the `hostToken` query parameter from a raw WebSocket upgrade
 * request URL (e.g. `/?hostToken=abc123`, as seen server-side via
 * `IncomingMessage.url`). Returns null if absent or unparsable.
 */
export function extractHostTokenFromRequestUrl(rawUrl: string | undefined | null): string | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl, 'http://internal.invalid');
    return u.searchParams.get(HOST_TOKEN_PARAM);
  } catch {
    return null;
  }
}

/** Constant-time-ish comparison to avoid trivial timing leaks on token length/content. */
export function hostTokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
