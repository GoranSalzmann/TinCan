// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "@tincan/auth";
import { sql } from "@tincan/db";
import { OWNER, startTestServer, type TestServer } from "../../testing/harness.js";
import { insertUser } from "./users.js";
import { hashPassword } from "@tincan/auth";

let s: TestServer;
let ownerToken: string;

beforeAll(async () => {
  s = await startTestServer();
});
afterAll(async () => {
  await s.close();
});

describe("before setup", () => {
  it("reports setupRequired and answers every other API with SETUP_REQUIRED", async () => {
    const caps = await s.request("GET", "/api/v1/capabilities");
    expect(caps.status).toBe(200);
    expect(caps.body.auth.setupRequired).toBe(true);
    const me = await s.request("GET", "/api/v1/users/@me");
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe("SETUP_REQUIRED");
    expect(
      (await s.request("POST", "/api/v1/auth/login", { body: { username: "a", password: "b" } })).body.error
        .code,
    ).toBe("SETUP_REQUIRED");
    expect((await s.request("GET", "/healthz")).status).toBe(200);
  });

  it("wrote the setup token to the data directory", () => {
    expect(s.setupToken()).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  });

  it("checks the setup token before anything else", async () => {
    const wrong = await s.request("POST", "/api/v1/auth/setup/verify", {
      body: { token: "AAAA-AAAA-AAAA-AAAA" },
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toMatchObject({ code: "PERMISSION_DENIED", details: { reason: "setup_token" } });
    const right = await s.request("POST", "/api/v1/auth/setup/verify", { body: { token: s.setupToken() } });
    expect(right.status).toBe(204);
    // spaces, dashes and case do not matter when typing it
    const typed = await s.request("POST", "/api/v1/auth/setup/verify", {
      body: { token: s.setupToken().toLowerCase().replace(/-/g, " ") },
    });
    expect(typed.status).toBe(204);
  });

  it("rejects bad usernames and weak passwords with field details", async () => {
    const token = s.setupToken();
    const badName = await s.request("POST", "/api/v1/auth/setup", {
      body: { token, username: "Not Valid!", displayName: "X", password: OWNER.password },
    });
    expect(badName.status).toBe(400);
    expect(badName.body.error.code).toBe("VALIDATION_FAILED");
    const weak = await s.request("POST", "/api/v1/auth/setup", {
      body: { token, username: "mika", displayName: "Mika", password: "short" },
    });
    expect(weak.body.error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { password: "too_short" } },
    });
    const common = await s.request("POST", "/api/v1/auth/setup", {
      body: { token, username: "mika", displayName: "Mika", password: "password123" },
    });
    expect(common.body.error.details.fields.password).toBe("too_common");
  });

  it("rate limits setup token guessing per IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push(
        (await s.request("POST", "/api/v1/auth/setup/verify", { body: { token: `BAD${i}` } })).status,
      );
    }
    expect(codes.at(-1)).toBe(429);
  });
});

describe("setup", () => {
  it("creates the owner, the space and a session, and deletes the token", async () => {
    // the guessing limit above must not lock the real owner out for good: wait for a fresh window
    await s.running.ports.pubsub.kv.del("rl:setup:ip:127.0.0.1");
    const token = s.setupToken();
    const res = await s.request("POST", "/api/v1/auth/setup", {
      body: { token, ...OWNER, instanceName: "Friends of Tin" },
    });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: "mika", displayName: "Mika", isInstanceOwner: true });
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.setCookie).toMatch(/^tincan_session=.+; Path=\/; HttpOnly; SameSite=Strict/);
    ownerToken = res.body.token as string;
    expect(existsSync(join(s.dir, "setup-token"))).toBe(false);

    const caps = await s.request("GET", "/api/v1/capabilities");
    expect(caps.body.auth.setupRequired).toBe(false);
    expect(caps.body.server.name).toBe("Friends of Tin");
    const space = await sql<{ name: string }>`SELECT name FROM space`.execute(s.running.ports.db.query);
    expect(space.rows).toEqual([{ name: "Friends of Tin" }]);
  });

  it("refuses a second setup", async () => {
    const again = await s.request("POST", "/api/v1/auth/setup", {
      body: { token: "AAAA-AAAA-AAAA-AAAA", ...OWNER, username: "other" },
    });
    expect([403, 409]).toContain(again.status);
  });

  it("stores only a hash of the session token", async () => {
    const rows = await sql<{ token_hash: string }>`SELECT token_hash FROM session`.execute(
      s.running.ports.db.query,
    );
    expect(rows.rows.map((r) => r.token_hash)).toContain(hashToken(ownerToken));
    expect(rows.rows.map((r) => r.token_hash)).not.toContain(ownerToken);
  });

  it("stores the password as argon2id", async () => {
    const r = await sql<{ password_hash: string }>`SELECT password_hash FROM user`.execute(
      s.running.ports.db.query,
    );
    expect(r.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
  });
});

