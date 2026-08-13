import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import {
  createConnection,
  createServer as createTcpServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { test } from "node:test";
import {
  type NetworkAttachment,
  type TcpConnection,
  type TcpSession,
  webSocketNetwork,
} from "../src/index.ts";
import { websocket_relay } from "./assets.ts";
import { collect } from "./helpers.ts";

async function relay(...publications: string[]): Promise<{ process: ChildProcess; url: string }> {
  const process = spawn(
    websocket_relay,
    [
      "--listen",
      "127.0.0.1",
      "--port",
      "0",
      ...publications.flatMap((publication) => ["--publish", publication]),
    ],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let output = "";
  for await (const chunk of process.stdout!) {
    output += chunk;
    const match = output.match(/Listening on (ws:\/\/[^\s]+)/);
    if (match) return { process, url: match[1]! };
  }
  throw new Error(`WebSocket relay exited before listening: ${output}`);
}

function guestNetwork(
  connect: (options: { port: number; signal?: AbortSignal }) => Promise<TcpConnection>,
) {
  return { address: "192.0.2.2", connect } as NetworkAttachment;
}

function echoConnection(
  transform = (bytes: Uint8Array) => bytes,
  onWrite?: () => void,
): TcpConnection {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let closed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
    },
    cancel() {
      closed = true;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk.slice());
      onWrite?.();
    },
    close() {
      if (closed) return;
      const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const input = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        input.set(chunk, offset);
        offset += chunk.byteLength;
      }
      output.enqueue(transform(input));
      output.close();
      closed = true;
    },
    abort() {
      closed = true;
    },
  });
  return {
    readable,
    writable,
    localAddr: { transport: "tcp", hostname: "192.0.2.1", port: 49152 },
    remoteAddr: { transport: "tcp", hostname: "192.0.2.2", port: 8080 },
    close() {
      if (closed) return;
      closed = true;
      output.error(new Error("connection closed"));
    },
  };
}

async function exchange(port: number, payload: Uint8Array) {
  const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  await once(socket, "connect");
  socket.end(payload);
  await once(socket, "end");
  socket.destroy();
  return new Uint8Array(Buffer.concat(chunks));
}

async function websocket(url: string) {
  const socket = new WebSocket(url, "lowland-tcp-v1");
  socket.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
      once: true,
    });
  });
  return socket;
}

function websocketMessage(socket: WebSocket) {
  return new Promise<Uint8Array>((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        if (!(event.data instanceof ArrayBuffer)) {
          reject(new Error("relay sent a non-binary test message"));
        } else {
          resolve(new Uint8Array(event.data));
        }
      },
      { once: true },
    );
    socket.addEventListener("close", () => reject(new Error("relay closed before responding")), {
      once: true,
    });
  });
}

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function stop(process: ChildProcess) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, "exit");
  process.kill();
  await exited;
}

async function close(server: Server) {
  if (!server.listening) return;
  const closed = once(server, "close");
  server.close();
  await closed;
}

async function descriptorCount(process: ChildProcess) {
  if (process.pid === undefined) throw new Error("relay has no process ID");
  return (await readdir(`/proc/${process.pid}/fd`)).length;
}

async function waitForDescriptorCount(process: ChildProcess, expected: number) {
  const deadline = Date.now() + 1_000;
  let actual = await descriptorCount(process);
  while (actual !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    actual = await descriptorCount(process);
  }
  assert.equal(actual, expected, "relay leaked the WebSocket or upstream descriptor");
}

