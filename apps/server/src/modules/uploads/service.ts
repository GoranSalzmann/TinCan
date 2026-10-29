// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Db } from "@tincan/db";
import type { Kv } from "@tincan/pubsub";
import { AppError, newId, type Attachment } from "@tincan/shared";
import type { Storage } from "@tincan/storage";
import type { EventBus } from "../../framework/events.js";
import type { Logger } from "../../framework/types.js";
import { enforceRateLimit } from "../../http/rate-limit.js";
import type { AccountsApi } from "../accounts/api.js";
import type { RolesApi } from "../roles/api.js";
import type { UploadsApi } from "./api.js";
import {
  avatarImage,
  cleanFilename,
  inspectImage,
  safeDeclaredType,
  sniffImage,
  thumbnail,
} from "./images.js";
import type { UploadsTables } from "./schema.js";

export interface UploadsSettings {
  maxBytes: number;
  userQuotaBytes: number;
  diskWarnPercent: number;
  thumbnailSize: number;
}

/** Hard ceiling for one file: uploads are buffered in memory while they are checked and thumbnailed. */
export const MAX_FILE_BYTES_CEILING = 512 * 1024 * 1024;

export interface UploadLimits {
  maxBytes: number;
  userQuotaBytes: number;
}

export interface UploadsDeps {
  db: Db<UploadsTables>;
  storage: Storage;
  kv: Kv;
  roles: RolesApi;
  accounts: AccountsApi;
  events: EventBus;
  log: Logger;
  settings: UploadsSettings;
}

type Row = UploadsTables["attachment"];

export const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
const GC_AFTER_MS = 24 * 3_600_000;

const wire = (r: Row): Attachment => ({
  id: r.id,
  filename: r.deleted_at === null ? r.filename : "",
  contentType: r.deleted_at === null ? r.content_type : "application/octet-stream",
  size: r.deleted_at === null ? r.size : 0,
  width: r.deleted_at === null ? r.width : null,
  height: r.deleted_at === null ? r.height : null,
  hasThumbnail: r.deleted_at === null && r.has_thumb === 1,
  removed: r.deleted_at !== null,
});

export class UploadsService implements UploadsApi {
  readonly #d: UploadsDeps;

  constructor(deps: UploadsDeps) {
    this.#d = deps;
  }

  // ---- quota ---------------------------------------------------------------------------------

