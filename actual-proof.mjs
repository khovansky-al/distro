// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { createReadStream, mkdtempSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const actualCommit = "adf5d198282218f06ce0a6cbe847bee66f483332";
const siteRoot = process.env.ACTUAL_PROOF_SITE;
const repositoryRoot = process.env.ACTUAL_PROOF_REPOSITORY;
const relayCommand = process.env.ACTUAL_PROOF_RELAY;
if (!siteRoot || !repositoryRoot || !relayCommand) {
  throw new Error("ACTUAL_PROOF_SITE, ACTUAL_PROOF_REPOSITORY, and ACTUAL_PROOF_RELAY are required");
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

function existingFile(root, relative) {
  const path = join(root, normalize(relative));
  if (!path.startsWith(`${root}/`)) return undefined;
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const repositoryRequest = url.pathname.startsWith("/apk/");
  const root = repositoryRequest ? repositoryRoot : siteRoot;
  const relative = repositoryRequest
    ? url.pathname.slice("/apk/".length)
    : url.pathname === "/"
      ? "index.html"
      : url.pathname.slice(1);
  const path = existingFile(root, relative);
  if (!path) {
    response.writeHead(404).end();
    return;
  }
  const { size } = statSync(path);
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] !== "" ? Number(range[2]) : size - 1;
  if (start < 0 || end < start || end >= size) {
    response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    return;
  }
  response.writeHead(range ? 206 : 200, {
    "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(path, { start, end }).pipe(response);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  const requestedPort = Number(process.env.ACTUAL_PROOF_SITE_PORT ?? 0);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    reject(new Error(`invalid ACTUAL_PROOF_SITE_PORT ${process.env.ACTUAL_PROOF_SITE_PORT}`));
    return;
  }
  server.listen(requestedPort, "127.0.0.1", resolve);
});
const sitePort = server.address().port;

const relay = spawn(
  relayCommand,
  ["--listen", "127.0.0.1", "--port", "0", "--publish", "127.0.0.1:0:3001"],
  { stdio: ["ignore", "pipe", "inherit"] },
);
const relayReady = Promise.withResolvers();
let relayOutput = "";
relay.stdout.setEncoding("utf8");
relay.stdout.on("data", (chunk) => {
  process.stdout.write(`[relay] ${chunk}`);
  relayOutput += chunk;
  const match = relayOutput.match(/Listening on (ws:\/\/[^\s]+)/);
  if (match) relayReady.resolve(match[1]);
});
relay.once("error", relayReady.reject);
relay.once("exit", (code, signal) => {
  relayReady.reject(new Error(`relay exited early (code ${code}, signal ${signal})`));
});
const relayUrl = await relayReady.promise;

const resumeProfile = process.env.ACTUAL_PROOF_RESUME_PROFILE;
const profileParent = process.env.ACTUAL_PROOF_PROFILE_PARENT ?? process.cwd();
const profile = resumeProfile ?? mkdtempSync(join(profileParent, ".linux-wasm-actual-proof-"));
const ownsProfile = resumeProfile === undefined;
const vmUrl =
  `http://127.0.0.1:${sitePort}/?webgl=0&diskGiB=8&` +
  `relay=${encodeURIComponent(relayUrl)}&publish=0:3001`;

function recordEvents(page) {
  return page.addInitScript(() => {
    globalThis.lowlandProofEvents = [];
    for (const type of ["boot-status", "publication-opened", "fatal"]) {
      addEventListener(`lowland:${type}`, (event) =>
        globalThis.lowlandProofEvents.push({ type, detail: event.detail }),
      );
    }
  });
}

async function waitForTerminal(page, timeout = 180_000) {
  const terminal = page.locator(".xterm-rows");
  try {
    await terminal.waitFor({ state: "visible", timeout });
    await page.waitForFunction(
      () => document.querySelector(".xterm-rows")?.textContent?.includes("root@lowland"),
      undefined,
      { timeout },
    );
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => ({
        url: location.href,
        body: document.body.textContent,
        events: globalThis.lowlandProofEvents,
      }))
      .catch((evaluationError) => ({ evaluationError: `${evaluationError}` }));
    console.error(`[vm-timeout] ${JSON.stringify(diagnostic)}`);
    throw error;
  }
  return { terminal, input: page.locator(".xterm-helper-textarea") };
}

