// SPDX-License-Identifier: AGPL-3.0-or-later
import sharp from "sharp";

/** Raster types that are safe to show inline and that `sharp` can thumbnail. SVG is deliberately absent. */
export const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Content sniffing by magic bytes: the declared type is a hint, never trusted (15, 07 §3.7). */
export function sniffImage(buf: Buffer): string | null {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return null;
}

/** Types that must never be served inline, whatever the uploader claimed. */
const DANGEROUS =
  /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|text\/javascript|application\/javascript)/i;

/** The type we record for a non-image upload: the declared one if it is well-formed and harmless, else octet-stream. */
export function safeDeclaredType(declared: string | undefined): string {
  const t = (declared ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/.test(t))
    return "application/octet-stream";
  if (DANGEROUS.test(t)) return "application/octet-stream";
  return t;
}

/** Strips directories, control characters and the characters that break headers; never empty. */
export function cleanFilename(name: string | undefined): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = [...base]
    .filter((ch) => ch.codePointAt(0)! >= 32 && ch.codePointAt(0) !== 127 && !'"<>|:*?'.includes(ch))
    .join("")
    .trim()
    .replace(/^[.]+/, "");
  const limited = [...cleaned].slice(0, 200).join("");
  return limited.length > 0 ? limited : "file";
}

export interface ImageInfo {
  width: number;
  height: number;
}

const MAX_PIXELS = 100_000_000;

/** Throws if `sharp` cannot decode the file or it is absurdly large. */
export async function inspectImage(buf: Buffer): Promise<ImageInfo> {
  const meta = await sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: "error" }).metadata();
  if (!meta.width || !meta.height) throw new Error("not an image");
  // EXIF orientations 5–8 are rotated a quarter turn when shown.
  const turned = (meta.orientation ?? 1) >= 5;
  return turned ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
}

/** A WebP preview that fits in a square of `size`, upright, first frame only. */
export function thumbnail(buf: Buffer, size: number): Promise<Buffer> {
  return sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: "error" })
    .rotate()
    .resize(size, size, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

/** Square, upright, 256 px: avatars are cropped to the centre. */
export function avatarImage(buf: Buffer, size = 256): Promise<Buffer> {
  return sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: "error" })
    .rotate()
    .resize(size, size, { fit: "cover" })
    .webp({ quality: 85 })
    .toBuffer();
}
