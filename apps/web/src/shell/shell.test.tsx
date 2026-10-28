// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Capabilities } from "@tincan/shared";
import { stopGateway, useSession } from "../core/session/store.js";
import { AppRoutes } from "./AuthGate.js";

/** A tiny in-memory server for the endpoints the shell uses. */
function fakeServer(opts: { setupRequired: boolean; loggedIn?: boolean }) {
  const state = {
    setupRequired: opts.setupRequired,
    loggedIn: opts.loggedIn ?? false,
    name: "Tin Can",
    calls: [] as string[],
    token: "AAAA-BBBB-CCCC-DDDD",
    rateLimitLogin: false,
  };
  const caps = (): Capabilities => ({
    server: { name: state.name, version: "0.1.0", apiVersion: 1, sourceUrl: "https://example.test/src" },
    features: {},
    limits: {},
    auth: { methods: ["local"], signup: "invite-only", setupRequired: state.setupRequired },
  });
  const user = {
    id: "U1",
    username: "mika",
    displayName: "Mika",
    avatarKey: null,
    isInstanceOwner: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const json = (status: number, body: unknown) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const err = (status: number, code: string, details?: unknown) =>
    json(status, { error: { code, message: code, details } });

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, string>) : {};
      state.calls.push(`${method} ${url}`);
      if (url.endsWith("/capabilities")) return Promise.resolve(json(200, caps()));
      if (url.endsWith("/users/@me"))
        return Promise.resolve(state.loggedIn ? json(200, user) : err(401, "UNAUTHENTICATED"));
      if (url.endsWith("/auth/setup/verify")) {
        return Promise.resolve(
          body.token === state.token
            ? json(204, null)
            : err(403, "PERMISSION_DENIED", { reason: "setup_token" }),
        );
      }
      if (url.endsWith("/auth/setup")) {
        if (body.password === "password123")
          return Promise.resolve(err(400, "VALIDATION_FAILED", { fields: { password: "too_common" } }));
        state.setupRequired = false;
        state.loggedIn = true;
        return Promise.resolve(json(200, { token: "t", expiresAt: "2027-01-01T00:00:00.000Z", user }));
      }
      if (url.endsWith("/admin/instance")) {
        state.name = body.name ?? state.name;
        return Promise.resolve(json(200, { name: state.name, ownerId: "U1" }));
      }
      if (url.endsWith("/auth/login")) {
        if (state.rateLimitLogin) return Promise.resolve(err(429, "RATE_LIMITED", { retryAfterMs: 3000 }));
        if (body.password !== "right password here") return Promise.resolve(err(401, "UNAUTHENTICATED"));
        state.loggedIn = true;
        return Promise.resolve(json(200, { token: "t", expiresAt: "2027-01-01T00:00:00.000Z", user }));
      }
      if (url.endsWith("/auth/logout")) {
        state.loggedIn = false;
        return Promise.resolve(json(204, null));
      }
      if (url.endsWith("/auth/gateway-ticket"))
        return Promise.resolve(json(200, { ticket: "tk", expiresInMs: 30000 }));
      return Promise.resolve(err(404, "NOT_FOUND"));
    }),
  );
  return state;
}

/** The gateway is covered by its own tests; here sockets just never connect. */
class IdleSocket {
  readyState = 0;
  onopen: unknown = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  send() {}
  close() {}
}

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", IdleSocket);
  stopGateway();
  useSession.setState({
    boot: "loading",
    capabilities: null,
    user: null,
    gateway: "closed",
    wizardActive: false,
  });
});
afterEach(() => {
  stopGateway();
  vi.unstubAllGlobals();
});

