// SPDX-License-Identifier: AGPL-3.0-or-later

/** Stable error codes (07 §2.2). `code` drives client logic and i18n lookup. */
export const ERROR_HTTP_STATUS = {
  VALIDATION_FAILED: 400,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  PERMISSION_DENIED: 403,
  FEATURE_DISABLED: 403,
  BANNED: 403,
  TIMED_OUT: 403,
  ACCOUNT_DISABLED: 403,
  SETUP_REQUIRED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVITE_EXPIRED: 410,
  INVITE_EXHAUSTED: 410,
  PAYLOAD_TOO_LARGE: 413,
  QUOTA_EXCEEDED: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  CLIENT_TOO_OLD: 426,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown>; requestId?: string };
}

/** Domain error: `safeMessage` is shown to users, everything else is logged and returned as INTERNAL. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, safeMessage: string, details?: Record<string, unknown>) {
    super(safeMessage);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}
