// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/** Web Push (RFC 8030) subscription as the browser's `PushSubscription.toJSON()` gives it. */
export const PushSubscriptionRequestSchema = z.strictObject({
  endpoint: z.url().max(2048),
  keys: z.strictObject({
    p256dh: z.string().min(16).max(256),
    auth: z.string().min(8).max(128),
  }),
});
export type PushSubscriptionRequest = z.infer<typeof PushSubscriptionRequestSchema>;

export const PushUnsubscribeRequestSchema = z.strictObject({ endpoint: z.url().max(2048) });

export const PushKeyResponseSchema = z.object({ publicKey: z.string().min(1) });

/** What the service worker receives. Kept small: push services cap payloads near 4 KB. */
export interface PushPayload {
  channelId: string;
  messageId: string;
  title: string;
  body: string;
}
