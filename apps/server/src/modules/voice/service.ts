// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from "@tincan/db";
import type { Kv } from "@tincan/pubsub";
import {
  AppError,
  channelIdOfRoom,
  voiceRoomName,
  type VoiceJoinResponse,
  type VoiceParticipant,
  type VoiceSource,
} from "@tincan/shared";
import { enforceRateLimit } from "../../http/rate-limit.js";
import type { GatewayRegistrar, Logger } from "../../framework/types.js";
import type { AccountsApi } from "../accounts/api.js";
import type { ChannelRecord, ChannelsApi } from "../channels/api.js";
import type { RolesApi } from "../roles/api.js";
import { grantFor, samePermission } from "./grants.js";
import {
  mintToken,
  type LiveKitRooms,
  type LkParticipant,
  type LkPermission,
  type LkWebhookEvent,
  type WebhookVerifier,
} from "./livekit.js";
import { PresenceStore, toWire, type PresenceEntry } from "./presence.js";

export interface VoiceSettings {
  defaultUserLimit: number;
  audioBitrateKbps: number;
  tokenTtlSecs: number;
  /** Server-wide caps for the top video layer (08 §5.2); a channel can only lower the screen share one. */
  camera: { maxBitrateKbps: number };
  screenshare: { maxBitrateKbps: number };
  emptyTimeoutSecs: number;
  departureTimeoutSecs: number;
  joinRate: { max: number; windowSecs: number };
}

import type { VoiceTables } from "./schema.js";

export interface VideoLimits {
  cameraMaxKbps: number;
  screenshareMaxKbps: number;
}

export interface VoiceDeps {
  db: Db<VoiceTables>;
  settings: VoiceSettings;
  livekit: { url: string; apiKey: string; apiSecret: string };
  rooms: LiveKitRooms;
  verify: WebhookVerifier;
  roles: RolesApi;
  channels: ChannelsApi;
  accounts: AccountsApi;
  gateway: GatewayRegistrar;
  kv: Kv;
  log: Logger;
  now?: () => number;
}

export type RepairKind =
  | "presence_added"
  | "presence_fixed"
  | "presence_removed"
  | "permission_updated"
  | "participant_removed"
  | "duplicate_session"
  | "orphan_room";

export interface VoiceStats {
  webhooks: {
    received: number;
    rejected: number;
    duplicates: number;
    byEvent: Record<string, number>;
    lastLagMs: number | null;
  };
  reconcile: {
    runs: number;
    failures: number;
    lastAt: number | null;
    lastDurationMs: number | null;
    livekitReachable: boolean | null;
    /** A sustained non-zero rate means a primary path (webhooks, the fast enforcement) is broken (18 T34). */
    repairs: Record<RepairKind, number>;
  };
}

const emptyRepairs = (): Record<RepairKind, number> => ({
  presence_added: 0,
  presence_fixed: 0,
  presence_removed: 0,
  permission_updated: 0,
  participant_removed: 0,
  duplicate_session: 0,
  orphan_room: 0,
});

export class VoiceService {
  readonly presence: PresenceStore;
  readonly stats: VoiceStats = {
    webhooks: { received: 0, rejected: 0, duplicates: 0, byEvent: {}, lastLagMs: null },
    reconcile: {
      runs: 0,
      failures: 0,
      lastAt: null,
      lastDurationMs: null,
      livekitReachable: null,
      repairs: emptyRepairs(),
    },
  };
  readonly #d: VoiceDeps;
  readonly #now: () => number;
  #reconciling: Promise<void> | null = null;
  readonly #refreshing = new Map<string, Promise<void>>();

