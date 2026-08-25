#!/bin/busybox sh

# Buffer.allocUnsafe used to allocate its ArrayBuffer backing store directly
# with malloc. QuickJS could not see those bytes, so unreachable object cycles
# carrying Buffers did not create heap pressure and were not collected before
# wasm32's address space was exhausted. Yarn's zlib link phase creates exactly
# that sort of short-lived Buffer graph.

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

cat >/tmp/buffer-memory.js <<'SCRIPT'
const chunkBytes = 16 * 1024 * 1024;
const iterations = 321;

for (let index = 0; index < iterations; index += 1) {
  const buffer = Buffer.allocUnsafe(chunkBytes);
  buffer[0] = index & 0xff;
  buffer[chunkBytes - 1] = (index + 1) & 0xff;
  if (buffer[0] !== (index & 0xff) || buffer[chunkBytes - 1] !== ((index + 1) & 0xff)) {
    throw new Error(`buffer ${index} did not preserve its endpoint bytes`);
  }

  // Reference counting cannot reclaim this unreachable cycle. The cycle GC
  // must see the ArrayBuffer bytes and run often enough to keep the live set
  // bounded while cumulative allocation exceeds the wasm32 address space.
  const holder = { buffer };
  holder.self = holder;
}

const aggregateGiB = (iterations * chunkBytes) / (1024 ** 3);
console.log(`buffer-memory ok ${aggregateGiB.toFixed(3)} GiB`);
SCRIPT

node /tmp/buffer-memory.js >/tmp/buffer-memory.out 2>/tmp/buffer-memory.err ||
  fail "Buffer memory stress failed: $(cat /tmp/buffer-memory.err)"

result="$(cat /tmp/buffer-memory.out)"
[ "$result" = "buffer-memory ok 5.016 GiB" ] ||
  fail "unexpected Buffer memory output '$result'"

echo "::vm-test::pass"
while :; do :; done
