// Fastify 5 + @fastify/websocket + fastify-type-provider-zod + @fastify/swagger.
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import { z } from "zod";
import {
  serializerCompiler, validatorCompiler, jsonSchemaTransform, type ZodTypeProvider,
  hasZodFastifySchemaValidationErrors, isResponseSerializationError,
} from "fastify-type-provider-zod";
import { ALLOWED_ORIGINS, ChannelParams, CreateMessageBody, ErrorEnvelope, HistoryQuery, MAX_CLIENT_FRAME, Message, createMessageUseCase } from "./shared.js";
import { broadcast, onConnection } from "./gateway.js";

export async function buildFastify() {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((err, _req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "Invalid request", details: err.validation } });
    }
    if (isResponseSerializationError(err)) return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal error" } });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const code = status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "BAD_REQUEST" : "INTERNAL";
    return reply.code(status).send({ error: { code, message: status === 500 ? "Internal error" : (err as Error).message } });
  });
  await app.register(swagger, {
    openapi: { openapi: "3.1.0", info: { title: "Tin Can", version: "1" } },
    transform: jsonSchemaTransform,
  });
  await app.register(websocket, { options: { maxPayload: MAX_CLIENT_FRAME } });

  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post("/api/v1/channels/:channelId/messages", {
    schema: { params: ChannelParams, body: CreateMessageBody, response: { 201: Message, 400: ErrorEnvelope } },
  }, async (req, reply) => {
    const m = createMessageUseCase(req.params.channelId, req.body);
    broadcast("MESSAGE_CREATE", { id: m.id, channelId: m.channelId, content: m.content });
    return reply.code(201).send(m); // m carries an extra passwordHash field
  });
  r.get("/api/v1/channels/:channelId/messages", {
    schema: { params: ChannelParams, querystring: HistoryQuery, response: { 200: z.array(Message) } },
  }, async (req) => Array.from({ length: req.query.limit }, () => createMessageUseCase(req.params.channelId, { content: "hello" })));
  // Handler returns a value that violates its response schema.
  r.get("/api/v1/broken", { schema: { response: { 200: Message } } }, async () => ({ id: 123 }) as never);
  app.get("/api/v1/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  await app.register(async (scope) => {
    // Runs before the upgrade, so a bad Origin gets a plain 403 and no socket.
    scope.addHook("preValidation", async (req, reply) => {
      if (!ALLOWED_ORIGINS.includes(String(req.headers.origin))) return reply.code(403).send({ error: { code: "PERMISSION_DENIED", message: "origin" } });
    });
    scope.get("/gateway", { websocket: true, schema: { hide: true } }, (socket) => onConnection(socket));
  });
  return app;
}

export async function startFastify(port: number) {
  const app = await buildFastify();
  await app.listen({ port, host: "127.0.0.1" });
  return { close: () => app.close() };
}
