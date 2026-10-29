// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  API_PREFIX,
  CSRF_HEADER,
  type Capabilities,
  type Category,
  type Channel,
  type ChannelCreate,
  type ChannelList,
  type ChannelPatch,
  type ErrorCode,
  type Invite,
  type InviteCreate,
  type LoginResponse,
  type Member,
  type Message,
  type MessageCreate,
  type Overwrite,
  type ReadStateEntry,
  type Role,
  type RoleCreate,
  type RolePatch,
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
  /** Multipart upload; the browser sets the content type. */
  form?: FormData;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method,
      // The session is an HttpOnly cookie. The custom header is what makes a cross-site request unable to use it (11 §1.2).
      credentials: "same-origin",
      headers: {
        [CSRF_HEADER]: "1",
        ...(opts.body !== undefined && !opts.form ? { "content-type": "application/json" } : {}),
      },
      ...(opts.form
        ? { body: opts.form }
        : opts.body !== undefined
          ? { body: JSON.stringify(opts.body) }
          : {}),
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

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface OwnAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  channelId: string | null;
  messageId: string | null;
  createdAt: string;
}

export interface UploadResult {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  hasThumbnail: boolean;
}

const qs = (o: Record<string, string | number | boolean | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  capabilities: (signal?: AbortSignal) =>
    request<Capabilities>("GET", "/capabilities", signal ? { signal } : {}),
  me: () => request<User>("GET", "/users/@me"),
  login: (username: string, password: string) =>
    request<LoginResponse>("POST", "/auth/login", { body: { username, password } }),
  register: (body: { inviteCode?: string; username: string; displayName: string; password: string }) =>
    request<LoginResponse>("POST", "/auth/register", { body }),
  redeemReset: (code: string, newPassword: string) =>
    request<void>("POST", "/auth/reset", { body: { code, newPassword } }),
  invitePreview: (code: string) =>
    request<{ instanceName: string; memberCount: number }>("GET", `/invites/${encodeURIComponent(code)}`),
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
  revokeSession: (id: string) => request<void>("DELETE", `/auth/sessions/${encodeURIComponent(id)}`),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>("POST", "/auth/password", { body: { currentPassword, newPassword } }),
  gatewayTicket: () => request<{ ticket: string; expiresInMs: number }>("POST", "/auth/gateway-ticket"),

  // profile and synced settings
  patchProfile: (body: { displayName?: string; statusText?: string | null }) =>
    request<User>("PATCH", "/users/@me", { body }),
  settings: () => request<Record<string, unknown>>("GET", "/users/@me/settings"),
  patchSettings: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>("PATCH", "/users/@me/settings", { body }),
  setAvatar: (file: Blob) => {
    const form = new FormData();
    form.set("file", file, "avatar");
    return request<{ avatarKey: string }>("PUT", "/users/@me/avatar", { form });
  },
  clearAvatar: () => request<void>("DELETE", "/users/@me/avatar"),
  storage: () => request<{ usedBytes: number; quotaBytes: number }>("GET", "/users/@me/storage"),
  ownAttachments: (q: { sort: "size" | "date"; cursor?: string }) =>
    request<Page<OwnAttachment>>("GET", `/users/@me/attachments${qs(q)}`),
  deleteUpload: (id: string) => request<void>("DELETE", `/uploads/${encodeURIComponent(id)}`),

  // channels
  channels: (archived = false) =>
    request<ChannelList>("GET", `/channels${qs({ archived: archived || undefined })}`),
  createChannel: (body: ChannelCreate) => request<Channel>("POST", "/channels", { body }),
  patchChannel: (id: string, body: ChannelPatch) => request<Channel>("PATCH", `/channels/${id}`, { body }),
  deleteChannel: (id: string) => request<void>("DELETE", `/channels/${id}`),
  reorderChannels: (items: { id: string; categoryId: string | null; position: number }[]) =>
    request<void>("PATCH", "/channels/reorder", { body: { items } }),
  createCategory: (name: string) => request<Category>("POST", "/categories", { body: { name } }),
  patchCategory: (id: string, body: { name?: string; position?: number }) =>
    request<Category>("PATCH", `/categories/${id}`, { body }),
  deleteCategory: (id: string) => request<void>("DELETE", `/categories/${id}`),
  overwrites: (channelId: string) => request<Overwrite[]>("GET", `/channels/${channelId}/overwrites`),
  putOverwrite: (channelId: string, type: "role" | "member", targetId: string, allow: string, deny: string) =>
    request<Overwrite>("PUT", `/channels/${channelId}/overwrites/${type}/${targetId}`, {
      body: { allow, deny },
    }),
  deleteOverwrite: (channelId: string, type: "role" | "member", targetId: string) =>
    request<void>("DELETE", `/channels/${channelId}/overwrites/${type}/${targetId}`),

  // roles and members
  roles: () => request<Role[]>("GET", "/roles"),
  createRole: (body: RoleCreate) => request<Role>("POST", "/roles", { body }),
  patchRole: (id: string, body: RolePatch) => request<Role>("PATCH", `/roles/${id}`, { body }),
  deleteRole: (id: string) => request<void>("DELETE", `/roles/${id}`),
  members: (after?: string) => request<Page<Member>>("GET", `/members${qs({ limit: 200, after })}`),
  assignRole: (userId: string, roleId: string) => request<void>("PUT", `/members/${userId}/roles/${roleId}`),
  unassignRole: (userId: string, roleId: string) =>
    request<void>("DELETE", `/members/${userId}/roles/${roleId}`),
  setNickname: (userId: string, nickname: string | null) =>
    request<Member>("PATCH", `/members/${userId}`, { body: { nickname } }),
  explain: (userId: string, channelId: string) =>
    request<{ permissions: string; steps: { step: string; before: string; after: string }[] }>(
      "GET",
      `/members/${userId}/permissions${qs({ channelId })}`,
    ),
  resetToken: (userId: string) =>
    request<{ code: string; expiresAt: string }>("POST", `/admin/users/${userId}/reset-token`),

  // invites
  invites: (all = false, include: "active" | "all" = "active") =>
    request<Invite[]>("GET", `/invites${qs({ all: all || undefined, include })}`),
  createInvite: (body: InviteCreate) => request<Invite>("POST", "/invites", { body }),
  revokeInvite: (id: string) => request<void>("DELETE", `/invites/${id}`),

  // messages
  history: (channelId: string, q: { before?: string; after?: string; around?: string; limit?: number }) =>
    request<Message[]>("GET", `/channels/${channelId}/messages${qs(q)}`),
  sendMessage: (channelId: string, body: MessageCreate) =>
    request<Message>("POST", `/channels/${channelId}/messages`, { body }),
  editMessage: (channelId: string, id: string, content: string) =>
    request<Message>("PATCH", `/channels/${channelId}/messages/${id}`, { body: { content } }),
  deleteMessage: (channelId: string, id: string) =>
    request<void>("DELETE", `/channels/${channelId}/messages/${id}`),
  pin: (channelId: string, id: string, pinned: boolean) =>
    request<void>(pinned ? "PUT" : "DELETE", `/channels/${channelId}/pins/${id}`),
  pins: (channelId: string) => request<Message[]>("GET", `/channels/${channelId}/pins`),
  ack: (channelId: string, messageId: string) =>
    request<ReadStateEntry>("POST", `/channels/${channelId}/ack`, { body: { messageId } }),
  readState: () => request<ReadStateEntry[]>("GET", "/read-state"),
  search: (q: { q: string; channelId?: string; sort?: "newest" | "relevance"; cursor?: string }) =>
    request<Page<Message>>("GET", `/search${qs(q)}`),
};

/** Uploads one file with progress (fetch cannot report upload progress). */
export function uploadFile(
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_PREFIX}/uploads`);
    xhr.setRequestHeader(CSRF_HEADER, "1");
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError("NETWORK", "Couldn't reach the server.", 0));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    xhr.onload = () => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        // not JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as UploadResult);
        return;
      }
      const e = (
        payload as {
          error?: { code?: ErrorCode; message?: string; details?: Record<string, unknown> };
        } | null
      )?.error;
      reject(new ApiError(e?.code ?? "INTERNAL", e?.message ?? xhr.statusText, xhr.status, e?.details));
    };
    signal?.addEventListener("abort", () => xhr.abort());
    const form = new FormData();
    form.set("file", file, file.name);
    xhr.send(form);
  });
}

/** URL of a stored file; the session cookie authorises the request (07 §3.7). */
export const fileUrl = (id: string, filename: string, thumb = false): string =>
  `${API_PREFIX}/files/${encodeURIComponent(id)}/${encodeURIComponent(filename || "file")}${thumb ? "?thumb=1" : ""}`;
export const avatarUrl = (key: string): string => `${API_PREFIX}/avatars/${encodeURIComponent(key)}`;
