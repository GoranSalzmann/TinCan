// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ConfigError } from "./errors.js";
import { applyEnv, parseCoreConfig, withDotEnv } from "./load.js";

const SECRET = "x".repeat(40);
const minimal = { security: { instanceSecret: SECRET } };

describe("core config", () => {
  it("fills defaults from a minimal file", () => {
    const c = parseCoreConfig(minimal);
    expect(c.adapters.database).toEqual({ kind: "sqlite", path: "./data/app.db" });
    expect(c.adapters.pubsub).toEqual({ kind: "memory" });
    expect(c.server.port).toBe(3000);
    expect(c.server.trustProxy).toBe(false);
    expect(c.modules).toEqual({});
  });

  it("refuses unknown keys and says where", () => {
    expect(() =>
      parseCoreConfig({ ...minimal, adapters: { database: { kind: "sqlite", path: "x", pth: 1 } } }),
    ).toThrow(/unknown setting "adapters\.database\.pth"/);
    expect(() => parseCoreConfig({ ...minimal, typo: 1 })).toThrow(/unknown setting "typo"/);
  });

  it("refuses engines v1 does not ship", () => {
    expect(() =>
      parseCoreConfig({ ...minimal, adapters: { database: { kind: "postgres", path: "x" } } }),
    ).toThrow(ConfigError);
  });

  it("requires a long enough instance secret", () => {
    expect(() => parseCoreConfig({ security: { instanceSecret: "short" } })).toThrow(/instanceSecret/);
    expect(() => parseCoreConfig({})).toThrow(/TINCAN_SECURITY__INSTANCE_SECRET/);
  });
});

describe("environment overrides", () => {
  it("maps TINCAN_A__B_C to a.bC and coerces values", () => {
    const out = applyEnv(minimal, {
      TINCAN_SERVER__PORT: "8080",
      TINCAN_SERVER__TRUST_PROXY: "true",
      TINCAN_INSTANCE__PUBLIC_URL: "https://chat.example.com",
      TINCAN_SERVER__ALLOWED_ORIGINS: '["http://localhost:5173"]',
      OTHER: "ignored",
    });
    expect(out).toMatchObject({
      server: { port: 8080, trustProxy: true, allowedOrigins: ["http://localhost:5173"] },
      instance: { publicUrl: "https://chat.example.com" },
    });
  });

  it("writes module ids in kebab-case (04 §9)", () => {
    const out = applyEnv(
      {},
      { TINCAN_MODULES__TEXT_CHAT__ENABLED: "false", TINCAN_MODULES__ACCOUNTS__SESSION_IDLE_DAYS: "7" },
    );
    expect(out).toEqual({ modules: { "text-chat": { enabled: false }, accounts: { sessionIdleDays: 7 } } });
  });

  it("ignores TINCAN_CONFIG, which names the file rather than a setting", () => {
    expect(applyEnv({}, { TINCAN_CONFIG: "/config/config.yaml" })).toEqual({});
  });

  it("overrides the file and does not touch the input", () => {
    const base = { server: { port: 1 } };
    expect(applyEnv(base, { TINCAN_SERVER__PORT: "2" })).toEqual({ server: { port: 2 } });
    expect(base).toEqual({ server: { port: 1 } });
  });

  it("reads *_FILE secrets and strips the trailing newline", () => {
    const out = applyEnv(
      {},
      { TINCAN_SECURITY__INSTANCE_SECRET_FILE: "/run/secrets/s" },
      (() => `${SECRET}\n`) as never,
    );
    expect(out).toEqual({ security: { instanceSecret: SECRET } });
  });

  it("explains an unreadable secret file", () => {
    expect(() =>
      applyEnv({}, { TINCAN_SECURITY__INSTANCE_SECRET_FILE: "/nope" }, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/cannot be read/);
  });
});

describe("missing instance secret", () => {
  it("names the variable and says where `tincan init` put it", () => {
    for (const raw of [{}, { instance: { name: "x" } }]) {
      let message = "";
      try {
        parseCoreConfig(raw);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("TINCAN_SECURITY__INSTANCE_SECRET");
      expect(message).toContain(".env");
      expect(message).not.toMatch(/expected object, received undefined/);
    }
  });

  it("still reports a too-short secret as such", () => {
    expect(() => parseCoreConfig({ security: { instanceSecret: "short" } })).toThrow(/instanceSecret/);
  });
});

describe("withDotEnv", () => {
  const read = () =>
    `# comment\nTINCAN_SECURITY__INSTANCE_SECRET="${SECRET}"\nTINCAN_SERVER__PORT=9000\nTINCAN_CONFIG=/x\nHOST_UID=1000\n`;

  it("fills TINCAN_ variables that are unset, strips quotes, and ignores the rest", () => {
    const env = withDotEnv("/cfg", {}, read);
    expect(env).toEqual({ TINCAN_SECURITY__INSTANCE_SECRET: SECRET, TINCAN_SERVER__PORT: "9000" });
  });

  it("never overrides a real environment variable, and tolerates a missing file", () => {
    expect(withDotEnv("/cfg", { TINCAN_SERVER__PORT: "1" }, read).TINCAN_SERVER__PORT).toBe("1");
    expect(withDotEnv("/cfg", { A: "b" }, () => null)).toEqual({ A: "b" });
  });
});
