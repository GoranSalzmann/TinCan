// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from "@tincan/db";
import {
  AppError,
  newId,
  type Category,
  type Channel,
  type ChannelCreate,
  type ChannelKind,
  type ChannelPatch,
  type ChannelSettings,
  ChannelSettingsSchema,
} from "@tincan/shared";
import type { EventBus } from "../../framework/events.js";
import type { GatewayRegistrar } from "../../framework/types.js";
import type { RolesApi } from "../roles/api.js";
import type { ChannelRecord } from "./api.js";
import type { ChannelsTables } from "./schema.js";

export interface ChannelsDeps {
  db: Db<ChannelsTables>;
  roles: RolesApi;
  gateway: GatewayRegistrar;
  events: EventBus;
}

const toRecord = (r: ChannelsTables["channel"]): ChannelRecord => ({
  id: r.id,
  categoryId: r.category_id,
  type: r.type === "voice" ? "voice" : "text",
  name: r.name,
  topic: r.topic,
  position: r.position,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
  settings: parseSettings(r.settings),
});

function parseSettings(raw: string): ChannelSettings {
  try {
    const parsed = ChannelSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export const channelWire = (c: ChannelRecord): Channel => ({
  id: c.id,
  categoryId: c.categoryId,
  type: c.type,
  name: c.name,
  topic: c.topic,
  position: c.position,
  createdAt: new Date(c.createdAt).toISOString(),
  archivedAt: c.archivedAt === null ? null : new Date(c.archivedAt).toISOString(),
  settings: c.settings,
});

/** Names in text channels are lower-case with dashes, as people type them in links and mentions. */
function cleanName(type: ChannelKind, name: string): string {
  if (type === "voice") return name;
  return name.toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "channel";
}

export class ChannelsService {
  readonly #d: ChannelsDeps;
  #spaceId: string | null = null;
  #channels = new Map<string, ChannelRecord>();
  #categories = new Map<string, Category>();
  #loaded = false;

  constructor(deps: ChannelsDeps) {
    this.#d = deps;
  }

  // ---- loading and seeding -------------------------------------------------------------------

  async load(spaceId: string | null): Promise<void> {
    this.#spaceId = spaceId;
    const [chs, cats] = await Promise.all([
      this.#d.db.query.selectFrom("channel").selectAll().execute(),
      this.#d.db.query.selectFrom("channel_category").selectAll().execute(),
    ]);
    this.#channels = new Map(chs.map((c) => [c.id, toRecord(c)]));
    this.#categories = new Map(cats.map((c) => [c.id, { id: c.id, name: c.name, position: c.position }]));
    this.#loaded = true;
    await this.#sync();
  }

  /** Creates `#general` and `Lounge` for a space with no channels (11 §1.4). Idempotent. */
  async seedDefaults(tx: Db<ChannelsTables>, spaceId: string): Promise<void> {
    const any = await tx.query
      .selectFrom("channel")
      .select("id")
      .where("space_id", "=", spaceId)
      .limit(1)
      .executeTakeFirst();
    if (any) return;
    const now = Date.now();
    const text = newId(now);
    const voice = newId(now);
    await tx.query
      .insertInto("channel_category")
      .values([
        { id: text, space_id: spaceId, name: "Text channels", position: 0 },
        { id: voice, space_id: spaceId, name: "Voice channels", position: 1 },
      ])
      .execute();
    await tx.query
      .insertInto("channel")
      .values([
        {
          id: newId(now),
          space_id: spaceId,
          category_id: text,
          type: "text",
          name: "general",
          topic: null,
          position: 0,
          created_at: now,
          archived_at: null,
          settings: "{}",
        },
        {
          id: newId(now),
          space_id: spaceId,
          category_id: voice,
          type: "voice",
          name: "Lounge",
          topic: null,
          position: 0,
          created_at: now,
          archived_at: null,
          settings: "{}",
        },
      ])
      .execute();
  }

  /** Re-reads everything; used after seeding inside a transaction that has since committed. */
  async reload(): Promise<void> {
    const spaceId =
      this.#spaceId ??
      (await this.#d.db.query.selectFrom("channel").select("space_id").limit(1).executeTakeFirst())
        ?.space_id ??
      null;
    await this.load(spaceId);
  }

  async #sync(): Promise<void> {
    await this.#d.roles.syncChannels(
      [...this.#channels.values()]
        .filter((c) => c.archivedAt === null)
        .map((c) => ({ id: c.id, type: c.type })),
    );
  }

  // ---- reads ---------------------------------------------------------------------------------

  list(): ChannelRecord[] {
    return [...this.#channels.values()].sort(
      (a, b) => (a.categoryId ?? "").localeCompare(b.categoryId ?? "") || a.position - b.position,
    );
  }

  get(id: string): ChannelRecord | null {
    return this.#channels.get(id) ?? null;
  }

  categories(): Category[] {
    return [...this.#categories.values()].sort((a, b) => a.position - b.position);
  }

  /** What `userId` may see: active channels they can view, the categories that hold them, and their permissions. */
  async listFor(userId: string, opts: { archived?: boolean } = {}) {
    const canManage = await this.#d.roles.can(userId, "MANAGE_CHANNELS");
    const permissions = await this.#d.roles.channelPermissionMap(userId);
    const channels = this.list().filter((c) =>
      opts.archived ? canManage && c.archivedAt !== null : c.archivedAt === null && c.id in permissions,
    );
    const used = new Set(channels.map((c) => c.categoryId));
    const categories = this.categories().filter((c) => canManage || used.has(c.id));
    return { categories, channels: channels.map(channelWire), permissions };
  }

  // ---- channels ------------------------------------------------------------------------------

  async create(actorId: string, input: ChannelCreate): Promise<ChannelRecord> {
    await this.#d.roles.assert(actorId, "MANAGE_CHANNELS");
    if (!this.#spaceId) throw new AppError("SETUP_REQUIRED", "This server has not been set up yet.");
    this.#checkCategory(input.categoryId ?? null);
    const peers = this.list().filter((c) => c.categoryId === (input.categoryId ?? null));
    const now = Date.now();
    const row: ChannelsTables["channel"] = {
      id: newId(now),
      space_id: this.#spaceId,
      category_id: input.categoryId ?? null,
      type: input.type,
      name: cleanName(input.type, input.name),
      topic: input.topic ? input.topic : null,
      position: peers.reduce((m, c) => Math.max(m, c.position + 1), 0),
      created_at: now,
      archived_at: null,
      settings: JSON.stringify(input.settings ?? {}),
    };
    await this.#d.db.query.insertInto("channel").values(row).execute();
    const rec = toRecord(row);
    this.#channels.set(rec.id, rec);
    await this.#sync(); // pushes CHANNEL_CREATE to everyone who can see it, through the visibility listener
    this.#d.events.emit("channel.created", { channelId: rec.id });
    return rec;
  }

  async update(actorId: string, id: string, patch: ChannelPatch): Promise<ChannelRecord> {
    await this.#d.roles.assert(actorId, "MANAGE_CHANNELS");
    const cur = this.#channels.get(id);
    if (!cur) throw new AppError("NOT_FOUND", "No such channel.");
    const set: Partial<ChannelsTables["channel"]> = {};
    if (patch.name !== undefined) set.name = cleanName(cur.type, patch.name);
    if (patch.topic !== undefined) set.topic = patch.topic === "" ? null : patch.topic;
    if (patch.categoryId !== undefined) {
      this.#checkCategory(patch.categoryId);
      set.category_id = patch.categoryId;
    }
    if (patch.position !== undefined) set.position = patch.position;
    if (patch.settings !== undefined) set.settings = JSON.stringify({ ...cur.settings, ...patch.settings });
    if (patch.archived !== undefined) set.archived_at = patch.archived ? Date.now() : null;
    if (Object.keys(set).length > 0)
      await this.#d.db.query.updateTable("channel").set(set).where("id", "=", id).execute();
    const row = await this.#d.db.query
      .selectFrom("channel")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const rec = toRecord(row);
    this.#channels.set(id, rec);
    if (patch.archived !== undefined) {
      await this.#sync();
    } else {
      this.#d.gateway.dispatchToChannel(id, "CHANNEL_UPDATE", { channel: channelWire(rec) });
    }
    this.#d.events.emit("channel.updated", { channelId: id });
    return rec;
  }

  async remove(actorId: string, id: string): Promise<void> {
    await this.#d.roles.assert(actorId, "MANAGE_CHANNELS");
    if (!this.#channels.has(id)) throw new AppError("NOT_FOUND", "No such channel.");
    await this.#d.db.transaction(async (tx) => {
      await this.#d.roles.deleteChannelOverwrites(tx, id);
      await tx.query.deleteFrom("channel").where("id", "=", id).execute(); // messages cascade (text-chat)
    });
    this.#channels.delete(id);
    await this.#sync(); // CHANNEL_DELETE goes to everyone who could see it
    this.#d.events.emit("channel.deleted", { channelId: id });
  }

  async reorder(
    actorId: string,
    items: { id: string; categoryId: string | null; position: number }[],
  ): Promise<void> {
    await this.#d.roles.assert(actorId, "MANAGE_CHANNELS");
    for (const it of items) {
      if (!this.#channels.has(it.id)) throw new AppError("NOT_FOUND", "No such channel.");
      this.#checkCategory(it.categoryId);
    }
    await this.#d.db.transaction(async (tx) => {
      for (const it of items) {
        await tx.query
          .updateTable("channel")
          .set({ category_id: it.categoryId, position: it.position })
          .where("id", "=", it.id)
          .execute();
      }
    });
    for (const it of items) {
      const cur = this.#channels.get(it.id)!;
      this.#channels.set(it.id, { ...cur, categoryId: it.categoryId, position: it.position });
    }
    this.#d.gateway.dispatchToAll("CHANNEL_REORDER", { items });
  }

  // ---- categories ----------------------------------------------------------------------------

  #checkCategory(id: string | null): void {
    if (id !== null && !this.#categories.has(id)) throw new AppError("NOT_FOUND", "No such category.");
  }

  async createCategory(
    actorId: string,
    input: { name: string; position?: number | undefined },
  ): Promise<Category> {
    await this.#d.roles.assert(actorId, "MANAGE_CHANNELS");
    if (!this.#spaceId) throw new AppError("SETUP_REQUIRED", "This server has not been set up yet.");
    const cat: Category = {
      id: newId(),
      name: input.name,
      position:
        input.position ?? [...this.#categories.values()].reduce((m, c) => Math.max(m, c.position + 1), 0),
    };
    await this.#d.db.query
      .insertInto("channel_category")
      .values({ ...cat, space_id: this.#spaceId })
      .execute();
    this.#categories.set(cat.id, cat);
    this.#d.gateway.dispatchToAll("CATEGORY_CREATE", { category: cat });
    return cat;
  }

  async updateCategory(
    actorId: string,
    id: string,
    patch: { name?: string | undefined; position?: number | undefined },
  ): Promise<Category> {
    await this.#d.roles.assert(actorId, "MANAGE_CHANNELS");
    const cur = this.#categories.get(id);
    if (!cur) throw new AppError("NOT_FOUND", "No such category.");
    const next: Category = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
    };
    await this.#d.db.query
      .updateTable("channel_category")
      .set({ name: next.name, position: next.position })
      .where("id", "=", id)
      .execute();
    this.#categories.set(id, next);
    this.#d.gateway.dispatchToAll("CATEGORY_UPDATE", { category: next });
    return next;
  }

  async removeCategory(actorId: string, id: string): Promise<void> {
    await this.#d.roles.assert(actorId, "MANAGE_CHANNELS");
    if (!this.#categories.has(id)) throw new AppError("NOT_FOUND", "No such category.");
    await this.#d.db.query.deleteFrom("channel_category").where("id", "=", id).execute(); // channels keep going: category_id becomes null
    this.#categories.delete(id);
    for (const [cid, c] of this.#channels)
      if (c.categoryId === id) this.#channels.set(cid, { ...c, categoryId: null });
    this.#d.gateway.dispatchToAll("CATEGORY_DELETE", { categoryId: id });
  }

  isLoaded(): boolean {
    return this.#loaded;
  }
}
