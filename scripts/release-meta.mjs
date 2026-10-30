// SPDX-License-Identifier: AGPL-3.0-or-later
// Facts the release workflow needs from a version tag: is it a beta, which image tags to push, which part of
// CHANGELOG.md is the release body. Kept in a script so it can be tested and run by hand:
//   node scripts/release-meta.mjs v0.2.0-beta.1            prints the facts
//   node scripts/release-meta.mjs v0.2.0-beta.1 --notes out.md   also writes the changelog section
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;

export function parseVersion(input) {
  const m = SEMVER.exec(input.trim());
  if (!m) {
    throw new Error(
      `"${input}" is not a version tag. Use v1.2.3 for a release or v1.2.3-beta.1 for a beta (no build metadata).`,
    );
  }
  const [, major, minor, patch, pre] = m;
  const version = `${major}.${minor}.${patch}${pre ? `-${pre}` : ""}`;
  return { version, prerelease: Boolean(pre), minorLine: `${major}.${minor}` };
}

/** Beta tags never move `latest` or the minor line; only a plain x.y.z does. */
export function imageTags(input) {
  const v = parseVersion(input);
  return v.prerelease ? [v.version] : [v.version, v.minorLine, "latest"];
}

/** The body under `## [version]` up to the next `## `, or null. `Unreleased` is accepted by name. */
export function changelogSection(changelog, name) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const head = (l) => /^## /.test(l);
  const start = lines.findIndex((l) => head(l) && l.replace(/^##\s+/, "").startsWith(`[${name}]`));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && head(l));
  if (end < 0) end = lines.length;
  // Link reference definitions at the very end of the file belong to no release.
  const body = lines.slice(start + 1, end).filter((l) => !/^\[[^\]]+\]:\s/.test(l));
  const text = body.join("\n").trim();
  return text === "" ? null : text;
}

function main(argv) {
  const [input, flag, out] = argv;
  if (!input) throw new Error("Usage: node scripts/release-meta.mjs <tag> [--notes <file>]");
  const v = parseVersion(input);
  const tags = imageTags(input);
  for (const file of ["../package.json", "../apps/server/package.json"]) {
    const pkg = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
    if (pkg.version !== v.version) {
      throw new Error(
        `The tag says ${v.version} but ${file.slice(3)} says ${pkg.version}. Bump the version in both package.json files in the release commit.`,
      );
    }
  }
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const notes = changelogSection(changelog, v.version);
  if (flag === "--notes") {
    if (!notes)
      throw new Error(`CHANGELOG.md has no filled section "## [${v.version}]". Move Unreleased into it.`);
    writeFileSync(out, `${notes}\n`);
  }
  const facts = {
    version: v.version,
    prerelease: String(v.prerelease),
    tags: tags.join(","),
    has_notes: String(Boolean(notes)),
  };
  for (const [k, val] of Object.entries(facts)) console.log(`${k}=${val}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(facts)
        .map(([k, val]) => `${k}=${val}\n`)
        .join(""),
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
