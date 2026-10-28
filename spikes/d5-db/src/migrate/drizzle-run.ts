// Applies a drizzle-kit migrations folder with the better-sqlite3 migrator.
// Usage: tsx src/migrate/drizzle-run.ts <db> <migrationsFolder> <migrationsTable>
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const [path, folder, table] = process.argv.slice(2);
const sqlite = new Database(path!);
migrate(drizzle({ client: sqlite }), { migrationsFolder: folder!, migrationsTable: table });
const names = (sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'message_fts_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
console.log(`  tables: ${names.join(", ")}`);
console.log(`  ${table}: ${(sqlite.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c} rows`);
