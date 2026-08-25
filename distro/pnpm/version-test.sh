#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export HOME=/root

mkdir -p /root /tmp || fail "creating home and temporary directories failed"

# The interpreter needs both: Edge.js reads /proc and resolves /dev/fd.
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

pnpm --version >/tmp/pnpm-version.out 2>/tmp/pnpm-version.err ||
  fail "pnpm --version failed: $(cat /tmp/pnpm-version.err)"

version="$(cat /tmp/pnpm-version.out)"
[ "$version" = "10.34.5" ] ||
  fail "unexpected pnpm version '$version'"

# pnpx is a distinct entry point. It must preserve the pnpm version while
# presenting the dlx command, rather than merely being another pnpm wrapper.
pnpx --help >/tmp/pnpx-help.out 2>/tmp/pnpx-help.err ||
  fail "pnpx --help failed: $(cat /tmp/pnpx-help.err)"
grep -F 'Version 10.34.5' /tmp/pnpx-help.out >/dev/null ||
  fail "pnpx --help did not report version 10.34.5"
grep -F 'Usage: pnpm dlx <command> [args...]' /tmp/pnpx-help.out >/dev/null ||
  fail "pnpx --help did not report pnpm dlx usage"

# Pack and install a local tarball so this check exercises pnpm's archive,
# content-addressable store, linker, and Node module resolution without a
# network. The fixture also has a bin entry: running its node_modules/.bin
# link covers the command-link layout pnpm creates for projects.
mkdir -p /tmp/dependency/bin /tmp/project ||
  fail "creating fixture directories failed"
cat >/tmp/dependency/package.json <<'PACKAGE'
{
  "name": "dependency",
  "version": "1.0.0",
  "main": "index.js",
  "bin": { "fixture-command": "bin/fixture-command.js" }
}
PACKAGE
cat >/tmp/dependency/index.js <<'INDEX'
module.exports = "installed by pnpm";
INDEX
cat >/tmp/dependency/bin/fixture-command.js <<'COMMAND'
#!/usr/bin/env node
console.log("linked by pnpm");
COMMAND
chmod 0755 /tmp/dependency/bin/fixture-command.js

cd /tmp/dependency || fail "cd /tmp/dependency failed"
pnpm pack --pack-destination /tmp >/tmp/pack.out 2>/tmp/pack.err ||
  fail "pnpm pack failed: $(cat /tmp/pack.err)"
[ -s /tmp/dependency-1.0.0.tgz ] ||
  fail "pnpm pack produced no tarball"

cat >/tmp/project/package.json <<'PACKAGE'
{
  "name": "project",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "dependency": "file:/tmp/dependency-1.0.0.tgz"
  }
}
PACKAGE

cd /tmp/project || fail "cd /tmp/project failed"
pnpm install --offline >/tmp/install.out 2>/tmp/install.err ||
  fail "pnpm install failed: $(cat /tmp/install.err)"
[ -f /tmp/project/node_modules/dependency/index.js ] ||
  fail "pnpm install did not unpack the dependency"
[ -e /tmp/project/node_modules/.bin/fixture-command ] ||
  fail "pnpm install did not create the node_modules/.bin link"

installed="$(node -p 'require("dependency")' 2>/tmp/require.err)" ||
  fail "requiring the installed package failed: $(cat /tmp/require.err)"
[ "$installed" = "installed by pnpm" ] ||
  fail "installed package returned '$installed'"

linked="$(./node_modules/.bin/fixture-command 2>/tmp/bin.err)" ||
  fail "executing the node_modules/.bin command failed: $(cat /tmp/bin.err)"
[ "$linked" = "linked by pnpm" ] ||
  fail "node_modules/.bin command returned '$linked'"

printf '::pnpm::version=%s\n' "$version"
echo "::vm-test::pass"
while :; do :; done
