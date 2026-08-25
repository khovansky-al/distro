#!/bin/busybox sh

# A WebAssembly engine inside a WebAssembly guest.
#
# The interpreter's `WebAssembly` global is backed by wasm-micro-runtime rather
# than Wasmer, because Wasmer compiles modules to machine code at run time and a
# wasm guest cannot do that. WAMR interprets, so it can. See distro/wamr.
#
# Two things are worth checking and they fail differently. A global that is
# merely present satisfies feature detection while doing nothing -- which is
# worse than absent, because callers stop guarding. So this compiles and runs a
# real module and checks the arithmetic, rather than checking for the global.

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

cat >/tmp/webassembly.js <<'SCRIPT'
if (typeof WebAssembly === "undefined") {
  throw new Error("no WebAssembly global");
}

// The smallest module that proves the engine ran something: one exported
// function adding its two i32 parameters. Written out byte by byte so the test
// needs no toolchain in the guest to produce it.
const wasm = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version 1
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, // type: (i32,i32)->i32
  0x03, 0x02, 0x01, 0x00, // function 0 has that type
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, // export "add"
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b, // add body
]);

// Imports a.b as (i32) -> i32 and exports a wrapper named "call". Yarn's
// ZipFS workers use the same shape when libzip's Emscripten module links its
// minified JavaScript imports.
const importedWasm = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
  0x02, 0x07, 0x01, 0x01, 0x61, 0x01, 0x62, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x08, 0x01, 0x04, 0x63, 0x61, 0x6c, 0x6c, 0x00, 0x01,
  0x0a, 0x08, 0x01, 0x06, 0x00, 0x20, 0x00, 0x10, 0x00, 0x0b,
]);

const memoryWasm = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x05, 0x04, 0x01, 0x01, 0x01, 0x03, // memory 1..3 pages
  0x07, 0x0a, 0x01, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
]);

function runImportWorker(index) {
  const { Worker } = require("node:worker_threads");
  return new Promise((resolve, reject) => {
    let received = false;
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const module = new WebAssembly.Module(new Uint8Array(workerData));
      const instance = new WebAssembly.Instance(module, {
        a: { b: (value) => value + 1 },
      });
      parentPort.postMessage(instance.exports.call(41));
    `, { eval: true, workerData: Array.from(importedWasm) });
    worker.once("message", (value) => {
      received = true;
      if (value !== 42) {
        reject(new Error(`worker ${index} import returned ${value}`));
      } else {
        resolve(value);
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!received) {
        reject(new Error(`worker ${index} exited without a result (status ${code})`));
      }
    });
  });
}

async function main() {
  // Both spellings, because es-module-lexer -- the reason this global exists at
  // all -- uses compile followed by instantiate on the resulting module.
  const module = await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(module);

  const sum = instance.exports.add(2, 3);
  if (sum !== 5) {
    throw new Error(`add(2, 3) returned ${JSON.stringify(sum)}`);
  }
  if (instance.exports.add(5) !== 5 || instance.exports.add() !== 0) {
    throw new Error("missing numeric arguments did not default through ToInt32");
  }

  const names = WebAssembly.Module.exports(module).map((entry) => entry.name);
  if (!names.includes("add")) {
    throw new Error(`module exports ${JSON.stringify(names)}`);
  }

  const importedModule = new WebAssembly.Module(importedWasm);
  const importedInstance = new WebAssembly.Instance(importedModule, {
    a: { b: (value) => value + 1 },
  });
  const importedCall = importedInstance.exports.call;
  if (importedCall(41) !== 42) {
    throw new Error(`main-thread import returned ${importedCall(41)}`);
  }

  // Yarn fetches archives in parallel Worker environments. Exercise several
  // stores at once so the regression covers that production path rather than
  // only the main environment.
  const workerResults = await Promise.all(
    Array.from({ length: 4 }, (_, index) => runImportWorker(index)),
  );

  // Emscripten also emits exports wider than Edge's former fixed argv[32]
  // bridge. This module returns argument 39 and separately checks that all 40
  // missing i32 arguments arrive as undefined and coerce to zero.
  const wideWasm = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x2d, 0x01, 0x60, 0x28,
    ...Array(40).fill(0x7f),
    0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x08, 0x01, 0x04, 0x6c, 0x61, 0x73, 0x74, 0x00, 0x00,
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x20, 0x27, 0x0b,
  ]);
  const wide = new WebAssembly.Instance(new WebAssembly.Module(wideWasm));
  const wideArgs = Array.from({ length: 40 }, (_, index) => index);
  if (wide.exports.last(...wideArgs) !== 39 || wide.exports.last() !== 0) {
    throw new Error("wide or missing WebAssembly export arguments failed");
  }

  const memoryInstance = new WebAssembly.Instance(
    new WebAssembly.Module(memoryWasm),
  );
  const memory = memoryInstance.exports.memory;
  const oldBuffer = memory.buffer;
  new Uint8Array(oldBuffer)[0] = 0x5a;
  if (memory.grow(1) !== 1) {
    throw new Error("WebAssembly.Memory.grow returned the wrong old size");
  }
  const grownBuffer = memory.buffer;
  if (
    oldBuffer.byteLength !== 0 ||
    grownBuffer.byteLength !== 2 * 65536 ||
    new Uint8Array(grownBuffer)[0] !== 0x5a
  ) {
    throw new Error("WebAssembly.Memory.grow did not detach, grow, and preserve data");
  }

  // The dev-server path reads a wasm global while transforming a module. WAMR's
  // wasm_val_delete frees an owned wasm_val_t allocation, so Edge must never
  // call it on the stack-backed value filled by wasm_global_get or global_set.
  const global = new WebAssembly.Global({ value: "i32", mutable: true }, 7);
  if (global.value !== 7) {
    throw new Error(`initial global value was ${JSON.stringify(global.value)}`);
  }
  global.value = 11;
  if (global.value !== 11) {
    throw new Error(`updated global value was ${JSON.stringify(global.value)}`);
  }

  console.log(
    `webassembly ok add(2,3)=${sum} import=${importedCall(41)} workers=${workerResults.join(",")} memory=${grownBuffer.byteLength} global=${global.value}`,
  );
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
SCRIPT

node /tmp/webassembly.js >/tmp/webassembly.out 2>/tmp/webassembly.err ||
  fail "running a WebAssembly module failed: $(cat /tmp/webassembly.err)"

result="$(cat /tmp/webassembly.out)"
[ "$result" = "webassembly ok add(2,3)=5 import=42 workers=42,42,42,42 memory=131072 global=11" ] ||
  fail "unexpected WebAssembly output '$result'"

echo "::vm-test::pass"
while :; do :; done
