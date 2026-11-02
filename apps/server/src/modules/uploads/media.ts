// SPDX-License-Identifier: AGPL-3.0-or-later

/** Audio and video types that are served inline (23 §2). Anything else is a download. */
export const INLINE_MEDIA_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/wav",
  "audio/flac",
]);

const ascii = (b: Buffer, from: number, to: number): string => b.subarray(from, to).toString("latin1");

/**
 * Container check by magic bytes for audio and video. Like `sniffImage` this is a gate for "show inline", not a
 * validation: the bytes after the header are never parsed, only the browser plays them.
 */
export function sniffMedia(buf: Buffer, filename?: string): string | null {
  if (buf.length >= 12 && ascii(buf, 4, 8) === "ftyp") {
    const brand = ascii(buf, 8, 12);
    if (brand === "qt  ") return "video/quicktime";
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
    return "video/mp4";
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)
    return /\.(weba|opus)$/i.test(filename ?? "") ? "audio/webm" : "video/webm";
  if (buf.length >= 4 && ascii(buf, 0, 4) === "OggS") return "audio/ogg";
  if (buf.length >= 12 && ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WAVE") return "audio/wav";
  if (buf.length >= 4 && ascii(buf, 0, 4) === "fLaC") return "audio/flac";
  if (buf.length >= 3 && ascii(buf, 0, 3) === "ID3") return "audio/mpeg";
  // MPEG audio frame sync (11 set bits) with a valid layer, or ADTS AAC (also FFFx).
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0 && (buf[1]! & 0x06) !== 0)
    return "audio/mpeg";
  return null;
}

/** True when the PNG has an `acTL` chunk before its image data (an animated PNG). */
export function isApng(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  let at = 8;
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = ascii(buf, at + 4, at + 8);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    at += 12 + len;
  }
  return false;
}
