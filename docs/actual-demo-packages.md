# Install the Actual demo from the custom APK repository

## 1. Start the tailnet demo

From the workspace root:

```sh
./tailnet-demo.sh up
./tailnet-demo.sh status
```

The repo process serves `.gcroots/repository` on host loopback port 8182. The
browser relay maps its host loopback to the guest gateway, so the exact APK v3
index URL inside the guest is:

```text
http://192.0.2.1:8182/wasm32/Packages.adb
```

Do not pass only the server root: `apk` would look for the incompatible
`wasm32/APKINDEX.tar.gz`. Do not add `/apk`; that prefix belongs only to the
automated `actual-proof` server layout.

## 2. Install the writable guest on a new disk

During the first recovery boot, redirect the installer before running it:

```sh
repo_url='http://192.0.2.1:8182/wasm32/Packages.adb'
wget -qO /dev/null "$repo_url" || echo 'repository is unreachable'
sed -i "s#^repository=.*#repository=$repo_url#" /sbin/install-lowland
install-lowland
```

When installation finishes, reload the browser to boot the installed system.

## 3. Install the Actual prerequisites

Inside the installed guest:

```sh
repo_url='http://192.0.2.1:8182/wasm32/Packages.adb'
printf '%s\n' "$repo_url" > /etc/apk/repositories
apk --allow-untrusted add git yarn ca-certificates edgejs
```

The local Nix-built index is unsigned, so `--allow-untrusted` is required.
`192.0.2.2` is the guest itself; the repo is reached through `192.0.2.1:8182`.

## 4. Fetch and run Actual

```sh
mkdir -p /work
cd /work
git clone --filter=blob:none --no-checkout \
  https://github.com/actualbudget/actual.git actual
cd actual
git checkout adf5d198282218f06ce0a6cbe847bee66f483332
yarn install --immutable --mode=skip-build
sync
echo 3 > /proc/sys/vm/drop_caches
cd packages/desktop-client
BROWSER=none PORT=8080 \
  yarn vite --host 0.0.0.0 --port 8080 --mode browser
```

The tailnet demo already maps tailnet TCP port 12345 to guest TCP port 8080.
Open `http://<tailnet-host>:12345/` after Vite starts.
