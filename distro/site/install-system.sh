#!/bin/busybox sh
set -e

target=/mnt
repository=http://assets.low.land/apk/wasm32/Packages.adb

fail() {
  printf 'install-lowland: %s\n' "$*" >&2
  exit 1
}

# Make the destructive target checks explicit: this command is valid only in
# the recovery overlay and never formats a mounted disk or one with holders.
grep -q '^overlay / overlay ' /proc/mounts ||
  fail 'the recovery overlay is not mounted as /; refusing to format /dev/vdb'
[ ! -e /etc/lowland-installed ] ||
  fail 'this system is already installed; refusing to format /dev/vdb'
[ -b /dev/vdb ] || fail '/dev/vdb is not a block device'
[ "$(cat /sys/class/block/vdb/ro)" = 0 ] || fail '/dev/vdb is read-only'
if grep -q '^/dev/vdb' /proc/mounts; then
  fail '/dev/vdb or one of its partitions is mounted'
fi
for holder in /sys/class/block/vdb/holders/*; do
  [ ! -e "$holder" ] || fail "/dev/vdb is held by ${holder##*/}"
done

mkdir -p "$target"
mke2fs -q -t ext4 -F -L LOWLAND_ROOT -m 0 /dev/vdb
mount -t ext4 /dev/vdb "$target"
mkdir -p \
  "$target/boot" \
  "$target/dev" \
  "$target/mnt" \
  "$target/proc" \
  "$target/root" \
  "$target/run" \
  "$target/sys" \
  "$target/tmp"
chmod 1777 "$target/tmp"
mount --bind /boot "$target/boot"

cleanup() {
  umount "$target/boot" 2>/dev/null || true
  umount "$target" 2>/dev/null || true
}
trap cleanup EXIT

apk \
  --root "$target" \
  --arch wasm32 \
  --allow-untrusted \
  --repository "$repository" \
  add --initdb \
  apk-tools \
  busybox \
  e2fsprogs \
  lowland-boot

cp /sbin/site-init "$target/init"
mkdir -p "$target/etc/apk/keys"
cp /etc/apk/keys/site.rsa.pub "$target/etc/apk/keys/site.rsa.pub"
cp /etc/apk/repositories "$target/etc/apk/repositories"
cp /etc/resolv.conf "$target/etc/resolv.conf"
touch "$target/etc/lowland-installed"
sync
cleanup
trap - EXIT

printf '\nInstallation complete. Reload the page to boot the installed system.\n'
