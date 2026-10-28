// Child process for crash-test.ts. Usage: child.ts <mode> <dbPath> <seed>
// It SIGKILLs itself (or is killed by the parent) at the point under test.
import { createDb } from "./db.js";
import { createMessage, editMessage, deleteMessage } from "./textchat.js";
import { drainAll, drainOnce } from "./outbox.js";
import { searchHandlers } from "./search.js";
import { rng } from "../fixture/text.js";

const [mode, path, seedArg] = process.argv.slice(2);
const db = createDb(path!);
const rand = rng(Number(seedArg ?? 1));
const ch = ["chanA", "chanB", "chanC"];
const die = () => process.kill(process.pid, "SIGKILL");
let tok = Number(seedArg ?? 1) * 1_000_000;
const content = (kind: string) => `${kind} tok${tok++}x some words about the game tonight`;

async function writes(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await createMessage(db, { channelId: ch[i % 3]!, authorId: "u1", content: content("msg") }));
  return ids;
}

if (mode === "commit-then-crash") {
  // committed messages + outbox rows; the process dies before any drain runs
  const ids = await writes(500);
  for (const id of ids.slice(0, 50)) await editMessage(db, id, content("edited"));
  for (const id of ids.slice(50, 100)) await deleteMessage(db, id);
  die();
} else if (mode === "handler-then-crash") {
  // non-atomic consumer: the handler's effect commits, the ack never happens
  await writes(200);
  await drainAll(db, searchHandlers, { atomicAck: false, afterHandler: (i) => { if (i === 100) die(); } });
} else if (mode === "load") {
  // writer and drain running concurrently until the parent kills us
  const live: string[] = (db.sqlite.prepare("SELECT id FROM message WHERE deleted_at IS NULL").all() as { id: string }[]).map((r) => r.id);
  const writer = (async () => {
    for (;;) {
      const r = rand();
      if (r < 0.6 || live.length < 10) live.push(await createMessage(db, { channelId: ch[Math.floor(rand() * 3)]!, authorId: "u2", content: content("load") }));
      else if (r < 0.85) await editMessage(db, live[Math.floor(rand() * live.length)]!, content("reedit"));
      else await deleteMessage(db, live.splice(Math.floor(rand() * live.length), 1)[0]!);
    }
  })();
  const drainer = (async () => { for (;;) { await drainOnce(db, searchHandlers, { batch: 20 }); await new Promise((r) => setTimeout(r, 2)); } })();
  await Promise.all([writer, drainer]);
}
