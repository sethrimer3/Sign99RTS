import { describe, it, expect } from 'vitest';
import {
  buildAdvertisement,
  parseAdvertisement,
  pruneStaleLobbies,
  advertisementKey,
  getUsableIPv4Interfaces,
  type NetIfaceInfo,
} from './discovery.js';
import { LAN_PROTOCOL_VERSION } from './protocol.js';
import type { LanDiscoveredLobby } from './protocol.js';

function makeAd(overrides: Partial<Record<string, unknown>> = {}): string {
  const base = {
    type: 'sign99_lan_advertise',
    protocolVersion: LAN_PROTOCOL_VERSION,
    game: 'Sign99RTS',
    lobbyId: 'lobby_abc123',
    hostName: 'Alice',
    wsUrl: 'ws://192.168.1.50:8787',
    httpUrl: '',
    lanPort: 8787,
    maxSlots: 8,
    openSlots: 7,
    occupiedHumanSlots: 1,
    aiSlots: 0,
    matchStarted: false,
    build: 'Build 055',
    timestamp: Date.now(),
    ...overrides,
  };
  return JSON.stringify(base);
}

describe('buildAdvertisement', () => {
  it('embeds the protocol version and game id', () => {
    const ad = buildAdvertisement({
      lobbyId: 'lobby_1', hostName: 'Host', wsIp: '10.0.0.5', lanPort: 8787,
      maxSlots: 8, openSlots: 7, occupiedHumanSlots: 1, aiSlots: 0, matchStarted: false, build: 'Build 055',
    });
    expect(ad.protocolVersion).toBe(LAN_PROTOCOL_VERSION);
    expect(ad.game).toBe('Sign99RTS');
    expect(ad.wsUrl).toBe('ws://10.0.0.5:8787');
  });

  it('sanitizes control characters out of the host name', () => {
    const ad = buildAdvertisement({
      lobbyId: 'lobby_1', hostName: 'Ho\x00st\n', wsIp: '10.0.0.5', lanPort: 8787,
      maxSlots: 8, openSlots: 7, occupiedHumanSlots: 1, aiSlots: 0, matchStarted: false, build: '',
    });
    expect(ad.hostName).toBe('Host');
  });
});

describe('parseAdvertisement', () => {
  it('parses a well-formed advertisement', () => {
    const result = parseAdvertisement(makeAd(), '192.168.1.50', 1000);
    expect(result).not.toBeNull();
    expect(result?.lobbyId).toBe('lobby_abc123');
    expect(result?.sourceIp).toBe('192.168.1.50');
    expect(result?.expiresAt).toBeGreaterThan(1000);
  });

  it('rejects malformed JSON', () => {
    expect(parseAdvertisement('{not json', '192.168.1.50')).toBeNull();
  });

  it('rejects a different game id', () => {
    expect(parseAdvertisement(makeAd({ game: 'SomeOtherGame' }), '192.168.1.50')).toBeNull();
  });

  it('rejects a mismatched protocol version', () => {
    expect(parseAdvertisement(makeAd({ protocolVersion: LAN_PROTOCOL_VERSION + 1 }), '192.168.1.50')).toBeNull();
  });

  it('rejects a missing lobbyId', () => {
    expect(parseAdvertisement(makeAd({ lobbyId: '' }), '192.168.1.50')).toBeNull();
  });

  it('rejects an advertisement missing wsUrl', () => {
    expect(parseAdvertisement(makeAd({ wsUrl: undefined }), '192.168.1.50')).toBeNull();
  });

  it('ignores an advertised host and trusts the verified UDP source address instead', () => {
    // The payload claims to be reachable at a completely different IP than
    // the packet actually arrived from — we must not blindly trust that.
    const result = parseAdvertisement(makeAd({ wsUrl: 'ws://10.10.10.10:8787' }), '192.168.1.50');
    expect(result?.wsUrl).toBe('ws://192.168.1.50:8787');
  });

  it('rejects a non-websocket scheme in the claimed URL', () => {
    expect(parseAdvertisement(makeAd({ wsUrl: 'http://192.168.1.50:8787' }), '192.168.1.50')).toBeNull();
  });

  it('tolerates a malformed claimed wsUrl by falling back to lanPort + source address', () => {
    const result = parseAdvertisement(makeAd({ wsUrl: 'not a url', lanPort: 9999 }), '192.168.1.50');
    expect(result?.wsUrl).toBe('ws://192.168.1.50:9999');
  });

  it('clamps negative slot counts to zero', () => {
    const result = parseAdvertisement(makeAd({ openSlots: -5 }), '192.168.1.50');
    expect(result?.openSlots).toBe(0);
  });
});

