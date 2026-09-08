/**
 * Pure LAN-discovery protocol logic: building advertisements, parsing and
 * validating received ones, pruning stale entries, and picking which local
 * IPv4 interfaces are worth advertising on.
 *
 * Deliberately dependency-free (no `dgram`, no `os`) so every rule here is
 * unit-testable without opening real sockets. The Node-specific socket
 * plumbing lives in `server/lanDiscoveryCore.ts`, which calls into this file.
 */

import { LAN_PROTOCOL_VERSION, type LanDiscoveryAdvertisement, type LanDiscoveredLobby } from './protocol.js';

/** UDP port used for LAN discovery broadcasts. */
export const LAN_DISCOVERY_PORT = 47888;
/** How often a host re-broadcasts its advertisement. */
export const DISCOVERY_BROADCAST_INTERVAL_MS = 2000;
/** An advertisement not refreshed within this window is considered stale. */
export const DISCOVERY_STALE_MS = 6000;

const GAME_ID = 'Sign99RTS';

function sanitizeText(input: string, maxLen: number): string {
  return input.replace(/[^\x20-\x7E]/g, '').trim().slice(0, maxLen);
}

export interface BuildAdvertisementParams {
  lobbyId: string;
  hostName: string;
  wsIp: string;
  lanPort: number;
  maxSlots: number;
  openSlots: number;
  occupiedHumanSlots: number;
  aiSlots: number;
  matchStarted: boolean;
  build: string;
}

export function buildAdvertisement(p: BuildAdvertisementParams): LanDiscoveryAdvertisement {
  return {
    type: 'sign99_lan_advertise',
    protocolVersion: LAN_PROTOCOL_VERSION,
    game: GAME_ID,
    lobbyId: p.lobbyId,
    hostName: sanitizeText(p.hostName, 40) || 'Sign99 Host',
    wsUrl: `ws://${p.wsIp}:${p.lanPort}`,
    httpUrl: '',
    lanPort: p.lanPort,
    maxSlots: p.maxSlots,
    openSlots: Math.max(0, p.openSlots),
    occupiedHumanSlots: Math.max(0, p.occupiedHumanSlots),
    aiSlots: Math.max(0, p.aiSlots),
    matchStarted: p.matchStarted,
    build: sanitizeText(p.build, 32),
    timestamp: Date.now(),
  };
}

/**
 * Parse and validate a raw UDP advertisement payload.
 *
 * `sourceAddress` is the UDP packet's actual source IP as reported by the
 * socket layer (`rinfo.address`) — always more authoritative than whatever
 * IP the advertisement claims, since a spoofed or stale payload could name
 * an address the sender no longer owns. When the advertised `wsUrl` host
 * doesn't match the observed source address, we log nothing here (that's
 * the caller's job) and simply rewrite the URL to point at the verified
 * source address instead of trusting the payload blindly.
 */
export function parseAdvertisement(raw: string, sourceAddress: string, now: number = Date.now()): LanDiscoveredLobby | null {
  let parsed: Partial<LanDiscoveryAdvertisement>;
  try {
    parsed = JSON.parse(raw) as Partial<LanDiscoveryAdvertisement>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.type !== 'sign99_lan_advertise') return null;
  if (parsed.game !== GAME_ID) return null;
  if (parsed.protocolVersion !== LAN_PROTOCOL_VERSION) return null;
  if (typeof parsed.wsUrl !== 'string' || typeof parsed.lobbyId !== 'string' || !parsed.lobbyId) return null;

  const normalizedWsUrl = normalizeAdvertisedWsUrl(parsed.wsUrl, sourceAddress, Number(parsed.lanPort) || DEFAULT_FALLBACK_PORT);
  if (!normalizedWsUrl) return null;

  return {
    type: 'sign99_lan_advertise',
    protocolVersion: LAN_PROTOCOL_VERSION,
    game: GAME_ID,
    lobbyId: parsed.lobbyId,
    hostName: sanitizeText(parsed.hostName ?? 'Sign99 Host', 40),
    wsUrl: normalizedWsUrl,
    httpUrl: '',
    lanPort: Number(parsed.lanPort) || DEFAULT_FALLBACK_PORT,
    maxSlots: Number(parsed.maxSlots) || 8,
    openSlots: Math.max(0, Number(parsed.openSlots) || 0),
    occupiedHumanSlots: Math.max(0, Number(parsed.occupiedHumanSlots) || 0),
    aiSlots: Math.max(0, Number(parsed.aiSlots) || 0),
    matchStarted: Boolean(parsed.matchStarted),
    build: sanitizeText(parsed.build ?? '', 32),
    timestamp: Number(parsed.timestamp) || now,
    sourceIp: sourceAddress,
    lastSeenAt: now,
    expiresAt: now + DISCOVERY_STALE_MS,
  };
}

