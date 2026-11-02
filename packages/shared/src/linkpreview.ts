// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/** At most this many links of one message get a preview (23 §8.1). */
export const LINK_PREVIEW_MAX_PER_MESSAGE = 3;

/**
 * The http(s) links in a message that may get a preview, in order, without repeats. Code spans, code blocks and
 * links written as `<https://…>` are skipped, as in other chat apps. The server and the web client both use this,
 * so the client asks only for messages that have something to show.
 */
export function extractPreviewUrls(content: string): string[] {
  const text = content.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![<\w])https?:\/\/[^\s<>"'`]+/gi)) {
    // Trailing punctuation belongs to the sentence, not the link.
    const url = m[0].replace(/[.,;:!?)\]}]+$/, "");
    if (url.length > 2048 || out.includes(url)) continue;
    out.push(url);
    if (out.length >= LINK_PREVIEW_MAX_PER_MESSAGE) break;
  }
  return out;
}

export const LinkPreviewSchema = z.object({
  /** The link as written in the message. */
  url: z.string(),
  siteName: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  /** Path of the server's re-hosted copy of the image (same origin), or null. */
  image: z.string().nullable(),
  imageWidth: z.number().int().nullable(),
  imageHeight: z.number().int().nullable(),
  /** The page is a video (shown with a play badge); the card still opens the link. */
  video: z.boolean(),
});
export type LinkPreview = z.infer<typeof LinkPreviewSchema>;

export const LinkPreviewListSchema = z.object({ previews: z.array(LinkPreviewSchema) });

const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/, "not a domain name");

export const LinkPreviewSettingsSchema = z.object({
  enabled: z.boolean(),
  allowDomains: z.array(Domain).max(200),
  denyDomains: z.array(Domain).max(200),
});
export type LinkPreviewSettings = z.infer<typeof LinkPreviewSettingsSchema>;
export const LinkPreviewSettingsPatchSchema = LinkPreviewSettingsSchema.partial();
