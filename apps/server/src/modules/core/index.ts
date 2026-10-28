// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { coreMigrations } from "@tincan/db";
import { CapabilitiesSchema, CloseCode } from "@tincan/shared";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { KernelFacade } from "../../framework/kernel.js";
import { defineModule } from "../../framework/types.js";
import { VERSION } from "../../version.js";

const ModuleGraphSchema = z.object({
  version: z.string(),
  apiVersion: z.number(),
  adapters: z.object({
    database: z.string(),
    storage: z.string(),
    pubsub: z.string(),
    auth: z.array(z.string()),
  }),
  modules: z.array(z.object({ id: z.string(), version: z.string() })),
  disabled: z.array(z.string()),
  warnings: z.array(z.string()),
  listening: z.string().nullable(),
  livekit: z.string().nullable(),
});

/**
 * Always on (04 §2): capabilities, the module report, and the wiring between the event bus and the
 * gateway. The gateway socket itself, health probes and the HTTP kernel live in the runtime (boot.ts).
 */
export default defineModule({
  id: "core",
  version: VERSION,
  dependsOn: [],
  requiresPorts: ["db", "pubsub"],
  alwaysOn: true,
  migrations: coreMigrations,
  register(ctx) {
    const kernel = ctx.api.get<KernelFacade>("kernel");
    if (!kernel) throw new Error("core: the runtime did not provide its kernel facade");
    const http = ctx.http.withTypeProvider<ZodTypeProvider>();

    http.get("/capabilities", { schema: { response: { 200: CapabilitiesSchema } } }, () =>
      kernel.capabilities.build(),
    );

    http.get(
      "/admin/modules",
      { preHandler: ctx.http.requireOwner, schema: { response: { 200: ModuleGraphSchema } } },
      () => kernel.describe(),
    );

    // Gateway commands that belong to core (07 §4.6). `subscribe.channel` is reserved and a no-op in v1.
    ctx.gateway.onCommand("subscribe.channel", () => undefined);

    // A revoked login ends its gateway sessions (11 §1.2 revocation).
    ctx.events.on("session.revoked", ({ sessionId }) => {
      kernel.hub.dropByAuthSession(sessionId, CloseCode.AUTH_FAILED, "session revoked");
    });
  },
});