describe("auth gate", () => {
  it("sends every URL to /setup while the server has no owner", async () => {
    fakeServer({ setupRequired: true });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Set up Tin Can" })).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 4: Setup token")).toBeInTheDocument();
  });

  it("sends a visitor who is not logged in to /login, and /setup back to /", async () => {
    fakeServer({ setupRequired: false });
    renderApp("/setup");
    expect(await screen.findByRole("heading", { name: "Log in to Tin Can" })).toBeInTheDocument();
  });

  it("shows the empty layout to a logged-in user", async () => {
    fakeServer({ setupRequired: false, loggedIn: true });
    renderApp("/login");
    expect(await screen.findByRole("heading", { name: "Welcome to Tin Can" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Channels" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Members" })).toBeInTheDocument();
    expect(screen.getByText("No channels yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to main content" })).toBeInTheDocument();
  });

  it("explains an unreachable server and retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("offline"))),
    );
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Can't reach the server" })).toBeInTheDocument();
    const server = fakeServer({ setupRequired: false });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: /Log in to/ })).toBeInTheDocument();
    expect(server.calls).toContain("GET /api/v1/capabilities");
  });

  it("shows an upgrade screen when the server's API version is not the one this app speaks", async () => {
    fakeServer({ setupRequired: false });
    const original = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith("/capabilities")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                server: { name: "x", version: "9", apiVersion: 2, sourceUrl: "" },
                features: {},
                limits: {},
                auth: { methods: ["local"], signup: "closed", setupRequired: false },
              }),
            ),
          );
        }
        return original(url, init);
      }),
    );
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "This app needs an update" })).toBeInTheDocument();
  });
});

describe("login", () => {
  it("logs in and lands on the layout", async () => {
    fakeServer({ setupRequired: false });
    renderApp("/");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "mika");
    await user.type(screen.getByLabelText("Password"), "right password here");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("heading", { name: "Welcome to Tin Can" })).toBeInTheDocument();
  });

  it("shows one generic message for a wrong password", async () => {
    fakeServer({ setupRequired: false });
    renderApp("/");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "mika");
    await user.type(screen.getByLabelText("Password"), "wrong wrong wrong");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Username or password is incorrect.");
  });

  it("counts down when rate limited and disables the button meanwhile", async () => {
    const s = fakeServer({ setupRequired: false });
    s.rateLimitLogin = true;
    renderApp("/");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "mika");
    await user.type(screen.getByLabelText("Password"), "whatever it is");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByText(/Too many attempts. Try again in \d seconds?\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log in" })).toBeDisabled();
  });

  it("logs out from the account menu", async () => {
    fakeServer({ setupRequired: false, loggedIn: true });
    renderApp("/");
    await screen.findByRole("heading", { name: "Welcome to Tin Can" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: /Log in to/ })).toBeInTheDocument();
  });
});

describe("first-run setup (W-30)", () => {
  it("walks token → account → community → checks → app", async () => {
    const server = fakeServer({ setupRequired: true });
    renderApp("/setup");
    const user = userEvent.setup();

    // step 1: a wrong token tells you nothing else
    await user.type(await screen.findByLabelText("Setup token"), "NOPE");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That token doesn't match.");
    await user.clear(screen.getByLabelText("Setup token"));
    await user.type(screen.getByLabelText("Setup token"), server.token);
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // step 2: validation happens before anything is sent
    await screen.findByText("Step 2 of 4: Your account");
    await user.type(screen.getByLabelText("Display name"), "Mika");
    await user.type(screen.getByLabelText("Username"), "Not Valid!");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(
      await screen.findByText("Use 2 to 32 characters: a-z, 0-9, dot, dash, underscore."),
    ).toBeInTheDocument();
    expect(screen.getByText("Use at least 10 characters.")).toBeInTheDocument();
    expect(server.calls.some((c) => c.endsWith("/auth/setup"))).toBe(false);

    await user.clear(screen.getByLabelText("Username"));
    await user.type(screen.getByLabelText("Username"), "mika");
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    expect(screen.getByText(/Strong/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create account" }));

    // step 3: the wizard stays up even though the server no longer says setup is required
    await screen.findByText("Step 3 of 4: Your community");
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Friends of Tin");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // step 4
    await screen.findByText("Step 4 of 4: Server checks");
    expect(screen.getByText(/Secure connection \(HTTPS\)/)).toBeInTheDocument();
    expect(screen.getByText("Not set up yet. Voice arrives in a later version.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finish" }));

    expect(await screen.findByRole("heading", { name: "Welcome to Friends of Tin" })).toBeInTheDocument();
    expect(server.name).toBe("Friends of Tin");
  });
});
