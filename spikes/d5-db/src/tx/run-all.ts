// Runs the concurrency scenarios against every transaction implementation.
// Question (D5): can the async transaction(fn) of the Db port run on one
// better-sqlite3 connection without concurrent requests landing inside an
// open transaction?
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { IMPLS, type Impl } from "./impls.js";
import { sleep } from "../common/sqlite.js";

const dir = mkdtempSync(join(tmpdir(), "d5tx-"));
let n = 0;
const fresh = (make: (p: string) => Impl<any>) => make(join(dir, `t${n++}.db`));

const unhandled: string[] = [];
process.on("unhandledRejection", (e) => unhandled.push(String((e as Error)?.message ?? e)));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "TIMEOUT"> {
  return Promise.race([p, sleep(ms).then(() => "TIMEOUT" as const)]);
}
const boom = () => { throw new Error("boom"); };

type Result = { ok: boolean; detail: string };

const scenarios: Record<string, (impl: Impl<any>) => Promise<Result>> = {
  // A request's write issued while another request's transaction is awaiting.
  async interleave(impl) {
    const t = impl.transaction(async (tx) => { await impl.insertLog(tx, "T-begin"); await sleep(20); await impl.insertLog(tx, "T-end"); });
    await sleep(5);
    const p = impl.insertLog(impl.root, "R");
    const s = await Promise.allSettled([t, p]);
    const tags = await impl.tags(impl.root);
    const errs = s.filter((x) => x.status === "rejected").map((x) => String((x as PromiseRejectedResult).reason?.message));
    return { ok: JSON.stringify(tags) === '["T-begin","T-end","R"]', detail: `${JSON.stringify(tags)}${errs.length ? " errors: " + errs.join("; ") : ""}` };
  },
  // The transaction fails; the unrelated request's write must survive.
  async rollbackIsolation(impl) {
    const t = impl.transaction(async (tx) => { await impl.insertLog(tx, "T-a"); await sleep(20); boom(); });
    await sleep(5);
    const p = impl.insertLog(impl.root, "R");
    const s = await Promise.allSettled([t, p]);
    const tags = await impl.tags(impl.root);
    const pErr = s[1].status === "rejected" ? " (R rejected: " + String((s[1] as PromiseRejectedResult).reason?.message) + ")" : "";
    return { ok: JSON.stringify(tags) === '["R"]', detail: JSON.stringify(tags) + pErr };
  },
  // A read issued during an open transaction must not see its uncommitted rows.
  async dirtyRead(impl) {
    const t = impl.transaction(async (tx) => { await impl.insertLog(tx, "T-x"); await sleep(20); boom(); });
    await sleep(5);
    const seen = await impl.countTag(impl.root, "T-x");
    await Promise.allSettled([t]);
    const after = await impl.countTag(impl.root, "T-x");
    return { ok: seen === 0 && after === 0, detail: `seen during tx=${seen}, after rollback=${after}` };
  },
  // 300 concurrent requests: transactions of 1-4 writes with awaits in between,
  // 25% of them failing, mixed with plain writes. Groups must be contiguous and
  // atomic; plain writes must all survive.
  async stress(impl) {
    const plan: { kind: "plain" | "tx"; id: number; k: number; fail: boolean }[] = [];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 300; i++) plan.push(i % 3 === 0 ? { kind: "plain", id: i, k: 1, fail: false } : { kind: "tx", id: i, k: 1 + Math.floor(rnd() * 4), fail: rnd() < 0.25 });
    const ops = plan.map(async (p) => {
      await sleep(Math.floor(rnd() * 10));
      if (p.kind === "plain") return impl.insertLog(impl.root, `P${p.id}`);
      return impl.transaction(async (tx) => {
        for (let j = 0; j < p.k; j++) { await impl.insertLog(tx, `G${p.id}:${j}`); await sleep(Math.floor(rnd() * 3)); }
        if (p.fail) boom();
      });
    });
    const settled = await Promise.allSettled(ops);
    const unexpected = settled.filter((s) => s.status === "rejected" && (s.reason as Error)?.message !== "boom").map((s) => String((s as PromiseRejectedResult).reason?.message));
    const tags = await impl.tags(impl.root);
    let violations = 0;
    for (const p of plan) {
      if (p.kind === "plain") { if (!tags.includes(`P${p.id}`)) violations++; continue; }
      const idx = tags.map((t, i) => (t.startsWith(`G${p.id}:`) ? i : -1)).filter((i) => i >= 0);
      if (p.fail) { if (idx.length) violations++; continue; }
      if (idx.length !== p.k) { violations++; continue; }
      if (idx[idx.length - 1]! - idx[0]! !== p.k - 1) violations++; // not contiguous: something interleaved
    }
    const uniq = [...new Set(unexpected)].slice(0, 2).join(" | ");
    return { ok: violations === 0 && unexpected.length === 0, detail: `violations=${violations}, unexpected errors=${unexpected.length}${uniq ? " (" + uniq + ")" : ""}` };
  },
  // Developer mistake: using the outer handle inside a transaction callback.
  async outerHandleInsideTx(impl) {
    const t = impl.transaction(async (tx) => { await impl.insertLog(tx, "A"); await impl.insertLog(impl.root, "B"); boom(); });
    const r = await withTimeout(Promise.allSettled([t]), 1000);
    if (r === "TIMEOUT") return { ok: false, detail: "DEADLOCK: transaction never finishes; every later query on this Db would hang" };
    await sleep(50);
    const tags = await impl.tags(impl.root);
    const err = r[0].status === "rejected" ? String((r[0] as PromiseRejectedResult).reason?.message) : "";
    if (tags.includes("A")) return { ok: false, detail: `not atomic: rows survived the rollback ${JSON.stringify(tags)}` };
    if (tags.includes("B")) return { ok: false, detail: `B escaped the transaction and survived the rollback: ${JSON.stringify(tags)}` };
    return { ok: true, detail: err !== "boom" ? `rejected with: ${err}; nothing written` : `B ran inside the transaction and was rolled back: ${JSON.stringify(tags)}` };
  },
  // Cost of serialising: plain reads queued behind a transaction that awaits 50 ms of non-DB work.
  async headOfLineBlocking(impl) {
    const t = impl.transaction(async (tx) => { await impl.insertLog(tx, "T"); await sleep(50); });
    await sleep(1);
    const lat: number[] = [];
    await Promise.all(Array.from({ length: 50 }, async () => { const t0 = performance.now(); await impl.countTag(impl.root, "x"); lat.push(performance.now() - t0); }));
    await t;
    lat.sort((a, b) => a - b);
    return { ok: true, detail: `50 concurrent reads during a tx awaiting 50 ms: min ${lat[0]!.toFixed(1)} ms, max ${lat[lat.length - 1]!.toFixed(1)} ms` };
  },
};

console.log(`node ${process.version}\n`);
for (const [implName, make] of Object.entries(IMPLS)) {
  console.log(`## ${fresh(make).name}`);
  for (const [sName, run] of Object.entries(scenarios)) {
    const impl = fresh(make);
    unhandled.length = 0;
    let res: Result;
    try {
      const r = await withTimeout(run(impl), 5000);
      res = r === "TIMEOUT" ? { ok: false, detail: "scenario timed out (hang)" } : r;
    } catch (e) {
      res = { ok: false, detail: "threw: " + (e as Error).message };
    }
    await sleep(60);
    const extra = unhandled.length ? ` | unhandled rejections: ${[...new Set(unhandled)].join("; ")}` : "";
    console.log(`  ${res.ok ? "PASS" : "FAIL"}  ${sName.padEnd(20)} ${res.detail}${extra}`);
    try { impl.close(); } catch { /* deadlocked impls may refuse */ }
  }
  console.log(`  (${implName})\n`);
}
process.exit(0);
