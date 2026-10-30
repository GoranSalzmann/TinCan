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
import type { UploadsApi, UploadsStats } from "./api.js";
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
  memoryBudgetBytes: number;
}

/** Sanity ceiling for the owner's file limit. Uploads stream, so memory is not the bound; the backup archive format (8 GiB per entry) is, with margin. */
export const MAX_FILE_BYTES_CEILING = 4 * 1024 * 1024 * 1024;

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

/** Images up to this size get a thumbnail and dimensions; bigger ones are stored and offered as a download. */
export const THUMBNAIL_MAX_BYTES = 48 * 1024 * 1024;

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
  readonly #stats = {
    uploads: 0,
    bytes: 0,
    rejected: 0,
    inFlight: 0,
    inFlightBytes: 0,
    peakInFlightBytes: 0,
    peakInFlight: 0,
    busy: 0,
  };

  #reserved = 0;

  /**
   * Sets aside memory for one upload before its body is read (18 §N). Throws RATE_LIMITED (try again shortly) when the
   * uploads running now already hold the budget; returns the function that gives the memory back. A single file larger
   * than the whole budget is still allowed on its own, so raising the file limit never makes uploads impossible.
   */
  reserve(bytes: number): () => void {
    const budget = this.#d.settings.memoryBudgetBytes;
    if (this.#reserved > 0 && this.#reserved + bytes > budget) {
      this.#stats.busy++;
      throw new AppError(
        "RATE_LIMITED",
        "The server is busy with other uploads. Try again in a few seconds.",
        {
          retryAfterMs: 5000,
          reason: "upload_memory",
        },
      );
    }
    this.#reserved += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#reserved -= bytes;
    };
  }

  /** Counters for the metrics module; `inFlightBytes` is the memory held by uploads being checked and stored right now. */
  stats(): UploadsStats {
    return { ...this.#stats };
  }

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

  /**
   * Stores one upload without holding it in memory (18 §M proposal, built): the body goes to storage chunk by chunk
   * while it is counted and hashed, the first bytes decide the type, and only an image small enough to thumbnail is
   * read back (inside the memory budget). Memory per upload is a few chunks, whatever the file size.
   */
  async upload(
    userId: string,
    file: { stream: AsyncIterable<Buffer>; filename: string | undefined; declaredType: string | undefined },
  ): Promise<Attachment> {
    const s = this.#stats;
    s.inFlight++;
    s.peakInFlight = Math.max(s.peakInFlight, s.inFlight);
    try {
      const out = await this.#upload(userId, file);
      s.uploads++;
      s.bytes += out.size;
      return out;
    } catch (err) {
      s.rejected++;
      throw err;
    } finally {
      s.inFlight--;
    }
  }

  async #upload(
    userId: string,
    file: { stream: AsyncIterable<Buffer>; filename: string | undefined; declaredType: string | undefined },
  ): Promise<Attachment> {
    await this.#d.roles.assert(userId, "ATTACH_FILES");
    // 07 §2.4: 10 uploads a minute.
    await enforceRateLimit(this.#d.kv, { key: `upload:${userId}`, max: 10, windowMs: 60_000 });
    const it = file.stream[Symbol.asyncIterator]();
    try {
      return await this.#store(userId, file, it);
    } catch (err) {
      // Keep reading what is left of the body (and drop it), so the client receives the refusal instead of a stalled request.
      for (;;) {
        const r = await it.next().catch(() => ({ done: true }));
        if (r.done) break;
      }
      throw err;
    }
  }

  async #store(
    userId: string,
    file: { filename: string | undefined; declaredType: string | undefined },
    it: AsyncIterator<Buffer>,
  ): Promise<Attachment> {
    const { maxBytes } = this.#d.settings;

    // Peek at the first bytes: they decide the type before anything is stored.
    const first: Buffer[] = [];
    let have = 0;
    while (have < 16) {
      const r = await it.next();
      if (r.done) break;
      first.push(r.value);
      have += r.value.length;
    }
    if (have === 0) throw new AppError("VALIDATION_FAILED", "That file is empty.");
    const sniffed = sniffImage(Buffer.concat(first));
    const contentType = sniffed ?? safeDeclaredType(file.declaredType);
    const stored = !sniffed && contentType.startsWith("image/") ? "application/octet-stream" : contentType;

    // The person's room is known before the first byte is stored, so a body that would not fit stops part way.
    const { usedBytes, quotaBytes } = await this.usage(userId);
    let size = 0;
    const hash = createHash("sha256");
    const count = (c: Buffer): Buffer => {
      size += c.length;
      if (size > maxBytes) throw new AppError("PAYLOAD_TOO_LARGE", "That file is too large.", { maxBytes });
      if (usedBytes + size > quotaBytes)
        throw new AppError("QUOTA_EXCEEDED", "You have used up your upload space. Delete some files first.", {
          usedBytes,
          quotaBytes,
        });
      hash.update(c);
      return c;
    };
    async function* body(): AsyncGenerator<Buffer> {
      for (const c of first) yield count(c);
      for (;;) {
        const r = await it.next();
        if (r.done) return;
        yield count(r.value);
      }
    }

    const now = Date.now();
    const id = newId(now);
    const key = `att/${id}`;
    // A body that fails half way (too large, connection lost) leaves nothing: the storage port removes its temporary file.
    await this.#d.storage.put(key, Readable.from(body()), { contentType: stored });
    const discard = async (err: AppError): Promise<never> => {
      await this.#d.storage.delete(key).catch(() => undefined);
      throw err;
    };

    let dims: { width: number; height: number } | null = null;
    let thumb: Buffer | null = null;
    if (sniffed && size <= THUMBNAIL_MAX_BYTES) {
      // The one place a file is held in memory: an image to decode, bounded and counted against the shared budget.
      let release: () => void;
      try {
        release = this.reserve(size * 2);
      } catch (err) {
        return discard(err as AppError);
      }
      this.#stats.inFlightBytes += size;
      this.#stats.peakInFlightBytes = Math.max(this.#stats.peakInFlightBytes, this.#stats.inFlightBytes);
      try {
        const { stream } = await this.#d.storage.get(key);
        const buffer = Buffer.concat(await stream.toArray());
        dims = await inspectImage(buffer);
        thumb = await thumbnail(buffer, this.#d.settings.thumbnailSize);
      } catch {
        // Claims to be an image but is not decodable: refuse rather than store something odd.
        return discard(new AppError("UNSUPPORTED_MEDIA_TYPE", "That image could not be read."));
      } finally {
        this.#stats.inFlightBytes -= size;
        release();
      }
    }
    if (thumb)
      await this.#d.storage.put(`${key}.thumb`, Readable.from([thumb]), { contentType: "image/webp" });
    const row: Row = {
      id,
      message_id: null,
      channel_id: null,
      uploader_id: userId,
      storage_key: key,
      filename: cleanFilename(file.filename),
      content_type: stored,
      size,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      has_thumb: thumb ? 1 : 0,
      sha256: hash.digest("hex"),
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