describe('advertisementKey / pruneStaleLobbies', () => {
  it('de-duplicates by lobbyId + wsUrl', () => {
    const a = parseAdvertisement(makeAd(), '192.168.1.50', 0)!;
    const b = parseAdvertisement(makeAd(), '192.168.1.50', 0)!;
    expect(advertisementKey(a)).toBe(advertisementKey(b));
  });

  it('prunes only expired entries', () => {
    const map = new Map<string, LanDiscoveredLobby>();
    const fresh = parseAdvertisement(makeAd({ lobbyId: 'fresh' }), '192.168.1.50', 1000)!;
    const stale = parseAdvertisement(makeAd({ lobbyId: 'stale' }), '192.168.1.51', 1000)!;
    stale.expiresAt = 500; // already expired relative to "now" below
    map.set(advertisementKey(fresh), fresh);
    map.set(advertisementKey(stale), stale);

    const removed = pruneStaleLobbies(map, 2000);

    expect(removed).toEqual([advertisementKey(stale)]);
    expect(map.has(advertisementKey(fresh))).toBe(true);
    expect(map.has(advertisementKey(stale))).toBe(false);
  });

  it('duplicate advertisements from the same host simply overwrite the same key', () => {
    const map = new Map<string, LanDiscoveredLobby>();
    const first = parseAdvertisement(makeAd({ timestamp: 1 }), '192.168.1.50', 1000)!;
    const second = parseAdvertisement(makeAd({ timestamp: 2, openSlots: 3 }), '192.168.1.50', 1500)!;
    map.set(advertisementKey(first), first);
    map.set(advertisementKey(second), second);
    expect(map.size).toBe(1);
    expect(map.get(advertisementKey(second))?.openSlots).toBe(3);
  });
});

describe('getUsableIPv4Interfaces', () => {
  function iface(address: string, opts: Partial<NetIfaceInfo> = {}): NetIfaceInfo {
    return { address, family: 'IPv4', internal: false, netmask: '255.255.255.0', ...opts };
  }

  it('includes private Wi-Fi and Ethernet style addresses', () => {
    const result = getUsableIPv4Interfaces({
      'Wi-Fi': [iface('192.168.1.42')],
      'Ethernet': [iface('10.0.0.15')],
    });
    const addrs = result.map(r => r.address).sort();
    expect(addrs).toEqual(['10.0.0.15', '192.168.1.42']);
  });

  it('excludes loopback interfaces', () => {
    const result = getUsableIPv4Interfaces({
      'lo': [iface('127.0.0.1', { internal: true })],
    });
    expect(result).toHaveLength(0);
  });

  it('excludes IPv6 entries', () => {
    const result = getUsableIPv4Interfaces({
      'Wi-Fi': [iface('fe80::1', { family: 'IPv6' })],
    });
    expect(result).toHaveLength(0);
  });

  it('excludes link-local (APIPA) addresses', () => {
    const result = getUsableIPv4Interfaces({
      'Ethernet': [iface('169.254.1.5')],
    });
    expect(result).toHaveLength(0);
  });

  it('excludes obviously non-LAN public addresses', () => {
    const result = getUsableIPv4Interfaces({
      'ppp0': [iface('8.8.8.8')],
    });
    expect(result).toHaveLength(0);
  });

  it('includes CGNAT-range addresses used by VPNs like Tailscale', () => {
    const result = getUsableIPv4Interfaces({
      'tailscale0': [iface('100.100.50.1')],
    });
    expect(result).toHaveLength(1);
  });

  it('computes a subnet broadcast address from the netmask', () => {
    const result = getUsableIPv4Interfaces({
      'Wi-Fi': [iface('192.168.1.42', { netmask: '255.255.255.0' })],
    });
    expect(result[0].broadcast).toBe('192.168.1.255');
  });

  it('falls back to the global broadcast address when netmask is missing', () => {
    const result = getUsableIPv4Interfaces({
      'Wi-Fi': [iface('192.168.1.42', { netmask: undefined })],
    });
    expect(result[0].broadcast).toBe('255.255.255.255');
  });

  it('de-duplicates the same address reported on multiple interface entries', () => {
    const result = getUsableIPv4Interfaces({
      'Wi-Fi': [iface('192.168.1.42'), iface('192.168.1.42')],
    });
    expect(result).toHaveLength(1);
  });
});
