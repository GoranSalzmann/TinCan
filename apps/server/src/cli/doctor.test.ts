// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { resolveDataDir } from "./doctor.js";

describe("resolveDataDir", () => {
  const only =
    (...present: string[]) =>
    (p: string) =>
      present.some((x) => p.split("\\").join("/").endsWith(x));

  it("uses a path that exists as it is", () => {
    expect(resolveDataDir("./data", undefined, () => true).note).toBeUndefined();
  });

  it("maps a container path to the data folder next to the config file", () => {
    const r = resolveDataDir("/data", "/trial", only("trial/data"));
    expect(r.dir?.split("\\").join("/")).toBe("/trial/data");
    expect(r.note).toMatch(/container path \/data mapped to/);
  });

  it("skips the check for a container path with no data folder beside the config, instead of failing", () => {
    expect(resolveDataDir("/data", "/trial", () => false).dir).toBeNull();
    expect(resolveDataDir("/data", undefined, () => false).dir).toBeNull();
  });

  it("still fails for a missing relative path", () => {
    expect(resolveDataDir("./nope", "/trial", () => false).dir).not.toBeNull();
  });
});