  /** The limits in force now: the config values, or what the owner set at runtime. */
  limits(): UploadLimits {
    return { maxBytes: this.#d.settings.maxBytes, userQuotaBytes: this.#d.settings.userQuotaBytes };
  }

  /** Applies limits the owner saved earlier; call once at start-up. */
  async loadStoredLimits(): Promise<void> {
    const rows = await this.#d.db.query.selectFrom("upload_setting").select(["key", "value"]).execute();
    for (const r of rows) {
      if (r.key === "max_bytes") this.#d.settings.maxBytes = Math.min(r.value, MAX_FILE_BYTES_CEILING);
      if (r.key === "user_quota_bytes") this.#d.settings.userQuotaBytes = r.value;
    }
  }

  /** Changes the limits for the next request, without a restart, and keeps them across restarts. */
  async updateLimits(patch: Partial<UploadLimits>): Promise<UploadLimits> {
    const now = Date.now();
    const entries: [string, number][] = [];
    if (patch.maxBytes !== undefined) {
      if (patch.maxBytes > MAX_FILE_BYTES_CEILING)
        throw new AppError("VALIDATION_FAILED", "That file size limit is above the server's ceiling.", {
          ceiling: MAX_FILE_BYTES_CEILING,
        });
      entries.push(["max_bytes", patch.maxBytes]);
    }
    if (patch.userQuotaBytes !== undefined) entries.push(["user_quota_bytes", patch.userQuotaBytes]);
    for (const [key, value] of entries) {
      await this.#d.db.query
        .insertInto("upload_setting")
        .values({ key, value, updated_at: now })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now }))
        .execute();
    }
    if (patch.maxBytes !== undefined) this.#d.settings.maxBytes = patch.maxBytes;
    if (patch.userQuotaBytes !== undefined) this.#d.settings.userQuotaBytes = patch.userQuotaBytes;
    return this.limits();
  }

  async usage(userId: string): Promise<{ usedBytes: number; quotaBytes: number }> {
    const r = await this.#d.db.query
      .selectFrom("attachment")
      .select((eb) => eb.fn.sum<number>("size").as("n"))
      .where("uploader_id", "=", userId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return { usedBytes: Number(r?.n ?? 0), quotaBytes: this.#d.settings.userQuotaBytes };
  }

  // ---- upload --------------------------------------------------------------------------------

  async upload(
    userId: string,
    file: { buffer: Buffer; filename: string | undefined; declaredType: string | undefined },
  ): Promise<Attachment> {
    await this.#d.roles.assert(userId, "ATTACH_FILES");
    // 07 §2.4: 10 uploads a minute.
    await enforceRateLimit(this.#d.kv, { key: `upload:${userId}`, max: 10, windowMs: 60_000 });
    const { buffer } = file;
    if (buffer.length === 0) throw new AppError("VALIDATION_FAILED", "That file is empty.");
    if (buffer.length > this.#d.settings.maxBytes)
      throw new AppError("PAYLOAD_TOO_LARGE", "That file is too large.", {
        maxBytes: this.#d.settings.maxBytes,
      });
    const { usedBytes, quotaBytes } = await this.usage(userId);
    if (usedBytes + buffer.length > quotaBytes)
      throw new AppError("QUOTA_EXCEEDED", "You have used up your upload space. Delete some files first.", {
        usedBytes,
        quotaBytes,
      });

    const sniffed = sniffImage(buffer);
    let contentType = sniffed ?? safeDeclaredType(file.declaredType);
    let dims: { width: number; height: number } | null = null;
    let thumb: Buffer | null = null;
    if (sniffed) {
      try {
        dims = await inspectImage(buffer);
        thumb = await thumbnail(buffer, this.#d.settings.thumbnailSize);
      } catch {
        // Claims to be an image but is not decodable: refuse rather than store something odd.
        throw new AppError("UNSUPPORTED_MEDIA_TYPE", "That image could not be read.");
      }
    } else if (contentType.startsWith("image/")) {
      // An image type we cannot vouch for (svg, bmp, tiff …) is stored as an opaque download.
      contentType = "application/octet-stream";
    }

    const now = Date.now();
    const id = newId(now);
    const key = `att/${id}`;
    await this.#d.storage.put(key, Readable.from([buffer]), { contentType, size: buffer.length });
    if (thumb)
      await this.#d.storage.put(`${key}.thumb`, Readable.from([thumb]), { contentType: "image/webp" });
    const row: Row = {
      id,
      message_id: null,
      channel_id: null,
      uploader_id: userId,
      storage_key: key,
      filename: cleanFilename(file.filename),
      content_type: contentType,
      size: buffer.length,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      has_thumb: thumb ? 1 : 0,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      created_at: now,
      deleted_at: null,
    };
    try {
      await this.#d.db.query.insertInto("attachment").values(row).execute();
    } catch (err) {
      await this.#removeObjects(row);
      throw err;
    }
    return wire(row);
  }

  async #removeObjects(r: Pick<Row, "storage_key" | "has_thumb">): Promise<void> {
    await this.#d.storage
      .delete(r.storage_key)
      .catch((err: unknown) => this.#d.log.warn({ err }, "file delete failed"));
    if (r.has_thumb === 1)
      await this.#d.storage
        .delete(`${r.storage_key}.thumb`)
        .catch((err: unknown) => this.#d.log.warn({ err }, "thumbnail delete failed"));
  }

  // ---- UploadsApi ----------------------------------------------------------------------------

  async attach(
    rawTx: Db<unknown>,
    args: { ids: string[]; uploaderId: string; messageId: string; channelId: string },
  ): Promise<void> {
    const tx = rawTx.as<UploadsTables>();
    const rows = await tx.query
      .selectFrom("attachment")
      .select(["id", "uploader_id", "message_id", "deleted_at"])
      .where("id", "in", args.ids)
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of args.ids) {
      const r = byId.get(id);
      if (!r || r.uploader_id !== args.uploaderId || r.message_id !== null || r.deleted_at !== null)
        throw new AppError("VALIDATION_FAILED", "One of the files cannot be attached.", {
          fields: { attachmentIds: "unknown, already used or not yours" },
        });
    }
    await tx.query
      .updateTable("attachment")
      .set({ message_id: args.messageId, channel_id: args.channelId })
      .where("id", "in", args.ids)
      .execute();
  }

  async forMessages(messageIds: readonly string[]): Promise<Map<string, Attachment[]>> {
    const out = new Map<string, Attachment[]>();
    if (messageIds.length === 0) return out;
    const rows = await this.#d.db.query
      .selectFrom("attachment")
      .selectAll()
      .where("message_id", "in", [...messageIds])
      .orderBy("id")
      .execute();
    for (const r of rows) {
      const list = out.get(r.message_id!);
      if (list) list.push(wire(r));
      else out.set(r.message_id!, [wire(r)]);
    }
    return out;
  }

  // ---- own attachments (U16) -----------------------------------------------------------------

  async listOwn(
    userId: string,
    q: { sort: "size" | "date"; cursor?: string | undefined; limit: number },
  ): Promise<{
    items: {
      id: string;
      filename: string;
      contentType: string;
      size: number;
      channelId: string | null;
      messageId: string | null;
      createdAt: string;
    }[];
    nextCursor: string | null;
  }> {
    let query = this.#d.db.query
      .selectFrom("attachment")
      .selectAll()
      .where("uploader_id", "=", userId)
      .where("deleted_at", "is", null);
    if (q.sort === "date") {
      if (q.cursor) query = query.where("id", "<", q.cursor);
      query = query.orderBy("id", "desc");
    } else {
      const m = /^(\d+):(\w+)$/.exec(q.cursor ?? "");
      if (m) {
        const size = Number(m[1]);
        query = query.where((eb) =>
          eb.or([eb("size", "<", size), eb.and([eb("size", "=", size), eb("id", "<", m[2]!)])]),
        );
      }
      query = query.orderBy("size", "desc").orderBy("id", "desc");
    }
    const rows = await query.limit(q.limit + 1).execute();
    const page = rows.slice(0, q.limit);
    // Where an upload lives is shown only for channels the uploader can still see (U16).
    const visible = new Map<string, boolean>();
    for (const r of page) {
      if (r.channel_id && !visible.has(r.channel_id))
        visible.set(r.channel_id, await this.#d.roles.can(userId, "VIEW_CHANNEL", r.channel_id));
    }
    const last = page.at(-1);
    return {
      items: page.map((r) => {
        const seen = r.channel_id !== null && visible.get(r.channel_id) === true;
        return {
          id: r.id,
          filename: r.filename,
          contentType: r.content_type,
          size: r.size,
          channelId: seen ? r.channel_id : null,
          messageId: seen ? r.message_id : null,
          createdAt: new Date(r.created_at).toISOString(),
        };
      }),
      nextCursor:
        rows.length > q.limit && last ? (q.sort === "date" ? last.id : `${last.size}:${last.id}`) : null,
    };
  }

  /** Deletes an own attachment: quota is free at once and the message shows "File removed" (U16). */
  async removeOwn(userId: string, id: string): Promise<void> {
    const row = await this.#d.db.query
      .selectFrom("attachment")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row || row.uploader_id !== userId || row.deleted_at !== null)
      throw new AppError("NOT_FOUND", "No such file.");
    await this.#delete(row);
  }

  async #delete(row: Row): Promise<void> {
    await this.#d.db.query
      .updateTable("attachment")
      .set({ deleted_at: Date.now() })
      .where("id", "=", row.id)
      .execute();
    await this.#removeObjects(row);
    this.#d.events.emit("attachment.removed", {
      attachmentId: row.id,
      messageId: row.message_id,
      channelId: row.channel_id,
    });
  }

  // ---- serving -------------------------------------------------------------------------------

  /** The row if `userId` may fetch it: an unattached upload only by its uploader, an attached one by anyone who can view the channel. */
  async authorizeFile(userId: string, id: string): Promise<Row> {
    const row = await this.#d.db.query
      .selectFrom("attachment")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row || row.deleted_at !== null) throw new AppError("NOT_FOUND", "No such file.");
    if (row.channel_id === null) {
      if (row.uploader_id !== userId) throw new AppError("NOT_FOUND", "No such file.");
    } else if (!(await this.#d.roles.can(userId, "VIEW_CHANNEL", row.channel_id))) {
      throw new AppError("NOT_FOUND", "No such file.");
    }
    return row;
  }

  // ---- avatars -------------------------------------------------------------------------------

  async setAvatar(userId: string, buffer: Buffer): Promise<string> {
    await enforceRateLimit(this.#d.kv, { key: `avatar:${userId}`, max: 10, windowMs: 60_000 });
    if (!sniffImage(buffer))
      throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Avatars must be PNG, JPEG, GIF or WebP.");
    let out: Buffer;
    try {
      out = await avatarImage(buffer);
    } catch {
      throw new AppError("UNSUPPORTED_MEDIA_TYPE", "That image could not be read.");
    }
    const name = `${userId}-${createHash("sha256").update(out).digest("hex").slice(0, 12)}.webp`;
    await this.#d.storage.put(`avatar/${name}`, Readable.from([out]), { contentType: "image/webp" });
    const previous = (await this.#d.accounts.getUser(userId))?.avatarKey;
    await this.#d.accounts.setAvatarKey(userId, name);
    if (previous && previous !== name)
      await this.#d.storage.delete(`avatar/${previous}`).catch(() => undefined);
    return name;
  }

  async clearAvatar(userId: string): Promise<void> {
    const previous = (await this.#d.accounts.getUser(userId))?.avatarKey;
    await this.#d.accounts.setAvatarKey(userId, null);
    if (previous) await this.#d.storage.delete(`avatar/${previous}`).catch(() => undefined);
  }

  // ---- housekeeping --------------------------------------------------------------------------

  /** `uploads.gc` (05 §7): uploads that never got a message within a day. */
  async collectOrphans(): Promise<number> {
    const rows = await this.#d.db.query
      .selectFrom("attachment")
      .selectAll()
      .where("message_id", "is", null)
      .where("deleted_at", "is", null)
      .where("created_at", "<", Date.now() - GC_AFTER_MS)
      .limit(500)
      .execute();
    for (const r of rows) {
      await this.#removeObjects(r);
      await this.#d.db.query.deleteFrom("attachment").where("id", "=", r.id).execute();
    }
    return rows.length;
  }

  /** A message or its channel is gone: its files go with it. */
  async removeFor(by: { messageId?: string; channelId?: string }): Promise<void> {
    const q = this.#d.db.query.selectFrom("attachment").selectAll().where("deleted_at", "is", null);
    const rows = await (
      by.messageId ? q.where("message_id", "=", by.messageId) : q.where("channel_id", "=", by.channelId ?? "")
    ).execute();
    for (const r of rows) await this.#delete(r);
  }
}
