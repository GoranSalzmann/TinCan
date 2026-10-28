// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/** 11 §1.1: 2–32 chars of `[a-z0-9._-]`, stored lowercase. */
export const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;
export const UsernameSchema = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().regex(USERNAME_RE, "2 to 32 characters: a-z, 0-9, dot, dash, underscore"));

/** Any printable text, 1–32 characters (counted in code points). */
export const DisplayNameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .refine((s) => [...s].length >= 1 && [...s].length <= 32, "1 to 32 characters")
      // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
      .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "No control characters"),
  );

/** Not trimmed or normalised: the password is exactly what was typed. Policy is checked separately. */
export const PasswordSchema = z.string().min(1).max(256);

export const InstanceNameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(64));

export const UserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarKey: z.string().nullable(),
  isInstanceOwner: z.boolean(),
  createdAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const SetupVerifyRequestSchema = z.object({ token: z.string().min(1).max(256) });

export const SetupRequestSchema = z.object({
  token: z.string().min(1).max(256),
  username: UsernameSchema,
  displayName: DisplayNameSchema,
  password: PasswordSchema,
  instanceName: InstanceNameSchema.optional(),
});
export type SetupRequest = z.infer<typeof SetupRequestSchema>;

export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  clientName: z.string().min(1).max(64).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  user: UserSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const SessionInfoSchema = z.object({
  id: z.string(),
  clientName: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  expiresAt: z.string(),
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: PasswordSchema,
});

export const InstancePatchSchema = z.object({ name: InstanceNameSchema });

export const InstanceInfoSchema = z.object({ name: z.string(), ownerId: z.string().nullable() });

export const GatewayTicketResponseSchema = z.object({ ticket: z.string(), expiresInMs: z.number() });

/** Header every mutating request from the cookie-authenticated web client must carry (CSRF defence). */
export const CSRF_HEADER = "x-tincan-csrf";
export const SESSION_COOKIE = "tincan_session";
