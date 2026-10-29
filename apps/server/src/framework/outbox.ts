// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from "@tincan/db";
import { newId } from "@tincan/shared";
import type { Logger } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a module passes its own narrowed handle; the outbox only touches its own table
type AnyDb = Db<any>;

interface OutboxTable {
  outbox: { id: string; topic: string; payload: string; request_id: string; created_at: number };
}

export type OutboxHandler<T = unknown> = (payload: T, tx: AnyDb) => Promise<void>;

/** What a module sees of the core outbox (06 §3.14, 05 §3.1). */
export interface OutboxRegistrar {
  /** Appends a row inside the caller's transaction; skipped when no module consumes the topic. */
  append(tx: AnyDb, topic: string, payload: unknown, requestId?: string): Promise<void>;
  /** Handlers must be idempotent: a row is redelivered after a crash between handling and deletion. */
  subscribe<T = unknown>(topic: string, handler: OutboxHandler<T>): void;
  isConsumed(topic: string): boolean;
}

const BATCH = 200;
const MAX_ATTEMPTS = 5;

/**
 * Transactional outbox (18 T29). A use case writes a row in its own transaction; `drain` delivers
 * rows in id order and deletes each in the same transaction as the handler's writes, so a crash
 * either redelivers (idempotent handlers) or finds the work done.
 */
export class Outbox implements OutboxRegistrar {
  readonly #db: Db<OutboxTable>;
  readonly #log: Logger;
  readonly #handlers = new Map<string, OutboxHandler>();
  readonly #attempts = new Map<string, number>();
  #draining: Promise<number> | null = null;
  #again = false;
  #closed = false;

  constructor(db: Db, log: Logger) {
    this.#db = db.as<OutboxTable>();
    this.#log = log;
  }

  subscribe<T>(topic: string, handler: OutboxHandler<T>): void {
    if (this.#handlers.has(topic)) throw new Error(`outbox topic '${topic}' already has a consumer`);
    this.#handlers.set(topic, handler as OutboxHandler);
  }

  isConsumed(topic: string): boolean {
    return this.#handlers.has(topic);
  }

  async append(tx: AnyDb, topic: string, payload: unknown, requestId = ""): Promise<void> {
    if (!this.#handlers.has(topic)) return;
    const now = Date.now();
    await (tx as Db<OutboxTable>).query
      .insertInto("outbox")
      .values({
        id: newId(now),
        topic,
        payload: JSON.stringify(payload),
        request_id: requestId,
        created_at: now,
      })
      .execute();
    // Deliver soon after the commit rather than waiting for the next poll.
    setImmediate(() => void this.drain().catch(() => undefined));
  }

  close(): void {
    this.#closed = true;
  }

  /** Delivers everything pending. Concurrent calls share one run and ask for another pass. */
  drain(): Promise<number> {
    if (this.#draining) {
      this.#again = true;
      return this.#draining;
    }
    this.#draining = (async () => {
      let total = 0;
      try {
        do {
          this.#again = false;
          total += await this.#pass();
        } while (this.#again && !this.#closed);
      } finally {
        this.#draining = null;
      }
      return total;
    })();
    return this.#draining;
  }

  async backlog(): Promise<number> {
    const r = await this.#db.query
      .selectFrom("outbox")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  async #pass(): Promise<number> {
    let delivered = 0;
    for (;;) {
      if (this.#closed) return delivered;
      const rows = await this.#db.query.selectFrom("outbox").selectAll().orderBy("id").limit(BATCH).execute();
      if (rows.length === 0) return delivered;
      let stalled = false;
      for (const row of rows) {
        const handler = this.#handlers.get(row.topic);
        try {
          await this.#db.transaction(async (tx) => {
            if (handler) await handler(JSON.parse(row.payload) as unknown, tx as AnyDb);
            await tx.query.deleteFrom("outbox").where("id", "=", row.id).execute();
          });
          this.#attempts.delete(row.id);
          delivered++;
        } catch (err) {
          const n = (this.#attempts.get(row.id) ?? 0) + 1;
          this.#attempts.set(row.id, n);
          this.#log.error(
            { err, topic: row.topic, requestId: row.request_id, attempt: n },
            "outbox handler failed",
          );
          if (n >= MAX_ATTEMPTS) {
            // A poison row must not block everything behind it; `search reindex` repairs the gap.
            this.#attempts.delete(row.id);
            await this.#db.query.deleteFrom("outbox").where("id", "=", row.id).execute();
            this.#log.error({ topic: row.topic, id: row.id }, "outbox row dropped after repeated failures");
          } else {
            stalled = true;
            break;
          }
        }
      }
      if (stalled) return delivered;
      // A 200-row batch held the loop for 170 ms in D5 (05 §3.1): yield between batches.
      await new Promise<void>((r) => setImmediate(r));
    }
  }
}
