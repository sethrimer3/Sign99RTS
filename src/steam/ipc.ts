/**
 * Sign99RTS — Renderer-side typing for the Steam bridge (`window.sign99Steam`).
 *
 * The implementation lives in electron/preload.cjs + electron/steam/*. This file
 * only describes the surface and the wire shapes. Nothing here imports
 * `steamworks.js` — the renderer never sees Steam types, only strings/arrays.
 */

// ---------------------------------------------------------------------------
// Channel-name mirror (single source of truth is electron/steam/steamChannels.cjs).
// The vitest parity test in src/steam/__tests__/channels.test.ts asserts equality.
// ---------------------------------------------------------------------------

export const STEAM_REQ = {
  init: 'sign99:steam:init',
  identity: 'sign99:steam:identity',
  lobbyHost: 'sign99:steam:lobby:host',
  lobbyList: 'sign99:steam:lobby:list',
  lobbyJoin: 'sign99:steam:lobby:join',
  lobbyLeave: 'sign99:steam:lobby:leave',
  lobbySetData: 'sign99:steam:lobby:setData',
  lobbyInvite: 'sign99:steam:lobby:invite',
  setConnect: 'sign99:steam:setConnect',
  takePendingJoin: 'sign99:steam:takePendingJoin',
  netSend: 'sign99:steam:net:send',
  netAccept: 'sign99:steam:net:accept',
} as const;

export const STEAM_EVT = {
  status: 'sign99:steam:evt:status',
  lobby: 'sign99:steam:evt:lobby',
  joinRequested: 'sign99:steam:evt:joinRequested',
  netPacket: 'sign99:steam:evt:netPacket',
  netSessionRequest: 'sign99:steam:evt:netSessionRequest',
  netSessionFailed: 'sign99:steam:evt:netSessionFailed',
} as const;

/** P2P channel numbers (mirror of steamChannels.cjs NET_CHANNEL). */
export const STEAM_NET_CHANNEL = { reliable: 0, unreliable: 1 } as const;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface SteamInitStatus {
  ok: boolean;
  running: boolean;
  initialized: boolean;
  appId: number;
  error: string;
}

export interface SteamIdentityWire {
  steamId: string;
  name: string;
  appId: number;
}

export interface SteamLobbyMemberWire {
  steamId: string;
  name: string;
  isOwner: boolean;
}

export interface SteamLobbyInfoWire {
  lobbyId: string;
  owner: string;
  members: SteamLobbyMemberWire[];
  maxMembers: number;
  metadata: Record<string, string>;
  visibility: 'public' | 'friends' | 'private';
}

export interface SteamLobbySummaryWire {
  lobbyId: string;
  hostName: string;
  memberCount: number;
  maxMembers: number;
  visibility: 'public' | 'friends' | 'private';
  metadata: Record<string, string>;
}

export type SteamStatusEvent =
  | { state: 'ready' }
  | { state: 'lost'; error: string }
  | { state: 'failed'; error: string };

export interface SteamLobbyEventWire extends SteamLobbyInfoWire {
  kind:
    | 'member_joined'
    | 'member_left'
    | 'owner_changed'
    | 'metadata_changed'
    | 'lobby_closed';
  /** Present for member_joined / member_left. */
  steamId?: string;
  /** Present for lobby_closed. */
  reason?: string;
}

export interface SteamNetPacketWire {
  fromSteamId: string;
  channel: number;
  bytes: number[];
}

export interface HostLobbyOptsWire {
  visibility: 'public' | 'friends' | 'private';
  maxMembers: number;
  metadata?: Record<string, string>;
}

type Unsub = () => void;

/** The object exposed by electron/preload.cjs as `window.sign99Steam`. */
export interface Sign99SteamBridge {
  available: true;

  init(): Promise<SteamInitStatus>;
  getIdentity(): Promise<SteamIdentityWire>;

  hostLobby(opts: HostLobbyOptsWire): Promise<SteamLobbyInfoWire>;
  listLobbies(): Promise<SteamLobbySummaryWire[]>;
  joinLobby(lobbyId: string): Promise<SteamLobbyInfoWire>;
  leaveLobby(): Promise<void>;
  setLobbyData(patch: Record<string, string>): Promise<void>;
  openInviteDialog(): Promise<void>;
  setConnectString(connect: string): Promise<void>;
  takePendingJoin(): Promise<{ lobbyId: string | null }>;

  netSend(toSteamId: string, reliable: boolean, bytes: number[]): Promise<void>;
  netAccept(steamId: string): Promise<void>;

  onStatus(handler: (e: SteamStatusEvent) => void): Unsub;
  onLobbyEvent(handler: (e: SteamLobbyEventWire) => void): Unsub;
  onJoinRequested(handler: (e: { lobbyId: string }) => void): Unsub;
  onNetPacket(handler: (e: SteamNetPacketWire) => void): Unsub;
  onNetSessionRequest(handler: (e: { steamId: string }) => void): Unsub;
  onNetSessionFailed(handler: (e: { steamId: string; error: number }) => void): Unsub;
}

declare global {
  interface Window {
    sign99Steam?: Sign99SteamBridge;
    // See the Sign99LanBridge interface in src/menu.ts for the full shape;
    // left loose here so this file doesn't need to import menu.ts.
    sign99Lan?: unknown;
  }
}

/** Returns the Steam bridge if this build is Electron + preload loaded. */
export function getSteamBridge(): Sign99SteamBridge | null {
  const b = typeof window !== 'undefined' ? window.sign99Steam : undefined;
  return b && b.available ? b : null;
}

/** True when running inside the Electron desktop shell with the Steam bridge. */
export function isSteamBuild(): boolean {
  return getSteamBridge() !== null;
}
