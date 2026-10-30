// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { parseDocument, isMap, isScalar } from "yaml";
import { openSqlite, snapshotInWorker, sql } from "@tincan/db";
import { AppError } from "@tincan/shared";
import type { CoreConfig } from "../config/schema.js";
import { VERSION } from "../version.js";
import { extractTar, packTar, type TarFile } from "./tar.js";

/**
 * `tincan backup` and `tincan restore` (14 §6, 06 §7, 18 T28). The archive is a plain `.tar.gz`:
 *
 *   db/app.db        a consistent copy taken with VACUUM INTO on its own connection (the server keeps writing)
 *   files/…          the uploaded files, same layout as the storage directory
 *   config/…         config.yaml (secrets blanked unless asked), docker-compose.yml, Caddyfile; with secrets also
 *                    livekit.yaml and .env
 *   manifest.json    last: versions, schema versions, and the SHA-256 of every other entry
 */

export const ARCHIVE_FORMAT = 1;
const SECRET_KEY = /secret|password|token|passphrase|api[_-]?key/i;
const CONFIG_FILES = ["config.yaml", "docker-compose.yml", "Caddyfile"] as const;
const SECRET_FILES = ["livekit.yaml", ".env"] as const;

export interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface Manifest {
  format: number;
  createdAt: string;
  tincanVersion: string;
  /** True when `.env`, `livekit.yaml` and the real secrets in `config.yaml` are inside; protect the archive then. */
  secretsIncluded: boolean;
  /** Highest applied migration per module at the time of the snapshot. */
  schema: Record<string, number>;
  entries: ManifestEntry[];
  /** Files that disappeared between the database snapshot and the copy (deleted uploads); the database may still list them. */
  vanished: string[];
}

export interface BackupOptions {
  /** Where the archive goes. Default `<dataDir>/backups`. */
  outDir?: string;
  includeSecrets?: boolean;
  /** Directory holding config.yaml, .env, docker-compose.yml, Caddyfile and livekit.yaml. */
  configDir?: string;
  /** Keep only this many `tincan-backup-*.tar.gz` in `outDir` afterwards (oldest removed). */
  keep?: number;
  log?: (line: string) => void;
  now?: () => Date;
}

/** config.yaml with every secret-looking value blanked, comments kept. */
export function redactConfig(yamlText: string): string {
  const doc = parseDocument(yamlText);
  const walk = (node: unknown): void => {
    if (!isMap(node)) return;
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : "";
      if (isMap(pair.value)) walk(pair.value);
      else if (SECRET_KEY.test(key) && isScalar(pair.value) && pair.value.value)
        pair.value.value = "REDACTED";
    }
  };
  walk(doc.contents);
  return doc.toString();
}

async function* walk(root: string, base = root): AsyncGenerator<{ abs: string; rel: string; size: number }> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const abs = join(root, name);
    const st = await stat(abs).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) yield* walk(abs, base);
    else if (st.isFile()) yield { abs, rel: relative(base, abs).split(sep).join("/"), size: st.size };
  }
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");

