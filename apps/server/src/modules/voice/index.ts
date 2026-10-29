// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { AppError, VoiceStateArgsSchema } from "@tincan/shared";
import { defineModule, type AnyManifest } from "../../framework/types.js";
import { VERSION } from "../../version.js";
import type { AccountsApi } from "../accounts/api.js";
import type { ChannelsApi } from "../channels/api.js";
import type { RolesApi } from "../roles/api.js";
import type { VoiceApi } from "./api.js";
import { sdkWebhookVerifier, SdkLiveKit, type LiveKitRooms, type WebhookVerifier } from "./livekit.js";
import { registerVoiceRoutes } from "./routes.js";
import { voiceMigrations, type VoiceTables } from "./schema.js";
import { VoiceService } from "./service.js";

const ConfigSchema = z.strictObject({
  /** 08 §3.3: a channel without its own limit. */
  defaultUserLimit: z.number().int().min(1).max(99).default(25),
  /** Speech target of 08 §6, per channel up to 128. */
  audioBitrateKbps: z.number().int().min(8).max(128).default(40),
  /** Join tokens only have to survive connecting; LiveKit refreshes them for a live session (D1). */
  tokenTtlSecs: z.number().int().min(30).max(3600).default(600),
  /** 08 §5.2: camera 720p30 top layer is 1.2-1.7 Mbps; the screen share cap is the Host's lever on egress (08 §5.5). */
  camera: z.strictObject({ maxBitrateKbps: z.number().int().min(150).max(8000).default(1700) }).prefault({}),
  screenshare: z
    .strictObject({ maxBitrateKbps: z.number().int().min(300).max(20_000).default(6000) })
    .prefault({}),
  emptyTimeoutSecs: z.number().int().min(10).max(3600).default(60),
  departureTimeoutSecs: z.number().int().min(5).max(120).default(20),
  /** 07 §2.4: voice join 10 per minute per user. */
  joinRate: z
    .strictObject({
      max: z.number().int().min(1).default(10),
      windowSecs: z.number().int().min(1).default(60),
    })
    .prefault({}),
  /** 05 §7: presence.reconcile, 30 s. */
  reconcileIntervalMs: z.number().int().min(1000).default(30_000),
});

export interface VoiceOverrides {
  rooms?: LiveKitRooms;
  verify?: WebhookVerifier;
}

/** Voice channels on LiveKit: rooms, tokens from permissions, webhooks, presence and the reconciler (08, 05 §6). */
export function createVoiceModule(overrides: VoiceOverrides = {}): AnyManifest {
  return defineModule({
    id: "voice",
    version: VERSION,
    dependsOn: ["channels"],
    requiresPorts: ["db", "pubsub", "livekit"],
    // On when a LiveKit server is configured; `modules.voice.enabled: false` turns it off.
    enabledByDefault: (ports) => ports.has("livekit"),
    configSchema: ConfigSchema,
    migrations: voiceMigrations,
    async register(ctx) {
      const roles = ctx.api.get<RolesApi>("roles");
      const channels = ctx.api.get<ChannelsApi>("channels");
      const accounts = ctx.api.get<AccountsApi>("accounts");
      if (!roles || !channels || !accounts) throw new AppError("INTERNAL", "voice: a dependency is missing");
      const lk = ctx.ports.livekit;
      const cfg = ctx.config;
      const svc = new VoiceService({
        db: ctx.ports.db.as<VoiceTables>(),
        // A copy: the owner's runtime changes must not write into the shared config object.
        settings: { ...cfg, camera: { ...cfg.camera }, screenshare: { ...cfg.screenshare } },
        livekit: { url: lk.url, apiKey: lk.apiKey, apiSecret: lk.apiSecret },
        rooms: overrides.rooms ?? new SdkLiveKit(lk.apiUrl, lk.apiKey, lk.apiSecret),
        verify: overrides.verify ?? sdkWebhookVerifier(lk.apiKey, lk.apiSecret),
        roles,
        channels,
        accounts,
        gateway: ctx.gateway,
        kv: ctx.ports.pubsub.kv,
        log: ctx.log,
      });

      await svc.loadStoredLimits();
      registerVoiceRoutes(ctx.http, svc, roles);

      ctx.gateway.onCommand("voice.state", (args, { actor }) => {
        const parsed = VoiceStateArgsSchema.safeParse(args);
        if (!parsed.success) throw new AppError("VALIDATION_FAILED", "voice.state needs muted and deafened.");
        svc.setSelfState(actor.userId, parsed.data.muted, parsed.data.deafened);
      });
      ctx.gateway.contributeReady(async (actor) => ({ voice: await svc.snapshotFor(actor.userId) }));

      // Fast path of T25: push permission changes to LiveKit within seconds; the reconciler is the backstop.
      ctx.events.on("permissions.changed", ({ userIds, channelId }) => svc.enforceMany(userIds, channelId));
      ctx.events.on("user.disabled", ({ userId }) => svc.enforce(userId));
      ctx.events.on("channel.updated", ({ channelId }) => svc.enforceMany("all", channelId));
      ctx.events.on("channel.deleted", ({ channelId }) => svc.channelRemoved(channelId));
      ctx.jobs.every("voice.reconcile", cfg.reconcileIntervalMs, () => svc.reconcile(), { runOnStart: true });

      // Preferences that follow the person across devices (12 §8); device ids stay local.
      accounts.registerSetting("audio.preset", z.enum(["voice", "music", "quiet"]));
      accounts.registerSetting("audio.noiseTier", z.enum(["off", "browser", "rnnoise"]));
      accounts.registerSetting("audio.pushToTalk", z.boolean());

      ctx.capabilities.feature("voice", { defaultUserLimit: cfg.defaultUserLimit });
      const api: VoiceApi = {
        participants: (channelId) => svc.presence.inChannel(channelId).map((e) => svc.wire(e)),
        stats: () => svc.stats,
        reconcileNow: () => svc.reconcile(),
      };
      ctx.api.provide("voice", api);
    },
  });
}

export default createVoiceModule();
