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

async function main() {
  // Both spellings, because es-module-lexer -- the reason this global exists at
  // all -- uses compile followed by instantiate on the resulting module.
  const module = await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(module);

  const sum = instance.exports.add(2, 3);
  if (sum !== 5) {
    throw new Error(`add(2, 3) returned ${JSON.stringify(sum)}`);
  }

  const names = WebAssembly.Module.exports(module).map((entry) => entry.name);
  if (!names.includes("add")) {
    throw new Error(`module exports ${JSON.stringify(names)}`);
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

  console.log(`webassembly ok add(2,3)=${sum} global=${global.value}`);
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
SCRIPT

node /tmp/webassembly.js >/tmp/webassembly.out 2>/tmp/webassembly.err ||
  fail "running a WebAssembly module failed: $(cat /tmp/webassembly.err)"

result="$(cat /tmp/webassembly.out)"
[ "$result" = "webassembly ok add(2,3)=5 global=11" ] ||
  fail "unexpected WebAssembly output '$result'"

echo "::vm-test::pass"
while :; do :; done
