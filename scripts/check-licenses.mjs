// SPDX-License-Identifier: AGPL-3.0-or-later
// F2 (18 §F): every dependency licence must be compatible with distributing Tin Can under AGPL-3.0-or-later.
// Permissive licences and weak copyleft that can be combined with AGPL-3.0 pass; anything else fails the build
// until someone reviews it and adds it here with a reason.
import { execSync } from "node:child_process";

const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
  "MPL-2.0", // file-level copyleft; allows combination under the AGPL via its secondary-licence clause
  "CC-BY-4.0", // data and documentation only
  "LGPL-3.0-or-later", // reviewed: dynamic linking only
]);

/** Packages whose metadata has no usable SPDX field but whose licence was read and accepted. */
const REVIEWED = new Map([
  // ["package-name", "reason"],
]);

const out = execSync("pnpm licenses list --json", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const byLicense = JSON.parse(out);

/** `A OR B` passes if either side does; `A AND B` needs both. Parentheses are flattened, which is enough for SPDX in npm metadata. */
function accepted(expr) {
  const flat = expr.replace(/[()]/g, " ").trim();
  return flat.split(/\s+OR\s+/i).some((alt) => alt.split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim())));
}

const bad = [];
let count = 0;
for (const [license, pkgs] of Object.entries(byLicense)) {
  for (const pkg of pkgs) {
    count++;
    if (!accepted(license) && !REVIEWED.has(pkg.name))
      bad.push(`${pkg.name}@${pkg.versions.join(",")}: ${license}`);
  }
}

if (bad.length > 0) {
  console.error(
    `Licences that are not on the allow-list (scripts/check-licenses.mjs):\n  ${bad.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(`Licences OK (${count} packages, ${Object.keys(byLicense).join(", ")})`);
