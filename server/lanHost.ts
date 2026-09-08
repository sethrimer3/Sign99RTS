/**
 * Sign99RTS LAN WebSocket relay — host-authoritative lobby + game-state relay.
 *
 * This is a *factory*, not a script with side effects at import time, so it
 * can be started/stopped on demand by either:
 *   - the Electron main process (production desktop LAN hosting), or
 *   - `server/lanServer.ts`, a thin standalone CLI entry used only for
 *     browser-based development (`npm run dev:lan`).
 *
 * The first client to connect becomes the host. Other clients join as
 * players in open slots. The host browser runs the authoritative simulation
 * and broadcasts periodic game-state snapshots through this relay.
 *
 * Connection flow:
 *   Host:      connect → server sends welcome(slot=0) → host ready
 *   Non-host:  connect → server sends server_connected(clientId, protocolVersion) →
 *              client sends join_request(protocolVersion) →
 *              server sends welcome(slotN) or join_rejected(reason)
 */

import { WebSocketServer, WebSocket } from 'ws';
import type {
  LobbyState,
  ClientMessage,
  MsgServerConnected,
  MsgWelcome,
  MsgLobbyUpdate,
  MsgJoinRejected,
  MsgKicked,
  MsgMatchStart,
  MsgRelayedSnapshot,
  MsgRelayedInput,
  MsgMatchEnd,
  MsgChat,
  MsgPong,
  AIDifficulty,
  SlotType,
  RaceSelection,
} from '../src/lan/protocol.js';
import { LAN_PROTOCOL_VERSION, DEFAULT_LAN_PORT } from '../src/lan/protocol.js';
import {
  initLobbySlots,
  assignSlot,
  releaseSlot,
  slotIndexForClient,
  snapshotLobby,
  evaluateJoinRequest,
  MAX_LAN_SLOTS,
} from '../src/lan/lanLobby.js';

/** Heartbeat: if a client has not sent any message for this many ms, close it. */
const CLIENT_TIMEOUT_MS = 60_000;
const HEARTBEAT_CHECK_INTERVAL_MS = 15_000;
/**
 * Maximum buffered bytes before we skip sending a snapshot to a lagging client.
 * 128 KB gives roughly 2–3 large snapshots worth of buffer before dropping.
 */
const BACKPRESSURE_LIMIT = 128 * 1024;

interface ConnectedClient {
  id: string;
  ws: WebSocket;
  slotIndex: number | null;
  playerName: string;
  isHost: boolean;
  lastMessageAt: number;
}

export interface LanHostOptions {
  /** TCP port to listen on. Defaults to DEFAULT_LAN_PORT (8787). */
  port?: number;
  /** Build label surfaced to clients (e.g. "Build 055"), used for diagnostics only. */
  build?: string;
  /** Called whenever the lobby state changes (join/leave/ready/config/etc). */
  onLobbyChanged?: (lobby: LobbyState) => void;
  /** Called once the match starts. */
  onMatchStarted?: () => void;
  /** Called when the server has fully stopped (port released). */
  onStopped?: () => void;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface LanHostHandle {
  readonly port: number;
  readonly lobbyId: string;
  getLobbySnapshot(): LobbyState;
  isHostConnected(): boolean;
  /** Cleanly close all sockets and stop listening. Safe to call more than once. */
  stop(): Promise<void>;
}

/**
 * Start a LAN host server. Resolves once the WebSocket server is actually
 * listening (or rejects with a descriptive error — e.g. EADDRINUSE — so the
 * caller can distinguish "port already in use" from other failure modes).
 */
export function startLanHostServer(options: LanHostOptions = {}): Promise<LanHostHandle> {
  const requestedPort = options.port ?? DEFAULT_LAN_PORT;
  const log = options.logger ?? console;
  const build = options.build ?? '';
  const lobbyId = `lobby_${Math.random().toString(36).slice(2, 10)}`;

  let lobbySlots = initLobbySlots(MAX_LAN_SLOTS);
  let hostClientId: string | null = null;
  let matchStarted = false;
  let matchSeed = 0;
  const clients = new Map<string, ConnectedClient>();
  let nextClientNum = 1;
  const newClientId = () => `client_${(nextClientNum++).toString(36)}`;

  function getLobbyState(): LobbyState {
    return snapshotLobby(lobbySlots, hostClientId, matchStarted);
  }

  function send<T extends object>(ws: WebSocket, msg: T): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function sendWithBackpressure<T extends object>(ws: WebSocket, msg: T): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > BACKPRESSURE_LIMIT) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function broadcast<T extends object>(msg: T, excludeId?: string): void {
    for (const [id, client] of clients) if (id !== excludeId) send(client.ws, msg);
  }

