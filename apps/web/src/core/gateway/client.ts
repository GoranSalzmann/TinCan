// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  API_VERSION,
  CloseCode,
  GATEWAY_PATH,
  GATEWAY_VERSION,
  NON_RESUMABLE_CLOSE_CODES,
  Op,
  type ClientInfo,
  type HelloPayload,
} from "@tincan/shared";

/**
 * Gateway client (07 §4, 12 §3): connect, identify, heartbeat, resume with a sequence number, and
 * reconnect with exponential backoff (1 s → 30 s, jitter). It owns no UI state; callers read `onState`.
 */

export type GatewayState =
  | "connecting"
  | "ready"
  | "reconnecting"
  | "closed"
  /** The server revoked the login (close 4004): the app should return to the login screen. */
  | "unauthenticated"
  /** The server speaks a newer API than this client (close 4011). */
  | "too-old";

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface GatewayOptions {
  url: string;
  /** A fresh single-use ticket for every connection attempt (the web session cookie is not readable by scripts). */
  getCredentials: () => Promise<{ ticket: string } | { token: string }>;
  client: ClientInfo;
  onState?: (state: GatewayState) => void;
  onDispatch?: (t: string, d: unknown, s: number) => void;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
  backoff?: { minMs: number; maxMs: number };
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

const OPEN = 1;

export function gatewayUrl(origin: Location | { protocol: string; host: string }): string {
  const scheme = origin.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${origin.host}${GATEWAY_PATH}?v=${GATEWAY_VERSION}&encoding=json`;
}

export class GatewayClient {
  readonly #o: GatewayOptions;
  #socket: SocketLike | null = null;
  #state: GatewayState = "closed";
  #sessionId: string | null = null;
  #lastSeq = 0;
  #attempt = 0;
  #stopped = true;
  #heartbeat: unknown;
  #awaitingAck = false;
  #retry: unknown;
  #generation = 0;
  #commandId = 0;

  constructor(options: GatewayOptions) {
    this.#o = options;
  }

  get state(): GatewayState {
    return this.#state;
  }
  get sessionId(): string | null {
    return this.#sessionId;
  }
  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** Sends a gateway command (07 §4.6) such as typing.start; dropped silently while not connected. */
  command(cmd: string, args: unknown): void {
    const s = this.#socket;
    if (!s || s.readyState !== OPEN || this.#state !== "ready") return;
    s.send(JSON.stringify({ op: Op.COMMAND, d: { cmd, args, id: ++this.#commandId } }));
  }

  connect(): void {
    this.#stopped = false;
    this.#open();
  }

  disconnect(): void {
    this.#stopped = true;
    this.#generation++;
    this.#clearTimers();
    const s = this.#socket;
    this.#socket = null;
    if (s && s.readyState <= OPEN) s.close(CloseCode.NORMAL, "client closing");
    this.#sessionId = null;
    this.#lastSeq = 0;
    this.#set("closed");
  }

  #set(state: GatewayState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#o.onState?.(state);
  }

  #timer(fn: () => void, ms: number): unknown {
    return (this.#o.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  }
  #untimer(id: unknown): void {
    (this.#o.clearTimer ?? ((i) => clearTimeout(i as ReturnType<typeof setTimeout>)))(id);
  }
  #clearTimers(): void {
    this.#untimer(this.#heartbeat);
    this.#untimer(this.#retry);
    this.#heartbeat = undefined;
    this.#retry = undefined;
  }

  #open(): void {
    const generation = ++this.#generation;
    this.#set(this.#sessionId ? "reconnecting" : "connecting");
    const socket = (this.#o.createSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike))(this.#o.url);
    this.#socket = socket;
    socket.onmessage = (ev) => {
      if (generation === this.#generation) void this.#onFrame(socket, String(ev.data));
    };
    socket.onclose = (ev) => {
      if (generation === this.#generation) this.#onClose(ev.code);
    };
    socket.onerror = () => undefined; // a close event always follows
  }

  async #onFrame(socket: SocketLike, raw: string): Promise<void> {
    let frame: { op: number; t?: string; s?: number; d?: unknown };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    switch (frame.op) {
      case Op.HELLO: {
        const hello = frame.d as HelloPayload;
        if (hello.apiVersion !== API_VERSION) {
          socket.close(CloseCode.NORMAL, "api version mismatch");
          this.#stopped = true;
          this.#set("too-old");
          return;
        }
        this.#startHeartbeat(socket, hello.heartbeatIntervalMs);
        await this.#authenticate(socket);
        return;
      }
      case Op.HEARTBEAT_ACK:
        this.#awaitingAck = false;
        return;
      case Op.HEARTBEAT:
        this.#beat(socket);
        return;
      case Op.RECONNECT:
        socket.close(CloseCode.GOING_AWAY, "server asked to reconnect");
        return;
      case Op.INVALID_SESSION:
        // The server no longer has our session (or the replay window passed): start over with IDENTIFY.
        this.#sessionId = null;
        this.#lastSeq = 0;
        await this.#authenticate(socket);
        return;
      case Op.DISPATCH: {
        if (typeof frame.s === "number" && frame.s > this.#lastSeq) this.#lastSeq = frame.s;
        if (frame.t === "READY") {
          this.#sessionId = String((frame.d as { sessionId: string }).sessionId);
          this.#lastSeq = 0;
          this.#attempt = 0;
          this.#set("ready");
        } else if (frame.t === "RESUMED") {
          this.#attempt = 0;
          this.#set("ready");
        }
        if (frame.t !== undefined) this.#o.onDispatch?.(frame.t, frame.d, frame.s ?? 0);
        return;
      }
    }
  }

  async #authenticate(socket: SocketLike): Promise<void> {
    let creds: { ticket: string } | { token: string };
    try {
      creds = await this.#o.getCredentials();
    } catch {
      socket.close(CloseCode.NORMAL, "no credentials"); // onclose schedules a retry
      return;
    }
    if (this.#socket !== socket || socket.readyState !== OPEN) return;
    const frame = this.#sessionId
      ? { op: Op.RESUME, d: { ...creds, sessionId: this.#sessionId, lastSeq: this.#lastSeq } }
      : { op: Op.IDENTIFY, d: { ...creds, client: this.#o.client } };
    socket.send(JSON.stringify(frame));
  }

  #startHeartbeat(socket: SocketLike, intervalMs: number): void {
    this.#untimer(this.#heartbeat);
    this.#awaitingAck = false;
    const tick = () => {
      // Two missed acks in a row means the connection is dead even if the socket still says open (07 §4.3).
      if (this.#awaitingAck) {
        socket.close(CloseCode.NORMAL, "heartbeat not acknowledged");
        return;
      }
      this.#beat(socket);
      this.#heartbeat = this.#timer(tick, intervalMs);
    };
    // The first beat is jittered so many clients do not beat in lockstep after a server restart.
    this.#heartbeat = this.#timer(tick, Math.floor(intervalMs * (this.#o.random ?? Math.random)()));
  }

  #beat(socket: SocketLike): void {
    if (socket.readyState !== OPEN) return;
    this.#awaitingAck = true;
    socket.send(JSON.stringify({ op: Op.HEARTBEAT, d: this.#lastSeq }));
  }

  #onClose(code: number): void {
    this.#clearTimers();
    this.#socket = null;
    if (this.#stopped) return;
    if (code === CloseCode.AUTH_FAILED) {
      this.#stopped = true;
      this.#sessionId = null;
      this.#set("unauthenticated");
      return;
    }
    if (code === CloseCode.CLIENT_TOO_OLD) {
      this.#stopped = true;
      this.#set("too-old");
      return;
    }
    if (NON_RESUMABLE_CLOSE_CODES.includes(code)) {
      // Resuming would be refused; keep the connection loop but start over with IDENTIFY.
      this.#sessionId = null;
      this.#lastSeq = 0;
    }
    this.#set("reconnecting");
    const { minMs, maxMs } = this.#o.backoff ?? { minMs: 1000, maxMs: 30_000 };
    const base = Math.min(maxMs, minMs * 2 ** this.#attempt++);
    const delay = Math.round(base / 2 + ((this.#o.random ?? Math.random)() * base) / 2);
    this.#retry = this.#timer(() => {
      if (!this.#stopped) this.#open();
    }, delay);
  }
}
