#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /tmp || fail "creating the temporary directory failed"
mount -t proc proc /proc || fail "mounting proc failed"

/wamr-interpreter-test >/tmp/wamr.out 2>/tmp/wamr.err ||
  fail "the interpreter failed: $(cat /tmp/wamr.out)$(cat /tmp/wamr.err)"

result="$(cat /tmp/wamr.out)"
printf '%s\n' "$result"
[ "$result" = "wamr ok add(2,3)=5 global=11 memory=2" ] ||
  fail "unexpected output '$result'"

echo "::vm-test::pass"
while :; do :; done
