// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { buildValues } from "./init.js";
import { parseVersion, prerequisiteFindings, type Probe } from "./prereqs.js";
import { VERSION } from "../version.js";

const base = { domain: "chat.example.com", repoDir: "/repo" };

describe("buildValues images", () => {
  it("builds from the checkout by default and leaves the images untagged", () => {
    const v = buildValues(base, "/srv/tincan");
    expect(v.imageTag).toBeNull();
    expect(v.repoDir).not.toBeNull();
    expect(v.image).toBe("tincan");
  });

  it("uses released images with the given version, even inside a checkout", () => {
    const v = buildValues({ ...base, image: "ghcr.io/goransalzmann/tincan", version: "0.2.0-beta.1" }, "/x");
    expect(v.image).toBe("ghcr.io/goransalzmann/tincan");
    expect(v.imageTag).toBe("0.2.0-beta.1");
    expect(v.repoDir).toBeNull();
  });

  it("strips a leading v and defaults the version to this program's", () => {
    expect(buildValues({ ...base, image: "ghcr.io/o/tincan", version: "v1.2.3" }, "/x").imageTag).toBe(
      "1.2.3",
    );
    expect(buildValues({ ...base, image: "ghcr.io/o/tincan" }, "/x").imageTag).toBe(VERSION);
  });

  it("refuses a version without an image, a tag in the image name, and a bad version", () => {
    expect(() => buildValues({ ...base, version: "1.0.0" }, "/x")).toThrow(/--version goes with --image/);
    expect(() => buildValues({ ...base, image: "ghcr.io/o/tincan:1.0" }, "/x")).toThrow(/not an image name/);
    expect(() => buildValues({ ...base, image: "GHCR.io/O/Tincan" }, "/x")).toThrow(/not an image name/);
    expect(() => buildValues({ ...base, image: "ghcr.io/o/tincan", version: "1.0 beta" }, "/x")).toThrow(
      /not a valid version tag/,
    );
  });
});

const probeOf =
  (answers: Record<string, string | null>): Probe =>
  (cmd, args) => {
    const out = answers[`${cmd} ${args.join(" ")}`];
    return out === undefined || out === null ? null : { out, err: "" };
  };

const ENGINE = "docker version --format {{.Server.Version}}";
const COMPOSE = "docker compose version --short";
const CLI = "docker --version";

describe("prerequisiteFindings", () => {
  it("says nothing when Docker and Compose v2 are there", () => {
    const probe = probeOf({ [CLI]: "Docker version 29.9.2", [ENGINE]: "29.9.2", [COMPOSE]: "v5.6.1" });
    expect(prerequisiteFindings(probe, false)).toEqual([]);
  });

  it("explains a machine without Docker, and stays quiet inside a container", () => {
    expect(prerequisiteFindings(probeOf({}), false)[0]).toMatch(/Docker was not found/);
    expect(prerequisiteFindings(probeOf({}), true)).toEqual([]);
  });

  it("explains a daemon that does not answer", () => {
    const f = prerequisiteFindings(probeOf({ [CLI]: "Docker version 29", [COMPOSE]: "2.30.0" }), false);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/did not answer.*docker. group/);
  });

  it("flags a missing or v1 Compose and an old Engine", () => {
    const noCompose = probeOf({ [CLI]: "Docker version 27", [ENGINE]: "27.0.1" });
    expect(prerequisiteFindings(noCompose, false)[0]).toMatch(/Compose v2.*not found/s);
    const oldCompose = probeOf({ [CLI]: "x", [ENGINE]: "27.0.1", [COMPOSE]: "1.29.2" });
    expect(prerequisiteFindings(oldCompose, false)[0]).toMatch(/too old/);
    const oldEngine = probeOf({ [CLI]: "x", [ENGINE]: "19.03.5", [COMPOSE]: "2.2.0" });
    expect(prerequisiteFindings(oldEngine, false)[0]).toMatch(/older than 20\.10/);
  });

  it("reads versions with and without a leading v", () => {
    expect(parseVersion("v2.29.1")).toEqual([2, 29, 1]);
    expect(parseVersion("29.9")).toEqual([29, 9, 0]);
    expect(parseVersion("nonsense")).toBeNull();
  });
});
