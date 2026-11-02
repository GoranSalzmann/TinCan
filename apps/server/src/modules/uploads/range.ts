// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

/**
 * Reads one `Range: bytes=…` header against an object of `size` bytes (RFC 9110 §14). Returns the range to send,
 * "unsatisfiable" for a 416, or null when the header should be ignored (absent, other unit, malformed, or several
 * ranges: a server may answer those with the whole body).
 */
export function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (size === 0) return "unsatisfiable";
  if (m[1] === "") {
    // Suffix: the last n bytes.
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  if (end < start) return null;
  return { start, end };
}
