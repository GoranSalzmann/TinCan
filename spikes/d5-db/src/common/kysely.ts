// Kysely's SqliteDriver issues a deferred `begin`. A write transaction that
// reads first can then fail with SQLITE_BUSY when another process (the admin
// CLI) wrote in between; BEGIN IMMEDIATE takes the write lock up front.
import { SqliteDialect, SqliteDriver, CompiledQuery, type DatabaseConnection, type SqliteDialectConfig } from "kysely";

class ImmediateSqliteDriver extends SqliteDriver {
  override async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin immediate"));
  }
}

export class ImmediateSqliteDialect extends SqliteDialect {
  readonly #cfg: SqliteDialectConfig;
  constructor(cfg: SqliteDialectConfig) { super(cfg); this.#cfg = cfg; }
  override createDriver() { return new ImmediateSqliteDriver(this.#cfg); }
}