export async function createBackup(
  config: CoreConfig,
  opts: BackupOptions = {},
): Promise<{ path: string; manifest: Manifest }> {
  const log = opts.log ?? (() => undefined);
  const dbPath = resolve(config.adapters.database.path);
  const filesRoot = resolve(config.adapters.storage.path);
  const outDir = resolve(opts.outDir ?? join(config.dataDir, "backups"));
  if (!existsSync(dbPath)) throw new AppError("NOT_FOUND", `There is no database at ${dbPath}.`);
  await mkdir(outDir, { recursive: true });
  const when = (opts.now ?? (() => new Date()))();
  const name = `tincan-backup-${stamp(when)}.tar.gz`;
  const finalPath = join(outDir, name);
  const part = `${finalPath}.part`;
  const snapshot = join(outDir, `.snapshot-${process.pid}.db`);
  const staged = join(outDir, `.config-${process.pid}.yaml`);

  try {
    log("Copying the database (VACUUM INTO, the server may keep running) …");
    await snapshotInWorker(dbPath, snapshot);
    const schema = await readSchema(snapshot);

    const entries: ManifestEntry[] = [];
    const vanished: string[] = [];
    const record = (path: string, size: number) => (sha256: string) => entries.push({ path, size, sha256 });

    async function* items(): AsyncGenerator<TarFile | { path: string; bytes: Buffer; mode?: number }> {
      const dbStat = await stat(snapshot);
      yield {
        path: "db/app.db",
        size: dbStat.size,
        mode: 0o600,
        mtimeSec: Math.floor(when.getTime() / 1000),
        source: snapshot,
        onDone: record("db/app.db", dbStat.size),
      };

      let count = 0;
      for await (const f of walk(filesRoot)) {
        const st = await stat(f.abs).catch(() => null);
        if (!st) {
          vanished.push(f.rel);
          continue;
        }
        const path = `files/${f.rel}`;
        count++;
        yield {
          path,
          size: st.size,
          mode: 0o600,
          mtimeSec: Math.floor(st.mtimeMs / 1000),
          source: f.abs,
          onDone: record(path, st.size),
        };
      }
      log(`Added ${count} uploaded file(s).`);

      if (opts.configDir) {
        const dir = resolve(opts.configDir);
        for (const file of [...CONFIG_FILES, ...(opts.includeSecrets ? SECRET_FILES : [])]) {
          const abs = join(dir, file);
          if (!existsSync(abs)) continue;
          let source = abs;
          if (file === "config.yaml" && !opts.includeSecrets) {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(staged, redactConfig(await readFile(abs, "utf8")), { mode: 0o600 });
            source = staged;
          }
          const st = await stat(source);
          const path = `config/${file}`;
          yield {
            path,
            size: st.size,
            mode: 0o600,
            mtimeSec: Math.floor(st.mtimeMs / 1000),
            source,
            onDone: record(path, st.size),
          };
        }
      } else {
        log("No config directory given: the archive holds the data only.");
      }

      const manifest: Manifest = {
        format: ARCHIVE_FORMAT,
        createdAt: when.toISOString(),
        tincanVersion: VERSION,
        secretsIncluded: opts.includeSecrets === true,
        schema,
        entries: [...entries].sort((a, b) => a.path.localeCompare(b.path)),
        vanished,
      };
      manifestOut = manifest;
      yield { path: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") };
    }
    let manifestOut: Manifest | undefined;

    await pipeline(
      Readable.from(packTar(items())),
      createGzip({ level: 6 }),
      createWriteStream(part, { mode: 0o600 }),
    );
    await rename(part, finalPath);
    await chmod(finalPath, 0o600).catch(() => undefined);
    if (!manifestOut) throw new Error("backup: no manifest was produced");
    if (opts.keep !== undefined) await prune(outDir, opts.keep, log);
    log(`Wrote ${finalPath}`);
    return { path: finalPath, manifest: manifestOut };
  } finally {
    await rm(snapshot, { force: true });
    await rm(staged, { force: true });
    await rm(part, { force: true });
  }
}

/** Removes all but the newest `keep` backups in `dir`. Names sort by time. */
export async function prune(
  dir: string,
  keep: number,
  log: (line: string) => void = () => undefined,
): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => /^tincan-backup-.*\.tar\.gz$/.test(n)).sort();
  const old = names.slice(0, Math.max(0, names.length - Math.max(1, keep)));
  for (const n of old) {
    await rm(join(dir, n), { force: true });
    log(`Removed old backup ${n}`);
  }
  return old;
}

async function readSchema(dbFile: string): Promise<Record<string, number>> {
  const db = openSqlite({ path: dbFile });
  try {
    const rows = await sql<{
      module: string;
      v: number;
    }>`SELECT module, max(version) AS v FROM _migrations GROUP BY module`.execute(db.query);
    return Object.fromEntries(rows.rows.map((r) => [r.module, r.v]));
  } finally {
    await db.close();
  }
}

export interface RestoreResult {
  into: string;
  manifest: Manifest;
  files: number;
  warnings: string[];
}

/**
 * Unpacks into an empty directory laid out like a `tincan init` directory (data/app.db, data/files/…, then the
 * config files beside it), checks every checksum and the database, and only then moves anything into place.
 */
