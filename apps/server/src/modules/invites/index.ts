// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppError,
  InviteCreateSchema,
  InvitePreviewSchema,
  InviteSchema,
  newId,
  type Invite,
} from "@tincan/shared";
import { defineModule } from "../../framework/types.js";
import { enforceRateLimit } from "../../http/rate-limit.js";
import { VERSION } from "../../version.js";
import type { AccountsApi } from "../accounts/api.js";
import type { RolesApi } from "../roles/api.js";
import { invitesMigrations, type InvitesTables } from "./schema.js";

const DAY = 86_400_000;

const toInvite = (r: InvitesTables["invite"]): Invite => ({
  id: r.id,
  code: r.code,
  createdBy: r.created_by,
  createdAt: new Date(r.created_at).toISOString(),
  expiresAt: r.expires_at === null ? null : new Date(r.expires_at).toISOString(),
  maxUses: r.max_uses,
  uses: r.uses,
  revokedAt: r.revoked_at === null ? null : new Date(r.revoked_at).toISOString(),
  defaultRoleId: r.default_role_id,
});

/** Invite creation, preview, revocation and redemption (11 §1.5). */
export default defineModule({
  id: "invites",
  version: VERSION,
  dependsOn: ["accounts", "roles"],
  requiresPorts: ["db", "pubsub"],
  migrations: invitesMigrations,
  register(ctx) {
    const found = { accounts: ctx.api.get<AccountsApi>("accounts"), roles: ctx.api.get<RolesApi>("roles") };
    if (!found.accounts || !found.roles) throw new AppError("INTERNAL", "invites: a dependency is missing");
    const { accounts, roles } = found as { accounts: AccountsApi; roles: RolesApi };
    const db = ctx.ports.db.as<InvitesTables>();
    const kv = ctx.ports.pubsub.kv;

    // Registration consumes a use in its own transaction, so `maxUses` holds under races.
    accounts.setInviteRedeemer({
      async redeem(rawTx, code, userId, now) {
        const tx = rawTx.as<InvitesTables>();
        const claimed = await tx.query
          .updateTable("invite")
          .set((eb) => ({ uses: eb("uses", "+", 1) }))
          .where("code", "=", code)
          .where("revoked_at", "is", null)
          .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
          .where((eb) => eb.or([eb("max_uses", "is", null), eb("uses", "<", eb.ref("max_uses"))]))
          .returning(["id", "default_role_id"])
          .executeTakeFirst();
        if (!claimed) {
          const row = await tx.query
            .selectFrom("invite")
            .selectAll()
            .where("code", "=", code)
            .executeTakeFirst();
          if (!row || row.revoked_at !== null) throw new AppError("NOT_FOUND", "That invite is not valid.");
          if (row.expires_at !== null && row.expires_at <= now)
            throw new AppError("INVITE_EXPIRED", "That invite has expired.");
          throw new AppError("INVITE_EXHAUSTED", "That invite has been used up.");
        }
        await tx.query
          .insertInto("invite_use")
          .values({ invite_id: claimed.id, user_id: userId, used_at: now })
          .execute();
        return { defaultRoleId: claimed.default_role_id };
      },
    });

    const http = ctx.http.withTypeProvider<ZodTypeProvider>();

    http.post(
      "/invites",
      {
        preHandler: ctx.http.authenticate,
        schema: { body: InviteCreateSchema, response: { 201: InviteSchema } },
      },
      async (req, reply) => {
        const userId = req.actor!.userId;
        await roles.assert(userId, "CREATE_INVITE");
        const spaceId = await accounts.spaceId();
        if (!spaceId) throw new AppError("SETUP_REQUIRED", "This server has not been set up yet.");
        if (req.body.defaultRoleId !== undefined) {
          const role = await roles.getRole(req.body.defaultRoleId);
          if (!role || role.isDefault)
            throw new AppError("VALIDATION_FAILED", "No such role.", {
              fields: { defaultRoleId: "unknown" },
            });
          // Handing out a role through an invite is assigning it to the future member.
          await roles.authorizeOrThrow(userId, {
            kind: "role.assign",
            role: roles.roleFacts(role),
            member: { userId: "", isOwner: false, rank: 0 },
          });
        }
        const now = Date.now();
        const row: InvitesTables["invite"] = {
          id: newId(now),
          space_id: spaceId,
          code: randomBytes(9).toString("base64url"),
          created_by: userId,
          created_at: now,
          expires_at: req.body.expiresInSecs ? now + req.body.expiresInSecs * 1000 : null,
          max_uses: req.body.maxUses ?? null,
          uses: 0,
          revoked_at: null,
          default_role_id: req.body.defaultRoleId ?? null,
        };
        await db.query.insertInto("invite").values(row).execute();
        return reply.status(201).send(toInvite(row));
      },
    );

    http.get(
      "/invites",
      {
        preHandler: ctx.http.authenticate,
        schema: {
          querystring: z.object({
            all: z.coerce.boolean().optional(),
            include: z.enum(["active", "all"]).default("active"),
          }),
          response: { 200: z.array(InviteSchema) },
        },
      },
      async (req) => {
        const userId = req.actor!.userId;
        const everyone = req.query.all && (await roles.can(userId, "MANAGE_INVITES"));
        const now = Date.now();
        let q = db.query.selectFrom("invite").selectAll().orderBy("id", "desc").limit(500);
        if (!everyone) q = q.where("created_by", "=", userId);
        if (req.query.include === "active") {
          q = q
            .where("revoked_at", "is", null)
            .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
            .where((eb) => eb.or([eb("max_uses", "is", null), eb("uses", "<", eb.ref("max_uses"))]));
        }
        return (await q.execute()).map(toInvite);
      },
    );

    http.delete(
      "/invites/:id",
      { preHandler: ctx.http.authenticate, schema: { params: z.object({ id: z.string().min(1).max(64) }) } },
      async (req, reply) => {
        const userId = req.actor!.userId;
        const row = await db.query
          .selectFrom("invite")
          .selectAll()
          .where("id", "=", req.params.id)
          .executeTakeFirst();
        if (!row) throw new AppError("NOT_FOUND", "No such invite.");
        if (row.created_by !== userId) {
          // Someone else's invite: the same answer as for one that does not exist unless the caller manages invites.
          if (!(await roles.can(userId, "MANAGE_INVITES")))
            throw new AppError("NOT_FOUND", "No such invite.");
        }
        await db.query
          .updateTable("invite")
          .set({ revoked_at: Date.now() })
          .where("id", "=", row.id)
          .where("revoked_at", "is", null)
          .execute();
        return reply.status(204).send();
      },
    );

    // Public: lets the invite page show where you are being invited (W-32). Rate limited, codes are secrets.
    http.get(
      "/invites/:code",
      {
        schema: {
          params: z.object({ code: z.string().min(4).max(64) }),
          response: { 200: InvitePreviewSchema },
        },
      },
      async (req, reply) => {
        await enforceRateLimit(
          kv,
          { key: `invite-preview:ip:${req.ip}`, max: 30, windowMs: 15 * 60_000 },
          reply,
        );
        const now = Date.now();
        const row = await db.query
          .selectFrom("invite")
          .selectAll()
          .where("code", "=", req.params.code)
          .executeTakeFirst();
        if (!row || row.revoked_at !== null) throw new AppError("NOT_FOUND", "That invite is not valid.");
        if (row.expires_at !== null && row.expires_at <= now)
          throw new AppError("INVITE_EXPIRED", "That invite has expired.");
        if (row.max_uses !== null && row.uses >= row.max_uses)
          throw new AppError("INVITE_EXHAUSTED", "That invite has been used up.");
        return { instanceName: await accounts.instanceName(), memberCount: await accounts.memberCount() };
      },
    );

    ctx.jobs.every("invites.purge", 60 * 60_000, async () => {
      const cutoff = Date.now() - 30 * DAY;
      await db.query
        .deleteFrom("invite")
        .where((eb) =>
          eb.or([
            eb.and([eb("revoked_at", "is not", null), eb("revoked_at", "<", cutoff)]),
            eb.and([eb("expires_at", "is not", null), eb("expires_at", "<", cutoff)]),
          ]),
        )
        .execute();
    });

    ctx.capabilities.feature("invites", true);
  },
});
