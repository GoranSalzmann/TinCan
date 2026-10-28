// SPDX-License-Identifier: AGPL-3.0-or-later
// Fails when a tracked file looks like it contains a credential. A cheap first line of defence in the
// PR pipeline (16 §12); real secrets also belong out of git history, so a hit is a reason to rotate.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe live key", /\b[sr]k_live_[0-9A-Za-z]{20,}\b/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/],
  [
    "secret assignment",
    /\b(?:api[_-]?secret|client[_-]?secret|password|passwd)\b["']?\s*[:=]\s*["'][A-Za-z0-9+/_-]{24,}["']/i,
  ],
];

const SKIP_PATH = /(^|\/)(pnpm-lock\.yaml|LICENSE|\.git\/|node_modules\/|spikes\/|docs\/)/;
const BINARY = /\.(png|jpe?g|gif|ico|woff2?|ttf|wasm|zip|gz)$/i;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => f && !SKIP_PATH.test(f) && !BINARY.test(f));

const hits = [];
for (const file of files) {
  if (/(^|\/)\.env(\.|$)/.test(file) && !/\.example$/.test(file))
    hits.push(`${file}: an .env file must not be committed`);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (re.test(line)) hits.push(`${file}:${i + 1}: looks like a ${name}`);
  });
}

if (hits.length > 0) {
  console.error(`Possible secrets:\n  ${hits.join("\n  ")}`);
  process.exit(1);
}
console.log(`Secret scan OK (${files.length} files)`);
