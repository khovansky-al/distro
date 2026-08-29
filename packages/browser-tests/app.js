import { blockDevice, bootMachine, consoleDevice, fileSystemDevice } from "@lowland/kernel";
import { createNetwork, guestAgent, webSocketNetwork } from "@lowland/guest";
import {
  BrowserFS,
  OPFSBlockStorageError,
  openOPFSBlockDevice,
  openOPFSBlockStorage,
  opfsBlockErrorCode,
} from "@lowland/guest/browser";

async function collectProcess(child) {
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

const rootfs = fetch("/rootfs.erofs").then(async (response) => {
  if (!response.ok) throw new Error(`failed to load rootfs: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
});

async function rootDevice() {
  const bytes = await rootfs;
  return blockDevice({
    capacity: bytes.byteLength,
    read(offset, target) {
      const source = bytes.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
  });
}

async function opfsDiskDevice(name, capacity) {
  return await openOPFSBlockDevice({ name, ...(capacity === undefined ? {} : { capacity }) });
}

// Boots a guest, runs the scenario, and always shuts the machine down.
// Scenarios return plain JSON so specs assert on the result directly.
async function withGuest(scenario, options) {
  const agent = guestAgent();
  const network = options?.network?.attach(agent);
  const machine = await bootMachine({
    cpus: options?.cpus ?? 1,
    plugins: [
      agent,
      ...(options?.devices ?? []),
      await rootDevice(),
      ...(network ? [network] : []),
    ],
  });
  try {
    return await scenario(agent);
  } finally {
    machine.close();
    await machine.closed;
  }
}

globalThis.bootSmoke = () =>
  withGuest(async (guest) => {
    const result = await collectProcess(await guest.exec(["uname", "-a"]));
    return { ...result, machineClosed: true };
  });

globalThis.opfsWorkerDiskRoundTrip = async () => {
  const directory = await navigator.storage.getDirectory();
  const name = "virtio-worker-round-trip.img";
  const removeDisk = async () => {
    await directory.removeEntry(name).catch(() => {});
    await directory.removeEntry(`${name}.metadata`).catch(() => {});
    for (let index = 1; ; index++) {
      try {
        await directory.removeEntry(`${name}.part${index}`);
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") break;
        throw error;
      }
    }
  };
  await removeDisk();
  const marker = "opfs-worker-virtio-round-trip";
  const offset = 256 * 1024 ** 2 + 4096;

  try {
    const first = await opfsDiskDevice(name, 300 * 1024 ** 2);
    const locked = await opfsDiskDevice(name).then(
      async (device) => {
        await device.close();
        return "opened";
      },
      (error) => (error instanceof OPFSBlockStorageError ? error.code : `${error}`),
    );
    const write = await withGuest(
      async (guest) =>
        collectProcess(
          await guest.exec([
            "sh",
            "-c",
            `until [ -b /dev/vdb ]; do sleep 0.1; done; printf '%s\\n' '${marker}' | dd of=/dev/vdb bs=1 seek=${offset} conv=fsync 2>/dev/null`,
          ]),
        ),
      { devices: [first] },
    );

    const second = await opfsDiskDevice(name);
    const read = await withGuest(
      async (guest) =>
        collectProcess(
          await guest.exec([
            "sh",
            "-c",
            `until [ -b /dev/vdb ]; do sleep 0.1; done; dd if=/dev/vdb bs=1 skip=${offset} count=${marker.length + 1} 2>/dev/null`,
          ]),
        ),
      { devices: [second] },
    );
    return { locked, marker, offset, write, read };
  } finally {
    await removeDisk();
  }
};

globalThis.websocketFetch = async () => {
  const response = await fetch("/relay-info.json");
  if (!response.ok) throw new Error(`WebSocket relay is unavailable: ${response.status}`);
  const { relayUrl, targetPort } = await response.json();
  const network = createNetwork(webSocketNetwork({ url: relayUrl }));
  try {
    return await withGuest(
      async (guest) =>
        collectProcess(
          await guest.exec([
            "wget",
            "-qO-",
            // The virtual gateway maps to host loopback. Guest localhost
            // would stay entirely inside Linux and never reach the adapter.
            `http://${network.gateway}:${targetPort}/relay-fixture`,
          ]),
        ),
      { network },
    );
  } finally {
    network.close();
  }
};

let publishedHttp;

