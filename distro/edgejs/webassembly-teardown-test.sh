#!/bin/busybox sh

# WAMR's engine is process-global. It must remain alive until the JavaScript
# wrappers for WebAssembly objects have been finalized, or their deletes hit
# wasm_runtime_free after the allocator has been destroyed.

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

cat >/tmp/webassembly-teardown.js <<'SCRIPT'
const count = Number(process.argv[2]);
if (!Number.isInteger(count) || count < 1) {
  throw new Error(`invalid instance count ${JSON.stringify(process.argv[2])}`);
}

// A module with three exported extern kinds makes each live instance retain
// the wrapper types whose late finalizers exposed this teardown ordering bug.
const moduleBytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x04, 0x04, 0x01, 0x70, 0x00, 0x01, // one funcref table
  0x05, 0x03, 0x01, 0x00, 0x01, // one page of memory
  0x06, 0x06, 0x01, 0x7f, 0x01, 0x41, 0x00, 0x0b, // mutable i32 global
  0x07, 0x0d, 0x03,
  0x01, 0x6d, 0x02, 0x00, // memory "m"
  0x01, 0x74, 0x01, 0x00, // table "t"
  0x01, 0x67, 0x03, 0x00, // global "g"
]);

const module = new WebAssembly.Module(moduleBytes);
const instances = [];
for (let index = 0; index < count; index++) {
  const instance = new WebAssembly.Instance(module);
  if (!instance.exports.m || !instance.exports.t || !instance.exports.g) {
    throw new Error(`instance ${index} did not retain all exported objects`);
  }
  instances.push(instance);
}

// The test intentionally keeps `instances` live. Environment teardown now
// follows this marker, so every allocator warning must occur after it (on the
// old binary) and the fixed binary must emit none.
process.stderr.write("wasm teardown marker\n");
SCRIPT

run_case() {
  label="$1"
  count="$2"
  out="/tmp/webassembly-teardown-${label}.out"
  err="/tmp/webassembly-teardown-${label}.err"

  node /tmp/webassembly-teardown.js "$count" >"$out" 2>"$err" ||
    fail "$label WebAssembly teardown program failed: $(cat "$err")"

  markers="$(grep -c '^wasm teardown marker$' "$err" || true)"
  [ "$markers" -eq 1 ] ||
    fail "$label teardown marker count was $markers"

  before_marker="$(awk '
    /wasm teardown marker/ { marked = 1 }
    /wasm_runtime_free/ && !marked { count++ }
    END { print count + 0 }
  ' "$err")"
  [ "$before_marker" -eq 0 ] ||
    fail "$label had $before_marker wasm_runtime_free warnings before teardown"

  warnings="$(grep -c 'wasm_runtime_free' "$err" || true)"
  printf '%s wasm_runtime_free warnings: %s\n' "$label" "$warnings"
  eval "warnings_${label}=$warnings"
}

warnings_n1=0
warnings_n8=0
run_case n1 1
run_case n8 8

if [ "${EXPECT_WASM_RUNTIME_FREE_FLOOD:-0}" = 1 ]; then
  [ "$warnings_n1" -gt 0 ] ||
    fail "diagnostic N=1 run did not reproduce the wasm_runtime_free flood"
  [ "$warnings_n8" -gt "$warnings_n1" ] ||
    fail "diagnostic warning count did not scale from N=1 to N=8"
else
  [ "$warnings_n1" -eq 0 ] ||
    fail "fixed N=1 run still emitted wasm_runtime_free warnings"
  [ "$warnings_n8" -eq 0 ] ||
    fail "fixed N=8 run still emitted wasm_runtime_free warnings"
fi

echo "::vm-test::pass"
while :; do :; done
