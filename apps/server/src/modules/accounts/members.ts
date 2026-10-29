// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from "@tincan/db";
import type { MemberRecord } from "./api.js";
import type { AccountsTables } from "./schema.js";

function select(db: Db<AccountsTables>) {
  return db.query
    .selectFrom("member")
    .innerJoin("user", "user.id", "member.user_id")
    .select([
      "member.user_id",
      "member.joined_at",
      "member.nickname",
      "member.timeout_until",
      "user.username",
      "user.display_name",
      "user.avatar_key",
      "user.status_text",
      "user.is_instance_owner",
      "user.disabled_at",
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof select>["execute"]>>[number];

const toRecord = (r: Row): MemberRecord => ({
  userId: r.user_id,
  username: r.username,
  displayName: r.display_name,
  avatarKey: r.avatar_key,
  statusText: r.status_text,
  nickname: r.nickname,
  joinedAt: r.joined_at,
  timeoutUntil: r.timeout_until,
  isOwner: r.is_instance_owner === 1,
  disabled: r.disabled_at !== null,
});

export async function listMembers(db: Db<AccountsTables>): Promise<MemberRecord[]> {
  const rows = await select(db).orderBy("member.joined_at").orderBy("member.user_id").execute();
  return rows.map(toRecord);
}

export async function getMember(db: Db<AccountsTables>, userId: string): Promise<MemberRecord | null> {
  const row = await select(db).where("member.user_id", "=", userId).executeTakeFirst();
  return row ? toRecord(row) : null;
}

export async function memberCount(db: Db<AccountsTables>): Promise<number> {
  const r = await db.query
    .selectFrom("member")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

export async function spaceOf(db: Db<AccountsTables>): Promise<{ id: string; ownerId: string } | null> {
  const r = await db.query.selectFrom("space").select(["id", "owner_user_id"]).limit(1).executeTakeFirst();
  return r ? { id: r.id, ownerId: r.owner_user_id } : null;
}
