// SPDX-License-Identifier: AGPL-3.0-or-later
import { PERM, permissionsToString } from "@tincan/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../testing/harness.js";
import { permsExplain, resetPassword, searchReindex } from "./ops.js";

let s: TestServer;
let owner: string;

beforeEach(async () => {
  s = await startTestServer();
  owner = await s.setupOwner();
});
afterEach(async () => {
  await s.close();
});

describe("admin commands on a stopped server", () => {
  it("explains a member's permissions step by step", async () => {
    await s.register("ann");
    const channels = (await s.request("GET", "/api/v1/channels", { token: owner })).body.channels as {
      id: string;
      name: string;
    }[];
    const general = channels.find((c) => c.name === "general")!;
    const everyone = (
      (await s.request("GET", "/api/v1/roles", { token: owner })).body as { id: string; isDefault: boolean }[]
    ).find((r) => r.isDefault)!;
    await s.request("PUT", `/api/v1/channels/${general.id}/overwrites/role/${everyone.id}`, {
      token: owner,
      body: { allow: "0", deny: permissionsToString(PERM.SEND_MESSAGES) },
    });
    await s.running.close();
    const out = await permsExplain(s.config, { user: "ann", channel: "general" });
    expect(out).toContain("ann in #general (text)");
    expect(out).toContain("@everyone overwrite");
    expect(out).toMatch(/- SEND_MESSAGES/);
    expect(out).toMatch(/Denied:.*SEND_MESSAGES/);
    await expect(permsExplain(s.config, { user: "nobody", channel: "general" })).rejects.toThrow(/No user/);
    await expect(permsExplain(s.config, { user: "ann", channel: "nope" })).rejects.toThrow(/No channel/);
  });

  it("issues a reset code for a user or the owner, which works at the login screen", async () => {
    await s.register("ann");
    await s.running.close();
    const out = await resetPassword(s.config, { owner: true });
    const code = /code: ([A-Z0-9-]+)/.exec(out)![1]!;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await expect(resetPassword(s.config, { username: "nobody", owner: false })).rejects.toThrow(/No user/);

    const second = await startTestServer({
      config: {
        dataDir: s.dir,
        adapters: {
          database: { kind: "sqlite", path: `${s.dir}/app.db` },
          storage: { kind: "local", path: `${s.dir}/files` },
        },
      },
    });
    try {
      const redeemed = await second.request("POST", "/api/v1/auth/reset", {
        body: { code, newPassword: "a brand new passphrase" },
      });
      expect(redeemed.status).toBe(204);
      expect((await second.login("mika", "a brand new passphrase")).status).toBe(200);
    } finally {
      await second.running.close();
    }
  });

  it("reindexes the search index and waits for it", async () => {
    const ann = await s.register("ann");
    const ch = (await s.request("GET", "/api/v1/channels", { token: owner })).body.channels[0].id as string;
    await s.request("POST", `/api/v1/channels/${ch}/messages`, {
      token: ann.token,
      body: { content: "findable words" },
    });
    await s.running.outbox.drain();
    await s.running.close();
    const lines: string[] = [];
    const result = await searchReindex(s.config, (l) => lines.push(l));
    expect(result).toMatch(/Reindexed 1 messages/);
    expect(lines.join("\n")).toMatch(/Queued 1 messages/);
  });

  it("says so when the module is off", async () => {
    await s.running.close();
    const off = { ...s.config, modules: { ...s.config.modules, search: { enabled: false } } };
    await expect(searchReindex(off)).rejects.toThrow(/not enabled/);
  });
});