globalThis.startPublishedHttp = async () => {
  if (publishedHttp) throw new Error("published HTTP fixture is already running");
  const response = await fetch("/relay-info.json");
  if (!response.ok) throw new Error(`WebSocket relay is unavailable: ${response.status}`);
  const { relayUrl } = await response.json();
  const relayNetwork = webSocketNetwork({ url: relayUrl });
  const network = createNetwork(relayNetwork);
  let agent;
  let machine;
  let attachment;
  let server;
  let publication;
  try {
    agent = guestAgent();
    attachment = network.attach(agent);
    machine = await bootMachine({
      cpus: 1,
      plugins: [agent, await rootDevice(), attachment],
    });
    const fixture = await collectProcess(
      await agent.exec([
        "sh",
        "-c",
        "mkdir -p /tmp/published-http && " +
          "printf '%s\\n' 'hello from a published WASM Linux server' > " +
          "/tmp/published-http/index.html",
      ]),
    );
    if (!fixture.status.success) {
      throw new Error(`failed to create HTTP fixture: ${fixture.stderr}`);
    }
    server = await agent.exec([
      "/usr/sbin/httpd",
      "-f",
      "-p",
      "0.0.0.0:8080",
      "-h",
      "/tmp/published-http",
    ]);
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const probe = await attachment.connect({ port: 8080 });
        probe.close();
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    publication = await relayNetwork.publishTcp(attachment, {
      relayPort: 0,
      guestPort: 8080,
    });
    publishedHttp = { machine, network, publication, server };
    return publication.relayPort;
  } catch (error) {
    publication?.close();
    await publication?.closed.catch(() => {});
    await server?.close();
    machine?.close();
    await machine?.closed.catch(() => {});
    network.close();
    throw error;
  }
};

globalThis.stopPublishedHttp = async () => {
  if (!publishedHttp) return;
  const { machine, network, publication, server } = publishedHttp;
  publishedHttp = undefined;
  publication.close();
  await publication.closed.catch(() => {});
  await server.kill();
  await server.status;
  machine.close();
  await machine.closed.catch(() => {});
  network.close();
};

globalThis.spawnStress = () =>
  withGuest(async (guest) => {
    // One in-guest shell spawning a vfork+exec pair per iteration at full
    // burst rate, with no host round-trip pacing between iterations. This is
    // the workload that exhausts WebKit's shared-memory address-space budget
    // when spawns outpace its asynchronous reservation reclaim: paced
    // spawning passes everywhere, bursts are what break.
    const script = "i=0; while [ $i -lt 100 ]; do ls / >/dev/null || exit 1; i=$((i+1)); done";
    return collectProcess(await guest.exec(["sh", "-c", script]));
  });

globalThis.remoteMemoryMetadata = () =>
  withGuest(
    async (guest) => {
      const script = [
        "MARKER=remote-vm-environ sleep 30 &",
        "pid=$!",
        "attempt=0",
        "while [ $attempt -lt 500 ]; do",
        "  cmdline=$(tr '\\000' ' ' < /proc/$pid/cmdline)",
        '  [ "$cmdline" = "sleep 30 " ] && break',
        "  attempt=$((attempt+1))",
        // Reading /proc does not block. Yield the single guest CPU so the
        // background child can reach execve instead of exhausting a retry
        // count while it still has the parent shell's command line.
        "  sleep 0.01",
        "done",
        "environ=$(tr '\\000' '\\n' < /proc/$pid/environ)",
        "auxv_size=$(wc -c < /proc/$pid/auxv)",
        "kill $pid",
        "wait $pid 2>/dev/null || true",
        'printf \'cmdline=%s\\nenviron=%s\\nauxv=%s\\n\' "$cmdline" "$(printf \'%s\\n\' "$environ" | grep \'^MARKER=\')" "$auxv_size"',
      ].join("\n");
      return collectProcess(await guest.exec(["sh", "-c", script]));
    },
    { cpus: 1 },
  );

let lifecycleGuest;

globalThis.startRemoteMemoryLifecycle = async () => {
  if (lifecycleGuest) throw new Error("remote-memory lifecycle guest is already running");
  const agent = guestAgent();
  const machine = await bootMachine({ cpus: 1, plugins: [agent, await rootDevice()] });
  lifecycleGuest = { agent, machine };
};

