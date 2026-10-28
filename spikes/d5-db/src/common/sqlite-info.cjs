// Prints the bundled SQLite version, FTS5 availability and the better-sqlite3 API surface.
const D = require("better-sqlite3");
const d = new D(":memory:");
console.log("sqlite", d.prepare("select sqlite_version() v").get().v,
  "| fts5", d.prepare("select sqlite_compileoption_used('ENABLE_FTS5') f").get().f);
console.log("Database methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(d)).join(" "));
