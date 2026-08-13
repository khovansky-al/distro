import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { test } from "node:test";
import { type TcpSession, webSocketNetwork } from "../src/index.ts";
import { websocket_relay } from "./assets.ts";
import { collect } from "./helpers.ts";

async function relay(): Promise<{ process: ChildProcess; url: string }> {
  const process = spawn(websocket_relay, ["--listen", "127.0.0.1", "--port", "0"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  for await (const chunk of process.stdout!) {
    output += chunk;
    const match = output.match(/Listening on (ws:\/\/[^\s]+)/);
    if (match) return { process, url: match[1]! };
  }
  throw new Error(`WebSocket relay exited before listening: ${output}`);
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