globalThis.runRemoteMemoryLifecycleBatch = async (batch, iterations) => {
  if (!lifecycleGuest) throw new Error("remote-memory lifecycle guest is not running");
  const script = [
    "i=0",
    `while [ $i -lt ${iterations} ]; do`,
    `  MARKER=remote-vm-lifecycle-${batch}-$i sleep 30 &`,
    "  pid=$!",
    "  attempt=0",
    "  while [ $attempt -lt 500 ]; do",
    "    cmdline=$(tr '\\000' ' ' < /proc/$pid/cmdline)",
    '    [ "$cmdline" = "sleep 30 " ] && break',
    "    attempt=$((attempt+1))",
    // This is a readiness wait, not a throughput assertion. Without a
    // blocking operation the observer can win every timeslice and consume
    // all retries before the child changes its /proc identity at execve.
    "    sleep 0.01",
    "  done",
    "  environ=$(tr '\\000' '\\n' < /proc/$pid/environ | grep '^MARKER=')",
    "  auxv_size=$(wc -c < /proc/$pid/auxv)",
    "  kill $pid",
    "  wait $pid 2>/dev/null || true",
    '  [ "$cmdline" = "sleep 30 " ] || exit 10',
    `  [ "$environ" = "MARKER=remote-vm-lifecycle-${batch}-$i" ] || exit 11`,
    '  [ "$auxv_size" -gt 0 ] || exit 12',
    "  i=$((i+1))",
    "done",
    "printf 'batch=%s processes=%s\\n' \"" + batch + '" "$i"',
  ].join("\n");
  return collectProcess(await lifecycleGuest.agent.exec(["sh", "-c", script]));
};

globalThis.closeRemoteMemoryLifecycle = async () => {
  if (!lifecycleGuest) return;
  const { machine } = lifecycleGuest;
  lifecycleGuest = undefined;
  machine.close();
  await machine.closed;
};