describe("race: two simultaneous setups", () => {
  it("lets exactly one owner be created", async () => {
    const racer = await startTestServer();
    try {
      const token = racer.setupToken();
      const attempt = (username: string) =>
        racer.request("POST", "/api/v1/auth/setup", { body: { token, ...OWNER, username } });
      const results = await Promise.all([attempt("one"), attempt("two"), attempt("three")]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const n = await sql<{ n: number }>`SELECT count(*) AS n FROM user WHERE is_instance_owner = 1`.execute(
        racer.running.ports.db.query,
      );
      expect(n.rows[0]?.n).toBe(1);
    } finally {
      await racer.close();
    }
  });
});

describe("login", () => {
  it("logs in and returns the same shape setup does", async () => {
    const res = await s.login("mika", OWNER.password);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { username: "mika" } });
    expect(Object.keys(res.body.user).sort()).toEqual(
      ["avatarKey", "createdAt", "displayName", "id", "isInstanceOwner", "username"].sort(),
    );
    expect(new Date(res.body.expiresAt as string).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it("treats an unknown user and a wrong password identically", async () => {
    const wrong = await s.login("mika", "not the password at all");
    const unknown = await s.login("nobody", "not the password at all");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect({ ...wrong.body.error, requestId: undefined }).toEqual({
      ...unknown.body.error,
      requestId: undefined,
    });
  });

  it("limits attempts per username (5 per 15 minutes) with retryAfterMs", async () => {
    await s.running.ports.pubsub.kv.del("rl:login:user:throttled");
    const codes: number[] = [];
    let last: Awaited<ReturnType<typeof s.login>> | undefined;
    for (let i = 0; i < 6; i++) {
      last = await s.login("throttled", "nope nope nope", { keepLimits: true });
      codes.push(last.status);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    expect(last?.body.error.code).toBe("RATE_LIMITED");
    expect(last?.body.error.details.retryAfterMs).toBeGreaterThan(0);
    expect(last?.headers.get("retry-after")).toBeTruthy();
  });

  it("limits attempts per IP (10 per 15 minutes)", async () => {
    await s.running.ports.pubsub.kv.del("rl:login:ip:127.0.0.1");
    const codes: number[] = [];
    for (let i = 0; i < 11; i++)
      codes.push((await s.login(`ip-user-${i}`, "nope nope nope", { keepLimits: true })).status);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it("refuses a disabled account only after the password was right", async () => {
    const db = s.running.ports.db;
    await db.transaction(async (tx) => {
      await insertUser(tx, {
        username: "dis",
        displayName: "Dis",
        passwordHash: await hashPassword("a long enough password", {
          memoryKiB: 1024,
          timeCost: 1,
          parallelism: 1,
        }),
      });
    });
    await sql`UPDATE user SET disabled_at = ${Date.now()} WHERE username = 'dis'`.execute(db.query);
    expect((await s.login("dis", "wrong password here")).body.error.code).toBe("UNAUTHENTICATED");
    expect((await s.login("dis", "a long enough password")).body.error.code).toBe("ACCOUNT_DISABLED");
  });
});

describe("authenticated requests", () => {
  it("accepts a bearer token and returns only public fields", async () => {
    const res = await s.request("GET", "/api/v1/users/@me", { token: ownerToken });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });

  it("rejects missing, malformed and unknown tokens with UNAUTHENTICATED", async () => {
    for (const token of [undefined, "x", "A".repeat(43)]) {
      const res = await s.request("GET", "/api/v1/users/@me", token ? { token } : {});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
      expect(res.body.error.requestId).toBeTruthy();
    }
  });

  it("requires the CSRF header for cookie-authenticated writes but not for reads or bearer tokens", async () => {
    const cookie = `tincan_session=${ownerToken}`;
    expect((await s.request("GET", "/api/v1/users/@me", { cookie })).status).toBe(200);
    const noHeader = await s.request("POST", "/api/v1/auth/gateway-ticket", { cookie });
    expect(noHeader.status).toBe(403);
    const withHeader = await s.request("POST", "/api/v1/auth/gateway-ticket", {
      cookie,
      headers: { "x-tincan-csrf": "1" },
    });
    expect(withHeader.status).toBe(200);
    expect(withHeader.body.ticket).toBeTruthy();
    expect((await s.request("POST", "/api/v1/auth/gateway-ticket", { token: ownerToken })).status).toBe(200);
  });

  it("refuses an expired session", async () => {
    const login = await s.login("mika", OWNER.password);
    const token = login.body.token as string;
    await sql`UPDATE session SET expires_at = ${Date.now() - 1} WHERE token_hash = ${hashToken(token)}`.execute(
      s.running.ports.db.query,
    );
    expect((await s.request("GET", "/api/v1/users/@me", { token })).status).toBe(401);
  });

  it("logs out: the token stops working and the cookie is cleared", async () => {
    const login = await s.login("mika", OWNER.password);
    const token = login.body.token as string;
    const out = await s.request("POST", "/api/v1/auth/logout", { token });
    expect(out.status).toBe(204);
    expect(out.setCookie).toMatch(/Max-Age=0/);
    expect((await s.request("GET", "/api/v1/users/@me", { token })).status).toBe(401);
  });
});

describe("sessions and password", () => {
  it("lists sessions, marks the current one and revokes another", async () => {
    const a = (await s.login("mika", OWNER.password)).body.token as string;
    const b = (await s.login("mika", OWNER.password)).body.token as string;
    const list = await s.request("GET", "/api/v1/auth/sessions", { token: a });
    expect(list.status).toBe(200);
    const sessions = list.body as { id: string; current: boolean }[];
    expect(sessions.filter((x) => x.current)).toHaveLength(1);
    const other = sessions.find((x) => !x.current)!;
    expect((await s.request("DELETE", `/api/v1/auth/sessions/${other.id}`, { token: a })).status).toBe(204);
    expect((await s.request("DELETE", `/api/v1/auth/sessions/${other.id}`, { token: a })).status).toBe(404);
    // one of the two logins above is now dead
    const alive = await Promise.all([a, b].map((t) => s.request("GET", "/api/v1/users/@me", { token: t })));
    expect(alive.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("changes the password, signs out other devices, and checks the current one", async () => {
    await s.running.ports.pubsub.kv.del("rl:login:user:mika");
    const keep = (await s.login("mika", OWNER.password)).body.token as string;
    const other = (await s.login("mika", OWNER.password)).body.token as string;
    const wrong = await s.request("POST", "/api/v1/auth/password", {
      token: keep,
      body: { currentPassword: "wrong wrong wrong", newPassword: "another long password" },
    });
    expect(wrong.status).toBe(403);
    const weak = await s.request("POST", "/api/v1/auth/password", {
      token: keep,
      body: { currentPassword: OWNER.password, newPassword: "short" },
    });
    expect(weak.body.error.details.fields.password).toBe("too_short");
    const ok = await s.request("POST", "/api/v1/auth/password", {
      token: keep,
      body: { currentPassword: OWNER.password, newPassword: "another long password" },
    });
    expect(ok.status).toBe(204);
    expect((await s.request("GET", "/api/v1/users/@me", { token: keep })).status).toBe(200);
    expect((await s.request("GET", "/api/v1/users/@me", { token: other })).status).toBe(401);
    expect((await s.login("mika", OWNER.password)).status).toBe(401);
    await s.running.ports.pubsub.kv.del("rl:login:user:mika");
    expect((await s.login("mika", "another long password")).status).toBe(200);
  });
});

describe("owner-only endpoints", () => {
  it("lets the owner read the module report and rename the instance, and nobody else", async () => {
    // the password test above signed the setup session out, as it should
    ownerToken = (await s.login("mika", "another long password")).body.token as string;
    const modules = await s.request("GET", "/api/v1/admin/modules", { token: ownerToken });
    expect(modules.status).toBe(200);
    expect(modules.body.modules.map((m: { id: string }) => m.id)).toEqual([
      "core",
      "accounts",
      "roles",
      "channels",
    ]);

    const db = s.running.ports.db;
    await db.transaction(async (tx) => {
      await insertUser(tx, {
        username: "ann",
        displayName: "Ann",
        passwordHash: await hashPassword("ann has a long password", {
          memoryKiB: 1024,
          timeCost: 1,
          parallelism: 1,
        }),
      });
    });
    const ann = (await s.login("ann", "ann has a long password")).body.token as string;
    expect((await s.request("GET", "/api/v1/admin/modules", { token: ann })).body.error.code).toBe(
      "PERMISSION_DENIED",
    );
    expect(
      (await s.request("PATCH", "/api/v1/admin/instance", { token: ann, body: { name: "Mine" } })).status,
    ).toBe(403);

    const renamed = await s.request("PATCH", "/api/v1/admin/instance", {
      token: ownerToken,
      body: { name: "  Tin Cans  " },
    });
    expect(renamed.body.name).toBe("Tin Cans");
    expect((await s.request("GET", "/api/v1/capabilities")).body.server.name).toBe("Tin Cans");
  });
});

describe("http conventions", () => {
  it("answers unknown routes and bad JSON with the error envelope", async () => {
    const nf = await s.request("GET", "/api/v1/nope");
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe("NOT_FOUND");
    const bad = await fetch(`${s.url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("sets security headers and never caches API responses", async () => {
    const res = await s.request("GET", "/api/v1/capabilities");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("honours a client-supplied request id", async () => {
    const res = await s.request("GET", "/api/v1/nope", { headers: { "x-request-id": "req-abcdef123456" } });
    expect(res.body.error.requestId).toBe("req-abcdef123456");
  });
});
