#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export HOME=/root
export YARN_ENABLE_GLOBAL_CACHE=0

mkdir -p /root /tmp/project || fail "creating test directories failed"

# Edge.js reads /proc and resolves /dev/fd during startup.
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

yarn --version >/tmp/yarn-version.out 2>/tmp/yarn-version.err ||
  fail "yarn --version failed: $(cat /tmp/yarn-version.err)"
version="$(cat /tmp/yarn-version.out)"
[ "$version" = "4.17.1" ] || fail "unexpected Yarn version '$version'"

yarnpkg --version >/tmp/yarnpkg-version.out 2>/tmp/yarnpkg-version.err ||
  fail "yarnpkg --version failed: $(cat /tmp/yarnpkg-version.err)"
[ "$(cat /tmp/yarnpkg-version.out)" = "4.17.1" ] ||
  fail "yarnpkg reported the wrong version"

# A dependency-free project exercises Yarn's project discovery, lockfile, PnP
# generation, and immutable reinstall without requiring public networking.
cat >/tmp/project/package.json <<'PACKAGE'
{ "name": "offline-yarn-test", "private": true }
PACKAGE

cd /tmp/project || fail "entering project failed"
yarn install >/tmp/install.out 2>/tmp/install.err ||
  fail "first yarn install failed: $(cat /tmp/install.err)"
[ -f yarn.lock ] || fail "Yarn did not create yarn.lock"
[ -f .pnp.cjs ] || fail "Yarn did not create the PnP loader"

yarn install --immutable >/tmp/reinstall.out 2>/tmp/reinstall.err ||
  fail "immutable yarn install failed: $(cat /tmp/reinstall.err)"

platform="$(yarn node -p 'process.platform + "/" + process.arch' 2>/tmp/node.err)" ||
  fail "yarn node failed: $(cat /tmp/node.err)"
[ "$platform" = "linux/wasm32" ] || fail "unexpected guest platform '$platform'"

printf '::yarn::version=%s\n' "$version"
echo "::vm-test::pass"
while :; do :; done
