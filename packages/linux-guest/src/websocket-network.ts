// SPDX-License-Identifier: MIT

import type { NetworkOptions, TcpSession } from "./network.ts";

const SUBPROTOCOL = "lowland-tcp-v1";
const Opcode = {
  connect: 0x01,
  resolve: 0x02,
  data: 0x03,
  finish: 0x04,
  reset: 0x05,
  connected: 0x81,
  resolved: 0x82,
  error: 0xff,
} as const;

interface WebSocketConstructor {
  new (url: string | URL, protocols?: string | string[]): WebSocket;
}

export interface WebSocketNetworkOptions {
  /**
   * WebSocket relay endpoint. Use `wss:` when the embedding page uses HTTPS.
   * A function may be supplied to mint a fresh, short-lived URL per flow.
   */
  url: string | URL | (() => string | URL | PromiseLike<string | URL>);
  /** Maximum browser-side WebSocket queue before guest reads are paused. */
  maxBufferedAmount?: number;
  /** Overrides the ambient WebSocket implementation, primarily for runtimes and tests. */
  webSocket?: WebSocketConstructor;
}

interface MessageWaiter {
  resolve(message: Uint8Array): void;
  reject(error: unknown): void;
}

function abort_error(signal: AbortSignal) {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function as_error(message: Uint8Array) {
  const text = new TextDecoder().decode(message.subarray(1));
  return new Error(text || "WebSocket relay rejected the operation");
}

class RelayChannel {
  readonly #socket: WebSocket;
  readonly #opened: Promise<void>;
  readonly #rejectOpened: (reason?: unknown) => void;
  readonly #messages: Uint8Array[] = [];
  readonly #waiters: MessageWaiter[] = [];
  readonly #signal?: AbortSignal;
  readonly #maxBufferedAmount: number;
  #failure?: unknown;

  constructor(
    url: string | URL,
    WebSocketImpl: WebSocketConstructor,
    maxBufferedAmount: number,
    signal?: AbortSignal,
  ) {
    this.#signal = signal;
    this.#maxBufferedAmount = maxBufferedAmount;
    this.#socket = new WebSocketImpl(url, SUBPROTOCOL);
    this.#socket.binaryType = "arraybuffer";
    const opened = Promise.withResolvers<void>();
    this.#opened = opened.promise;
    this.#rejectOpened = opened.reject;
    this.#socket.addEventListener(
      "open",
      () => {
        if (this.#socket.protocol !== SUBPROTOCOL) {
          this.fail(new Error(`WebSocket relay did not select ${SUBPROTOCOL}`));
          return;
        }
        opened.resolve();
      },
      { once: true },
    );
    this.#socket.addEventListener(
      "error",
      () => this.fail(new Error("WebSocket relay connection failed")),
      { once: true },
    );
    this.#socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        this.fail(new Error("WebSocket relay sent a non-binary message"));
        return;
      }
      const message = new Uint8Array(event.data);
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(message);
      else this.#messages.push(message);
    });
    this.#socket.addEventListener("close", (event) => {
      this.fail(
        new Error(event.reason || `WebSocket relay closed unexpectedly (code ${event.code})`),
      );
    });
    signal?.addEventListener("abort", () => this.fail(abort_error(signal)), { once: true });
    if (signal?.aborted) this.fail(abort_error(signal));
  }

  fail(error: unknown) {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#rejectOpened(error);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    try {
      this.#socket.close();
    } catch {
      // The original failure remains the useful error if a WebSocket
      // implementation rejects close() while still connecting.
    }
  }

  async send(message: Uint8Array<ArrayBuffer>) {
    await this.#opened;
    while (this.#socket.bufferedAmount > this.#maxBufferedAmount) {
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#signal?.aborted) throw abort_error(this.#signal);
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    if (this.#failure !== undefined) throw this.#failure;
    this.#socket.send(message);
  }

  async next() {
    await this.#opened;
    const message = this.#messages.shift();
    if (message) return message;
    if (this.#failure !== undefined) throw this.#failure;
    return new Promise<Uint8Array>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  close() {
    this.#socket.close(1000);
  }
}

function request(opcode: number, text: string, port?: number): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(text);
  const prefix = port === undefined ? 1 : 3;
  if (encoded.byteLength === 0 || encoded.byteLength > 0xffff - prefix) {
    throw new RangeError("relay hostname has an invalid length");
  }
  const message = new Uint8Array(prefix + encoded.byteLength);
  message[0] = opcode;
  if (port !== undefined) new DataView(message.buffer).setUint16(1, port);
  message.set(encoded, prefix);
  return message;
}

function control(
  opcode: number,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
): Uint8Array<ArrayBuffer> {
  const message = new Uint8Array(1 + payload.byteLength);
  message[0] = opcode;
  message.set(payload, 1);
  return message;
}

/**
 * Creates a browser-safe raw TCP adapter backed by a WebSocket relay.
 *
 * DNS lookups and TCP connections each use one WebSocket. The relay resolves
 * names and opens ordinary sockets on the browser's behalf; bytes remain
 * opaque end to end, so TLS and HTTP parsing stay inside the guest.
 */
export function webSocketNetwork({
  url,
  maxBufferedAmount = 1 << 20,
  webSocket = globalThis.WebSocket,
}: WebSocketNetworkOptions): NetworkOptions {
  if (!webSocket) throw new Error("this runtime does not provide WebSocket");
  if (!Number.isSafeInteger(maxBufferedAmount) || maxBufferedAmount < 0) {
    throw new RangeError("maxBufferedAmount must be a non-negative integer");
  }

  async function endpoint() {
    return typeof url === "function" ? await url() : url;
  }

  async function channel(signal?: AbortSignal) {
    return new RelayChannel(await endpoint(), webSocket, maxBufferedAmount, signal);
  }

  return {
    async resolveDns(hostname) {
      const relay = await channel();
      try {
        await relay.send(request(Opcode.resolve, hostname));
        const response = await relay.next();
        if (response[0] === Opcode.error) throw as_error(response);
        if (
          response[0] !== Opcode.resolved ||
          response.byteLength < 5 ||
          (response.byteLength - 1) % 4 !== 0
        ) {
          throw new Error("WebSocket relay sent an invalid DNS response");
        }
        const addresses: string[] = [];
        for (let offset = 1; offset < response.byteLength; offset += 4) {
          addresses.push(response.subarray(offset, offset + 4).join("."));
        }
        return addresses;
      } finally {
        relay.close();
      }
    },

    async connectTcp(session: TcpSession) {
      if (
        !Number.isInteger(session.target.port) ||
        session.target.port <= 0 ||
        session.target.port > 65535
      ) {
        throw new RangeError("relay TCP port is invalid");
      }
      const relay = await channel(session.signal);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
      try {
        await relay.send(request(Opcode.connect, session.target.hostname, session.target.port));
        const response = await relay.next();
        if (response[0] === Opcode.error) throw as_error(response);
        if (response.byteLength !== 1 || response[0] !== Opcode.connected) {
          throw new Error("WebSocket relay sent an invalid connect response");
        }

        // Waiting for CONNECTED before touching either stream lets the relay
        // refuse an upstream connection before the guest's SYN is accepted.
        reader = session.readable.getReader();
        writer = session.writable.getWriter();
        const uplink = (async () => {
          for (;;) {
            const { value, done } = await reader!.read();
            if (done) break;
            await relay.send(control(Opcode.data, value));
          }
          await relay.send(control(Opcode.finish));
        })();
        const downlink = (async () => {
          for (;;) {
            const message = await relay.next();
            switch (message[0]) {
              case Opcode.data:
                await writer!.write(message.subarray(1));
                break;
              case Opcode.finish:
                if (message.byteLength !== 1) throw new Error("invalid relay FIN message");
                await writer!.close();
                return;
              case Opcode.reset:
                throw new Error("WebSocket relay reset the TCP connection");
              case Opcode.error:
                throw as_error(message);
              default:
                throw new Error("WebSocket relay sent an invalid TCP message");
            }
          }
        })();
        await Promise.all([uplink, downlink]);
      } catch (error) {
        await relay.send(control(Opcode.reset)).catch(() => {});
        await reader?.cancel(error).catch(() => {});
        await writer?.abort(error).catch(() => {});
        throw error;
      } finally {
        reader?.releaseLock();
        writer?.releaseLock();
        relay.close();
      }
    },
  };
}
