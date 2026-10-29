// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
  WebhookReceiver,
  type ParticipantInfo,
} from "livekit-server-sdk";
import type { VoiceSource } from "@tincan/shared";

/**
 * The only file that talks to LiveKit's server SDK (05 §1, ADR-002). Everything else uses these plain types,
 * so tests run against a fake and the SDK can change under one file.
 */

export interface LkPermission {
  canSubscribe: boolean;
  canPublish: boolean;
  /** Empty means "none" here; the SDK's empty list means "all", so `canPublish` carries the intent. */
  sources: VoiceSource[];
}

export interface LkTrack {
  sid: string;
  source: VoiceSource | null;
  muted: boolean;
}

export interface LkParticipant {
  identity: string;
  sid: string;
  joinedAtMs: number;
  permission: LkPermission;
  tracks: LkTrack[];
}

export interface LkRoom {
  name: string;
  sid: string;
  numParticipants: number;
}

export interface CreateRoomOptions {
  name: string;
  emptyTimeoutSecs: number;
  departureTimeoutSecs: number;
  maxParticipants: number;
}

export interface LiveKitRooms {
  /** Idempotent: an existing room keeps its SID and metadata (D1). */
  createRoom(opts: CreateRoomOptions): Promise<LkRoom>;
  listRooms(): Promise<LkRoom[]>;
  listParticipants(room: string): Promise<LkParticipant[]>;
  updatePermission(room: string, identity: string, permission: LkPermission): Promise<void>;
  removeParticipant(room: string, identity: string): Promise<void>;
  deleteRoom(room: string): Promise<void>;
}

/** A webhook after signature verification, reduced to the fields the presence logic uses. */
export interface LkWebhookEvent {
  /** LiveKit's unique event id, for duplicate suppression. */
  id: string;
  event: string;
  /** Epoch seconds at LiveKit; events of one participant are ordered by it. */
  createdAt: number;
  room: { name: string; sid: string } | null;
  participant: { identity: string; sid: string } | null;
  track: LkTrack | null;
}

export type WebhookVerifier = (body: string, authorization: string | undefined) => Promise<LkWebhookEvent>;

const SOURCE_TO_ENUM: Record<VoiceSource, TrackSource> = {
  microphone: TrackSource.MICROPHONE,
  camera: TrackSource.CAMERA,
  screen_share: TrackSource.SCREEN_SHARE,
  screen_share_audio: TrackSource.SCREEN_SHARE_AUDIO,
};

export function sourceName(source: TrackSource): VoiceSource | null {
  switch (source) {
    case TrackSource.MICROPHONE:
      return "microphone";
    case TrackSource.CAMERA:
      return "camera";
    case TrackSource.SCREEN_SHARE:
      return "screen_share";
    case TrackSource.SCREEN_SHARE_AUDIO:
      return "screen_share_audio";
    default:
      return null;
  }
}

function toParticipant(p: ParticipantInfo): LkParticipant {
  const perm = p.permission;
  const sources = (perm?.canPublishSources ?? []).map(sourceName).filter((s): s is VoiceSource => s !== null);
  return {
    identity: p.identity,
    sid: p.sid,
    joinedAtMs: Number(p.joinedAtMs ?? BigInt(Number(p.joinedAt) * 1000)),
    permission: {
      canSubscribe: perm?.canSubscribe ?? false,
      canPublish: perm?.canPublish ?? false,
      sources: perm?.canPublish ? sources : [],
    },
    tracks: p.tracks.map((t) => ({ sid: t.sid, source: sourceName(t.source), muted: t.muted })),
  };
}

export class SdkLiveKit implements LiveKitRooms {
  readonly #svc: RoomServiceClient;
  constructor(apiUrl: string, apiKey: string, apiSecret: string) {
    this.#svc = new RoomServiceClient(apiUrl, apiKey, apiSecret);
  }
  async createRoom(o: CreateRoomOptions): Promise<LkRoom> {
    const r = await this.#svc.createRoom({
      name: o.name,
      emptyTimeout: o.emptyTimeoutSecs,
      departureTimeout: o.departureTimeoutSecs,
      maxParticipants: o.maxParticipants,
    });
    return { name: r.name, sid: r.sid, numParticipants: r.numParticipants };
  }
  async listRooms(): Promise<LkRoom[]> {
    return (await this.#svc.listRooms()).map((r) => ({
      name: r.name,
      sid: r.sid,
      numParticipants: r.numParticipants,
    }));
  }
  async listParticipants(room: string): Promise<LkParticipant[]> {
    return (await this.#svc.listParticipants(room)).map(toParticipant);
  }
  async updatePermission(room: string, identity: string, p: LkPermission): Promise<void> {
    await this.#svc.updateParticipant(room, identity, undefined, permissionMessage(p));
  }
  async removeParticipant(room: string, identity: string): Promise<void> {
    await this.#svc.removeParticipant(room, identity);
  }
  async deleteRoom(room: string): Promise<void> {
    await this.#svc.deleteRoom(room);
  }
}

function permissionMessage(p: LkPermission) {
  return {
    canSubscribe: p.canSubscribe,
    canPublish: p.canPublish,
    canPublishData: false,
    canPublishSources: p.sources.map((s) => SOURCE_TO_ENUM[s]),
  };
}

export interface MintOptions {
  apiKey: string;
  apiSecret: string;
  identity: string;
  name: string;
  room: string;
  permission: LkPermission;
  ttlSecs: number;
}

/** A join token. LiveKit refreshes it for the connected session itself (D1), so the TTL only has to cover connecting. */
export async function mintToken(o: MintOptions): Promise<string> {
  const t = new AccessToken(o.apiKey, o.apiSecret, { identity: o.identity, name: o.name, ttl: o.ttlSecs });
  t.addGrant({
    roomJoin: true,
    room: o.room,
    canSubscribe: o.permission.canSubscribe,
    canPublish: o.permission.canPublish,
    canPublishData: false,
    canUpdateOwnMetadata: true,
    canPublishSources: o.permission.sources.map((s) => SOURCE_TO_ENUM[s]),
  });
  return t.toJwt();
}

export function sdkWebhookVerifier(apiKey: string, apiSecret: string): WebhookVerifier {
  const receiver = new WebhookReceiver(apiKey, apiSecret);
  return async (body, authorization) => {
    const e = await receiver.receive(body, authorization);
    const t = e.track;
    return {
      id: e.id,
      event: e.event,
      createdAt: Number(e.createdAt),
      room: e.room ? { name: e.room.name, sid: e.room.sid } : null,
      participant: e.participant ? { identity: e.participant.identity, sid: e.participant.sid } : null,
      track: t ? { sid: t.sid, source: sourceName(t.source), muted: t.muted } : null,
    };
  };
}
