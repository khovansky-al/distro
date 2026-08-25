#!/bin/busybox sh

# Every asynchronous filesystem, crypto, and DNS operation in Node is handed to
# a libuv threadpool worker, so the first one starts a thread. That made thread
# creation the difference between an interpreter that prints its version and
# one that can run real programs: the version check passed while any async I/O
# trapped the process.
#
# The trap was a WebAssembly signature mismatch. libuv and QuickJS both pass a
# `void (*)(void *)` thread body to pthread_create through a union that retypes
# it as `void *(*)(void *)`. Everywhere else that is a harmless pun; on wasm a
# function pointer is a typed table index and the indirect call traps.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export HOME=/root

mkdir -p /root /tmp || fail "creating home and temporary directories failed"

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

cat >/tmp/async-io.js <<'SCRIPT'
const { randomBytes } = require("node:crypto");
const { readFile, writeFile } = require("node:fs/promises");
const { Worker } = require("node:worker_threads");

function workerExecArgv() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      "require('node:worker_threads').parentPort.postMessage(process.execArgv)",
      { eval: true, execArgv: ["--unhandled-rejections=strict"] },
    );
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

async function main() {
  await writeFile("/tmp/async-io.data", "threadpool");
  const contents = await readFile("/tmp/async-io.data", "utf8");
  if (contents !== "threadpool") {
    throw new Error(`asynchronous read returned ${JSON.stringify(contents)}`);
  }

  const bytes = await new Promise((resolve, reject) => {
    randomBytes(32, (error, value) => (error ? reject(error) : resolve(value)));
  });
  if (bytes.length !== 32) {
    throw new Error(`randomBytes returned ${bytes.length} bytes`);
  }

  // Several at once: the pool grows past its first worker only here.
  const many = await Promise.all(
    Array.from({ length: 16 }, () => readFile("/tmp/async-io.data", "utf8")),
  );
  if (many.length !== 16 || many.some((value) => value !== "threadpool")) {
    throw new Error("concurrent reads disagreed");
  }

  const execArgv = await workerExecArgv();
  if (execArgv.length !== 1 || execArgv[0] !== "--unhandled-rejections=strict") {
    throw new Error(`worker lost execArgv: ${JSON.stringify(execArgv)}`);
  }

  console.log("async-io ok");
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
SCRIPT

node /tmp/async-io.js >/tmp/async-io.out 2>/tmp/async-io.err ||
  fail "async I/O failed: $(cat /tmp/async-io.err)"

result="$(cat /tmp/async-io.out)"
[ "$result" = "async-io ok" ] ||
  fail "unexpected async I/O output '$result'"

echo "::vm-test::pass"
while :; do :; done
