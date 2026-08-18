#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export HOME=/root
# npm writes a cache before it does anything else, including printing its own
# version. Its default is under HOME, which this machine does have, but naming
# it keeps the test independent of that default.
export npm_config_cache=/root/.npm

mkdir -p /root /tmp || fail "creating home and temporary directories failed"

# The interpreter needs both: Edge.js reads /proc and resolves /dev/fd.
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

npm --version >/tmp/npm-version.out 2>/tmp/npm-version.err ||
  fail "npm --version failed: $(cat /tmp/npm-version.err)"

version="$(cat /tmp/npm-version.out)"
[ "$version" = "11.16.0" ] ||
  fail "unexpected npm version '$version'"

# npx resolves its own installation differently from npm, and it is the entry
# point every `npx <tool>` invocation goes through, so cover it separately.
npx --version >/tmp/npx-version.out 2>/tmp/npx-version.err ||
  fail "npx --version failed: $(cat /tmp/npx-version.err)"

npx_version="$(cat /tmp/npx-version.out)"
[ "$npx_version" = "11.16.0" ] ||
  fail "unexpected npx version '$npx_version'"

# npm's real work is packing and unpacking trees. Going through a tarball
# rather than a directory covers what a registry install actually does --
# tar and gzip in both directions through the interpreter's zlib -- without
# needing a network, which a VM test does not have.
mkdir -p /tmp/dependency /tmp/project || fail "creating fixture directories failed"
cat >/tmp/dependency/package.json <<'PACKAGE'
{ "name": "dependency", "version": "1.0.0", "main": "index.js" }
PACKAGE
cat >/tmp/dependency/index.js <<'INDEX'
module.exports = "installed by npm";
INDEX
cat >/tmp/project/package.json <<'PACKAGE'
{ "name": "project", "version": "1.0.0", "private": true }
PACKAGE

npm pack /tmp/dependency --pack-destination /tmp >/tmp/pack.out 2>/tmp/pack.err ||
  fail "npm pack failed: $(cat /tmp/pack.err)"
[ -s /tmp/dependency-1.0.0.tgz ] ||
  fail "npm pack produced no tarball"

cd /tmp/project || fail "cd /tmp/project failed"
npm install --offline --no-audit --no-fund /tmp/dependency-1.0.0.tgz \
  >/tmp/install.out 2>/tmp/install.err ||
  fail "npm install failed: $(cat /tmp/install.err)"
[ -f /tmp/project/node_modules/dependency/index.js ] ||
  fail "npm install did not unpack the dependency"

installed="$(node -p 'require("dependency")' 2>/tmp/require.err)" ||
  fail "requiring the installed package failed: $(cat /tmp/require.err)"
[ "$installed" = "installed by npm" ] ||
  fail "installed package returned '$installed'"

printf '::npm::version=%s\n' "$version"
echo "::vm-test::pass"
while :; do :; done
