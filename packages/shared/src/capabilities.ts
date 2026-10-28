// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/** Integer incremented on breaking protocol changes (04 §7, 07 §6). */
export const API_VERSION = 1;
export const API_PREFIX = "/api/v1";

export const CapabilitiesSchema = z.object({
  server: z.object({
    name: z.string(),
    version: z.string(),
    apiVersion: z.number().int(),
    /** AGPL section 13: where users of a (possibly modified) instance can get the source. */
    sourceUrl: z.string(),
  }),
  /** `true`, or an object of module-specific limits. Absent or false means the module is off. */
  features: z.record(z.string(), z.union([z.boolean(), z.record(z.string(), z.unknown())])),
  limits: z.record(z.string(), z.number()),
  auth: z.object({
    methods: z.array(z.enum(["local", "oidc"])),
    signup: z.enum(["invite-only", "open", "closed"]),
    setupRequired: z.boolean(),
  }),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