const DEFAULT_FALLBACK_PORT = 8787;

/**
 * Rewrite an advertised `ws://host:port` to use the UDP packet's verified
 * source address instead of the (potentially wrong or spoofed) host the
 * payload claims — the packet's source is authoritative on a LAN, and a
 * malformed/mismatched claimed host is exactly the kind of "obviously
 * wrong address" we should not blindly connect to.
 */
function normalizeAdvertisedWsUrl(claimedUrl: string, sourceAddress: string, fallbackPort: number): string | null {
  if (!sourceAddress) return null;
  let claimedPort = fallbackPort;
  try {
    const parsed = new URL(claimedUrl);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    if (parsed.port) claimedPort = Number(parsed.port);
  } catch {
    // Malformed URL in the payload — still trust the verified source address + fallback port.
  }
  if (!Number.isInteger(claimedPort) || claimedPort < 1 || claimedPort > 65535) return null;
  return `ws://${sourceAddress}:${claimedPort}`;
}

/** Stable de-duplication key for a discovered lobby: same lobby id + same reachable address. */
export function advertisementKey(adv: Pick<LanDiscoveredLobby, 'lobbyId' | 'wsUrl'>): string {
  return `${adv.lobbyId}@${adv.wsUrl}`;
}

/** Remove entries whose `expiresAt` has passed. Returns the removed keys. */
export function pruneStaleLobbies(map: Map<string, LanDiscoveredLobby>, now: number = Date.now()): string[] {
  const removed: string[] = [];
  for (const [key, value] of map) {
    if (value.expiresAt <= now) {
      map.delete(key);
      removed.push(key);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Interface selection
// ---------------------------------------------------------------------------

/** Minimal shape of Node's `os.NetworkInterfaceInfo`, kept local so this file has no `os` dependency. */
export interface NetIfaceInfo {
  address: string;
  family: string | number;
  internal: boolean;
  netmask?: string;
}

export interface UsableInterface {
  name: string;
  address: string;
  broadcast: string;
}

/** RFC1918 private ranges, plus the CGNAT range (100.64.0.0/10) used by several VPNs (e.g. Tailscale). */
function isLikelyLanIPv4(ip: string): boolean {
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  const m172 = ip.match(/^172\.(\d+)\./);
  if (m172) {
    const n = Number(m172[1]);
    if (n >= 16 && n <= 31) return true;
  }
  const mCgnat = ip.match(/^100\.(\d+)\./);
  if (mCgnat) {
    const n = Number(mCgnat[1]);
    if (n >= 64 && n <= 127) return true;
  }
  return false;
}

/** APIPA / link-local addresses mean the adapter failed to get a real address — never worth advertising. */
function isLinkLocalIPv4(ip: string): boolean {
  return ip.startsWith('169.254.');
}

function computeBroadcast(address: string, netmask: string | undefined): string {
  if (!netmask) return '255.255.255.255';
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  if (a.length !== 4 || m.length !== 4 || a.some(Number.isNaN) || m.some(Number.isNaN)) {
    return '255.255.255.255';
  }
  const b = a.map((octet, i) => (octet | (~m[i] & 0xff)) & 0xff);
  return b.join('.');
}

/**
 * From a `os.networkInterfaces()`-shaped map, pick IPv4, non-internal,
 * non-link-local, private-range addresses worth broadcasting discovery on.
 * Handles machines with Wi-Fi + Ethernet + VPN + virtual adapters by simply
 * returning all of them — the caller broadcasts on each — while skipping
 * loopback and obviously unusable (APIPA / non-private) adapters.
 */
export function getUsableIPv4Interfaces(ifaces: Record<string, NetIfaceInfo[] | undefined>): UsableInterface[] {
  const out: UsableInterface[] = [];
  const seen = new Set<string>();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs ?? []) {
      const family = addr.family === 4 || addr.family === 'IPv4';
      if (!family || addr.internal) continue;
      if (isLinkLocalIPv4(addr.address)) continue;
      if (!isLikelyLanIPv4(addr.address)) continue;
      if (seen.has(addr.address)) continue;
      seen.add(addr.address);
      out.push({ name, address: addr.address, broadcast: computeBroadcast(addr.address, addr.netmask) });
    }
  }
  return out;
}
