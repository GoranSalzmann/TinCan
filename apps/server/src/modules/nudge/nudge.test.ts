// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "@tincan/db";
import { Op } from "@tincan/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer, type TestUser } from "../../testing/harness.js";

const argon2 = { memoryKiB: 1024, timeCost: 1, parallelism: 1 };

let s: TestServer;
let ann: TestUser;
let bo: TestUser;
let cy: TestUser;

const api = (token: string) => ({
  get: (path: string) => s.request("GET", `/api/v1${path}`, { token }),
  post: (path: string, body?: unknown) => s.request("POST", `/api/v1${path}`, { token, body }),
});
const nudge = (token: string, userId: string) => api(token).post(`/members/${userId}/nudge`);

/** A server where `s.register` still works while nudge settings differ. */
async function boot(nudge: Record<string, unknown>): Promise<void> {
  s = await startTestServer({
    config: { modules: { accounts: { signup: "open", argon2 }, nudge } },
  });
  await s.setupOwner();
  ann = await s.register("ann");
  bo = await s.register("bo");
  cy = await s.register("cy");
}

async function socketFor(user: TestUser) {
  const sock = s.connect();
  await sock.next();
  sock.send({
    op: Op.IDENTIFY,
    d: { token: user.token, client: { name: "t", version: "1", platform: "node" } },
  });
  await sock.next((f) => f.t === "READY");
  return sock;
}

beforeEach(async () => {
  s = await startTestServer();
  await s.setupOwner();
  ann = await s.register("ann");
  bo = await s.register("bo");
  cy = await s.register("cy");
});
afterEach(async () => {
  await s.close();
});

describe("nudge", () => {
  it("advertises the feature and reaches a member over their live socket", async () => {
    const caps = await api(ann.token).get("/capabilities");
    expect(caps.body.features.nudge).toBe(true);
    const sock = await socketFor(bo);
    const res = await nudge(ann.token, bo.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ online: true });
    const frame = await sock.next((f) => f.t === "NUDGE_RECEIVED");
    expect(frame.d).toEqual({ senderId: ann.id, senderName: "ann" });
    sock.close();
  });

  it("says so when the target has no live socket", async () => {
    const res = await nudge(ann.token, bo.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ online: false });
  });

  it("refuses a nudge at yourself, a stranger, a disabled account and nobody logged in", async () => {
    expect((await nudge(ann.token, ann.id)).status).toBe(400);
    expect((await nudge(ann.token, "nobody")).status).toBe(404);
    expect((await s.request("POST", `/api/v1/members/${bo.id}/nudge`)).status).toBe(401);
    await sql`UPDATE user SET disabled_at = ${Date.now()} WHERE id = ${cy.id}`.execute(
      s.running.ports.db.query,
    );
    expect((await nudge(ann.token, cy.id)).status).toBe(404);
  });

  it("rate-limits a repeat nudge at one member and too many nudges in a window", async () => {
    await s.close();
    await boot({ cooldownSecs: 1, burst: { max: 2, windowSecs: 60 } });

    expect((await nudge(ann.token, bo.id)).status).toBe(200);
    const limited = await nudge(ann.token, bo.id);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(limited.body.error.details.retryAfterMs).toBeGreaterThan(0);

    // The pair cooldown is per pair; the burst cap is per sender (max 2 here).
    expect((await nudge(ann.token, cy.id)).status).toBe(200);
    expect((await nudge(ann.token, cy.id)).status).toBe(429);

    // After the cooldown the same pair works again once the burst counter is cleared.
    await new Promise((r) => setTimeout(r, 1100));
    await s.running.ports.pubsub.kv.del(`rl:nudge:burst:${ann.id}`);
    expect((await nudge(ann.token, bo.id)).status).toBe(200);
  });

  it("is gone entirely when the module is disabled", async () => {
    await s.close();
    await boot({ enabled: false });
    expect((await nudge(ann.token, bo.id)).status).toBe(404);
    const caps = await api(ann.token).get("/capabilities");
    expect(caps.body.features.nudge).toBeUndefined();
  });
});
