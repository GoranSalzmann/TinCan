// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  TURN_CADDY_SITE,
  caddyfile,
  composeFile,
  imageRef,
  livekitFile,
  turnLivekitBlock,
  turnSnippets,
  LIVEKIT_IMAGE,
  type InitValues,
} from "./templates.js";

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
  metricsToken: "m".repeat(48),
  grafanaPassword: "g".repeat(24),
  turnDomain: null,
  hostGatewayIp: "172.17.0.1",
  uid: 1000,
  gid: 1000,
  repoDir: null,
  image: "tincan",
  imageTag: null,
};

describe("caddyfile", () => {
  it("omits the global email block when no address was given (Caddy rejects an empty `email`)", () => {
    expect(caddyfile(values)).not.toContain("email");
  });

  it("serves hashed build files as immutable and the service worker and manifest uncached", () => {
    const text = caddyfile(values);
    expect(text).toContain('header /assets/* Cache-Control "public, max-age=31536000, immutable"');
    expect(text).toContain("@pwa path /sw.js /manifest.webmanifest");
    expect(text).toContain('header @pwa Cache-Control "no-cache"');
  });

  it("includes it when an address was given", () => {
    expect(caddyfile({ ...values, acmeEmail: "ops@example.com" })).toContain("email {$ACME_EMAIL}");
  });
});

describe("voice files", () => {
  it("pins the LiveKit image and binds its HTTP port to loopback and the host gateway only", () => {
    const compose = composeFile(values);
    expect(compose).toContain(`image: ${LIVEKIT_IMAGE}`);
    expect(LIVEKIT_IMAGE).toMatch(/:v\d+\.\d+\.\d+$/);
    const lk = livekitFile(values);
    expect(lk).toMatch(/bind_addresses:\n {2}- 127\.0\.0\.1\n {2}- 172\.17\.0\.1/);
    expect(lk).toContain("udp_port: 7882");
    expect(lk).toContain("/api/v1/internal/livekit/webhook");
    expect(lk).toContain("enabled: false");
  });

  it("blocks the internal webhook path at the proxy and proxies only the signalling path", () => {
    const caddy = caddyfile(values);
    expect(caddy).toContain("@internal path /api/internal/* /api/v1/internal/*");
    expect(caddy).toContain("handle /livekit/rtc*");
  });

  it("keeps the metrics endpoint off the internet and the dashboards on loopback", () => {
    expect(caddyfile(values)).toContain("/api/v1/metrics");
    const compose = composeFile(values);
    expect(compose).toContain("profiles: [dashboards]");
    expect(compose).toContain('"127.0.0.1:9090:9090"');
    expect(compose).toContain('"127.0.0.1:3001:3000"');
    expect(compose).toContain("GF_ANALYTICS_REPORTING_ENABLED");
  });

  it("turns TURN/TLS on with a certificate name that Caddy obtains", () => {
    const v = { ...values, turnDomain: "turn.example.com" };
    expect(livekitFile(v)).toMatch(
      /turn:\n {2}enabled: true\n {2}domain: turn\.example\.com\n {2}tls_port: 5349/,
    );
    expect(livekitFile(v)).toContain("turn.example.com/turn.example.com.crt");
    expect(caddyfile(v)).toContain("{$TURN_DOMAIN} {");
    expect(composeFile(v)).toContain("caddy-data:/caddy:ro");
  });
});

describe("turnSnippets", () => {
  const text = turnSnippets("turn.example.com");
  it("gives the same blocks that init writes, in the order the certificate needs", () => {
    expect(text).toContain(turnLivekitBlock("turn.example.com"));
    expect(text).toContain(TURN_CADDY_SITE);
    expect(text).toContain("TURN_DOMAIN=turn.example.com");
    expect(text.indexOf("Caddyfile")).toBeLessThan(text.indexOf("livekit.yaml"));
  });
  it("names the two ports to open", () => {
    expect(text).toContain("5349/tcp and 3478/udp");
  });
  it("is what the disabled livekit.yaml points to", () => {
    expect(livekitFile(values)).toContain("tincan voice turn-snippets --turn-domain turn.chat.example.com");
  });
});

describe("composeFile backup profile", () => {
  it("has an optional daily backup service with the host's uid and a read-only root", () => {
    const text = composeFile(values);
    expect(text).toContain("profiles: [backup]");
    expect(text).toContain(
      'command: ["node", "dist/cli.js", "backup", "--daemon", "--at", "03:30", "--keep", "14"]',
    );
    expect(text).toMatch(/\n {2}backup:\n[\s\S]*?read_only: true/);
  });
});

describe("released images", () => {
  const released = { ...values, image: "ghcr.io/goransalzmann/tincan", imageTag: "0.2.0-beta.1" };

  it("names the tagged server and web images and has no build section", () => {
    const text = composeFile(released);
    expect(text).toContain("image: ghcr.io/goransalzmann/tincan-server:0.2.0-beta.1");
    expect(text).toContain("image: ghcr.io/goransalzmann/tincan-web:0.2.0-beta.1");
    expect(text).not.toContain("build:");
    expect(imageRef(released, "web")).toBe("ghcr.io/goransalzmann/tincan-web:0.2.0-beta.1");
  });

  it("uses the same tagged server image for the backup service", () => {
    const text = composeFile(released);
    expect(text.match(/tincan-server:0\.2\.0-beta\.1/g)).toHaveLength(2);
  });

  it("leaves locally built images untagged", () => {
    expect(imageRef(values, "server")).toBe("tincan-server");
  });
});
