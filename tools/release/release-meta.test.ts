// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { changelogSection, imageTags, parseVersion } from "../../scripts/release-meta.mjs";

describe("release tags", () => {
  it("treats x.y.z as a release and moves latest and the minor line", () => {
    expect(imageTags("v1.2.3")).toEqual(["1.2.3", "1.2", "latest"]);
    expect(parseVersion("1.2.3").prerelease).toBe(false);
  });

  it("never moves latest for a beta or release candidate", () => {
    expect(imageTags("v0.2.0-beta.1")).toEqual(["0.2.0-beta.1"]);
    expect(imageTags("v1.0.0-rc.2")).toEqual(["1.0.0-rc.2"]);
  });

  it("rejects things that are not versions", () => {
    for (const bad of ["main", "v1.2", "v1.2.3.4", "v1.2.3+build", "v1.2.3-", "release-1"])
      expect(() => parseVersion(bad)).toThrow(/not a version tag/);
  });
});

const changelog = `# Changelog

## [Unreleased]

### Added
- New thing

## [0.2.0-beta.1] - 2026-11-01

### Fixed
- Old bug

## [0.1.0] - 2026-10-01

Nothing yet.

[Unreleased]: https://example.invalid/compare
`;

describe("changelogSection", () => {
  it("returns the text under the version heading only", () => {
    expect(changelogSection(changelog, "0.2.0-beta.1")).toBe("### Fixed\n- Old bug");
    expect(changelogSection(changelog, "Unreleased")).toBe("### Added\n- New thing");
  });

  it("drops trailing link definitions and reports a missing section as null", () => {
    expect(changelogSection(changelog, "0.1.0")).toBe("Nothing yet.");
    expect(changelogSection(changelog, "9.9.9")).toBeNull();
  });
});
