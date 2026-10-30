// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `tincan backup --daemon --at 03:30` keeps running and makes one backup a day, so a Host without cron can use the
 * `backup` compose profile. The clock is the container's (UTC unless TZ is set).
 */

/** Parses "HH:MM" (24 hours); throws a sentence a Host can act on. */
export function parseTimeOfDay(at: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  const hour = m ? Number(m[1]) : NaN;
  const minute = m ? Number(m[2]) : NaN;
  if (!m || hour > 23 || minute > 59) throw new Error(`--at needs a time like 03:30 (24 hours), not "${at}"`);
  return { hour, minute };
}

/** The next moment after `now` (exclusive) that the local clock reads `at`. */
export function nextRun(now: Date, at: string): Date {
  const { hour, minute } = parseTimeOfDay(at);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export interface ScheduleDeps {
  at: string;
  run: () => Promise<void>;
  log: (line: string) => void;
  now?: () => Date;
  /** Resolves after `ms`, or rejects/returns early when stopped. Injected so tests need no real time. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    // setTimeout caps at about 24.8 days; a day is far below that.
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Runs `run` at `at` every day until `signal` aborts. A failing run is logged and does not stop the schedule: the
 * next night tries again, and `last-backup-error.json` (written by the backup itself) tells `doctor`.
 */
export async function runSchedule(d: ScheduleDeps): Promise<void> {
  const now = d.now ?? (() => new Date());
  const sleep = d.sleep ?? realSleep;
  while (!d.signal.aborted) {
    const next = nextRun(now(), d.at);
    d.log(`Next backup at ${next.toISOString()}`);
    await sleep(next.getTime() - now().getTime(), d.signal);
    if (d.signal.aborted) return;
    try {
      await d.run();
    } catch (err) {
      d.log(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
