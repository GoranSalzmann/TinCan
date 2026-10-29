// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { resolveDataDir } from "./doctor.js";
import { apiUrlOnHost, decideTurnReload } from "./voice-checks.js";

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

describe("TURN certificate reload (18 T30)", () => {
  const base = { servedFingerprint: "a", currentFingerprint: "b", servedDaysLeft: 40, activeRooms: 0 };

  it("does nothing while LiveKit serves the current certificate", () => {
    expect(decideTurnReload({ ...base, currentFingerprint: "a", activeRooms: 3 })).toBe("none");
  });

  it("restarts at once when no room has people in it", () => {
    expect(decideTurnReload(base)).toBe("restart");
  });

  it("waits while a call runs, until the served certificate is close to expiry", () => {
    expect(decideTurnReload({ ...base, activeRooms: 2 })).toBe("wait");
    expect(decideTurnReload({ ...base, activeRooms: 2, servedDaysLeft: 7 })).toBe("restart");
    expect(decideTurnReload({ ...base, activeRooms: 2, servedDaysLeft: 12, deadlineDays: 14 })).toBe(
      "restart",
    );
  });
});

describe("apiUrlOnHost", () => {
  it("maps the container's host gateway name to loopback for the CLI on the host", () => {
    expect(apiUrlOnHost("http://host.docker.internal:7880")).toBe("http://127.0.0.1:7880");
    expect(apiUrlOnHost("http://10.0.0.5:7880")).toBe("http://10.0.0.5:7880");
  });
});
