# `@lowland/guest`

`@lowland/guest` is the Lowland guest-agent integration. It contributes its
private boot filesystem and vsock transport to an `@lowland/kernel` machine and
exposes processes, files, mounts, and networking through the returned agent.

## Installation

```sh
npm install @lowland/kernel @lowland/guest
```

## Usage

```js
import { blockDevice, bootMachine } from "@lowland/kernel";
import { guestAgent } from "@lowland/guest";

const rootfs = new Uint8Array(
  await fetch("/rootfs.erofs").then((response) => response.arrayBuffer()),
);
const root = blockDevice({
  capacity: rootfs.byteLength,
  read(offset, target) {
    const source = rootfs.subarray(offset, offset + target.byteLength);
    target.set(source);
    return source.byteLength;
  },
});

const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  plugins: [root, guest],
});

const result = await guest.run(["uname", "-a"]);
console.log(new TextDecoder().decode(result.stdout));
```

`exec()` returns a live `ChildProcess` with streaming standard I/O. `run()`
collects its status, stdout, and stderr and is convenient for bounded commands.
Both methods accept an argv array without shell parsing.

The plugin boots its private EROFS using the GPT partition label
`LOWLAND_AGENT`, so its position among block-device plugins is irrelevant. The
agent then requires exactly one attached EROFS or ext4 filesystem labeled
`LOWLAND_ROOT`, pivots into it, and unmounts its private boot filesystem.
Missing and duplicate system roots fail `bootMachine()` through the plugin
readiness hook.

Pass `"lowland.root.overlay=tmpfs"` as a kernel argument to mount the system
image read-only beneath a temporary writable OverlayFS:

```js
const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  args: ["lowland.root.overlay=tmpfs"],
  plugins: [guest, root],
});
```

## Networking

Networking is another composable guest integration:

```js
import { createNetwork } from "@lowland/guest";

const guest = guestAgent();
const network = createNetwork({ connectTcp, resolveDns });
const attachment = network.attach(guest);

await using machine = await bootMachine({
  cpus: 1,
  plugins: [root, guest, attachment],
});

console.log(attachment.address);
```

The attachment contributes the virtio NIC and configures it after the agent is
ready. Each agent supports one network attachment; attach multiple agents to
the same network to put them on one private IPv4 subnet.

### Raw browser networking through WebSocket

Browsers cannot open raw TCP sockets. `webSocketNetwork` tunnels each guest DNS
lookup and TCP flow through a native WebSocket relay while leaving the bytes
opaque, so HTTP and TLS still run inside Linux:

```js
import { createNetwork, guestAgent, webSocketNetwork } from "@lowland/guest";

const network = createNetwork(webSocketNetwork({ url: "wss://relay.example.net/" }));
const guest = guestAgent();
const attachment = network.attach(guest);
await using machine = await bootMachine({
  cpus: 1,
  plugins: [root, guest, attachment],
});
const request = await guest.exec(["wget", "-qO-", "https://example.com/"]);
console.log(await new Response(request.stdout).text());
network.close();
```

The same adapter can publish an approved native relay port to a TCP listener
inside one guest:

```js
const relay = webSocketNetwork({ url: "wss://relay.example.net/" });
const network = createNetwork(relay);
const guest = guestAgent();
const attachment = network.attach(guest);
await using machine = await bootMachine({
  cpus: 1,
  plugins: [root, guest, attachment],
});

// The native relay must allow --publish 127.0.0.1:12345:8080.
const publication = await relay.publishTcp(attachment, {
  relayPort: 12345,
  guestPort: 8080,
});
console.log(`listening on native TCP port ${publication.relayPort}`);

publication.close();
await publication.closed;
```

Use relay port `0` with a matching relay policy to request an OS-assigned
development port; `publication.relayPort` reports the effective port. The
guest server must bind its Ethernet address or `0.0.0.0`, not only
`127.0.0.1`. Publication carries raw TCP bytes and does not inherit
authentication from the reverse proxy serving the relay WebSocket, so the
published service must provide its own security when it is exposed beyond
loopback.

Run the companion `lowland-websocket-relay` from
`packages/websocket-relay`. An HTTPS embedding page must use a `wss:` endpoint;
the dependency-free relay speaks plain `ws:` and is intended to run behind a
TLS reverse proxy. Treat it as a security-sensitive forward proxy and require
authentication before exposing it beyond a trusted network.

## Host directory adapters

`@lowland/guest/node` provides `NodeFS`, and
`@lowland/guest/browser` provides `BrowserFS`. Adapt them with the kernel's
`fileSystemDevice()` and mount the resulting virtio-fs device through the
agent:

```js
import { fileSystemDevice } from "@lowland/kernel";
import { NodeFS } from "@lowland/guest/node";

const shared = fileSystemDevice(new NodeFS("/srv/guest-share"), {
  tag: "host",
  cache: false,
});
const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  plugins: [root, guest, shared],
});
await guest.fs.mkdir("/tmp/host");
await guest.mount("host", "/tmp/host", { type: "virtiofs" });
```

Pass `{ readOnly: true }` to `NodeFS` when read-only access is part of the trust
boundary. A read-only guest mount alone does not prevent writes through raw
filesystem requests. The Node adapter confines paths beneath its configured
root and does not follow final symlinks, but portable Node lacks the
descriptor-relative operations needed to make that confinement race-free
against an unrelated host process restructuring the directory. Use an OS
sandbox or native helper when that stronger boundary is required.

`BrowserFS` accepts OPFS and user-selected `FileSystemDirectoryHandle` values.
The browser API has no Unix inode metadata or atomic portable rename, so the
adapter synthesizes metadata and implements rename as copy-then-remove. A
failed rename can leave a partial destination or both names. Use `cache: false`
for directories modified outside the guest; this disables metadata and name
caching, but not the guest's data page cache.

## License

The TypeScript and JavaScript sources are available under the MIT license. The
published agent image also contains GPL-2.0-only BusyBox and MIT-licensed musl.
