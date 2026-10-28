// SPDX-License-Identifier: AGPL-3.0-or-later

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) {
      try {
        out[name] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // an undecodable cookie is as good as absent
      }
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSec?: number;
  secure: boolean;
}

/** HttpOnly + SameSite=Strict (+ Secure over https), as 11 §1.2 asks for the web session. */
export function sessionCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (opts.secure) parts.push("Secure");
  if (opts.maxAgeSec !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`);
  return parts.join("; ");
}

export function clearedCookie(name: string, secure: boolean): string {
  return sessionCookie(name, "", { maxAgeSec: 0, secure });
}
