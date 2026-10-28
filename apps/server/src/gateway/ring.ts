// SPDX-License-Identifier: AGPL-3.0-or-later

interface Entry {
  s: number;
  at: number;
  frame: string;
}

/**
 * Per-session replay buffer for RESUME (07 §4.3): the last `maxEvents` events or `maxAgeMs`,
 * whichever is smaller. Sequence numbers are strictly increasing and gap-free per session.
 */
export class RingBuffer {
  readonly #entries: Entry[] = [];
  readonly #maxEvents: number;
  readonly #maxAgeMs: number;

  constructor(maxEvents: number, maxAgeMs: number) {
    this.#maxEvents = maxEvents;
    this.#maxAgeMs = maxAgeMs;
  }

  push(s: number, frame: string, now: number): void {
    this.#entries.push({ s, at: now, frame });
    this.#trim(now);
  }

  #trim(now: number): void {
    while (this.#entries.length > this.#maxEvents) this.#entries.shift();
    while (this.#entries.length > 0 && now - this.#entries[0]!.at > this.#maxAgeMs) this.#entries.shift();
  }

  /**
   * Frames with `s > lastSeq`, or null if the buffer no longer reaches back that far (the client
   * must start over with IDENTIFY). `currentSeq` is the latest sequence number issued.
   */
  since(lastSeq: number, currentSeq: number, now: number): string[] | null {
    this.#trim(now);
    if (lastSeq === currentSeq) return [];
    const first = this.#entries[0];
    if (!first || first.s > lastSeq + 1) return null;
    return this.#entries.filter((e) => e.s > lastSeq).map((e) => e.frame);
  }

  get size(): number {
    return this.#entries.length;
  }
}