  function broadcastLobbyUpdate(): void {
    const lobby = getLobbyState();
    broadcast({ type: 'lobby_update', lobby } satisfies MsgLobbyUpdate);
    options.onLobbyChanged?.(lobby);
  }

  function handleClientDisconnect(clientId: string): void {
    const client = clients.get(clientId);
    if (!client) return;
    log.log(`[LAN] Disconnected: ${clientId} (${client.playerName}, slot ${client.slotIndex})`);
    releaseSlot(lobbySlots, clientId);
    clients.delete(clientId);

    if (client.isHost) {
      const end: MsgMatchEnd = { type: 'match_end', reason: 'Host closed the lobby.' };
      for (const [, remaining] of clients) {
        send(remaining.ws, end);
        setTimeout(() => remaining.ws.close(), 200);
      }
      matchStarted = false;
      hostClientId = null;
      lobbySlots = initLobbySlots(MAX_LAN_SLOTS);
      clients.clear();
      log.log('[LAN] Host disconnected — all clients kicked, lobby reset.');
      options.onLobbyChanged?.(getLobbyState());
    } else {
      broadcastLobbyUpdate();
    }
  }

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [clientId, client] of clients) {
      if (now - client.lastMessageAt > CLIENT_TIMEOUT_MS) {
        log.log(`[LAN] Client ${clientId} timed out (no message for ${CLIENT_TIMEOUT_MS / 1000}s)`);
        client.ws.terminate();
        handleClientDisconnect(clientId);
      }
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);

  return new Promise<LanHostHandle>((resolve, reject) => {
    const wss = new WebSocketServer({ port: requestedPort, host: '0.0.0.0' });

    let settled = false;
    let boundPort = requestedPort;
    wss.once('listening', () => {
      settled = true;
      const addr = wss.address();
      if (addr && typeof addr === 'object') boundPort = addr.port;
      log.log(`[LAN] WebSocket server listening on 0.0.0.0:${boundPort}`);
      resolve(makeHandle());
    });

    wss.once('error', (err: NodeJS.ErrnoException) => {
      clearInterval(heartbeatTimer);
      if (!settled) {
        settled = true;
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`LAN port ${requestedPort} is already in use. Close any other Sign99RTS host, or another app using that port.`));
        } else {
          reject(new Error(`Failed to start LAN host server: ${err.message}`));
        }
        return;
      }
      log.error('[LAN] WebSocket server error:', err);
    });

    function makeHandle(): LanHostHandle {
      wss.on('connection', (ws: WebSocket) => {
        const clientId = newClientId();
        const now = Date.now();
        const isHost = clients.size === 0;

        const client: ConnectedClient = {
          id: clientId,
          ws,
          slotIndex: null,
          playerName: isHost ? 'Host' : `Player ${clients.size + 1}`,
          isHost,
          lastMessageAt: now,
        };
        clients.set(clientId, client);

        if (matchStarted && !isHost) {
          const reject: MsgJoinRejected = { type: 'join_rejected', reason: 'Match already in progress.' };
          send(ws, reject);
          ws.close();
          clients.delete(clientId);
          log.log(`[LAN] Late-join rejected: ${clientId}`);
          return;
        }

        if (isHost) {
          hostClientId = clientId;
          assignSlot(lobbySlots, clientId, 0, client.playerName);
          client.slotIndex = 0;
          const welcome: MsgWelcome = {
            type: 'welcome', clientId, isHost: true, slotIndex: 0,
            lobby: getLobbyState(), protocolVersion: LAN_PROTOCOL_VERSION, build,
          };
          send(ws, welcome);
          log.log(`[LAN] Host connected: ${clientId}`);
        } else {
          const sc: MsgServerConnected = {
            type: 'server_connected', clientId, protocolVersion: LAN_PROTOCOL_VERSION, build,
          };
          send(ws, sc);
          log.log(`[LAN] Client connected (awaiting join_request): ${clientId}`);
        }

        ws.on('message', (raw: Buffer | string) => {
          let msg: ClientMessage;
          try {
            msg = JSON.parse(raw.toString()) as ClientMessage;
          } catch {
            return;
          }
          const myClient = clients.get(clientId);
          if (!myClient) return;
          myClient.lastMessageAt = Date.now();

          switch (msg.type) {
            case 'join_request': {
              if (myClient.isHost) break;
              const decision = evaluateJoinRequest({
                matchStarted,
                slots: lobbySlots,
                clientProtocolVersion: msg.protocolVersion,
                clientBuild: msg.build,
                hostBuild: build,
              });
              if (!decision.accept) {
                send(ws, { type: 'join_rejected', reason: decision.reason } satisfies MsgJoinRejected);
                log.log(`[LAN] join_request rejected for ${clientId}: ${decision.reason}`);
                break;
              }
              const playerName = (typeof msg.playerName === 'string'
                ? msg.playerName.trim().slice(0, 24)
                : '') || `Player ${clients.size}`;
              myClient.playerName = playerName;
              myClient.slotIndex = decision.slotIndex;
              assignSlot(lobbySlots, clientId, decision.slotIndex, playerName);
              const welcome: MsgWelcome = {
                type: 'welcome', clientId, isHost: false, slotIndex: decision.slotIndex,
                lobby: getLobbyState(), protocolVersion: LAN_PROTOCOL_VERSION, build,
              };
              send(ws, welcome);
              broadcastLobbyUpdate();
              log.log(`[LAN] ${playerName} joined slot ${decision.slotIndex}`);
              break;
            }

            case 'ready_toggle': {
              const si = slotIndexForClient(lobbySlots, clientId);
              if (si !== null && lobbySlots[si]) {
                lobbySlots[si].ready = !lobbySlots[si].ready;
                broadcastLobbyUpdate();
              }
              break;
            }

            case 'leave': {
              handleClientDisconnect(clientId);
              ws.close();
              break;
            }

            case 'slot_config': {
              if (matchStarted) break;
              const { slotIndex, slotType, aiDifficulty, race, teamId } = msg;
              if (typeof slotIndex !== 'number' || slotIndex < 0 || slotIndex >= MAX_LAN_SLOTS) break;
              const validTypes: SlotType[] = ['open', 'closed', 'ai', 'human'];
              if (!validTypes.includes(slotType)) break;
              const slot = lobbySlots[slotIndex];
              const nextTeamId = Number.isInteger(teamId)
                ? Math.max(0, Math.min(MAX_LAN_SLOTS - 1, Math.floor(teamId as number)))
                : slot.teamId ?? slotIndex;
              const validRaces: RaceSelection[] = ['terran', 'synonymous', 'random'];
              const nextRace = validRaces.includes(race as RaceSelection) ? (race as RaceSelection) : slot.race ?? 'terran';
              if (!myClient.isHost) {
                if (slot.clientId !== clientId || slot.type !== 'human') break;
                slot.race = nextRace;
                slot.teamId = nextTeamId;
                broadcastLobbyUpdate();
                break;
              }
              if (slotType === 'human' && slot.type === 'human' && slot.clientId) {
                slot.race = nextRace;
                slot.teamId = nextTeamId;
                broadcastLobbyUpdate();
                break;
              }
              if (slot.type === 'human' && slot.clientId) break;
              const validDiffs: AIDifficulty[] = ['easy', 'normal', 'hard', 'nightmare'];
              const diff = validDiffs.includes(aiDifficulty as AIDifficulty) ? (aiDifficulty as AIDifficulty) : 'normal';
              slot.type = slotType;
              slot.teamId = nextTeamId;
              slot.aiDifficulty = slotType === 'ai' ? diff : undefined;
              slot.race = nextRace;
              slot.ready = false;
              slot.clientId = undefined;
              slot.playerName = slotType === 'ai' ? `AI (${diff})` : undefined;
              broadcastLobbyUpdate();
              break;
            }

            case 'kick_player': {
              if (!myClient.isHost || matchStarted) break;
              const kickSlotIdx = typeof msg.slotIndex === 'number' ? msg.slotIndex : -1;
              if (kickSlotIdx < 1 || kickSlotIdx >= MAX_LAN_SLOTS) break;
              const kickSlot = lobbySlots[kickSlotIdx];
              if (!kickSlot || !kickSlot.clientId) break;
              const kickedId = kickSlot.clientId;
              const kickedClient = clients.get(kickedId);
              if (kickedClient) {
                send(kickedClient.ws, { type: 'kicked' } satisfies MsgKicked);
                kickedClient.ws.close();
              }
              kickSlot.type = 'open';
              kickSlot.clientId = undefined;
              kickSlot.playerName = undefined;
              kickSlot.ready = false;
              clients.delete(kickedId);
              log.log(`[LAN] Host kicked client ${kickedId} from slot ${kickSlotIdx}`);
              broadcastLobbyUpdate();
              break;
            }

            case 'start_match': {
              if (!myClient.isHost || matchStarted) break;
              const allReady = lobbySlots.every(slot => {
                if (slot.type !== 'human') return true;
                if (slot.slotIndex === 0) return true;
                return slot.ready;
              });
              if (!allReady) {
                send(ws, { type: 'chat', from: 'Server', text: 'Not all players are ready.' } satisfies MsgChat);
                break;
              }
              matchStarted = true;
              matchSeed = Math.floor(Math.random() * 0x7fffffff);
              for (const [, c] of clients) {
                const ms: MsgMatchStart = {
                  type: 'match_start', lobby: getLobbyState(), seed: matchSeed, hostSlot: 0, mySlot: c.slotIndex ?? -1,
                };
                send(c.ws, ms);
              }
              log.log(`[LAN] Match started (seed=${matchSeed})`);
              options.onMatchStarted?.();
              break;
            }

            case 'input_snapshot': {
              if (myClient.isHost || !hostClientId) break;
              const hostClient = clients.get(hostClientId);
              if (!hostClient) break;
              const dx = Math.max(-1, Math.min(1, Number(msg.dx) || 0));
              const dy = Math.max(-1, Math.min(1, Number(msg.dy) || 0));
              const relay: MsgRelayedInput = { type: 'relayed_input', fromSlot: myClient.slotIndex ?? -1, input: { ...msg, dx, dy } };
              send(hostClient.ws, relay);
              break;
            }

            case 'game_snapshot': {
              if (!myClient.isHost) break;
              const snapshot: MsgRelayedSnapshot = { ...msg, type: 'game_snapshot' };
              for (const [cid, c] of clients) {
                if (cid === clientId) continue;
                const sent = sendWithBackpressure(c.ws, snapshot);
                if (!sent && c.ws.bufferedAmount > BACKPRESSURE_LIMIT) {
                  log.warn(`[LAN] Dropping snapshot for lagging client ${cid} (buffered=${c.ws.bufferedAmount})`);
                }
              }
              break;
            }

            case 'ping': {
              send(ws, { type: 'pong', t: typeof msg.t === 'number' ? msg.t : 0 } satisfies MsgPong);
              break;
            }

            default:
              break;
          }
        });

        ws.on('close', () => handleClientDisconnect(clientId));
        ws.on('error', (err) => log.error(`[LAN] WS error for ${clientId}:`, err.message));
      });

      return {
        port: boundPort,
        lobbyId,
        getLobbySnapshot: getLobbyState,
        isHostConnected: () => hostClientId !== null,
        stop(): Promise<void> {
          return new Promise((resolveStop) => {
            clearInterval(heartbeatTimer);
            const end: MsgMatchEnd = { type: 'match_end', reason: 'Host closed the lobby.' };
            for (const [, c] of clients) {
              send(c.ws, end);
              c.ws.close();
            }
            clients.clear();
            wss.close(() => {
              log.log('[LAN] WebSocket server stopped.');
              options.onStopped?.();
              resolveStop();
            });
          });
        },
      };
    }
  });
}
