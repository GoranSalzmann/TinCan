// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  API_PREFIX,
  CSRF_HEADER,
  type Capabilities,
  type ErrorCode,
  type LoginResponse,
  type SessionInfo,
  type User,
} from "@tincan/shared";

/** An error answer in the envelope of 07 §2.2, or `NETWORK` when no answer arrived at all. */
export class ApiError extends Error {
  readonly code: ErrorCode | "NETWORK";
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;

  constructor(
    code: ErrorCode | "NETWORK",
    message: string,
    status: number,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }

  /** Milliseconds to wait, for RATE_LIMITED. */
  get retryAfterMs(): number | undefined {
    const v = this.details?.retryAfterMs;
    return typeof v === "number" ? v : undefined;
  }
}

interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method,
      // The session is an HttpOnly cookie. The custom header is what makes a cross-site request unable to use it (11 §1.2).
      credentials: "same-origin",
      headers: {
        [CSRF_HEADER]: "1",
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch {
    throw new ApiError("NETWORK", "Couldn't reach the server.", 0);
  }
  if (res.status === 204) return undefined as T;
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // not JSON: handled below
  }
  if (!res.ok) {
    const e = (
      payload as {
        error?: { code?: ErrorCode; message?: string; details?: Record<string, unknown>; requestId?: string };
      } | null
    )?.error;
    throw new ApiError(
      e?.code ?? "INTERNAL",
      e?.message ?? res.statusText,
      res.status,
      e?.details,
      e?.requestId,
    );
  }
  return payload as T;
}

export const api = {
  capabilities: (signal?: AbortSignal) =>
    request<Capabilities>("GET", "/capabilities", signal ? { signal } : {}),
  me: () => request<User>("GET", "/users/@me"),
  login: (username: string, password: string) =>
    request<LoginResponse>("POST", "/auth/login", { body: { username, password } }),
  logout: () => request<void>("POST", "/auth/logout"),
  verifySetupToken: (token: string) => request<void>("POST", "/auth/setup/verify", { body: { token } }),
  setup: (body: {
    token: string;
    username: string;
    displayName: string;
    password: string;
    instanceName?: string;
  }) => request<LoginResponse>("POST", "/auth/setup", { body }),
  renameInstance: (name: string) =>
    request<{ name: string; ownerId: string | null }>("PATCH", "/admin/instance", { body: { name } }),
  sessions: () => request<SessionInfo[]>("GET", "/auth/sessions"),
  gatewayTicket: () => request<{ ticket: string; expiresInMs: number }>("POST", "/auth/gateway-ticket"),
};
