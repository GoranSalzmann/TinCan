// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStorageContract } from "./contract.js";
import { LocalStorage } from "./index.js";

runStorageContract("local", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tincan-storage-"));
  return {
    storage: new LocalStorage(join(dir, "files")),
    cleanup: async () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
});
