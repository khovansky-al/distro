#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

node -e 'console.log(process.version)' >/tmp/node-version.out 2>/tmp/node-version.err ||
  fail "node evaluation failed: $(cat /tmp/node-version.err)"

version="$(cat /tmp/node-version.out)"
[ "$version" = "v24.13.2" ] ||
  fail "unexpected process.version '$version'"

printf '::edgejs::process.version=%s\n' "$version"
echo "::vm-test::pass"
while :; do :; done
