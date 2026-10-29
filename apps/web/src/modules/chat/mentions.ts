// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Member, Role } from "@tincan/shared";

/**
 * Mentions in the composer (12 §5.5). People type and see `@Ann`; the message that is sent carries
 * `<@userId>` tokens the server validates (the raw form is in packages/shared chat.ts). These are the
 * pure conversions between the two.
 */
export interface InsertedMention {
  /** What the composer shows, e.g. `@Ann`. */
  label: string;
  /** What is sent, e.g. `<@01…>`. */
  token: string;
}

export interface Candidate {
  kind: "user" | "role" | "channel" | "everyone";
  id: string;
  label: string;
  /** Extra text to match against, e.g. the username behind a nickname. */
  match: string[];
}

export const displayOf = (m: Pick<Member, "nickname" | "displayName">): string => m.nickname ?? m.displayName;

/** Finds the `@word` or `#word` the caret is in, if any. */
export function activeTrigger(
  text: string,
  caret: number,
): { trigger: "@" | "#"; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|[\s(])([@#])([^\s@#]{0,32})$/.exec(before);
  if (!m) return null;
  return { trigger: m[1] as "@" | "#", query: m[2]!, start: caret - m[2]!.length - 1 };
}

export function filterCandidates(all: readonly Candidate[], query: string, limit = 8): Candidate[] {
  const q = query.toLowerCase();
  const scored = all
    .map((c) => {
      const names = [c.label, ...c.match].map((x) => x.toLowerCase());
      const starts = names.some((n) => n.startsWith(q));
      const has = names.some((n) => n.includes(q));
      return { c, score: q === "" ? 1 : starts ? 2 : has ? 1 : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.label.localeCompare(b.c.label));
  return scored.slice(0, limit).map((x) => x.c);
}

export function candidatesFor(
  trigger: "@" | "#",
  members: readonly Member[],
  roles: readonly Role[],
  channels: readonly { id: string; name: string; type: string }[],
  canEveryone: boolean,
): Candidate[] {
  if (trigger === "#") {
    return channels
      .filter((c) => c.type === "text")
      .map((c) => ({ kind: "channel" as const, id: c.id, label: c.name, match: [] }));
  }
  return [
    ...members.map((m) => ({
      kind: "user" as const,
      id: m.userId,
      label: displayOf(m),
      match: [m.username, m.displayName],
    })),
    ...roles
      .filter((r) => !r.isDefault)
      .map((r) => ({ kind: "role" as const, id: r.id, label: r.name, match: [] })),
    ...(canEveryone
      ? [
          { kind: "everyone" as const, id: "everyone", label: "everyone", match: [] },
          { kind: "everyone" as const, id: "here", label: "here", match: [] },
        ]
      : []),
  ];
}

export function tokenOf(c: Candidate): InsertedMention {
  switch (c.kind) {
    case "user":
      return { label: `@${c.label}`, token: `<@${c.id}>` };
    case "role":
      return { label: `@${c.label}`, token: `<@&${c.id}>` };
    case "channel":
      return { label: `#${c.label}`, token: `<#${c.id}>` };
    case "everyone":
      return { label: `@${c.label}`, token: `@${c.label}` };
  }
}

/** Replaces the mentions the user inserted (and exact `@username` matches) with their tokens. */
export function encodeMentions(
  text: string,
  inserted: readonly InsertedMention[],
  members: readonly Member[],
): string {
  let out = text;
  const byLabel = new Map<string, string>();
  for (const i of inserted) byLabel.set(i.label, i.token);
  // Typed by hand: `@username` is unique, so it can be resolved without the picker.
  for (const m of members) {
    const label = `@${m.username}`;
    if (!byLabel.has(label)) byLabel.set(label, `<@${m.userId}>`);
  }
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length);
  if (labels.length === 0) return out;
  const escaped = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(^|[\\s(])(${escaped.join("|")})(?![\\p{L}\\p{N}_-])`, "gu");
  out = out.replace(re, (_all, lead: string, label: string) => `${lead}${byLabel.get(label) ?? label}`);
  return out;
}

/** The inverse, for editing a sent message: tokens become `@Name` and are remembered. */
export function decodeMentions(
  content: string,
  names: { user(id: string): string; role(id: string): string | null; channel(id: string): string | null },
): { text: string; inserted: InsertedMention[] } {
  const inserted: InsertedMention[] = [];
  const text = content.replace(/<(@&|@|#)([0-9A-HJKMNP-TV-Z]{26})>/g, (token, kind: string, id: string) => {
    const name = kind === "@" ? names.user(id) : kind === "@&" ? names.role(id) : names.channel(id);
    if (name === null) return token;
    const label = `${kind === "#" ? "#" : "@"}${name}`;
    inserted.push({ label, token });
    return label;
  });
  return { text, inserted };
}
