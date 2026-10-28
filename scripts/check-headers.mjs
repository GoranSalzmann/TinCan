// SPDX-License-Identifier: AGPL-3.0-or-later
// Every source file carries the SPDX tag (F3: AGPL-3.0-or-later).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TAG = "SPDX-License-Identifier: AGPL-3.0-or-later";
const EXT = /\.(ts|tsx|js|mjs|cjs|css)$/;
const SKIP = /(^|\/)(spikes|docs|node_modules|dist|\.claude)\//;
const SKIP_FILES = /\.generated\./;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => f && EXT.test(f) && !SKIP.test(f) && !SKIP_FILES.test(f));

const missing = files.filter((f) => {
  try {
    return !readFileSync(f, "utf8").split("\n").slice(0, 3).join("\n").includes(TAG);
  } catch {
    return false; // deleted but not yet staged
  }
});

if (missing.length > 0) {
  console.error(`Missing "${TAG}" in the first lines of:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log(`SPDX headers OK (${files.length} files)`);