  constructor(deps: VoiceDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.presence = new PresenceStore(this.#now);
  }

  // ---- join / leave --------------------------------------------------------------------------

  /** Returns the voice channel or throws NOT_FOUND, which is also the answer for a channel the user cannot see (M2-4). */
  async #voiceChannel(userId: string, channelId: string): Promise<ChannelRecord> {
    const ch = await this.#d.channels.get(channelId);
    if (!ch || ch.type !== "voice" || ch.archivedAt !== null) {
      throw new AppError("NOT_FOUND", "No such voice channel.");
    }
    if (!(await this.#d.roles.can(userId, "VIEW_CHANNEL", channelId))) {
      throw new AppError("NOT_FOUND", "No such voice channel.");
    }
    return ch;
  }

  limitOf(ch: ChannelRecord): number {
    return ch.settings.userLimit ?? this.#d.settings.defaultUserLimit;
  }

  /** The server-wide caps in force now: the config values, or what the owner set at runtime. */
  videoLimits(): VideoLimits {
    const g = this.#d.settings;
    return { cameraMaxKbps: g.camera.maxBitrateKbps, screenshareMaxKbps: g.screenshare.maxBitrateKbps };
  }

  /** Applies caps the owner saved earlier; call once at start-up. */
  async loadStoredLimits(): Promise<void> {
    const rows = await this.#d.db.query.selectFrom("voice_setting").select(["key", "value"]).execute();
    for (const r of rows) {
      if (r.key === "camera_max_kbps") this.#d.settings.camera.maxBitrateKbps = r.value;
      if (r.key === "screenshare_max_kbps") this.#d.settings.screenshare.maxBitrateKbps = r.value;
    }
  }

  /** Changes the caps for the next join, without a restart, and keeps them across restarts. */
  async updateVideoLimits(patch: Partial<VideoLimits>): Promise<VideoLimits> {
    const now = Date.now();
    const entries: [string, number][] = [];
    if (patch.cameraMaxKbps !== undefined) entries.push(["camera_max_kbps", patch.cameraMaxKbps]);
    if (patch.screenshareMaxKbps !== undefined)
      entries.push(["screenshare_max_kbps", patch.screenshareMaxKbps]);
    for (const [key, value] of entries) {
      await this.#d.db.query
        .insertInto("voice_setting")
        .values({ key, value, updated_at: now })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now }))
        .execute();
    }
    if (patch.cameraMaxKbps !== undefined) this.#d.settings.camera.maxBitrateKbps = patch.cameraMaxKbps;
    if (patch.screenshareMaxKbps !== undefined)
      this.#d.settings.screenshare.maxBitrateKbps = patch.screenshareMaxKbps;
    return this.videoLimits();
  }

  /** Top-layer caps in kbit/s. Advisory: LiveKit cannot enforce a publisher's bitrate, so a modified client could exceed it. */
  videoCaps(ch: ChannelRecord): { cameraMaxKbps: number; screenshareMaxKbps: number } {
    const g = this.#d.settings;
    return {
      cameraMaxKbps: g.camera.maxBitrateKbps,
      screenshareMaxKbps: Math.min(ch.settings.maxScreenshareKbps ?? Infinity, g.screenshare.maxBitrateKbps),
    };
  }

  async join(userId: string, channelId: string): Promise<VoiceJoinResponse> {
    const ch = await this.#voiceChannel(userId, channelId);
    await this.#d.roles.assert(userId, "CONNECT", channelId);
    const rate = this.#d.settings.joinRate;
    await enforceRateLimit(this.#d.kv, {
      key: `voice-join:${userId}`,
      max: rate.max,
      windowMs: rate.windowSecs * 1000,
    });
    const member = await this.#d.accounts.getMember(userId);
    if (!member || member.disabled)
      throw new AppError("PERMISSION_DENIED", "Your account cannot join voice.");

    const limit = this.limitOf(ch);
    const here = this.presence.get(channelId, userId);
    if (!here && this.presence.count(channelId) >= limit) {
      throw new AppError("CONFLICT", "This voice channel is full.", { reason: "channel_full", limit });
    }
    // One place at a time (08 §4.5): leave the old room before taking a token for the new one.
    const elsewhere = this.presence.find(userId);
    if (elsewhere && elsewhere.channelId !== channelId) await this.#evict(elsewhere, "moved");

    const room = voiceRoomName(channelId);
    try {
      await this.#d.rooms.createRoom({
        name: room,
        emptyTimeoutSecs: this.#d.settings.emptyTimeoutSecs,
        departureTimeoutSecs: this.#d.settings.departureTimeoutSecs,
        maxParticipants: limit,
      });
    } catch (err) {
      this.#d.log.warn({ err, room }, "voice: LiveKit refused to create the room");
      throw new AppError("UNAVAILABLE", "Voice is offline right now. Text chat is unaffected.");
    }

    const permission = grantFor(await this.#d.roles.permissionsIn(userId, channelId), ch.settings);
    const ttl = this.#d.settings.tokenTtlSecs;
    const token = await mintToken({
      apiKey: this.#d.livekit.apiKey,
      apiSecret: this.#d.livekit.apiSecret,
      identity: userId,
      name: member.nickname ?? member.displayName,
      room,
      permission,
      ttlSecs: ttl,
    });
    return {
      url: this.#d.livekit.url,
      token,
      expiresAt: new Date(this.#now() + ttl * 1000).toISOString(),
      roomName: room,
      publishDefaults: {
        audioBitrateKbps: Math.min(ch.settings.bitrateKbps ?? this.#d.settings.audioBitrateKbps, 128),
        dtx: true,
        red: true,
        sources: permission.sources,
        video: this.videoCaps(ch),
      },
      userLimit: limit,
    };
  }

  /**
   * Connection test (08 §10, W-25): a private room per person, listen-only and short-lived, outside the `vc_` namespace so
   * it never shows up as presence and the reconciler ignores it.
   */
  async diagnosticsToken(
    userId: string,
  ): Promise<{ url: string; token: string; roomName: string; expiresAt: string }> {
    await enforceRateLimit(this.#d.kv, { key: `voice-diag:${userId}`, max: 6, windowMs: 60_000 });
    const room = `diag_${userId}`;
    try {
      await this.#d.rooms.createRoom({
        name: room,
        emptyTimeoutSecs: 10,
        departureTimeoutSecs: 5,
        maxParticipants: 2,
      });
    } catch {
      throw new AppError("UNAVAILABLE", "Voice is offline right now. Text chat is unaffected.");
    }
    const ttl = 60;
    const token = await mintToken({
      apiKey: this.#d.livekit.apiKey,
      apiSecret: this.#d.livekit.apiSecret,
      identity: userId,
      name: "connection test",
      room,
      permission: { canSubscribe: true, canPublish: false, sources: [] },
      ttlSecs: ttl,
    });
    return {
      url: this.#d.livekit.url,
      token,
      roomName: room,
      expiresAt: new Date(this.#now() + ttl * 1000).toISOString(),
    };
  }

  /** Explicit leave: LiveKit and our presence are updated now instead of when the webhook lands. */
  async leave(userId: string): Promise<void> {
    const e = this.presence.find(userId);
    if (e) await this.#evict(e, null);
  }

  async #evict(
    e: PresenceEntry,
    reason: "moved" | "kicked" | "permission_lost" | "channel_deleted" | null,
  ): Promise<void> {
    this.presence.remove(e.channelId, e.userId);
    this.#announce(e.channelId, e.userId, null);
    // Say why first: the person's client also hears from LiveKit that it was removed, and should show our reason.
    if (reason) {
      this.#d.gateway.dispatchToUser(e.userId, "VOICE_SERVER_DISCONNECT", { channelId: e.channelId, reason });
    }
    try {
      await this.#d.rooms.removeParticipant(voiceRoomName(e.channelId), e.userId);
    } catch (err) {
      // Already gone is the common case; anything else is repaired by the next reconciliation (T25).
      this.#d.log.debug({ err, channelId: e.channelId }, "voice: removeParticipant failed");
    }
  }

  // ---- state for clients ---------------------------------------------------------------------

  async snapshotFor(userId: string): Promise<Record<string, VoiceParticipant[]>> {
    const visible = await this.#d.roles.visibleChannelIds(userId);
    const out: Record<string, VoiceParticipant[]> = {};
    for (const id of this.presence.channelIds()) {
      if (visible.has(id)) out[id] = this.presence.inChannel(id).map(toWire);
    }
    return out;
  }

  setSelfState(userId: string, muted: boolean, deafened: boolean): void {
    const e = this.presence.setSelfState(userId, muted, deafened);
    if (e) this.#announce(e.channelId, e.userId, e);
  }

  wire(e: PresenceEntry): VoiceParticipant {
    return toWire(e);
  }

  #announce(channelId: string, userId: string, entry: PresenceEntry | null): void {
    this.#d.gateway.dispatchToChannel(channelId, "VOICE_STATE_UPDATE", {
      channelId,
      userId,
      joined: entry !== null,
      ...(entry ? { participant: toWire(entry) } : {}),
    });
  }

  // ---- webhooks ------------------------------------------------------------------------------

  /** Verifies and applies one webhook. Throws UNAUTHENTICATED on a bad signature. */
  async handleWebhook(body: string, authorization: string | undefined): Promise<void> {
    let ev: LkWebhookEvent;
    try {
      ev = await this.#d.verify(body, authorization);
    } catch {
      this.stats.webhooks.rejected++;
      throw new AppError("UNAUTHENTICATED", "Bad webhook signature.");
    }
    this.apply(ev);
  }

  /** Applies a verified event. Public so tests can feed events in any order. */
  apply(ev: LkWebhookEvent): void {
    const w = this.stats.webhooks;
    w.received++;
    w.byEvent[ev.event] = (w.byEvent[ev.event] ?? 0) + 1;
    if (ev.createdAt) w.lastLagMs = Math.max(0, this.#now() - ev.createdAt * 1000);
    if (!this.presence.firstTime(ev.id)) {
      w.duplicates++;
      return;
    }
    const channelId = ev.room ? channelIdOfRoom(ev.room.name) : null;
    if (!channelId) return;

    switch (ev.event) {
      case "participant_joined": {
        if (!ev.participant) return;
        const entry = this.presence.joined(
          channelId,
          ev.participant.identity,
          ev.participant.sid,
          this.#now(),
          ev.createdAt,
        );
        if (entry) this.#announce(channelId, entry.userId, entry);
        return;
      }
      case "participant_left":
      case "participant_connection_aborted": {
        if (!ev.participant) return;
        const gone = this.presence.left(channelId, ev.participant.identity, ev.participant.sid, ev.createdAt);
        if (gone) this.#announce(channelId, gone.userId, null);
        return;
      }
      case "track_published":
      case "track_unpublished": {
        if (!ev.participant || !ev.track?.source) return;
        if (!this.presence.get(channelId, ev.participant.identity)) {
          // The track event overtook the join: fetch the room rather than guess (D1).
          void this.#refreshRoom(channelId);
          return;
        }
        const changed = this.presence.track(
          channelId,
          ev.participant.identity,
          ev.participant.sid,
          ev.track.source,
          ev.event === "track_published",
          ev.createdAt,
        );
        if (changed) this.#announce(channelId, changed.userId, changed);
        return;
      }
      case "room_finished": {
        for (const e of this.presence.removeChannel(channelId)) this.#announce(channelId, e.userId, null);
        return;
      }
      default:
    }
  }

  /** Re-reads one room and merges it; collapses bursts of events into one call. */
  #refreshRoom(channelId: string): Promise<void> {
    const running = this.#refreshing.get(channelId);
    if (running) return running;
    const p = (async () => {
      try {
        const parts = await this.#d.rooms.listParticipants(voiceRoomName(channelId));
        for (const part of parts) this.#merge(channelId, part, false);
      } catch (err) {
        this.#d.log.debug({ err, channelId }, "voice: room refresh failed");
      } finally {
        this.#refreshing.delete(channelId);
      }
    })();
    this.#refreshing.set(channelId, p);
    return p;
  }

  /** Makes presence match a LiveKit participant; counts a repair only when asked (the reconciler). */
  #merge(channelId: string, p: LkParticipant, countRepairs: boolean): void {
    const sources = p.tracks.map((t) => t.source).filter((s): s is VoiceSource => s !== null);
    const result = this.presence.adopt(channelId, p.identity, p.sid, p.joinedAtMs, sources);
    if (!result) return;
    const e = this.presence.get(channelId, p.identity);
    if (e) this.#announce(channelId, p.identity, e);
    if (countRepairs)
      this.stats.reconcile.repairs[result === "added" ? "presence_added" : "presence_fixed"]++;
  }

  // ---- permission enforcement ----------------------------------------------------------------

  async #desired(userId: string, ch: ChannelRecord): Promise<LkPermission | "remove"> {
    const member = await this.#d.accounts.getMember(userId);
    if (!member || member.disabled) return "remove";
    const grant = grantFor(await this.#d.roles.permissionsIn(userId, ch.id), ch.settings);
    if (!grant.canSubscribe) return "remove";
    if (!(await this.#d.roles.can(userId, "VIEW_CHANNEL", ch.id))) return "remove";
    return grant;
  }

  /**
   * Happy-path enforcement (the 2 s target of 11 §2.6): recompute one person's grant and push it. Never throws;
   * a failed LiveKit call is repaired by the next reconciliation pass (≤ 30 s, T25).
   */
  async enforce(userId: string): Promise<void> {
    const e = this.presence.find(userId);
    if (!e) return;
    try {
      const ch = await this.#d.channels.get(e.channelId);
      if (!ch || ch.archivedAt !== null) return await this.#evict(e, "channel_deleted");
      const want = await this.#desired(userId, ch);
      if (want === "remove") return await this.#evict(e, "permission_lost");
      await this.#d.rooms.updatePermission(voiceRoomName(e.channelId), userId, want);
    } catch (err) {
      this.#d.log.warn({ err, userId }, "voice: enforcement failed; the reconciler will retry");
    }
  }

  async enforceMany(userIds: readonly string[] | "all", channelId?: string): Promise<void> {
    const targets = this.presence
      .all()
      .filter(
        (e) => (userIds === "all" || userIds.includes(e.userId)) && (!channelId || e.channelId === channelId),
      );
    await Promise.all(targets.map((e) => this.enforce(e.userId)));
  }

  async channelRemoved(channelId: string): Promise<void> {
    for (const e of this.presence.removeChannel(channelId)) {
      this.#announce(channelId, e.userId, null);
      this.#d.gateway.dispatchToUser(e.userId, "VOICE_SERVER_DISCONNECT", {
        channelId,
        reason: "channel_deleted",
      });
    }
    try {
      await this.#d.rooms.deleteRoom(voiceRoomName(channelId));
    } catch (err) {
      this.#d.log.debug({ err, channelId }, "voice: deleteRoom failed (room may not exist)");
    }
  }

  // ---- reconciler (T25) ----------------------------------------------------------------------

  /** One pass: LiveKit is the truth for who is connected; the database is the truth for what they may do. */
  reconcile(): Promise<void> {
    this.#reconciling ??= this.#reconcileOnce().finally(() => {
      this.#reconciling = null;
    });
    return this.#reconciling;
  }

  async #reconcileOnce(): Promise<void> {
    const r = this.stats.reconcile;
    const started = this.#now();
    const repairs = r.repairs;
    try {
      const rooms = (await this.#d.rooms.listRooms()).filter((x) => channelIdOfRoom(x.name) !== null);
      r.livekitReachable = true;
      const live = new Set<string>(); // "channelId:userId" found in LiveKit this pass
      const best = new Map<string, { channelId: string; joinedAtMs: number; room: string }>();

      for (const room of rooms) {
        const channelId = channelIdOfRoom(room.name)!;
        const ch = await this.#d.channels.get(channelId);
        if (!ch || ch.type !== "voice" || ch.archivedAt !== null) {
          repairs.orphan_room++;
          await this.channelRemoved(channelId);
          continue;
        }
        for (const p of await this.#d.rooms.listParticipants(room.name)) {
          const want = await this.#desired(p.identity, ch);
          if (want === "remove") {
            repairs.participant_removed++;
            this.#d.gateway.dispatchToUser(p.identity, "VOICE_SERVER_DISCONNECT", {
              channelId,
              reason: "permission_lost",
            });
            await this.#d.rooms.removeParticipant(room.name, p.identity).catch(() => undefined);
            if (this.presence.remove(channelId, p.identity)) this.#announce(channelId, p.identity, null);
            continue;
          }
          if (!samePermission(p.permission, want)) {
            repairs.permission_updated++;
            await this.#d.rooms.updatePermission(room.name, p.identity, want);
          }
          // The same person in two rooms: keep the newer session (08 §4.5).
          const prev = best.get(p.identity);
          if (prev && prev.joinedAtMs >= p.joinedAtMs) {
            await this.#dropDuplicate(room.name, p.identity, channelId, repairs);
            continue;
          }
          if (prev) {
            live.delete(`${prev.channelId}:${p.identity}`);
            await this.#dropDuplicate(prev.room, p.identity, prev.channelId, repairs);
          }
          best.set(p.identity, { channelId, joinedAtMs: p.joinedAtMs, room: room.name });
          live.add(`${channelId}:${p.identity}`);
          this.#merge(channelId, p, true);
        }
      }

      // Entries LiveKit did not show: a missing room is conclusive, a missing person needs two passes in a row
      // because a join can land between the participant list and the webhook.
      const roomIds = new Set(rooms.map((x) => channelIdOfRoom(x.name)!));
      for (const e of this.presence.all()) {
        if (live.has(`${e.channelId}:${e.userId}`)) continue;
        e.missed++;
        if (!roomIds.has(e.channelId) || e.missed >= 2) {
          repairs.presence_removed++;
          this.presence.remove(e.channelId, e.userId);
          this.#announce(e.channelId, e.userId, null);
        }
      }
    } catch (err) {
      r.failures++;
      // Warn once when LiveKit becomes unreachable, not every 30 s while it stays down.
      if (r.livekitReachable !== false)
        this.#d.log.warn({ err }, "voice: reconciliation could not reach LiveKit");
      r.livekitReachable = false;
    } finally {
      r.runs++;
      r.lastAt = this.#now();
      r.lastDurationMs = this.#now() - started;
    }
  }

  async #dropDuplicate(
    room: string,
    userId: string,
    channelId: string,
    repairs: Record<RepairKind, number>,
  ): Promise<void> {
    repairs.duplicate_session++;
    await this.#d.rooms.removeParticipant(room, userId).catch(() => undefined);
    if (this.presence.remove(channelId, userId)) this.#announce(channelId, userId, null);
  }
}
