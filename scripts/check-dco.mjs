// SPDX-License-Identifier: AGPL-3.0-or-later
// DCO (18 F3): every commit in the range carries `Signed-off-by: Name <email>` (git commit -s).
// Usage: node scripts/check-dco.mjs [<base>]   (default: origin/main, or main when there is no remote)
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const base =
  process.argv[2] ??
  process.env.DCO_BASE ??
  (git("branch", "--list", "-r", "origin/main") ? "origin/main" : "main");

const shas = git("rev-list", "--no-merges", `${base}..HEAD`).split("\n").filter(Boolean);
const missing = shas.filter(
  (sha) => !/^Signed-off-by: .+ <.+@.+>$/m.test(git("show", "-s", "--format=%B", sha)),
);

if (missing.length > 0) {
  console.error(
    `Commits without a Signed-off-by line (use \`git commit -s\`, or \`git rebase --signoff ${base}\`):\n  ` +
      missing.map((sha) => `${sha.slice(0, 10)} ${git("show", "-s", "--format=%s", sha)}`).join("\n  "),
  );
  process.exit(1);
}
console.log(`DCO OK (${shas.length} commits since ${base})`);