async function within<T>(promise: Promise<T>, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("resolves DNS and relays an opaque HTTP connection over WebSocket", async () => {
  const native = await relay();
  const server = createServer((_request, response) => response.end("hello through the relay"));
  const port = await listen(server);
  try {
    const network = webSocketNetwork({ url: native.url });
    assert.ok((await network.resolveDns("localhost")).includes("127.0.0.1"));

    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const session: TcpSession = {
      target: { hostname: "127.0.0.1", port },
      readable: input.readable,
      writable: output.writable,
      signal: new AbortController().signal,
    };
    const handled = Promise.resolve().then(() => network.connectTcp(session));
    const response = collect(output.readable);
    const writer = input.writable.getWriter();
    await writer.write(
      new TextEncoder().encode("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
    );
    await writer.close();
    const [, bytes] = await Promise.all([handled, response]);
    assert.match(new TextDecoder().decode(bytes), /hello through the relay/);
  } finally {
    await close(server);
    await stop(native.process);
  }
});

test("refuses a TCP connection before consuming the guest session", async () => {
  const native = await relay();
  try {
    const network = webSocketNetwork({ url: native.url });
    let readerAcquired = false;
    const readable = new ReadableStream<Uint8Array>();
    Object.defineProperty(readable, "getReader", {
      value() {
        readerAcquired = true;
        return ReadableStream.prototype.getReader.call(readable);
      },
    });
    const session: TcpSession = {
      target: { hostname: "127.0.0.1", port: 1 },
      readable,
      writable: new WritableStream(),
      signal: new AbortController().signal,
    };
    await assert.rejects(
      () => Promise.resolve(network.connectTcp(session)),
      /upstream TCP connection failed/,
    );
    assert.equal(readerAcquired, false);
  } finally {
    await stop(native.process);
  }
});

test("aborting after a guest FIN closes the relay's upstream socket", async () => {
  const native = await relay();
  const accepted = Promise.withResolvers<void>();
  const halfClosed = Promise.withResolvers<void>();
  let upstream: Socket | undefined;
  const baselineDescriptors =
    process.platform === "linux" ? await descriptorCount(native.process) : undefined;
  const server = createTcpServer({ allowHalfOpen: true }, (socket) => {
    upstream = socket;
    accepted.resolve();
    socket.resume();
    socket.once("end", () => halfClosed.resolve());
  });
  const port = await listen(server);
  const abort = new AbortController();
  try {
    const network = webSocketNetwork({ url: native.url });
    const session: TcpSession = {
      target: { hostname: "127.0.0.1", port },
      readable: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
      writable: new WritableStream(),
      signal: abort.signal,
    };
    const handled = Promise.resolve(network.connectTcp(session));
    await within(accepted.promise, "relay did not connect upstream");
    await within(halfClosed.promise, "relay did not forward the guest FIN");

    abort.abort(new Error("browser cancelled"));
    await assert.rejects(handled, /browser cancelled/);
    if (baselineDescriptors !== undefined) {
      await waitForDescriptorCount(native.process, baselineDescriptors);
    }
  } finally {
    upstream?.destroy();
    await close(server);
    await stop(native.process);
  }
});

test("rejects disabled, unapproved, and duplicate TCP publications", async () => {
  const network = guestNetwork(async () => echoConnection());
  const disabled = await relay();
  try {
    await assert.rejects(
      () =>
        webSocketNetwork({ url: disabled.url }).publishTcp(network, {
          relayPort: 0,
          guestPort: 8080,
        }),
      /not approved/,
    );
  } finally {
    await stop(disabled.process);
  }

  const approved = await relay("0:8080");
  try {
    const adapter = webSocketNetwork({ url: approved.url });
    await assert.rejects(
      () => adapter.publishTcp(network, { relayPort: 0, guestPort: 8081 }),
      /not approved/,
    );
    const publication = await adapter.publishTcp(network, { relayPort: 0, guestPort: 8080 });
    try {
      await assert.rejects(
        () => adapter.publishTcp(network, { relayPort: 0, guestPort: 8080 }),
        /already active/,
      );
    } finally {
      publication.close();
      await publication.closed;
    }
  } finally {
    await stop(approved.process);
  }
});

test("publishes opaque, half-closed, concurrent TCP flows and can rebind", async () => {
  const native = await relay("127.0.0.1:0:8080");
  const baselineDescriptors =
    process.platform === "linux" ? await descriptorCount(native.process) : undefined;
  const invert = (bytes: Uint8Array) => Uint8Array.from(bytes, (byte) => byte ^ 0xff);
  const network = guestNetwork(async () => echoConnection(invert));
  const adapter = webSocketNetwork({ url: native.url });
  try {
    const publication = await adapter.publishTcp(network, { relayPort: 0, guestPort: 8080 });
    assert.equal(publication.guestPort, 8080);
    assert.ok(publication.relayPort > 0);
    const payloads = Array.from(
      { length: 8 },
      (_, index) => new Uint8Array([0, index, 127, 128, 255]),
    );
    const responses = await Promise.all(
      payloads.map((payload) => exchange(publication.relayPort, payload)),
    );
    assert.deepEqual(responses, payloads.map(invert));
    publication.close();
    await publication.closed;
    if (baselineDescriptors !== undefined) {
      await waitForDescriptorCount(native.process, baselineDescriptors);
    }

    const rebound = await adapter.publishTcp(network, { relayPort: 0, guestPort: 8080 });
    assert.deepEqual(
      await exchange(rebound.relayPort, new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
      new Uint8Array([0x21, 0x52, 0x41, 0x10]),
    );
    rebound.close();
    await rebound.closed;
  } finally {
    await stop(native.process);
  }
});

test("publishes an exact relay port and rejects a native client when the guest refuses", async () => {
  const reservation = createTcpServer();
  const relayPort = await listen(reservation);
  const native = await relay(`127.0.0.1:${relayPort}:8080`).finally(() => close(reservation));
  const refused = Promise.withResolvers<void>();
  const network = guestNetwork(async () => {
    refused.resolve();
    throw new Error("guest listener refused the connection");
  });
  try {
    const adapter = webSocketNetwork({ url: native.url });
    const publication = await adapter.publishTcp(network, {
      relayPort,
      guestPort: 8080,
    });
    assert.equal(publication.relayPort, relayPort);
    const socket = createConnection({ host: "127.0.0.1", port: relayPort });
    const socketClosed = once(socket, "close");
    socket.on("error", () => {});
    await once(socket, "connect");
    await within(refused.promise, "publication did not try the guest listener");
    await within(socketClosed, "relay did not reject the native connection");
    publication.close();
    await publication.closed;
    const rebound = await adapter.publishTcp(network, { relayPort, guestPort: 8080 });
    assert.equal(rebound.relayPort, relayPort);
    rebound.close();
    await rebound.closed;
  } finally {
    await stop(native.process);
  }
});

test("publication cancellation closes pending and active native connections", async () => {
  const native = await relay("127.0.0.1:0:8080");
  const baselineDescriptors =
    process.platform === "linux" ? await descriptorCount(native.process) : undefined;
  const active = Promise.withResolvers<void>();
  const network = guestNetwork(async () => {
    return echoConnection(
      (bytes) => bytes,
      () => active.resolve(),
    );
  });
  try {
    const publication = await webSocketNetwork({ url: native.url }).publishTcp(network, {
      relayPort: 0,
      guestPort: 8080,
    });
    const socket = createConnection({ host: "127.0.0.1", port: publication.relayPort });
    const socketClosed = once(socket, "close");
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(new Uint8Array([1, 2, 3]));
    await within(active.promise, "publication did not activate the inbound flow");
    publication.close();
    await publication.closed;
    await within(socketClosed, "publication did not close the native connection");
    if (baselineDescriptors !== undefined) {
      await waitForDescriptorCount(native.process, baselineDescriptors);
    }
  } finally {
    await stop(native.process);
  }
});

test("relay loss rejects the publication and closes its active native flow", async () => {
  const native = await relay("127.0.0.1:0:8080");
  const active = Promise.withResolvers<void>();
  const network = guestNetwork(async () =>
    echoConnection(
      (bytes) => bytes,
      () => active.resolve(),
    ),
  );
  let client: Socket | undefined;
  try {
    const publication = await webSocketNetwork({ url: native.url }).publishTcp(network, {
      relayPort: 0,
      guestPort: 8080,
    });
    client = createConnection({ host: "127.0.0.1", port: publication.relayPort });
    const clientClosed = once(client, "close");
    client.on("error", () => {});
    await once(client, "connect");
    client.write(new Uint8Array([1]));
    await within(active.promise, "publication did not activate the inbound flow");
    const publicationRejected = assert.rejects(
      publication.closed,
      /closed unexpectedly|connection failed/,
    );
    await stop(native.process);
    await publicationRejected;
    await within(clientClosed, "relay loss did not close the native flow");
  } finally {
    client?.destroy();
    await stop(native.process);
  }
});

test("pending publication capabilities expire after 45 seconds", async () => {
  const native = await relay("127.0.0.1:0:8080");
  let control: WebSocket | undefined;
  let flow: WebSocket | undefined;
  let client: Socket | undefined;
  try {
    control = await websocket(native.url);
    const boundMessage = websocketMessage(control);
    control.send(new Uint8Array([0x06, 0, 0, 0x1f, 0x90]));
    const bound = await boundMessage;
    assert.equal(bound[0], 0x83);
    const relayPort = new DataView(bound.buffer, bound.byteOffset, bound.byteLength).getUint16(1);

    const incomingMessage = websocketMessage(control);
    client = createConnection({ host: "127.0.0.1", port: relayPort });
    const clientClosed = once(client, "close");
    client.on("error", () => {});
    await once(client, "connect");
    const incoming = await incomingMessage;
    assert.equal(incoming.byteLength, 17);
    assert.equal(incoming[0], 0x84);

    await new Promise((resolve) => setTimeout(resolve, 46_000));
    await within(clientClosed, "expired pending connection remained open");
    flow = await websocket(native.url);
    const rejectedMessage = websocketMessage(flow);
    const accept = new Uint8Array(17);
    accept[0] = 0x07;
    accept.set(incoming.subarray(1), 1);
    flow.send(accept);
    const rejected = await rejectedMessage;
    assert.equal(rejected[0], 0xff);
    assert.match(new TextDecoder().decode(rejected.subarray(1)), /unavailable/);
  } finally {
    client?.destroy();
    flow?.close();
    control?.close();
    await stop(native.process);
  }
});

test("limits each publication to 64 pending native connections", async () => {
  const native = await relay("127.0.0.1:0:8080");
  let control: WebSocket | undefined;
  const clients: Socket[] = [];
  const closed: Promise<unknown>[] = [];
  try {
    control = await websocket(native.url);
    const boundMessage = websocketMessage(control);
    control.send(new Uint8Array([0x06, 0, 0, 0x1f, 0x90]));
    const bound = await boundMessage;
    const relayPort = new DataView(bound.buffer, bound.byteOffset, bound.byteLength).getUint16(1);
    let overflowClosed: Promise<unknown> | undefined;
    for (let index = 0; index < 65; index++) {
      const client = createConnection({ host: "127.0.0.1", port: relayPort });
      client.on("error", () => {});
      clients.push(client);
      const clientClosed = once(client, "close");
      closed.push(clientClosed);
      await once(client, "connect");
      if (index === 64) overflowClosed = clientClosed;
    }
    await within(overflowClosed!, "relay did not reject the 65th pending connection");
    control.close();
    await within(
      Promise.all(closed.slice(0, 64)),
      "closing the publication did not release pending connections",
    );
    control = undefined;
  } finally {
    for (const client of clients) client.destroy();
    control?.close();
    await stop(native.process);
  }
});