export async function restoreBackup(
  archive: string,
  into: string,
  opts: { log?: (line: string) => void } = {},
): Promise<RestoreResult> {
  const log = opts.log ?? (() => undefined);
  const target = resolve(into);
  if (!existsSync(archive)) throw new AppError("NOT_FOUND", `There is no archive at ${archive}.`);
  if (existsSync(target) && (await readdir(target)).length > 0) {
    throw new AppError("CONFLICT", `${target} is not empty. Restore into a new, empty directory.`);
  }
  await mkdir(target, { recursive: true });
  const staging = join(target, ".restore-staging");
  await mkdir(staging, { recursive: true });
  const seen = new Map<string, ManifestEntry>();
  try {
    log("Reading the archive …");
    await extractTar(createReadStream(archive).pipe(createGunzip()), async (h) => {
      if (h.type === "dir") return null;
      const dest = join(staging, ...h.path.split("/"));
      if (!resolve(dest).startsWith(staging + sep)) throw new Error(`unsafe path ${h.path}`);
      await mkdir(dirname(dest), { recursive: true });
      const hash = createHash("sha256");
      let size = 0;
      const out = createWriteStream(dest, { mode: 0o600 });
      const origWrite = out.write.bind(out);
      out.write = ((chunk: Buffer, ...rest: unknown[]) => {
        hash.update(chunk);
        size += chunk.length;
        return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof out.write;
      out.once("finish", () => seen.set(h.path, { path: h.path, size, sha256: hash.digest("hex") }));
      return out;
    });

    let manifest: Manifest;
    try {
      manifest = JSON.parse(await readFile(join(staging, "manifest.json"), "utf8")) as Manifest;
    } catch {
      throw new AppError(
        "VALIDATION_FAILED",
        "This archive has no readable manifest.json; it is not a Tin Can backup or it is damaged.",
      );
    }
    if (manifest.format !== ARCHIVE_FORMAT)
      throw new AppError(
        "VALIDATION_FAILED",
        `This archive has format ${manifest.format}; this version reads format ${ARCHIVE_FORMAT}.`,
      );

    for (const e of manifest.entries) {
      const got = seen.get(e.path);
      if (!got) throw new AppError("VALIDATION_FAILED", `The archive is missing ${e.path}.`);
      if (got.sha256 !== e.sha256 || got.size !== e.size)
        throw new AppError(
          "VALIDATION_FAILED",
          `${e.path} does not match its checksum; the archive is damaged.`,
        );
    }
    for (const p of seen.keys())
      if (p !== "manifest.json" && !manifest.entries.some((e) => e.path === p))
        throw new AppError("VALIDATION_FAILED", `The archive holds ${p}, which the manifest does not list.`);
    log(`All ${manifest.entries.length} checksums match.`);

    const dbFile = join(staging, "db", "app.db");
    if (!existsSync(dbFile)) throw new AppError("VALIDATION_FAILED", "The archive has no database.");
    const db = openSqlite({ path: dbFile });
    try {
      const check = await sql<{ integrity_check: string }>`PRAGMA integrity_check`.execute(db.query);
      if (check.rows.length !== 1 || check.rows[0]!.integrity_check !== "ok")
        throw new AppError(
          "VALIDATION_FAILED",
          "The database in the archive fails SQLite's integrity check.",
        );
    } finally {
      await db.close();
    }
    log("The database passes SQLite's integrity check.");

    // Move into place: data/app.db, data/files/…, config files beside the data directory.
    await mkdir(join(target, "data", "files"), { recursive: true });
    await rename(dbFile, join(target, "data", "app.db"));
    let files = 0;
    for (const e of manifest.entries) {
      if (e.path.startsWith("files/")) {
        const dest = join(target, "data", ...e.path.split("/"));
        await mkdir(dirname(dest), { recursive: true });
        await rename(join(staging, ...e.path.split("/")), dest);
        files++;
      } else if (e.path.startsWith("config/")) {
        await rename(join(staging, ...e.path.split("/")), join(target, e.path.slice("config/".length)));
      }
    }
    const warnings: string[] = [];
    if (!manifest.secretsIncluded)
      warnings.push(
        "The archive holds no secrets. Put the original .env (instance secret, LiveKit keys) next to config.yaml before starting, or voice keys and logins from before the backup will not match.",
      );
    if (manifest.vanished.length > 0)
      warnings.push(
        `${manifest.vanished.length} uploaded file(s) were deleted while the backup ran; their messages may show a missing file.`,
      );
    if (!existsSync(join(target, "config.yaml")))
      warnings.push(
        "The archive holds no config files; run `tincan init` beside the restored data or supply your own config.yaml.",
      );
    return { into: target, manifest, files, warnings };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