async function fetchBytes(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`failed to load ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const bootInitramfs = fetchBytes("/boot.cpio");

async function runInstalledSystem(path, cpus) {
  const [initcpio, disk] = await Promise.all([bootInitramfs, fetchBytes(path)]);
  const root = blockDevice({
    capacity: disk.byteLength,
    read(offset, target) {
      const source = disk.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
  });

  let resolve;
  let reject;
  const completed = new Promise((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  let output = "";
  const decoder = new TextDecoder();
  const consume = (chunk) => {
    // Virtio console output may be a view into shared WebAssembly memory,
    // which TextDecoder deliberately rejects in Chromium and Firefox.
    output += decoder.decode(Uint8Array.from(chunk), { stream: true });
    if (output.includes("::vm-test::pass")) resolve();
    if (output.includes("::vm-test::fail") || output.includes("Kernel panic - not syncing")) {
      reject(new Error(output));
    }
  };
  const outputStream = () =>
    new WritableStream({
      write: consume,
    });
  const input = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  const machine = await bootMachine({
    cpus,
    plugins: [root, consoleDevice(input, outputStream())],
    initcpio,
  });
  void machine.bootConsole.pipeTo(outputStream()).catch(reject);
  void machine.closed.then(
    () => reject(new Error("machine closed before scheduler handoff test completed")),
    reject,
  );

  try {
    await completed;
  } finally {
    machine.close();
    await machine.closed.catch(() => {});
  }
}

globalThis.schedulerHandoffStress = () => runInstalledSystem("/scheduler-handoff.erofs", 2);

globalThis.remoteMemoryProtocol = () => runInstalledSystem("/remote-vm.erofs", 2);

globalThis.posixSpawnHandoffStress = () => runInstalledSystem("/posix-spawn-stress.erofs", 1);

globalThis.opfsVirtioFileSystem = async () => {
  const storage = await navigator.storage.getDirectory();
  await storage.removeEntry("virtio-fs-test", { recursive: true }).catch(() => {});
  const directory = await storage.getDirectoryHandle("virtio-fs-test", { create: true });
  const filesystem = new BrowserFS(directory);
  const created = await filesystem.create(filesystem.root, "hello", 0x40 | 0x80 | 0x2, {
    mode: 0o100640,
    uid: 1000,
    gid: 1000,
  });
  const input = new TextEncoder().encode("persistent");
  await filesystem.write(created.node, created.handle, 0n, input);
  const output = await filesystem.read(created.node, created.handle, 0n, input.length);
  const directoryNode = await filesystem.mkdir(filesystem.root, "directory", {
    mode: 0o040750,
    uid: 1000,
    gid: 1000,
  });
  const nested = await filesystem.create(directoryNode, "nested", 0x40 | 0x80 | 0x2, {
    mode: 0o100600,
    uid: 1000,
    gid: 1000,
  });
  await filesystem.write(nested.node, nested.handle, 0n, new TextEncoder().encode("before"));
  await filesystem.rename(filesystem.root, "directory", filesystem.root, "moved-directory");
  await filesystem.write(nested.node, nested.handle, 0n, new TextEncoder().encode("after"));
  await filesystem.rename(filesystem.root, "hello", filesystem.root, "renamed");
  const entries = (
    await filesystem.readdir(filesystem.root, await filesystem.opendir(filesystem.root))
  )
    .map((entry) => entry.name)
    .sort();

  const reopened = new BrowserFS(directory);
  const node = await reopened.lookup(reopened.root, "renamed");
  const handle = await reopened.open(node, 0);
  const persisted = await reopened.read(node, handle, 0n, input.length);
  const movedDirectory = await reopened.lookup(reopened.root, "moved-directory");
  const nestedNode = await reopened.lookup(movedDirectory, "nested");
  const nestedHandle = await reopened.open(nestedNode, 0);
  const nestedPersisted = await reopened.read(nestedNode, nestedHandle, 0n, 5);
  await filesystem.setattr(created.node, {
    mtime: { seconds: 123n, nanoseconds: 456_000_000 },
  });
  const stat = await filesystem.getattr(created.node);

  const concurrent = await filesystem.create(filesystem.root, "concurrent", 0x40 | 0x80 | 0x2, {
    mode: 0o100600,
    uid: 1000,
    gid: 1000,
  });
  await filesystem.write(
    concurrent.node,
    concurrent.handle,
    0n,
    new TextEncoder().encode("000000"),
  );
  await Promise.all([
    filesystem.write(concurrent.node, concurrent.handle, 0n, new TextEncoder().encode("abc")),
    filesystem.write(concurrent.node, concurrent.handle, 3n, new TextEncoder().encode("def")),
  ]);
  const concurrentData = await filesystem.read(concurrent.node, concurrent.handle, 0n, 6);
  await filesystem.unlink(filesystem.root, "concurrent");

  const old = await filesystem.create(filesystem.root, "identity", 0x40 | 0x80 | 0x2, {
    mode: 0o100600,
    uid: 1000,
    gid: 1000,
  });
  await filesystem.write(old.node, old.handle, 0n, new TextEncoder().encode("old"));
  await filesystem.unlink(filesystem.root, "identity");
  const replacement = await filesystem.create(filesystem.root, "identity", 0x40 | 0x80 | 0x2, {
    mode: 0o100600,
    uid: 1000,
    gid: 1000,
  });
  await filesystem.write(replacement.node, replacement.handle, 0n, new TextEncoder().encode("new"));
  await filesystem.write(old.node, old.handle, 0n, new TextEncoder().encode("OLD")).catch(() => {});
  const replacementData = await filesystem.read(replacement.node, replacement.handle, 0n, 3);
  await filesystem.unlink(filesystem.root, "identity");

  const externalOld = await filesystem.create(
    filesystem.root,
    "external-identity",
    0x40 | 0x80 | 0x2,
    { mode: 0o100600, uid: 1000, gid: 1000 },
  );
  await directory.removeEntry("external-identity");
  const missing = await filesystem.lookup(filesystem.root, "external-identity");
  const externalFile = await directory.getFileHandle("external-identity", { create: true });
  const externalWritable = await externalFile.createWritable();
  await externalWritable.write("new");
  await externalWritable.close();
  await filesystem
    .write(externalOld.node, externalOld.handle, 0n, new TextEncoder().encode("OLD"))
    .catch(() => {});
  const externalReplacement = await filesystem.lookup(filesystem.root, "external-identity");
  const externalReplacementHandle = await filesystem.open(externalReplacement, 0);
  const externalReplacementData = await filesystem.read(
    externalReplacement,
    externalReplacementHandle,
    0n,
    3,
  );
  await filesystem.unlink(filesystem.root, "external-identity");

  const renameSource = await filesystem.create(
    filesystem.root,
    "rename-source",
    0x40 | 0x80 | 0x2,
    { mode: 0o100600, uid: 1000, gid: 1000 },
  );
  await filesystem.write(
    renameSource.node,
    renameSource.handle,
    0n,
    new TextEncoder().encode("source"),
  );
  const renameDestination = await filesystem.create(
    filesystem.root,
    "rename-destination",
    0x40 | 0x80 | 0x2,
    { mode: 0o100600, uid: 1000, gid: 1000 },
  );
  await filesystem.write(
    renameDestination.node,
    renameDestination.handle,
    0n,
    new TextEncoder().encode("destination"),
  );
  await filesystem.rename(filesystem.root, "rename-source", filesystem.root, "rename-destination");
  const renamed = await filesystem.lookup(filesystem.root, "rename-destination");
  const renamedHandle = await filesystem.open(renamed, 0);
  const renameDestinationData = await filesystem.read(renamed, renamedHandle, 0n, 6);
  const renameSourceMissing =
    (await filesystem.lookup(filesystem.root, "rename-source")) === undefined;
  const replacedHandleStale = await filesystem.getattr(renameDestination.node).then(
    () => false,
    () => true,
  );
  await filesystem.unlink(filesystem.root, "rename-destination");
  return {
    concurrent: new TextDecoder().decode(concurrentData),
    entries,
    externalMissing: missing === undefined,
    externalReplacement: new TextDecoder().decode(externalReplacementData),
    mode: stat.mode & 0o777,
    mtime: `${stat.mtime.seconds}.${String(stat.mtime.nanoseconds).padStart(9, "0")}`,
    nestedPersisted: new TextDecoder().decode(nestedPersisted),
    output: new TextDecoder().decode(output),
    persisted: new TextDecoder().decode(persisted),
    renameDestination: new TextDecoder().decode(renameDestinationData),
    renameSourceMissing,
    replacedHandleStale,
    replacement: new TextDecoder().decode(replacementData),
  };
};

globalThis.opfsVirtioFileSystemGuest = async () => {
  const storage = await navigator.storage.getDirectory();
  await storage.removeEntry("virtio-fs-guest-test", { recursive: true }).catch(() => {});
  const directory = await storage.getDirectoryHandle("virtio-fs-guest-test", { create: true });
  const filesystem = new BrowserFS(directory);
  const input = new Uint8Array(256 * 1024);
  for (let index = 0; index < input.length; index += 1) input[index] = index % 251;

  const mounted = await withGuest(
    async (guest) => {
      const mount = await collectProcess(
        await guest.exec([
          "sh",
          "-c",
          "mkdir -p /tmp/shared && mount -t virtiofs browser-test /tmp/shared",
        ]),
      );
      if (!mount.status.success) throw new Error(`mount failed: ${mount.stderr}`);
      await guest.fs.writeFile("/tmp/shared/persistent", input);
      const output = await guest.fs.readFile("/tmp/shared/persistent");
      return {
        size: output.byteLength,
        first: output[0],
        last: output.at(-1),
      };
    },
    {
      devices: [
        fileSystemDevice(filesystem, {
          tag: "browser-test",
          cache: false,
        }),
      ],
    },
  );

  const reopened = new BrowserFS(directory);
  const node = await reopened.lookup(reopened.root, "persistent");
  const handle = await reopened.open(node, 0);
  const persisted = await reopened.read(node, handle, 0n, input.byteLength);
  return {
    ...mounted,
    persistedSize: persisted.byteLength,
    persistedFirst: persisted[0],
    persistedLast: persisted.at(-1),
  };
};

globalThis.opfsBlockStorage = async () => {
  const directory = await navigator.storage.getDirectory();
  const name = "opfs-block-storage-test.ext4";
  const removeDisk = async () => {
    await directory.removeEntry(name).catch(() => {});
    await directory.removeEntry(`${name}.metadata`).catch(() => {});
    for (let index = 1; ; index++) {
      try {
        await directory.removeEntry(`${name}.part${index}`);
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") break;
        throw error;
      }
    }
  };
  await removeDisk();
  const capacity = 4 * 1024 ** 3;
  const positions = [0, 137 * 1024 * 1024 + 509, capacity - 4096];
  const expected = positions.map((position, index) => {
    const data = new Uint8Array(4096);
    for (let offset = 0; offset < data.length; offset++) data[offset] = (offset + index * 31) % 251;
    return { position, data };
  });
  const storage = await openOPFSBlockStorage({ name, capacity });
  let locked;
  try {
    await Promise.all(expected.map(({ position, data }) => storage.write(position, data)));
    await storage.flush();
    locked = await openOPFSBlockStorage({ name }).then(
      () => "opened",
      (error) => (error instanceof OPFSBlockStorageError ? error.code : `${error}`),
    );
  } finally {
    await storage.close();
  }

  const reopened = await openOPFSBlockStorage({ name });
  try {
    const reads = await Promise.all(
      expected.map(async ({ position, data }) => {
        const actual = new Uint8Array(data.byteLength);
        const read = await reopened.read(position, actual);
        if (read !== actual.byteLength) return false;
        return actual.every((value, index) => value === data[index]);
      }),
    );
    return {
      capacity: reopened.capacity,
      locked,
      reads,
      readBytes: expected.reduce((total, entry) => total + entry.data.byteLength, 0),
    };
  } finally {
    await reopened.close();
    await removeDisk();
  }
};

globalThis.opfsBlockQuotaMapping = () =>
  opfsBlockErrorCode(new DOMException("test quota exhausted", "QuotaExceededError"));
