// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VoiceParticipant, VoiceSource } from "@tincan/shared";

/** One person in one voice room, as the app believes it (08 §7). */
export interface PresenceEntry {
  userId: string;
  channelId: string;
  /** LiveKit's participant SID: tells a late event of an old session from one of the current session. */
  sid: string;
  joinedAt: number;
  sources: Set<VoiceSource>;
  muted: boolean;
  deafened: boolean;
  /** Epoch seconds of the newest webhook applied; older events of this session are stale. */
  eventAt: number;
  /** Reconciliation passes in a row that did not find this person in LiveKit. */
  missed: number;
}

export const toWire = (e: PresenceEntry): VoiceParticipant => ({
  userId: e.userId,
  joinedAt: new Date(e.joinedAt).toISOString(),
  sources: [...e.sources],
  muted: e.muted,
  deafened: e.deafened,
});

const TOMBSTONE_MS = 60_000;
const SEEN_EVENTS = 2000;

/**
 * In-memory presence with the ordering rules the webhook races need. LiveKit delivers webhooks from
 * several workers, so events can arrive duplicated, late or out of order (D1):
 *  - an event id is applied once;
 *  - `left` for a session id that is not the current one is ignored (the person already rejoined);
 *  - a session that left is remembered for a minute so a `joined` that overtakes its `left` is not resurrected.
 */
export class PresenceStore {
  readonly #rooms = new Map<string, Map<string, PresenceEntry>>();
  readonly #seen = new Set<string>();
  readonly #tombstones = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** True the first time an event id is seen. */
  firstTime(id: string): boolean {
    if (!id) return true;
    if (this.#seen.has(id)) return false;
    this.#seen.add(id);
    if (this.#seen.size > SEEN_EVENTS) this.#seen.delete(this.#seen.values().next().value as string);
    return true;
  }

  get(channelId: string, userId: string): PresenceEntry | undefined {
    return this.#rooms.get(channelId)?.get(userId);
  }

  /** The room a person is in, if any. */
  find(userId: string): PresenceEntry | undefined {
    for (const room of this.#rooms.values()) {
      const e = room.get(userId);
      if (e) return e;
    }
    return undefined;
  }

  inChannel(channelId: string): PresenceEntry[] {
    return [...(this.#rooms.get(channelId)?.values() ?? [])];
  }

  channelIds(): string[] {
    return [...this.#rooms.keys()];
  }

  all(): PresenceEntry[] {
    return [...this.#rooms.values()].flatMap((r) => [...r.values()]);
  }

  count(channelId: string): number {
    return this.#rooms.get(channelId)?.size ?? 0;
  }

  /** Applies `participant_joined`. Returns the entry if it changed presence, else null. */
  joined(
    channelId: string,
    userId: string,
    sid: string,
    joinedAt: number,
    eventAt: number,
  ): PresenceEntry | null {
    this.#sweepTombstones();
    if (this.#tombstones.has(sid)) return null;
    const cur = this.get(channelId, userId);
    if (cur && cur.sid === sid) {
      cur.missed = 0;
      return null; // duplicate delivery of the same join
    }
    if (cur && cur.eventAt > eventAt) return null; // an older session's late join
    const entry: PresenceEntry = {
      userId,
      channelId,
      sid,
      joinedAt,
      sources: new Set(),
      muted: false,
      deafened: false,
      eventAt,
      missed: 0,
    };
    this.#put(entry);
    return entry;
  }

  /** Applies `participant_left`. Returns the removed entry, or null when the event is stale or unknown. */
  left(channelId: string, userId: string, sid: string, eventAt: number): PresenceEntry | null {
    this.#tombstones.set(sid, this.#now());
    const cur = this.get(channelId, userId);
    if (!cur || cur.sid !== sid) return null;
    if (cur.eventAt > eventAt) return null;
    this.remove(channelId, userId);
    return cur;
  }

  /** Applies track events. Returns the entry if its sources changed. */
  track(
    channelId: string,
    userId: string,
    sid: string,
    source: VoiceSource,
    published: boolean,
    eventAt: number,
  ): PresenceEntry | null {
    const cur = this.get(channelId, userId);
    if (!cur || cur.sid !== sid) return null;
    if (published === cur.sources.has(source)) {
      cur.eventAt = Math.max(cur.eventAt, eventAt);
      return null;
    }
    // An unpublish that is older than the latest applied event for this session lost the race with a re-publish.
    if (!published && eventAt < cur.eventAt) return null;
    if (published) cur.sources.add(source);
    else cur.sources.delete(source);
    cur.eventAt = Math.max(cur.eventAt, eventAt);
    return cur;
  }

  /** Self-declared mute/deafen from the gateway. */
  setSelfState(userId: string, muted: boolean, deafened: boolean): PresenceEntry | null {
    const cur = this.find(userId);
    if (!cur || (cur.muted === muted && cur.deafened === deafened)) return null;
    cur.muted = muted;
    cur.deafened = deafened;
    return cur;
  }

  /** Reconciler: makes the entry match LiveKit. Reports what was repaired. */
  adopt(
    channelId: string,
    userId: string,
    sid: string,
    joinedAt: number,
    sources: Iterable<VoiceSource>,
  ): "added" | "fixed" | null {
    const want = new Set(sources);
    const cur = this.get(channelId, userId);
    if (!cur || cur.sid !== sid) {
      const e: PresenceEntry = {
        userId,
        channelId,
        sid,
        joinedAt,
        sources: want,
        muted: false,
        deafened: false,
        eventAt: 0,
        missed: 0,
      };
      this.#put(e);
      return "added";
    }
    cur.missed = 0;
    const same = want.size === cur.sources.size && [...want].every((s) => cur.sources.has(s));
    if (same) return null;
    cur.sources = want;
    return "fixed";
  }

  remove(channelId: string, userId: string): PresenceEntry | null {
    const room = this.#rooms.get(channelId);
    const e = room?.get(userId);
    if (!room || !e) return null;
    room.delete(userId);
    if (room.size === 0) this.#rooms.delete(channelId);
    return e;
  }

  removeChannel(channelId: string): PresenceEntry[] {
    const room = this.#rooms.get(channelId);
    this.#rooms.delete(channelId);
    return room ? [...room.values()] : [];
  }

  #put(e: PresenceEntry): void {
    let room = this.#rooms.get(e.channelId);
    if (!room) this.#rooms.set(e.channelId, (room = new Map<string, PresenceEntry>()));
    room.set(e.userId, e);
  }

  #sweepTombstones(): void {
    const cutoff = this.#now() - TOMBSTONE_MS;
    for (const [sid, at] of this.#tombstones) if (at < cutoff) this.#tombstones.delete(sid);
  }
}
