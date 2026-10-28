// SPDX-License-Identifier: AGPL-3.0-or-later
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export async function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const answer = (await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith("y");
}

/** Reads a line without echoing it. */
export async function askSecret(question: string): Promise<string> {
  process.stdout.write(`${question}: `);
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk as Buffer);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  muted = true;
  try {
    return await rl.question("");
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}
