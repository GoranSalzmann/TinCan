// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { caddyfile, type InitValues } from "./templates.js";

const values: InitValues = {
  domain: "chat.example.com",
  acmeEmail: "",
  instanceName: "Tin Can",
  insecureHttp: false,
  httpPort: 8080,
  publicUrl: "https://chat.example.com",
  instanceSecret: "x".repeat(64),
  livekitKey: "APIkey",
  livekitSecret: "secret",
  uid: 1000,
  gid: 1000,
  repoDir: null,
  image: "tincan",
};

describe("caddyfile", () => {
  it("omits the global email block when no address was given (Caddy rejects an empty `email`)", () => {
    expect(caddyfile(values)).not.toContain("email");
  });

  it("includes it when an address was given", () => {
    expect(caddyfile({ ...values, acmeEmail: "ops@example.com" })).toContain("email {$ACME_EMAIL}");
  });
});
