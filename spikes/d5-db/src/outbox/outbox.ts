// Core outbox (06 §3.14): append inside the use case's transaction, drain in ID order.
import { monotonicFactory } from "ulidx";
import type { Db, Tx } from "./db.js";

const ulid = monotonicFactory();

export function appendOutbox(tx: Tx, topic: string, payload: unknown, requestId?: string) {
  return tx.insertInto("outbox").values({ id: ulid(), topic, payload: JSON.stringify(payload), request_id: requestId ?? null, created_at: Date.now() }).execute();
}

export type Handler = (tx: Tx, payload: any) => Promise<void>;

export interface DrainOpts {
  batch?: number;
  // false = handler commits in its own transaction and the ack is a separate
  // transaction (models a consumer outside the DB); exercises idempotency.
  atomicAck?: boolean;
  // test hook: called after a handler commits, before the row is acked
  afterHandler?: (rowIndex: number) => void;
}

// Delivers up to `batch` rows. Returns the number delivered.
export async function drainOnce(db: Db, handlers: Record<string, Handler>, opts: DrainOpts = {}): Promise<number> {
  const rows = await db.query.selectFrom("outbox").selectAll().orderBy("id").limit(opts.batch ?? 200).execute();
  let i = 0;
  for (const row of rows) {
    const h = handlers[row.topic];
    if (!h) continue; // topic of a disabled module stays queued
    const payload = JSON.parse(row.payload);
    if (opts.atomicAck === false) {
      await db.transaction((tx) => h(tx, payload));
      opts.afterHandler?.(i);
      await db.query.deleteFrom("outbox").where("id", "=", row.id).execute();
    } else {
      await db.transaction(async (tx) => {
        await h(tx, payload);
        await tx.deleteFrom("outbox").where("id", "=", row.id).execute();
      });
      opts.afterHandler?.(i);
    }
    i++;
  }
  return i;
}

export async function drainAll(db: Db, handlers: Record<string, Handler>, opts: DrainOpts = {}): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await drainOnce(db, handlers, opts);
    total += n;
    if (n === 0) return total;
    await new Promise((r) => setImmediate(r));
  }
}
