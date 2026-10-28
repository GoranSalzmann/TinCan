// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/** Gateway wire protocol (07 §4). */
export const GATEWAY_PATH = "/gateway";
export const GATEWAY_VERSION = 1;
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024;
export const MAX_SERVER_FRAME_BYTES = 1024 * 1024;

export const Op = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 3,
  COMMAND: 4,
  COMMAND_RESULT: 5,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;
export type OpCode = (typeof Op)[keyof typeof Op];

export const CloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  UNKNOWN_ERROR: 4000,
  INVALID_OPCODE: 4001,
  DECODE_ERROR: 4002,
  NOT_AUTHENTICATED: 4003,
  AUTH_FAILED: 4004,
  ALREADY_AUTHENTICATED: 4005,
  INVALID_SEQUENCE: 4007,
  RATE_LIMITED: 4008,
  SESSION_TIMED_OUT: 4009,
  SLOW_CONSUMER: 4010,
  CLIENT_TOO_OLD: 4011,
  SESSION_REPLACED: 4012,
} as const;
export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

/** Close codes after which a client must not blindly reconnect with RESUME (07 §4.7). */
export const NON_RESUMABLE_CLOSE_CODES: readonly number[] = [
  CloseCode.INVALID_OPCODE,
  CloseCode.DECODE_ERROR,
  CloseCode.AUTH_FAILED,
  CloseCode.INVALID_SEQUENCE,
  CloseCode.SESSION_TIMED_OUT,
  CloseCode.CLIENT_TOO_OLD,
  CloseCode.SESSION_REPLACED,
];

export const ClientInfoSchema = z.object({
  name: z.string().min(1).max(64),
  version: z.string().min(1).max(32),
  platform: z.string().min(1).max(32),
});
export type ClientInfo = z.infer<typeof ClientInfoSchema>;

const hasExactlyOneCredential = (v: { token?: string | undefined; ticket?: string | undefined }) =>
  (v.token === undefined) !== (v.ticket === undefined);

/**
 * `token` is a session token (desktop, CLI). The web client holds its session in an HttpOnly cookie,
 * so it trades the cookie for a short-lived single-use `ticket` first (POST /auth/gateway-ticket).
 */
export const IdentifyPayloadSchema = z
  .object({
    token: z.string().min(1).max(512).optional(),
    ticket: z.string().min(1).max(512).optional(),
    client: ClientInfoSchema,
    capabilitiesHash: z.string().max(128).optional(),
  })
  .refine(hasExactlyOneCredential, { message: "exactly one of token or ticket" });
export type IdentifyPayload = z.infer<typeof IdentifyPayloadSchema>;

export const ResumePayloadSchema = z
  .object({
    token: z.string().min(1).max(512).optional(),
    ticket: z.string().min(1).max(512).optional(),
    sessionId: z.string().min(1).max(64),
    lastSeq: z.number().int().min(0),
  })
  .refine(hasExactlyOneCredential, { message: "exactly one of token or ticket" });
export type ResumePayload = z.infer<typeof ResumePayloadSchema>;

export const CommandPayloadSchema = z.object({
  cmd: z.string().min(1).max(64),
  args: z.unknown().optional(),
  id: z.union([z.string().max(64), z.number().int()]),
});
export type CommandPayload = z.infer<typeof CommandPayloadSchema>;

export const HeartbeatPayloadSchema = z.number().int().min(0).nullable();

/** Any client→server frame, before the payload is checked against its opcode. */
export const ClientFrameSchema = z.object({
  op: z.number().int(),
  d: z.unknown().optional(),
});
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export interface HelloPayload {
  heartbeatIntervalMs: number;
  apiVersion: number;
  sessionHint?: string;
}

export interface ReadyPayload {
  sessionId: string;
  user: { id: string; username: string; displayName: string; isInstanceOwner: boolean };
  instance: { name: string; ownerId: string | null };
  /** Per-module contributions (channels, roles, members, presence …) arrive with their modules. */
  [key: string]: unknown;
}

export interface DispatchFrame<T = unknown> {
  op: typeof Op.DISPATCH;
  t: string;
  s: number;
  d: T;
}

/** Which module owns each gateway command (07 §4.6), so a disabled module answers FEATURE_DISABLED. */
export const GATEWAY_COMMANDS: Readonly<Record<string, string>> = {
  "presence.set": "accounts",
  "typing.start": "text-chat",
  "voice.state": "voice",
  "subscribe.channel": "core",
};

export const GATEWAY_DEFAULTS = {
  heartbeatIntervalMs: 25_000,
  identifyTimeoutMs: 10_000,
  ringBufferEvents: 1000,
  ringBufferMs: 2 * 60_000,
  maxSendQueueBytes: 4 * 1024 * 1024,
} as const;
