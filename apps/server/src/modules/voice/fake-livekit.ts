// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VoiceSource } from "@tincan/shared";
import type {
  CreateRoomOptions,
  LiveKitRooms,
  LkParticipant,
  LkPermission,
  LkRoom,
  LkWebhookEvent,
  WebhookVerifier,
} from "./livekit.js";

/** An in-memory LiveKit for tests: rooms, participants, calls made, and switches that make calls fail. */
export class FakeLiveKit implements LiveKitRooms {
  readonly rooms = new Map<
    string,
    { sid: string; participants: Map<string, LkParticipant>; opts: CreateRoomOptions }
  >();
  readonly calls: string[] = [];
  /** Methods listed here throw, as if LiveKit were unreachable. */
  readonly failing = new Set<string>();
  #n = 0;

  #maybeFail(method: string): void {
    this.calls.push(method);
    if (this.failing.has(method) || this.failing.has("*"))
      throw new Error(`fake LiveKit: ${method} unavailable`);
  }

  async createRoom(opts: CreateRoomOptions): Promise<LkRoom> {
    this.#maybeFail("createRoom");
    let r = this.rooms.get(opts.name);
    if (!r) this.rooms.set(opts.name, (r = { sid: `RM_${++this.#n}`, participants: new Map(), opts }));
    return { name: opts.name, sid: r.sid, numParticipants: r.participants.size };
  }
  async listRooms(): Promise<LkRoom[]> {
    this.#maybeFail("listRooms");
    return [...this.rooms].map(([name, r]) => ({ name, sid: r.sid, numParticipants: r.participants.size }));
  }
  async listParticipants(room: string): Promise<LkParticipant[]> {
    this.#maybeFail("listParticipants");
    return [...(this.rooms.get(room)?.participants.values() ?? [])];
  }
  async updatePermission(room: string, identity: string, permission: LkPermission): Promise<void> {
    this.#maybeFail("updatePermission");
    const p = this.rooms.get(room)?.participants.get(identity);
    if (p) p.permission = permission;
  }
  async removeParticipant(room: string, identity: string): Promise<void> {
    this.#maybeFail("removeParticipant");
    this.rooms.get(room)?.participants.delete(identity);
  }
  async deleteRoom(room: string): Promise<void> {
    this.#maybeFail("deleteRoom");
    this.rooms.delete(room);
  }

  /** Puts someone into a room as LiveKit would after a client connects (no webhook is sent). */
  connect(
    room: string,
    identity: string,
    opts: { sid?: string; permission?: LkPermission; sources?: VoiceSource[]; joinedAtMs?: number } = {},
  ): LkParticipant {
    let r = this.rooms.get(room);
    if (!r) {
      r = {
        sid: `RM_${++this.#n}`,
        participants: new Map(),
        opts: { name: room, emptyTimeoutSecs: 60, departureTimeoutSecs: 20, maxParticipants: 99 },
      };
      this.rooms.set(room, r);
    }
    const p: LkParticipant = {
      identity,
      sid: opts.sid ?? `PA_${++this.#n}`,
      joinedAtMs: opts.joinedAtMs ?? Date.now(),
      permission: opts.permission ?? {
        canSubscribe: true,
        canPublish: true,
        sources: ["microphone", "camera", "screen_share", "screen_share_audio"],
      },
      tracks: (opts.sources ?? []).map((source, i) => ({ sid: `TR_${identity}_${i}`, source, muted: false })),
    };
    r.participants.set(identity, p);
    return p;
  }

  /** What LiveKit would do when a person drops without any webhook arriving. */
  vanish(room: string, identity: string): void {
    this.rooms.get(room)?.participants.delete(identity);
  }
}

/** A verifier for tests: the body is the event as JSON, and the Authorization header must be "ok". */
export const jsonVerifier: WebhookVerifier = async (body, authorization) => {
  if (authorization !== "ok") throw new Error("bad signature");
  return JSON.parse(body) as LkWebhookEvent;
};
