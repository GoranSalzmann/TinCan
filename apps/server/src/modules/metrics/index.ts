// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { z } from "zod";
import { AppError } from "@tincan/shared";
import type { KernelFacade } from "../../framework/kernel.js";
import { defineModule } from "../../framework/types.js";
import { VERSION } from "../../version.js";
import type { UploadsApi } from "../uploads/api.js";
import type { VoiceApi } from "../voice/api.js";

const ConfigSchema = z.strictObject({
  /**
   * Bearer token for Prometheus. Without one, `GET /api/v1/metrics` answers only the instance owner (with a session
   * token) and requests that reach the server directly over loopback; `tincan init` generates one.
   */
  token: z.string().min(16).optional(),
});

const sha = (s: string) => createHash("sha256").update(s).digest();
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Prometheus metrics (14 §8). Protected: token, owner session, or a direct loopback connection with no proxy header. */
export default defineModule({
  id: "metrics",
  version: VERSION,
  dependsOn: [],
  requiresPorts: [],
  configSchema: ConfigSchema,
  register(ctx) {
    const kernel = ctx.api.get<KernelFacade>("kernel");
    if (!kernel) throw new Error("metrics: the runtime did not provide its kernel facade");
    const m = kernel.metrics;
    const uploads = () => ctx.api.get<UploadsApi>("uploads");
    const voice = () => ctx.api.get<VoiceApi>("voice");

    // ---- process ----
    const delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    const rss = m.gauge("process_resident_memory_bytes", "Resident set size");
    const heap = m.gauge("process_heap_used_bytes", "V8 heap in use");
    const buffers = m.gauge(
      "process_array_buffers_bytes",
      "Memory held by Buffers and ArrayBuffers (uploads live here)",
    );
    const uptime = m.gauge("process_uptime_seconds", "Seconds since the process started");
    const cpu = m.counter("process_cpu_seconds_total", "CPU time used by the process");
    const lagMean = m.gauge(
      "nodejs_eventloop_lag_mean_seconds",
      "Mean event loop delay since the last scrape",
    );
    const lagP99 = m.gauge(
      "nodejs_eventloop_lag_p99_seconds",
      "99th percentile event loop delay since the last scrape",
    );
    const lagMax = m.gauge(
      "nodejs_eventloop_lag_max_seconds",
      "Worst event loop delay since the last scrape",
    );
    m.collect(() => {
      const mem = process.memoryUsage();
      rss.set(mem.rss);
      heap.set(mem.heapUsed);
      buffers.set(mem.arrayBuffers);
      uptime.set(process.uptime());
      const c = process.cpuUsage();
      cpu.setTotal(undefined, (c.user + c.system) / 1e6);
      lagMean.set(Number.isNaN(delay.mean) ? 0 : delay.mean / 1e9);
      lagP99.set(delay.percentile(99) / 1e9);
      lagMax.set(delay.max / 1e9);
      delay.reset();
    });

    // ---- backups: written by `tincan backup` beside the archives (14 §6) ----
    const lastBackup = m.gauge(
      "tincan_last_backup_timestamp_seconds",
      "Unix time of the newest successful backup; 0 when there never was one",
    );
    const lastBackupFailed = m.gauge(
      "tincan_last_backup_failed",
      "1 when the newest backup run failed after the newest success",
    );
    const backupDir = join(ctx.core.dataDir, "backups");
    const readMarker = async (name: string): Promise<number | null> => {
      try {
        const at = (JSON.parse(await readFile(join(backupDir, name), "utf8")) as { at?: unknown }).at;
        const ms = typeof at === "string" ? Date.parse(at) : NaN;
        return Number.isNaN(ms) ? null : ms;
      } catch {
        return null;
      }
    };
    m.collect(async () => {
      const [ok, bad] = await Promise.all([
        readMarker("last-backup.json"),
        readMarker("last-backup-error.json"),
      ]);
      lastBackup.set(ok === null ? 0 : Math.floor(ok / 1000));
      lastBackupFailed.set(bad !== null && (ok === null || bad > ok) ? 1 : 0);
    });

    // ---- the runtime ----
    const info = m.gauge("tincan_build_info", "Always 1; the labels carry the version", ["version"]);
    info.set(1, { version: VERSION });
    const sockets = m.gauge(
      "tincan_gateway_sessions",
      "Gateway sessions held (connected or inside the resume window)",
    );
    const online = m.gauge("tincan_gateway_users_online", "Users with at least one gateway connection");
    const jobRuns = m.counter("tincan_job_runs_total", "Scheduled job runs", ["job"]);
    const jobFail = m.counter("tincan_job_failures_total", "Scheduled job runs that threw", ["job"]);
    const jobSkip = m.counter(
      "tincan_job_skipped_overlaps_total",
      "Runs skipped because the last one was still going",
      ["job"],
    );
    const jobMs = m.gauge("tincan_job_last_duration_seconds", "Duration of the last run of a job", ["job"]);
    const busFail = m.counter("tincan_event_handler_failures_total", "Event handlers that threw");
    const outboxBacklog = m.gauge("tincan_outbox_backlog", "Outbox entries waiting to be processed");
    const dbPing = m.gauge("tincan_db_ping_seconds", "Time for a trivial query at scrape time");
    m.collect(async () => {
      sockets.set(kernel.hub.sessions.size);
      online.set(kernel.hub.onlineUserIds().length);
      for (const j of kernel.scheduler.stats()) {
        jobRuns.setTotal({ job: j.name }, j.runs);
        jobFail.setTotal({ job: j.name }, j.failures);
        jobSkip.setTotal({ job: j.name }, j.skippedOverlaps);
        if (j.lastDurationMs !== null) jobMs.set(j.lastDurationMs / 1000, { job: j.name });
      }
      busFail.setTotal(undefined, kernel.events.failures.count);
      outboxBacklog.set(await kernel.outbox.backlog());
      const t0 = performance.now();
      await kernel.db.health();
      dbPing.set((performance.now() - t0) / 1000);
    });

    // ---- voice (18 T34: a sustained non-zero repair rate means a primary path is broken) ----
    const repairs = m.counter("tincan_reconcile_repairs_total", "Voice reconciliation repairs by kind", [
      "kind",
    ]);
    const reconRuns = m.counter("tincan_voice_reconcile_runs_total", "Voice reconciliation passes");
    const reconFail = m.counter(
      "tincan_voice_reconcile_failures_total",
      "Voice reconciliation passes that could not reach LiveKit",
    );
    const reconMs = m.gauge(
      "tincan_voice_reconcile_last_duration_seconds",
      "Duration of the last reconciliation pass",
    );
    const lkUp = m.gauge(
      "tincan_livekit_reachable",
      "1 when the last reconciliation reached LiveKit, 0 when not",
    );
    const hooks = m.counter("tincan_voice_webhooks_total", "LiveKit webhooks applied, by event", ["event"]);
    const hookBad = m.counter("tincan_voice_webhooks_rejected_total", "Webhooks with a bad signature");
    const hookDup = m.counter("tincan_voice_webhooks_duplicate_total", "Webhooks seen twice");
    const hookLag = m.gauge("tincan_voice_webhook_lag_seconds", "Age of the newest webhook when it arrived");
    const rotations = m.counter("tincan_voice_e2ee_rotations_total", "Key rotations of encrypted calls");
    const rooms = m.gauge("tincan_voice_rooms", "Voice rooms with at least one person");
    const people = m.gauge("tincan_voice_participants", "People in voice, over all rooms");
    m.collect(() => {
      const v = voice();
      if (!v) return;
      const s = v.stats();
      for (const [kind, n] of Object.entries(s.reconcile.repairs)) repairs.setTotal({ kind }, n);
      reconRuns.setTotal(undefined, s.reconcile.runs);
      reconFail.setTotal(undefined, s.reconcile.failures);
      if (s.reconcile.lastDurationMs !== null) reconMs.set(s.reconcile.lastDurationMs / 1000);
      if (s.reconcile.livekitReachable !== null) lkUp.set(s.reconcile.livekitReachable ? 1 : 0);
      for (const [event, n] of Object.entries(s.webhooks.byEvent)) hooks.setTotal({ event }, n);
      hookBad.setTotal(undefined, s.webhooks.rejected);
      hookDup.setTotal(undefined, s.webhooks.duplicates);
      if (s.webhooks.lastLagMs !== null) hookLag.set(s.webhooks.lastLagMs / 1000);
      rotations.setTotal(undefined, s.e2ee.rotations);
      const occupancy = v.occupancy();
      rooms.set(occupancy.filter((n) => n > 0).length);
      people.set(occupancy.reduce((a, b) => a + b, 0));
    });

    // ---- uploads (the 512 MiB per-file ceiling is held in memory, 18 §L) ----
    const upCount = m.counter("tincan_uploads_total", "Uploads accepted");
    const upBytes = m.counter("tincan_upload_bytes_total", "Bytes of accepted uploads");
    const upRejected = m.counter(
      "tincan_uploads_rejected_total",
      "Uploads refused (size, quota, type, rate, permission)",
    );
    const upBusy = m.counter(
      "tincan_uploads_busy_total",
      "Uploads told to retry because the memory budget was in use",
    );
    const upInflight = m.gauge("tincan_uploads_in_flight", "Uploads being processed right now");
    const upMem = m.gauge(
      "tincan_uploads_in_flight_bytes",
      "Memory held by uploads being processed right now",
    );
    const upPeak = m.gauge(
      "tincan_uploads_in_flight_peak_bytes",
      "Largest tincan_uploads_in_flight_bytes since the start",
    );
    m.collect(() => {
      const u = uploads()?.stats();
      if (!u) return;
      upCount.setTotal(undefined, u.uploads);
      upBytes.setTotal(undefined, u.bytes);
      upRejected.setTotal(undefined, u.rejected);
      upBusy.setTotal(undefined, u.busy);
      upInflight.set(u.inFlight);
      upMem.set(u.inFlightBytes);
      upPeak.set(u.peakInFlightBytes);
    });

    // ---- moderation and audit ----
    const audit = m.counter(
      "tincan_audit_events_total",
      "Audit entries recorded since the start, by action",
      ["action"],
    );
    ctx.events.on("audit.recorded", (e) => audit.inc({ action: e.action }));

    ctx.capabilities.feature("metrics", true);

    // ---- the endpoint ----
    const expected = ctx.config.token ? sha(ctx.config.token) : null;
    ctx.http.get("/metrics", async (req, reply) => {
      const auth = req.headers.authorization;
      const bearer = auth ? /^Bearer\s+(\S+)$/i.exec(auth)?.[1] : undefined;
      let allowed = false;
      if (bearer && expected && timingSafeEqual(sha(bearer), expected)) allowed = true;
      if (!allowed && (bearer || req.headers.cookie)) {
        // A session that belongs to the owner may read it too.
        try {
          await ctx.http.requireOwner(req);
          allowed = true;
        } catch {
          // fall through to the refusal below
        }
      }
      // Direct loopback only: behind Caddy the socket peer is Caddy's container, and Caddy adds X-Forwarded-For.
      if (!allowed && LOOPBACK.has(req.raw.socket.remoteAddress ?? "") && !req.headers["x-forwarded-for"])
        allowed = true;
      if (!allowed)
        throw new AppError("PERMISSION_DENIED", "Metrics are for the owner or a scraper with the token.");
      return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(await m.render());
    });
  },
});
