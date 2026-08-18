#!/bin/busybox sh

# A native N-API addon normally ships as a .node file that process.dlopen maps
# at run time. This platform is static-only and wasm has no dlopen, so the
# addon's code is compiled into the interpreter and registered under the file
# name `require` asks for. That makes two things worth checking separately from
# whatever the addon does: that `require` still resolves a path to a file that
# exists, and that requiring it returns the addon's exports rather than
# attempting a dynamic load that cannot work.
#
# Rolldown is the linked addon, so its exports are what a working registry
# produces. This test asks only whether they arrived; whether rolldown bundles
# correctly is a question for vite.

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

addon=/lib/edge-addons/rolldown-binding.node
[ -f "$addon" ] || fail "no placeholder file for the linked addon at $addon"

cat >/tmp/linked-addon.js <<'SCRIPT'
// Exactly what napi-rs's generated loader does when NAPI_RS_NATIVE_LIBRARY_PATH
// is set: require the path, whole. Going through require rather than calling
// process.dlopen directly is the point, because that is the path rolldown takes
// and it covers the .node extension handler as well as the registry itself.
// Not named `exports`: that identifier is already a parameter of CommonJS's
// module wrapper, so declaring it makes the file fail to parse as CommonJS,
// and module-syntax detection then retries it as an ES module where `require`
// does not exist.
const addon = require(process.env.LINKED_ADDON);

// Whether any exports arrived is the first question: a failed registration
// returns an untouched object, and a dynamic load could not even be attempted
// here.
const names = Object.keys(addon).sort();
if (names.length === 0) {
  throw new Error("the linked addon registered no exports");
}

// The second question is whether an asynchronous export ever settles. Napi-rs
// resolves every promise through a threadsafe function, so an interpreter that
// accepts those calls and drops them leaves the promise pending forever, the
// event loop empty, and the process exiting successfully having printed
// nothing at all. That is why the success line is printed from inside the
// callback and the test asserts on the output rather than the exit status:
// nothing else here can tell that failure from a pass.
addon
  .transform("probe.js", "export const answer = 1 + 1;")
  .then((result) => {
    if (typeof result.code !== "string") {
      throw new Error(`transform resolved with no code: ${JSON.stringify(result)}`);
    }
    console.log(`linked-addon ok ${names.length}: ${names.join(",")}`);
  })
  .catch((error) => {
    console.error(error.stack ?? String(error));
    process.exit(1);
  });
SCRIPT

LINKED_ADDON="$addon" node /tmp/linked-addon.js >/tmp/linked-addon.out 2>/tmp/linked-addon.err ||
  fail "loading the linked addon failed: $(cat /tmp/linked-addon.err)"

result="$(cat /tmp/linked-addon.out)"
# Printed so the exported names reach the test log on success too, not only
# through the failure path's stderr dump.
printf '%s\n' "$result"
case "$result" in
"linked-addon ok "*) ;;
*) fail "unexpected linked addon output '$result'" ;;
esac

# The interpreter defaults NAPI_RS_NATIVE_LIBRARY_PATH to the placeholder it
# installs, because that variable is the only way a napi-rs loader can find a
# linked addon: there is no .node file to detect and no dlopen to call. Without
# the default, every addon works only for a caller who already knows this.
default="$(node -e 'process.stdout.write(String(process.env.NAPI_RS_NATIVE_LIBRARY_PATH))')" ||
  fail "reading the default addon path failed"
[ "$default" = "$addon" ] ||
  fail "NAPI_RS_NATIVE_LIBRARY_PATH defaulted to '$default', expected '$addon'"

# The default has to be usable, not merely present, and by a caller that sets
# nothing at all -- which is the case the export in every probe hid until now.
cat >/tmp/default-addon.js <<'SCRIPT'
const path = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
if (!path) throw new Error("NAPI_RS_NATIVE_LIBRARY_PATH is unset");
const addon = require(path);
const names = Object.keys(addon);
if (names.length === 0) throw new Error("the default addon path registered no exports");
console.log(`default-addon ok ${names.length}`);
SCRIPT

node /tmp/default-addon.js >/tmp/default-addon.out 2>/tmp/default-addon.err ||
  fail "loading the addon through the default path failed: $(cat /tmp/default-addon.err)"
default_result="$(cat /tmp/default-addon.out)"
printf '%s\n' "$default_result"
case "$default_result" in
"default-addon ok "*) ;;
*) fail "unexpected default addon output '$default_result'" ;;
esac

# An explicit value must still win: this is a default, not an override.
explicit="$(NAPI_RS_NATIVE_LIBRARY_PATH=/tmp/explicit-addon-path \
  node -e 'process.stdout.write(String(process.env.NAPI_RS_NATIVE_LIBRARY_PATH))')" ||
  fail "reading the explicit addon path failed"
[ "$explicit" = "/tmp/explicit-addon-path" ] ||
  fail "an explicit NAPI_RS_NATIVE_LIBRARY_PATH was overwritten with '$explicit'"

echo "::vm-test::pass"
while :; do :; done
