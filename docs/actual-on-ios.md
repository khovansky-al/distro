# Actual from source on iPadOS

The browser site supports Actual's browser-local client on a persistent ext4
filesystem in OPFS. The sync server is not part of this configuration.

Inside an installed browser guest:

```sh
apk add edgejs yarn git ca-certificates
mkdir -p /work
cd /work
git clone https://github.com/actualbudget/actual.git
cd actual
yarn install --immutable --mode=skip-build
sync
echo 3 > /proc/sys/vm/drop_caches
BROWSER=none yarn start
```

The cache checkpoint is required after the first multi-gigabyte install. The
no-MMU wasm kernel has a fixed 4 GiB physical pool, and Yarn's link step leaves
most of it populated with clean ext4 page cache. Syncing and dropping that
clean cache gives the Vite process room to start; it does not discard any
filesystem data and is unnecessary on later boots.

The automated proof uses the same guest checkout and environment, but starts
Vite directly from `packages/desktop-client`:

```sh
cd /work/actual/packages/desktop-client
BROWSER=none PORT=3001 yarn vite --host 0.0.0.0 --port 3001 --mode browser
```

That direct command avoids the guest's root `yarn start` parallel watcher
orphaning its browser process; interactive use may continue to use the root
command above.

`nix run .#actual-proof` drives the pinned commit used by the automated proof,
`adf5d198282218f06ce0a6cbe847bee66f483332`, through the packaged site, native
relay, APK repository, persistent Chromium profile, and a published guest port.
It requires public GitHub and Yarn registry access and is intentionally not a
Nix check.

## Native iOS host contract

The iOS application is a separate component. It must:

- target iPadOS 17 or newer;
- serve the packaged site on `http://127.0.0.1` with COOP and COEP;
- expose the native relay on `ws://127.0.0.1`;
- approve a loopback publication from guest TCP port 3001;
- keep the VM page alive while it displays the published Actual page; and
- open the VM with a URL shaped like:

```text
http://127.0.0.1:<site-port>/?relay=ws://127.0.0.1:<relay-port>/&publish=<published-port>:3001&diskGiB=8
```

Loopback is a trustworthy origin, so this integration needs neither TLS nor
tailnet routing. OPFS remains origin-private. The first-run UI reports whether
the browser granted persistent storage; without that grant, WebKit can still
evict the filesystem under storage pressure.
