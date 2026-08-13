// SPDX-License-Identifier: MIT

import type { NetworkAttachment, NetworkOptions, TcpConnection, TcpSession } from "./network.ts";

const SUBPROTOCOL = "lowland-tcp-v1";
const Opcode = {
  connect: 0x01,
  resolve: 0x02,
  data: 0x03,
  finish: 0x04,
  reset: 0x05,
  bind: 0x06,
  accept: 0x07,
  reject: 0x08,
  connected: 0x81,
  resolved: 0x82,
  bound: 0x83,
  incoming: 0x84,
  accepted: 0x85,
  error: 0xff,
} as const;

const CAPABILITY_LENGTH = 16;

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

export interface TcpPublicationOptions {
  /** Relay listener requested from an approved `--publish` rule. Zero asks the OS to choose. */
  relayPort: number;
  /** TCP listener inside the guest. */
  guestPort: number;
}

/** A relay listener mapped to one guest TCP port. */
export interface TcpPublication extends Disposable {
  /** TCP port inside the guest. */
  readonly guestPort: number;
  /** Effective native relay port, including an OS-assigned port requested with zero. */
  readonly relayPort: number;
  /** Settles after the listener and all of its flows have closed. */
  readonly closed: Promise<void>;
  /** Releases the relay listener and resets any pending or active flows. */
  close(): void;
}

export interface WebSocketNetwork extends NetworkOptions {
  /** Publishes an approved native relay port to a listener on `guestNetwork`. */
  publishTcp(
    guestNetwork: NetworkAttachment,
    options: TcpPublicationOptions,
  ): Promise<TcpPublication>;
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
  readonly closed: Promise<void>;
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
    const closed = Promise.withResolvers<void>();
    this.#opened = opened.promise;
    this.closed = closed.promise;
    this.#rejectOpened = opened.reject;
    this.#socket.addEventListener(
      "open",
      () => {
        if (this.#failure !== undefined) {
          this.#socket.close(1000);
          return;
        }
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
      closed.resolve();
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
    this.fail(new Error("WebSocket relay channel closed"));
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

function port_pair(opcode: number, first: number, second: number) {
  const message = new Uint8Array(5);
  const view = new DataView(message.buffer);
  message[0] = opcode;
  view.setUint16(1, first);
  view.setUint16(3, second);
  return message;
}

function valid_port(port: number, allowZero = false) {
  return Number.isInteger(port) && port >= (allowZero ? 0 : 1) && port <= 65535;
}

interface TcpStreams {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

async function bridge_tcp(relay: RelayChannel, streams: TcpStreams) {
  const reader = streams.readable.getReader();
  const writer = streams.writable.getWriter();
  try {
    const uplink = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
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
            await writer.write(message.subarray(1));
            break;
          case Opcode.finish:
            if (message.byteLength !== 1) throw new Error("invalid relay FIN message");
            await writer.close();
            return;
          case Opcode.reset:
            if (message.byteLength !== 1) throw new Error("invalid relay RESET message");
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
    await reader.cancel(error).catch(() => {});
    await writer.abort(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

class Publication implements TcpPublication {
  readonly guestPort: number;
  readonly relayPort: number;
  readonly closed: Promise<void>;
  readonly #guestNetwork: NetworkAttachment;
  readonly #control: RelayChannel;
  readonly #openChannel: (signal?: AbortSignal) => Promise<RelayChannel>;
  readonly #abort = new AbortController();
  readonly #flows = new Set<Promise<void>>();

  constructor(
    guestNetwork: NetworkAttachment,
    guestPort: number,
    relayPort: number,
    controlChannel: RelayChannel,
    openChannel: (signal?: AbortSignal) => Promise<RelayChannel>,
  ) {
    this.#guestNetwork = guestNetwork;
    this.guestPort = guestPort;
    this.relayPort = relayPort;
    this.#control = controlChannel;
    this.#openChannel = openChannel;
    this.closed = this.#run();
  }

  async #handle(capability: Uint8Array) {
    let connection: TcpConnection | undefined;
    let relay: RelayChannel | undefined;
    try {
      connection = await this.#guestNetwork.connect({
        port: this.guestPort,
        signal: this.#abort.signal,
      });
    } catch (error) {
      if (!this.#abort.signal.aborted) {
        await this.#control.send(control(Opcode.reject, capability)).catch(() => {});
      }
      return;
    }
    try {
      relay = await this.#openChannel(this.#abort.signal);
      await relay.send(control(Opcode.accept, capability));
      const response = await relay.next();
      if (response[0] === Opcode.error) throw as_error(response);
      if (response.byteLength !== 1 || response[0] !== Opcode.accepted) {
        throw new Error("WebSocket relay sent an invalid ACCEPT response");
      }
      await bridge_tcp(relay, connection);
    } catch {
      connection.close();
    } finally {
      relay?.close();
    }
  }

  async #run() {
    try {
      for (;;) {
        const message = await this.#control.next();
        if (message[0] === Opcode.error) throw as_error(message);
        if (message.byteLength !== 1 + CAPABILITY_LENGTH || message[0] !== Opcode.incoming) {
          throw new Error("WebSocket relay sent an invalid publication message");
        }
        const flow = this.#handle(message.slice(1));
        this.#flows.add(flow);
        void flow.then(
          () => this.#flows.delete(flow),
          () => this.#flows.delete(flow),
        );
      }
    } catch (error) {
      if (!this.#abort.signal.aborted) {
        this.#abort.abort(error);
        throw error;
      }
    } finally {
      this.#control.close();
      await Promise.allSettled(this.#flows);
      await this.#control.closed;
    }
  }

  close() {
    if (this.#abort.signal.aborted) return;
    this.#abort.abort(new Error("TCP publication closed"));
    this.#control.close();
  }

  [Symbol.dispose]() {
    this.close();
  }
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
}: WebSocketNetworkOptions): WebSocketNetwork {
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
      if (!valid_port(session.target.port)) {
        throw new RangeError("relay TCP port is invalid");
      }
      const relay = await channel(session.signal);
      try {
        await relay.send(request(Opcode.connect, session.target.hostname, session.target.port));
        const response = await relay.next();
        if (response[0] === Opcode.error) throw as_error(response);
        if (response.byteLength !== 1 || response[0] !== Opcode.connected) {
          throw new Error("WebSocket relay sent an invalid connect response");
        }

        // Waiting for CONNECTED before touching either stream lets the relay
        // refuse an upstream connection before the guest's SYN is accepted.
        await bridge_tcp(relay, session);
      } finally {
        relay.close();
      }
    },

    async publishTcp(guestNetwork, { relayPort, guestPort }) {
      if (!valid_port(relayPort, true))
        throw new RangeError("relayPort must be between 0 and 65535");
      if (!valid_port(guestPort)) throw new RangeError("guestPort must be between 1 and 65535");
      const relay = await channel();
      try {
        await relay.send(port_pair(Opcode.bind, relayPort, guestPort));
        const response = await relay.next();
        if (response[0] === Opcode.error) throw as_error(response);
        if (response.byteLength !== 3 || response[0] !== Opcode.bound) {
          throw new Error("WebSocket relay sent an invalid BIND response");
        }
        const effectivePort = new DataView(
          response.buffer,
          response.byteOffset,
          response.byteLength,
        ).getUint16(1);
        if (!valid_port(effectivePort)) {
          throw new Error("WebSocket relay returned an invalid bound port");
        }
        return new Publication(guestNetwork, guestPort, effectivePort, relay, channel);
      } catch (error) {
        relay.close();
        throw error;
      }
    },
  };
}
