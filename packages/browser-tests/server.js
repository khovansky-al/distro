import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = process.cwd();
let relayProcess;
let relayUrl;

async function startRelay(command) {
  relayProcess = spawn(
    command,
    ["--listen", "127.0.0.1", "--port", "0", "--publish", "127.0.0.1:0:8080"],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let output = "";
  const ready = Promise.withResolvers();
  relayProcess.stdout.setEncoding("utf8");
  relayProcess.stdout.on("data", (chunk) => {
    output += chunk;
    const match = output.match(/Listening on (ws:\/\/[^\s]+)/);
    if (match) ready.resolve(match[1]);
  });
  relayProcess.once("error", ready.reject);
  relayProcess.once("exit", (code, signal) => {
    ready.reject(
      new Error(
        `WebSocket relay exited before listening (code ${code}, signal ${signal}): ${output}`,
      ),
    );
  });
  return ready.promise;
}

if (process.env.WEBSOCKET_RELAY) {
  relayUrl = await startRelay(process.env.WEBSOCKET_RELAY);
}

process.once("exit", () => relayProcess?.kill());
const types = {
  ".cpio": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".erofs": "application/octet-stream",
  ".wasm": "application/wasm",
};

// The guest root disk and the scheduler-handoff initramfs are nix build
// products: present in the packed suite the checks run against, absent in a
// dev checkout, where we build them ourselves. Same contract as
// packages/linux-guest/tests/assets.ts, including $LINUX_GUEST_TEST_ASSETS.
const built = new Map();
function build(attribute) {
  if (!built.has(attribute)) {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    built.set(
      attribute,
      promisify(execFile)("nix", [
        "build",
        `${repository}#${attribute}`,
        "--no-link",
        "--print-out-paths",
      ]).then(({ stdout }) => stdout.trim()),
    );
  }
  return built.get(attribute);
}

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  if (pathname === "/relay-info.json") {
    if (!relayUrl) {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.stringify({
      relayUrl,
      targetPort: server.address().port,
    });
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
    return;
  }
  if (pathname === "/relay-fixture") {
    const body = "hello from the browser WebSocket relay\n";
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      Connection: "close",
    });
    response.end(body);
    return;
  }
  const relative = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
  let path = join(root, relative);
  if (!path.startsWith(`${root}/`)) {
    response.writeHead(403).end();
    return;
  }
  const exists = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (!exists(path)) {
    try {
      if (relative === "rootfs.erofs") {
        const directory =
          process.env.LINUX_GUEST_TEST_ASSETS ?? (await build("linux-guest.checks.tests.assets"));
        path = join(directory, relative);
      } else if (relative === "boot.cpio") {
        path = await build("image.bootInitramfs");
      } else if (relative === "scheduler-handoff.erofs") {
        path = await build("basic-init.schedulerHandoffDisk");
      } else if (relative === "remote-vm.erofs") {
        path = await build("basic-init.remoteMemoryDisk");
      } else if (relative === "posix-spawn-stress.erofs") {
        path = await build("basic-init.posixSpawnStressDisk");
      }
    } catch (error) {
      console.error(`failed to build ${relative}:`, error.stderr ?? error);
      built.clear();
      response.writeHead(500).end();
      return;
    }
  }
  if (!exists(path)) {
    response.writeHead(404).end();
    return;
  }
  const { size } = statSync(path);
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!range && size === 0) {
    response.writeHead(200, {
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Content-Length": 0,
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
    response.end();
    return;
  }
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] !== "" ? Number(range[2]) : size - 1;
  if (start < 0 || end < start || end >= size) {
    response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    return;
  }
  response.writeHead(range ? 206 : 200, {
    "Content-Type": types[extname(path)] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(path, { start, end }).pipe(response);
});

// Port 0 by default, since the suite only needs some free port. The tailnet
// demo sets PORT so its Tailscale Serve routes survive a restart.
server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  console.log(`Listening on http://127.0.0.1:${server.address().port}`);
});