async function readGuestFile(page, path) {
  const ready = `actual-proof-log-${Math.random().toString(16).slice(2)}`;
  const split = Math.floor(ready.length / 2);
  const input = page.locator(".xterm-helper-textarea");
  await input.pressSequentially(
    `busybox httpd -p 3001 -h / >/dev/null 2>&1 & printf '%s%s\\n' '${ready.slice(0, split)}' '${ready.slice(split)}'`,
  );
  await input.press("Enter");
  await page.waitForFunction(
    (expected) => document.querySelector(".xterm-rows")?.textContent?.includes(expected),
    ready,
    { timeout: 10_000 },
  );
  const port = await publishedPort(page);
  const url = `http://127.0.0.1:${port}/${path.replace(/^\/+/, "")}`;
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
      lastError = new Error(`guest log returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(250);
  }
  throw lastError;
}

async function command(page, shell, marker, timeout = 180_000, diagnosticPath) {
  const failure = `${marker}-failed`;
  const markerPrint = (value) => {
    const split = Math.floor(value.length / 2);
    return `printf '%s%s\\n' '${value.slice(0, split)}' '${value.slice(split)}'`;
  };
  const wrapped = `{ ${shell}\n}; lowland_status=$?; if [ "$lowland_status" -eq 0 ]; then ${markerPrint(marker)}; else ${markerPrint(failure)}; fi`;
  const input = page.locator(".xterm-helper-textarea");
  await input.pressSequentially(wrapped);
  await input.press("Enter");
  try {
    await page.waitForFunction(
      ({ marker, failure }) => {
        const text = document.querySelector(".xterm-rows")?.textContent ?? "";
        return text.includes(marker) || text.includes(failure);
      },
      { marker, failure },
      { timeout },
    );
  } catch (error) {
    const text = (await page.locator(".xterm-rows").textContent()) ?? "";
    throw new Error(`${marker} timed out: ${text}`, { cause: error });
  }
  const text = (await page.locator(".xterm-rows").textContent()) ?? "";
  if (text.includes(failure)) {
    let diagnostic = "";
    if (diagnosticPath) {
      diagnostic = await readGuestFile(page, diagnosticPath).catch(
        (error) => `could not retrieve ${diagnosticPath}: ${error.stack ?? error}`,
      );
    }
    throw new Error(`${failure}:\n${diagnostic}\nterminal:\n${text}`);
  }
  console.log(`[guest] ${marker}`);
}

async function publishedPort(page) {
  await page.waitForFunction(
    () =>
      globalThis.lowlandProofEvents?.some(
        (event) => event.type === "publication-opened" && event.detail.guestPort === 3001,
      ),
    undefined,
    { timeout: 60_000 },
  );
  return await page.evaluate(
    () =>
      globalThis.lowlandProofEvents
        .filter((event) => event.type === "publication-opened" && event.detail.guestPort === 3001)
        .at(-1).detail.hostPort,
  );
}

async function verifyActual(context, port, expectedEdit = false) {
  const page = await context.newPage();
  page.on("console", (message) => console.error(`[actual-console:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[actual-pageerror] ${error.stack ?? error}`));
  page.on("requestfailed", (request) =>
    console.error(`[actual-request-failed] ${request.url()} ${request.failure()?.errorText ?? ""}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400 || response.url().includes("/src/index.tsx")) {
      console.error(`[actual-response] ${response.status()} ${response.url()}`);
    }
  });
  const deadline = Date.now() + 180_000;
  let response;
  let navigationError;
  while (Date.now() < deadline) {
    try {
      response = await page.goto(`http://127.0.0.1:${port}/`, {
        // The first Vite transform can take longer than a navigation timeout
        // on wasm. Commit is enough to validate the HTTP response; the DOM
        // assertions below wait for the transformed application to arrive.
        waitUntil: "commit",
        timeout: Math.min(30_000, deadline - Date.now()),
      });
      if (response?.status() === 200) break;
    } catch (error) {
      navigationError = error;
    }
    await page.waitForTimeout(1_000);
  }
  if (!response && navigationError) throw navigationError;
  if (!response || response.status() !== 200) throw new Error(`Actual returned ${response?.status()}`);
  const headers = response.headers();
  if (headers["cross-origin-opener-policy"] !== "same-origin") throw new Error("Actual lacks COOP");
  if (headers["cross-origin-embedder-policy"] !== "require-corp") throw new Error("Actual lacks COEP");
  if (!(await page.evaluate(() => crossOriginIsolated))) throw new Error("Actual is not isolated");
  if (expectedEdit) {
    const source = await response.text();
    if (!source.includes("actual-proof-live-edit")) {
      throw new Error("restarted Vite response does not contain the persisted source edit");
    }
  }
  try {
    await page.getByText("Welcome to Actual", { exact: false }).waitFor({ timeout: 600_000 });
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => ({
        url: location.href,
        readyState: document.readyState,
        body: document.body.textContent,
        html: document.body.innerHTML.slice(0, 4000),
        resources: performance
          .getEntriesByType("resource")
          .map((entry) => ({ name: entry.name, duration: entry.duration }))
          .slice(-40),
      }))
      .catch((evaluationError) => ({ evaluationError: `${evaluationError}` }));
    console.error(`[actual-timeout] ${JSON.stringify(diagnostic)}`);
    throw error;
  }
  await page.getByText("Start budgeting", { exact: false }).waitFor({ timeout: 60_000 });
  await page.getByText("App: v26.8.1", { exact: false }).waitFor({ timeout: 60_000 });
  return page;
}

