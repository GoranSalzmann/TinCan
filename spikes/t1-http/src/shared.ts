// What packages/shared would hold: zod schemas used by server and clients (07).
import { z } from "zod";

export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "ULID");
export const ChannelParams = z.object({ channelId: Ulid });
export const CreateMessageBody = z.object({
  content: z.string().min(1).max(4000),
  nonce: z.string().max(64).optional(),
  replyToId: Ulid.optional(),
});
export const Message = z.object({
  id: Ulid,
  channelId: Ulid,
  authorId: Ulid,
  content: z.string(),
  createdAt: z.string(),
});
export const HistoryQuery = z.object({
  before: Ulid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const ErrorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

// Gateway frames (07 §4.1-4.2)
export const ClientFrame = z.discriminatedUnion("op", [
  z.object({ op: z.literal(1), d: z.number().nullable() }), // HEARTBEAT
  z.object({ op: z.literal(2), d: z.object({ token: z.string(), client: z.object({ name: z.string(), version: z.string(), platform: z.string() }) }) }), // IDENTIFY
  z.object({ op: z.literal(4), d: z.object({ cmd: z.string(), args: z.unknown(), id: z.string() }) }), // COMMAND
]);

export const MAX_CLIENT_FRAME = 64 * 1024; // 07 §4.1
export const ALLOWED_ORIGINS = ["https://chat.example.org", "app://tincan"];
export const GOOD_TOKEN = "valid-session-token";

// In-memory stand-in for the messages use case.
export const CHANNEL = "01J9Z3Y4V5W6X7Y8Z9A0B1C2D3";
export const USER = "01J9Z3Y4V5W6X7Y8Z9A0B1C2D4";
let seq = 0;
export function createMessageUseCase(channelId: string, body: z.infer<typeof CreateMessageBody>) {
  const id = "01J9Z3Y4V5W6X7Y8Z9" + String(seq++).padStart(8, "0").replace(/[ILOU]/g, "0");
  // `passwordHash` stands for an internal field a handler might return by mistake.
  return { id, channelId, authorId: USER, content: body.content, createdAt: new Date(0).toISOString(), passwordHash: "argon2id$secret" };
}
