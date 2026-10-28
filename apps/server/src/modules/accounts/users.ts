// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db, Selectable } from "@tincan/db";
import { newId, type User } from "@tincan/shared";
import type { AccountsTables } from "./schema.js";

export type UserRow = Selectable<AccountsTables["user"]>;

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
    isInstanceOwner: row.is_instance_owner === 1,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function findUserByUsername(
  db: Db<AccountsTables>,
  username: string,
): Promise<UserRow | undefined> {
  return db.query.selectFrom("user").selectAll().where("username", "=", username).executeTakeFirst();
}

export async function findUserById(db: Db<AccountsTables>, id: string): Promise<UserRow | undefined> {
  return db.query.selectFrom("user").selectAll().where("id", "=", id).executeTakeFirst();
}

export interface NewUser {
  username: string;
  displayName: string;
  passwordHash: string;
  isOwner?: boolean;
}

/** Inserts a user inside the caller's transaction. A taken username surfaces as a unique-constraint error. */
export async function insertUser(tx: Db<AccountsTables>, input: NewUser, now = Date.now()): Promise<UserRow> {
  const row: UserRow = {
    id: newId(now),
    username: input.username,
    display_username: input.username,
    display_name: input.displayName,
    avatar_key: null,
    status_text: null,
    password_hash: input.passwordHash,
    created_at: now,
    disabled_at: null,
    is_instance_owner: input.isOwner ? 1 : 0,
  };
  await tx.query.insertInto("user").values(row).execute();
  return row;
}

export async function countUsers(db: Db<AccountsTables>): Promise<number> {
  const r = await db.query
    .selectFrom("user")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/** Creates the owner, the one space and the owner's membership (11 §1.4). Roles and channels join in M2. */
export async function createOwnerAndSpace(
  tx: Db<AccountsTables>,
  input: { username: string; displayName: string; passwordHash: string; instanceName: string },
  now = Date.now(),
): Promise<UserRow> {
  const owner = await insertUser(tx, { ...input, isOwner: true }, now);
  const spaceId = newId(now);
  await tx.query
    .insertInto("space")
    .values({
      id: spaceId,
      name: input.instanceName,
      icon_key: null,
      created_at: now,
      owner_user_id: owner.id,
    })
    .execute();
  await tx.query
    .insertInto("member")
    .values({
      space_id: spaceId,
      user_id: owner.id,
      joined_at: now,
      nickname: null,
      timeout_until: null,
      invited_by: null,
    })
    .execute();
  return owner;
}