let context;
let completed = false;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: process.env.ACTUAL_PROOF_HEADFUL !== "1",
    args: ["--unlimited-storage"],
  });
  let vm = context.pages()[0] ?? (await context.newPage());
  await recordEvents(vm);
  await vm.goto(vmUrl);
  if (resumeProfile) {
    await waitForTerminal(vm);
    await command(
      vm,
      "test -d /work/actual && test -f /work/actual/node_modules/.yarn-state.yml && test -f /work/actual/yarn.lock",
      "actual-proof-resumed",
    );
  } else {
    await vm.locator("#provision-disk").click();
    await waitForTerminal(vm);

    const localRepository = `http://192.0.2.1:${sitePort}/apk/wasm32/Packages.adb`;
    await command(
      vm,
      `sed -i 's#^repository=.*#repository=${localRepository}#' /sbin/install-lowland; install-lowland`,
      "actual-proof-installed",
      300_000,
    );
    await vm.reload();
    await waitForTerminal(vm);
    await command(
      vm,
      `printf '%s\\n' '${localRepository}' > /etc/apk/repositories; apk --allow-untrusted add edgejs yarn git ca-certificates >/tmp/actual-apk.log 2>&1 || { cat /tmp/actual-apk.log; false; }`,
      "actual-proof-packages",
      180_000,
      "/tmp/actual-apk.log",
    );
    await command(
      vm,
      `mkdir -p /work; cd /work; { git clone --filter=blob:none --no-checkout https://github.com/actualbudget/actual.git actual && cd actual && git checkout ${actualCommit}; } >/tmp/actual-git.log 2>&1 || { cat /tmp/actual-git.log; false; }`,
      "actual-proof-checkout",
      600_000,
      "/tmp/actual-git.log",
    );
    await command(
      vm,
      "cd /work/actual; : > /tmp/actual-yarn.log; lowland_yarn_attempt=1; lowland_yarn_status=1; while [ $lowland_yarn_attempt -le 3 ]; do printf 'attempt %s\\n' \"$lowland_yarn_attempt\" >> /tmp/actual-yarn.log; yarn install --immutable --mode=skip-build >>/tmp/actual-yarn.log 2>&1; lowland_yarn_status=$?; [ $lowland_yarn_status -eq 0 ] && break; lowland_yarn_attempt=$((lowland_yarn_attempt + 1)); [ $lowland_yarn_attempt -le 3 ] && sleep 5; done; test $lowland_yarn_status -eq 0 && test -f node_modules/.yarn-state.yml",
      "actual-proof-dependencies",
      3_600_000,
      "/tmp/actual-yarn.log",
    );
  }
  await command(
    vm,
    "sync; echo 3 > /proc/sys/vm/drop_caches; lowland_available_kib=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo); test \"$lowland_available_kib\" -gt 2000000",
    "actual-proof-cache-reclaimed",
  );
  await command(
    vm,
    "cd /work/actual/packages/desktop-client; BROWSER=none PORT=3001 yarn vite --host 0.0.0.0 --port 3001 --mode browser >/tmp/actual-vite.log 2>&1 & echo $! >/tmp/actual-vite.pid; lowland_vite_wait=0; until wget -qO /dev/null http://192.0.2.2:3001/; do lowland_vite_wait=$((lowland_vite_wait + 1)); [ $lowland_vite_wait -lt 600 ] || break; sleep 1; done; sleep 3; wget -qO /dev/null http://192.0.2.2:3001/ || { { printf 'pid='; cat /tmp/actual-vite.pid 2>/dev/null; printf '\\n'; ps 2>&1; printf '\\n---log---\\n'; cat /tmp/actual-vite.log 2>&1; printf '\\n---files---\\n'; ls -l /tmp/actual-vite* 2>&1; } >/tmp/actual-vite-diagnostic.log; false; }",
    "actual-proof-vite-started",
    660_000,
    "/tmp/actual-vite-diagnostic.log",
  );
  const port = await publishedPort(vm);
  let actual = await verifyActual(context, port);

  await command(
    vm,
    "printf '%s\\n' '<div>actual-proof-live-edit</div>' >> /work/actual/packages/desktop-client/index.html",
    "actual-proof-source-edited",
  );
  await actual.reload({ waitUntil: "domcontentloaded" });
  await actual.getByText("actual-proof-live-edit", { exact: false }).waitFor({ timeout: 60_000 });
  await command(
    vm,
    "grep -q actual-proof-live-edit /work/actual/packages/desktop-client/index.html",
    "actual-proof-source-persisted",
  );
  await command(
    vm,
    "sync; echo 3 > /proc/sys/vm/drop_caches; lowland_available_kib=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo); test \"$lowland_available_kib\" -gt 2000000",
    "actual-proof-restart-cache-reclaimed",
  );
  await actual.close();

  await context.close();
  context = await chromium.launchPersistentContext(profile, {
    headless: process.env.ACTUAL_PROOF_HEADFUL !== "1",
    args: ["--unlimited-storage"],
  });
  vm = context.pages()[0] ?? (await context.newPage());
  await recordEvents(vm);
  await vm.goto(vmUrl);
  await waitForTerminal(vm);
  await command(
    vm,
    "test -d /work/actual && test -f /work/actual/node_modules/.yarn-state.yml && test -f /work/actual/yarn.lock && grep -q actual-proof-live-edit /work/actual/packages/desktop-client/index.html; cd /work/actual/packages/desktop-client; BROWSER=none PORT=3001 yarn vite --host 0.0.0.0 --port 3001 --mode browser >/tmp/actual-vite.log 2>&1 & echo $! >/tmp/actual-vite.pid; lowland_vite_wait=0; until wget -qO /dev/null http://192.0.2.2:3001/; do lowland_vite_wait=$((lowland_vite_wait + 1)); [ $lowland_vite_wait -lt 600 ] || break; sleep 1; done; sleep 3; wget -qO /dev/null http://192.0.2.2:3001/ || { { printf 'pid='; cat /tmp/actual-vite.pid 2>/dev/null; printf '\\n'; ps 2>&1; printf '\\n---log---\\n'; cat /tmp/actual-vite.log 2>&1; printf '\\n---files---\\n'; ls -l /tmp/actual-vite* 2>&1; } >/tmp/actual-vite-diagnostic.log; false; }",
    "actual-proof-persisted",
    660_000,
    "/tmp/actual-vite-diagnostic.log",
  );
  const restartedPort = await publishedPort(vm);
  actual = await verifyActual(context, restartedPort, true);
  await actual.close();

  console.log("Actual v26.8.1 booted from source, live-reloaded, and survived a browser restart");
  completed = true;
} finally {
  await context?.close().catch(() => {});
  relay.kill();
  await new Promise((resolve) => server.close(resolve));
  if (ownsProfile && (completed || process.env.ACTUAL_PROOF_KEEP_FAILED_PROFILE !== "1")) {
    await rm(profile, { recursive: true, force: true });
  } else if (!completed) {
    console.error(`Preserved failed Actual proof profile at ${profile}`);
  } else {
    console.log(`Left resumed Actual proof profile at ${profile}`);
  }
}
