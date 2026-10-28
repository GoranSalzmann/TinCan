// Hono 4 + @hono/node-server + @hono/node-ws + @hono/zod-openapi.
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { WebSocket } from "ws";
import { ALLOWED_ORIGINS, ChannelParams, CreateMessageBody, ErrorEnvelope, HistoryQuery, Message, createMessageUseCase } from "./shared.js";
import { broadcast, onConnection } from "./gateway.js";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ content: { "application/json": { schema } }, description });

export function buildHono() {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: { code: "VALIDATION_FAILED", message: "Invalid request", details: result.error.issues } }, 400);
    },
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status === 400) return c.json({ error: { code: "BAD_REQUEST", message: err.message } }, 400);
    return c.json({ error: { code: "INTERNAL", message: "Internal error" } }, 500);
  });
  app.use("/api/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "too large" } }, 413) }));
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.openapi(createRoute({
    method: "post", path: "/api/v1/channels/{channelId}/messages",
    request: { params: ChannelParams, body: { content: { "application/json": { schema: CreateMessageBody } }, required: true } },
    responses: { 201: json(Message, "Created"), 400: json(ErrorEnvelope, "Validation failed") },
  }), (c) => {
    const m = createMessageUseCase(c.req.valid("param").channelId, c.req.valid("json"));
    broadcast("MESSAGE_CREATE", { id: m.id, channelId: m.channelId, content: m.content });
    return c.json(m, 201); // m carries an extra passwordHash field
  });
  app.openapi(createRoute({
    method: "get", path: "/api/v1/channels/{channelId}/messages",
    request: { params: ChannelParams, query: HistoryQuery },
    responses: { 200: json(z.array(Message), "History"), 400: json(ErrorEnvelope, "Validation failed") },
  }), (c) => {
    const { channelId } = c.req.valid("param");
    return c.json(Array.from({ length: c.req.valid("query").limit }, () => createMessageUseCase(channelId, { content: "hello" })), 200);
  });
  // Handler returns a value that violates its response schema.
  app.openapi(createRoute({ method: "get", path: "/api/v1/broken", responses: { 200: json(Message, "Broken") } }),
    (c) => c.json({ id: 123 } as never, 200));
  app.doc31("/api/v1/openapi.json", { openapi: "3.1.0", info: { title: "Tin Can", version: "1" } });

  app.get("/gateway",
    async (c, next) => {
      if (!ALLOWED_ORIGINS.includes(c.req.header("origin") ?? "")) return c.json({ error: { code: "PERMISSION_DENIED", message: "origin" } }, 403);
      await next();
    },
    upgradeWebSocket(() => ({ onOpen: (_evt, ws) => onConnection(ws.raw as WebSocket) })));
  return { app, injectWebSocket };
}

export async function startHono(port: number) {
  const { app, injectWebSocket } = buildHono();
  const server = await new Promise<ReturnType<typeof serve>>((res) => { const s = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => res(s)); });
  injectWebSocket(server);
  return { close: () => new Promise<void>((res) => server.close(() => res())) };
}
