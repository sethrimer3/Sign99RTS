/**
 * Node-side UDP plumbing for LAN discovery. All protocol decisions (what
 * counts as a valid advertisement, which interfaces to broadcast on, when
 * an entry goes stale) live in `src/lan/discovery.ts` as pure, unit-tested
 * functions — this file just wires them to real sockets.
 *
 * Used by both `server/lanServer.ts` (standalone dev/browser helper) and,
 * via a compiled JS import, the Electron main process.
 */

import dgram from 'node:dgram';
import os from 'node:os';
import {
  buildAdvertisement,
  parseAdvertisement,
  pruneStaleLobbies,
  advertisementKey,
  getUsableIPv4Interfaces,
  LAN_DISCOVERY_PORT,
  DISCOVERY_BROADCAST_INTERVAL_MS,
} from '../src/lan/discovery.js';
import type { LanDiscoveredLobby } from '../src/lan/protocol.js';

export interface LanDiscoveryOptions {
  udpPort?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  onDiscoveredChanged?: (lobbies: LanDiscoveredLobby[]) => void;
}

export interface HostAdvertiseInfo {
  lobbyId: string;
  hostName: string;
  lanPort: number;
  maxSlots: number;
  openSlots: number;
  occupiedHumanSlots: number;
  aiSlots: number;
  matchStarted: boolean;
  build: string;
}

export interface LanDiscoveryHandle {
  /** Start listening for other hosts' advertisements (safe to call repeatedly; a no-op if already listening). */
  startListening(): Promise<void>;
  stopListening(): void;
  /** Begin (or update) broadcasting this machine as a joinable host. */
  advertise(info: HostAdvertiseInfo): void;
  /** Stop broadcasting — e.g. because the local host lobby closed. */
  stopAdvertising(): void;
  getDiscovered(): LanDiscoveredLobby[];
  /** Fully tear down sockets and timers. */
  dispose(): void;
}

export function createLanDiscovery(options: LanDiscoveryOptions = {}): LanDiscoveryHandle {
  const log = options.logger ?? console;
  const udpPort = options.udpPort ?? LAN_DISCOVERY_PORT;
  const discovered = new Map<string, LanDiscoveredLobby>();

  let socket: dgram.Socket | null = null;
  let listening = false;
  let advertiseTimer: ReturnType<typeof setInterval> | null = null;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  let currentAdvertiseInfo: HostAdvertiseInfo | null = null;

  function notifyChanged(): void {
    options.onDiscoveredChanged?.(Array.from(discovered.values()));
  }

  function prune(): void {
    const removed = pruneStaleLobbies(discovered, Date.now());
    if (removed.length > 0) notifyChanged();
  }

  function ensureSocket(): dgram.Socket {
    if (socket) return socket;
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (buf, rinfo) => {
      const adv = parseAdvertisement(buf.toString('utf8'), rinfo.address);
      if (!adv) return;
      discovered.set(advertisementKey(adv), adv);
      notifyChanged();
    });
    socket.on('error', (err) => {
      log.error('[LAN Discovery] UDP socket error:', err.message);
    });
    return socket;
  }

  function startListening(): Promise<void> {
    if (listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = ensureSocket();
      const onError = (err: NodeJS.ErrnoException) => {
        s.removeListener('listening', onListening);
        reject(new Error(`LAN discovery failed to bind UDP port ${udpPort}: ${err.message}`));
      };
      const onListening = () => {
        s.removeListener('error', onError);
        s.setBroadcast(true);
        listening = true;
        log.log(`[LAN] Discovery listening on UDP ${udpPort}`);
        if (!pruneTimer) pruneTimer = setInterval(prune, DISCOVERY_BROADCAST_INTERVAL_MS);
        resolve();
      };
      s.once('error', onError);
      s.once('listening', onListening);
      try {
        s.bind(udpPort, '0.0.0.0');
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function stopListening(): void {
    listening = false;
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
    if (socket) { socket.close(); socket = null; }
    discovered.clear();
  }

  function broadcastNow(): void {
    if (!socket || !currentAdvertiseInfo) return;
    const ifaces = getUsableIPv4Interfaces(os.networkInterfaces() as Record<string, ReturnType<typeof os.networkInterfaces>[string]>);
    if (ifaces.length === 0) {
      log.warn('[LAN] No usable LAN interface found to advertise on (only loopback/link-local detected).');
      return;
    }
    for (const iface of ifaces) {
      const payload = Buffer.from(JSON.stringify(buildAdvertisement({
        lobbyId: currentAdvertiseInfo.lobbyId,
        hostName: currentAdvertiseInfo.hostName,
        wsIp: iface.address,
        lanPort: currentAdvertiseInfo.lanPort,
        maxSlots: currentAdvertiseInfo.maxSlots,
        openSlots: currentAdvertiseInfo.openSlots,
        occupiedHumanSlots: currentAdvertiseInfo.occupiedHumanSlots,
        aiSlots: currentAdvertiseInfo.aiSlots,
        matchStarted: currentAdvertiseInfo.matchStarted,
        build: currentAdvertiseInfo.build,
      })));
      log.log(`[LAN] Advertising lobby on ${iface.address}`);
      socket!.send(payload, udpPort, iface.broadcast, (err) => {
        if (err) log.warn(`[LAN] Failed to broadcast on ${iface.broadcast}: ${err.message}`);
      });
      // Always also hit the global broadcast address as a fallback for
      // adapters whose netmask couldn't be read.
      if (iface.broadcast !== '255.255.255.255') {
        socket!.send(payload, udpPort, '255.255.255.255', () => {});
      }
    }
  }

  function advertise(info: HostAdvertiseInfo): void {
    currentAdvertiseInfo = info;
    ensureSocket();
    if (!listening) {
      // Advertising requires the socket to be bound; start listening (a
      // host also wants to see other hosts, e.g. to avoid port clashes).
      void startListening().then(broadcastNow).catch((err) => log.error('[LAN] advertise() could not bind socket:', err.message));
    } else {
      broadcastNow();
    }
    if (!advertiseTimer) {
      advertiseTimer = setInterval(broadcastNow, DISCOVERY_BROADCAST_INTERVAL_MS);
    }
  }

  function stopAdvertising(): void {
    currentAdvertiseInfo = null;
    if (advertiseTimer) { clearInterval(advertiseTimer); advertiseTimer = null; }
  }

  function dispose(): void {
    stopAdvertising();
    stopListening();
  }

  return {
    startListening,
    stopListening,
    advertise,
    stopAdvertising,
    getDiscovered: () => Array.from(discovered.values()),
    dispose,
  };
}
