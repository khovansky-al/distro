#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

bundle=/etc/ssl/certs/ca-certificates.crt
[ -s "$bundle" ] || fail "CA certificate bundle is missing or empty"
grep -q -- '-----BEGIN CERTIFICATE-----' "$bundle" ||
  fail "CA certificate bundle contains no PEM certificates"

echo "::ca-certificates::bundle=$bundle"
echo "::vm-test::pass"
while :; do :; done
