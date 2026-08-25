// SPDX-License-Identifier: MIT

import {
  type BlockDeviceStorage,
  type FS,
  type FSAttributes,
  type FSCreateContext,
  type FSDirectoryEntry,
  FSError,
  type FSSetAttributes,
  type FSTimestamp,
} from "@lowland/kernel";

export { opfsBlockErrorCode } from "./opfs-block-errors.js";

export class OPFSBlockStorageError extends Error {
  readonly code: string;

  constructor(message: string, code = "EIO", options?: ErrorOptions) {
    super(message, options);
    this.name = "OPFSBlockStorageError";
    this.code = code;
  }
}

export interface OPFSBlockStorage extends BlockDeviceStorage, AsyncDisposable {
  readonly capacity: number;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface OpenOPFSBlockStorageOptions {
  /** OPFS directory containing the disk. Defaults to the origin's root. */
  directory?: FileSystemDirectoryHandle;
  /** File name within `directory`. Defaults to `root.ext4`. */
  name?: string;
  /** Create the file when it is absent. Defaults to true. */
  create?: boolean;
  /** Initialize an empty file to this size, or require this exact existing size. */
  capacity?: number;
  /** Grow an existing file to `capacity`; shrinking is never allowed. */
  resize?: boolean;
  /** Override the origin-wide exclusive Web Lock name. */
  lockName?: string;
}

const OPFS_BLOCK_METADATA_VERSION = 1;
// Chromium's OPFS synchronous access handle cannot reliably grow one sparse
// file to 1 GiB in every supported storage backend. Present one logical block
// device while keeping its implementation files below that boundary.
const OPFS_BLOCK_SEGMENT_SIZE = 256 * 1024 ** 2;

interface OPFSBlockMetadata {
  version: number;
  capacity: number;
  segmentSize: number;
}

async function readOPFSBlockMetadata(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<OPFSBlockMetadata | undefined> {
  let handle: FileSystemFileHandle;
  try {
    handle = await directory.getFileHandle(`${name}.metadata`);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
    throw error;
  }
  const parsed = JSON.parse(await (await handle.getFile()).text()) as Partial<OPFSBlockMetadata>;
  if (
    parsed.version !== OPFS_BLOCK_METADATA_VERSION ||
    !Number.isSafeInteger(parsed.capacity) ||
    parsed.capacity! <= 0 ||
    parsed.segmentSize !== OPFS_BLOCK_SEGMENT_SIZE
  ) {
    throw new OPFSBlockStorageError(`OPFS disk ${name} has invalid metadata`, "EIO");
  }
  return parsed as OPFSBlockMetadata;
}

async function writeOPFSBlockMetadata(
  directory: FileSystemDirectoryHandle,
  name: string,
  capacity: number,
) {
  const handle = await directory.getFileHandle(`${name}.metadata`, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(
      JSON.stringify({
        version: OPFS_BLOCK_METADATA_VERSION,
        capacity,
        segmentSize: OPFS_BLOCK_SEGMENT_SIZE,
      }),
    );
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => {});
    throw error;
  }
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  capacity?: number;
  data?: ArrayBuffer;
  written?: number;
  error?: { name: string; message: string; code: string };
}

/**
 * Opens a random-access OPFS file as virtio block storage.
 *
 * A dedicated worker owns the synchronous access handle. Only requested byte
 * ranges cross the worker boundary, and a Web Lock prevents another tab from
 * mounting the same origin-private disk at the same time.
 */
export async function openOPFSBlockStorage(
  options: OpenOPFSBlockStorageOptions = {},
): Promise<OPFSBlockStorage> {
  if (!navigator.storage?.getDirectory) {
    throw new OPFSBlockStorageError("this browser does not support OPFS", "ENOSYS");
  }
  if (!navigator.locks?.request) {
    throw new OPFSBlockStorageError("this browser does not support exclusive Web Locks", "ENOSYS");
  }
  const directory = options.directory ?? (await navigator.storage.getDirectory());
  const name = options.name ?? "root.ext4";
  const file = await directory.getFileHandle(name, { create: options.create ?? true });
  const parts = await directory.resolve(file);
  const lockName = options.lockName ?? `@lowland/guest/opfs-block/${parts?.join("/") ?? name}`;
  const acquired = Promise.withResolvers<boolean>();
  const releaseLock = Promise.withResolvers<void>();
  let acquisitionSettled = false;
  const lockRequest = navigator.locks.request(
    lockName,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      acquisitionSettled = true;
      acquired.resolve(lock !== null);
      if (lock) await releaseLock.promise;
    },
  );
  void lockRequest.catch((error) => {
    if (!acquisitionSettled) acquired.reject(error);
  });
  if (!(await acquired.promise)) {
    throw new OPFSBlockStorageError(`OPFS disk ${name} is already mounted in another tab`, "EBUSY");
  }

  let requestedCapacity: number;
  try {
    const metadata = await readOPFSBlockMetadata(directory, name);
    const firstSegmentSize = (await file.getFile()).size;
    requestedCapacity = metadata?.capacity ?? firstSegmentSize;
    if (options.capacity !== undefined) {
      if (!Number.isSafeInteger(options.capacity) || options.capacity <= 0) {
        throw new RangeError("OPFS disk capacity must be a positive safe integer");
      }
      if (
        requestedCapacity === 0 ||
        (options.resize === true && requestedCapacity < options.capacity)
      ) {
        requestedCapacity = options.capacity;
      } else if (requestedCapacity !== options.capacity) {
        throw new RangeError(
          `existing OPFS disk is ${requestedCapacity} bytes, not the requested ${options.capacity}`,
        );
      }
    }
    if (requestedCapacity <= 0) {
      throw new RangeError("an empty OPFS disk requires an explicit capacity");
    }
    if (requestedCapacity > OPFS_BLOCK_SEGMENT_SIZE || metadata) {
      await writeOPFSBlockMetadata(directory, name, requestedCapacity);
    }
  } catch (error) {
    releaseLock.resolve();
    await lockRequest.catch(() => {});
    throw error;
  }

  const worker = new Worker(new URL("./opfs-block-worker.js", import.meta.url), {
    type: "module",
    name: `OPFS block storage: ${name}`,
  });
  let nextId = 1;
  let closing = false;
  let fatalError: OPFSBlockStorageError | undefined;
  const pending = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>
  >();
  const closed = Promise.withResolvers<void>();
  void closed.promise.catch(() => {});

  const fail = (error: unknown) => {
    const failure =
      error instanceof OPFSBlockStorageError
        ? error
        : new OPFSBlockStorageError(error instanceof Error ? error.message : String(error), "EIO", {
            cause: error,
          });
    if (fatalError) return;
    fatalError = failure;
    closing = true;
    for (const operation of pending.values()) operation.reject(failure);
    pending.clear();
    worker.terminate();
    releaseLock.resolve();
    closed.reject(failure);
  };

  worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const operation = pending.get(response.id);
    if (!operation) return;
    pending.delete(response.id);
    if (response.ok) operation.resolve(response as unknown as Record<string, unknown>);
    else {
      const detail = response.error;
      operation.reject(
        new OPFSBlockStorageError(detail?.message ?? "OPFS block operation failed", detail?.code, {
          cause: detail,
        }),
      );
    }
  });
  worker.addEventListener("error", (event) => fail(event.error ?? new Error(event.message)));
  worker.addEventListener("messageerror", () => fail(new Error("invalid OPFS worker message")));

  const call = (message: Record<string, unknown>, transfer: Transferable[] = []) => {
    if (fatalError) return Promise.reject(fatalError);
    if (closing && message.type !== "close") {
      return Promise.reject(new OPFSBlockStorageError("OPFS disk is closing", "EBADF"));
    }
    const id = nextId++;
    const operation = Promise.withResolvers<Record<string, unknown>>();
    pending.set(id, operation);
    worker.postMessage({ id, ...message }, transfer);
    return operation.promise;
  };

  let opened: Record<string, unknown>;
  try {
    opened = await call({
      type: "init",
      file,
      directory,
      name,
      capacity: requestedCapacity,
      segmentSize: OPFS_BLOCK_SEGMENT_SIZE,
    });
  } catch (error) {
    fail(error);
    throw error;
  }
  const capacity = opened.capacity;
  if (typeof capacity !== "number") {
    const error = new OPFSBlockStorageError("OPFS worker returned no disk capacity");
    fail(error);
    throw error;
  }

  const checkRange = (offset: number, length: number) => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > capacity
    ) {
      throw new RangeError("block request is outside the OPFS disk");
    }
  };

  const storage: OPFSBlockStorage = {
    capacity,
    closed: closed.promise,
    async read(offset, target) {
      checkRange(offset, target.byteLength);
      const response = await call({ type: "read", offset, length: target.byteLength });
      if (!(response.data instanceof ArrayBuffer)) {
        throw new OPFSBlockStorageError("OPFS worker returned invalid read data");
      }
      const data = new Uint8Array(response.data);
      target.set(data);
      return data.byteLength;
    },
    async write(offset, data) {
      checkRange(offset, data.byteLength);
      const copy = data.slice();
      const response = await call({ type: "write", offset, data: copy.buffer }, [copy.buffer]);
      if (typeof response.written !== "number") {
        throw new OPFSBlockStorageError("OPFS worker returned an invalid write count");
      }
      return response.written;
    },
    async flush() {
      await call({ type: "flush" });
    },
    async close() {
      if (closing) return closed.promise;
      closing = true;
      try {
        await call({ type: "close" });
        worker.terminate();
        releaseLock.resolve();
        await lockRequest;
        closed.resolve();
      } catch (error) {
        fail(error);
        throw error;
      }
      return closed.promise;
    },
    async [Symbol.asyncDispose]() {
      await storage.close();
    },
  };
  return storage;
}

const FileType = {
  directory: 0o040000,
  file: 0o100000,
} as const;

const OpenFlags = {
  EXCLUSIVE: 0x80,
  TRUNCATE: 0x200,
} as const;

interface Metadata {
  mode: number;
  uid: number;
  gid: number;
  atime: FSTimestamp;
  mtime: FSTimestamp;
  mtimeOverride: boolean;
  ctime: FSTimestamp;
}

function now(): FSTimestamp {
  const milliseconds = Date.now();
  return {
    seconds: BigInt(Math.floor(milliseconds / 1000)),
    nanoseconds: (milliseconds % 1000) * 1_000_000,
  };
}

function valid_name(name: string) {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  ) {
    throw new FSError("EINVAL", "invalid path component");
  }
  return name;
}

function opfs_error(error: unknown): never {
  if (error instanceof FSError) throw error;
  const name = error instanceof DOMException ? error.name : "";
  const code =
    {
      InvalidModificationError: "ENOTEMPTY",
      NoModificationAllowedError: "EACCES",
      NotAllowedError: "EACCES",
      NotFoundError: "ENOENT",
      QuotaExceededError: "ENOSPC",
      TypeMismatchError: "EINVAL",
    }[name] ?? "EIO";
  throw new FSError(
    code as ConstructorParameters<typeof FSError>[0],
    error instanceof Error ? error.message : String(error),
  );
}

async function opfs_call<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    opfs_error(error);
  }
}

function checked_offset(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new FSError("EINVAL", "offset exceeds JavaScript's integer range");
  }
  return result;
}

class Node {
  parts: string[];
  handle: FileSystemHandle;
  metadata: Metadata;
  mutation = Promise.resolve();
  // Browser handles identify a locator rather than an inode generation and may
  // resolve a same-path recreation. Once removal is observed, permanently
  // detach this generation so old guest handles fail instead of retargeting it.
  attached = true;

  constructor(parts: string[], handle: FileSystemHandle, metadata: Metadata) {
    this.parts = parts;
    this.handle = handle;
    this.metadata = metadata;
  }
}

class Handle {
  readonly node: Node;

  constructor(node: Node) {
    this.node = node;
  }
}

function default_metadata(kind: FileSystemHandle["kind"]): Metadata {
  const timestamp = now();
  return {
    mode: FileType[kind] | (kind === "directory" ? 0o755 : 0o644),
    uid: 0,
    gid: 0,
    atime: timestamp,
    mtime: timestamp,
    mtimeOverride: false,
    ctime: timestamp,
  };
}

/**
 * A virtio-fs backend for a browser `FileSystemDirectoryHandle`.
 *
 * The browser File System API exposes no Unix ownership, permissions, links,
 * or inode metadata. This adapter presents conventional synthetic values for
 * them and keeps chmod/chown/timestamp changes for the lifetime of this object.
 *
 * Rename copies to the destination and then removes the source because the
 * portable API has no atomic namespace rename. Replacing a destination first
 * removes it, as required by package managers and other normal Linux software.
 * Failure can therefore lose the old destination, leave a partial new one, or
 * leave both names if removing the source fails.
 *
 * Browser handles cannot keep an unlinked file alive like a POSIX descriptor.
 * When this adapter observes removal, existing descriptors become stale and
 * fail rather than targeting a new entry created at the same path. An external
 * remove-and-recreate with no observed missing state cannot be distinguished.
 * Writes and truncations through one adapter are serialized per node, but
 * other adapters or applications can still race its portable API operations.
 */
export class BrowserFS implements FS<Node, Handle> {
  readonly root: Node;
  readonly #nodes = new Map<string, Node>();

  constructor(root: FileSystemDirectoryHandle) {
    this.root = new Node([], root, default_metadata("directory"));
    this.#nodes.set("", this.root);
  }

  #as_node(node: Node) {
    if (!(node instanceof Node)) {
      throw new FSError("EINVAL", "node belongs to another filesystem");
    }
    if (!node.attached) {
      throw new FSError("ENOENT", "filesystem node is no longer attached");
    }
    return node;
  }

  #directory(node: Node) {
    const result = this.#as_node(node);
    if (result.handle.kind !== "directory") {
      throw new FSError("ENOTDIR");
    }
    return result.handle as FileSystemDirectoryHandle;
  }

  #remember(parts: string[], handle: FileSystemHandle) {
    const key = parts.join("/");
    let node = this.#nodes.get(key);
    if (!node) {
      node = new Node(parts, handle, default_metadata(handle.kind));
      this.#nodes.set(key, node);
    } else {
      node.handle = handle;
    }
    return node;
  }

  #forget(parts: readonly string[]) {
    const key = parts.join("/");
    for (const [candidate, node] of this.#nodes) {
      if (candidate === key || candidate.startsWith(`${key}/`)) {
        node.attached = false;
        this.#nodes.delete(candidate);
      }
    }
  }

  #open_handle(node: Node, handle: Handle) {
    const current = this.#as_node(node);
    if (!(handle instanceof Handle) || handle.node !== current) {
      throw new FSError("EBADF");
    }
    return current;
  }

  async #mutate<T>(node: Node, operation: () => Promise<T>): Promise<T> {
    const previous = node.mutation;
    const completion = Promise.withResolvers<void>();
    node.mutation = completion.promise;
    await previous;
    try {
      return await operation();
    } finally {
      completion.resolve();
    }
  }

  async #child(
    parent: FileSystemDirectoryHandle,
    name: string,
  ): Promise<FileSystemHandle | undefined> {
    try {
      return await parent.getDirectoryHandle(name);
    } catch (error) {
      if (
        !(error instanceof DOMException) ||
        !["NotFoundError", "TypeMismatchError"].includes(error.name)
      ) {
        opfs_error(error);
      }
    }
    try {
      return await parent.getFileHandle(name);
    } catch (error) {
      if (
        error instanceof DOMException &&
        ["NotFoundError", "TypeMismatchError"].includes(error.name)
      ) {
        return undefined;
      }
      opfs_error(error);
    }
  }

  async lookup(parent: Node, name: string) {
    const parent_node = this.#as_node(parent);
    const parts = [...parent_node.parts, valid_name(name)];
    const handle = await this.#child(this.#directory(parent), name);
    if (!handle) {
      this.#forget(parts);
      return undefined;
    }
    return this.#remember(parts, handle);
  }

  async getattr(node: Node): Promise<FSAttributes> {
    const current = this.#as_node(node);
    let size = 0n;
    if (current.handle.kind === "file") {
      const file = await opfs_call((current.handle as FileSystemFileHandle).getFile());
      size = BigInt(file.size);
      if (!current.metadata.mtimeOverride) {
        current.metadata.mtime = {
          seconds: BigInt(Math.floor(file.lastModified / 1000)),
          nanoseconds: (file.lastModified % 1000) * 1_000_000,
        };
      }
    }
    return {
      mode: current.metadata.mode,
      size,
      nlink: current.handle.kind === "directory" ? 2 : 1,
      uid: current.metadata.uid,
      gid: current.metadata.gid,
      blockSize: 4096,
      atime: current.metadata.atime,
      mtime: current.metadata.mtime,
      ctime: current.metadata.ctime,
    };
  }

  async setattr(node: Node, changes: FSSetAttributes) {
    const current = this.#as_node(node);
    return await this.#mutate(current, async () => {
      this.#as_node(current);
      if (changes.size !== undefined) {
        if (current.handle.kind !== "file") {
          throw new FSError("EISDIR");
        }
        const writable = await opfs_call(
          (current.handle as FileSystemFileHandle).createWritable({
            keepExistingData: true,
          }),
        );
        try {
          await opfs_call(writable.truncate(checked_offset(changes.size)));
        } finally {
          await opfs_call(writable.close());
        }
        // Truncation changes the backing file, so its native timestamp becomes
        // authoritative unless this setattr also supplies an explicit mtime.
        current.metadata.mtimeOverride = false;
      }
      if (changes.mode !== undefined) {
        current.metadata.mode = (current.metadata.mode & 0o170000) | (changes.mode & 0o7777);
      }
      if (changes.uid !== undefined) current.metadata.uid = changes.uid;
      if (changes.gid !== undefined) current.metadata.gid = changes.gid;
      if (changes.atime !== undefined) {
        current.metadata.atime = changes.atime === "now" ? now() : changes.atime;
      }
      if (changes.mtime !== undefined) {
        current.metadata.mtime = changes.mtime === "now" ? now() : changes.mtime;
        current.metadata.mtimeOverride = true;
      }
      if (changes.ctime !== undefined) current.metadata.ctime = changes.ctime;
      else current.metadata.ctime = now();
      return await this.getattr(current);
    });
  }

  async open(node: Node, flags: number) {
    const current = this.#as_node(node);
    if (current.handle.kind !== "file") {
      throw new FSError("EISDIR");
    }
    if (flags & OpenFlags.TRUNCATE) {
      await this.setattr(current, { size: 0n });
    }
    return new Handle(current);
  }

  async create(parent: Node, name: string, flags: number, context: FSCreateContext) {
    name = valid_name(name);
    const parent_node = this.#as_node(parent);
    const directory = this.#directory(parent);
    const existing = await this.#child(directory, name);
    if (existing) {
      if (flags & OpenFlags.EXCLUSIVE) {
        throw new FSError("EEXIST");
      }
      if (existing.kind !== "file") {
        throw new FSError("EISDIR");
      }
    }
    const file = existing ?? (await opfs_call(directory.getFileHandle(name, { create: true })));
    const node = this.#remember([...parent_node.parts, name], file);
    if (!existing) {
      node.metadata.mode = FileType.file | (context.mode & 0o7777);
      node.metadata.uid = context.uid;
      node.metadata.gid = context.gid;
    }
    if (flags & OpenFlags.TRUNCATE) await this.setattr(node, { size: 0n });
    return { node, handle: new Handle(node) };
  }

  async read(node: Node, handle: Handle, offset: bigint, length: number) {
    const current = this.#open_handle(node, handle);
    if (current.handle.kind !== "file") {
      throw new FSError("EISDIR");
    }
    const file = await opfs_call((current.handle as FileSystemFileHandle).getFile());
    current.metadata.atime = now();
    return new Uint8Array(
      await opfs_call(
        file.slice(checked_offset(offset), checked_offset(offset) + length).arrayBuffer(),
      ),
    );
  }

  async write(node: Node, handle: Handle, offset: bigint, data: Uint8Array) {
    const current = this.#open_handle(node, handle);
    return await this.#mutate(current, async () => {
      this.#open_handle(node, handle);
      if (current.handle.kind !== "file") {
        throw new FSError("EISDIR");
      }
      const writable = await opfs_call(
        (current.handle as FileSystemFileHandle).createWritable({
          keepExistingData: true,
        }),
      );
      try {
        await opfs_call(writable.seek(checked_offset(offset)));
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        await opfs_call(writable.write(copy.buffer));
      } finally {
        await opfs_call(writable.close());
      }
      current.metadata.mtime = now();
      current.metadata.mtimeOverride = false;
      current.metadata.ctime = current.metadata.mtime;
      return data.byteLength;
    });
  }

  // OPFS commits each write when its writable closes, so a file is durable by
  // the time `write` resolves; flush and fsync have nothing left to do.
  async flush() {}

  async fsync() {}

  async opendir(node: Node) {
    this.#directory(node);
    return new Handle(this.#as_node(node));
  }

  async readdir(node: Node, handle: Handle): Promise<FSDirectoryEntry<Node>[]> {
    const current = this.#open_handle(node, handle);
    const result: FSDirectoryEntry<Node>[] = [];
    for await (const [name, handle] of this.#directory(node).entries()) {
      result.push({
        name,
        node: this.#remember([...current.parts, name], handle),
      });
    }
    return result;
  }

  async mkdir(parent: Node, name: string, context: FSCreateContext) {
    name = valid_name(name);
    const parent_node = this.#as_node(parent);
    if (await this.#child(this.#directory(parent), name)) {
      throw new FSError("EEXIST");
    }
    const handle = await opfs_call(
      this.#directory(parent).getDirectoryHandle(name, { create: true }),
    );
    const node = this.#remember([...parent_node.parts, name], handle);
    node.metadata.mode = FileType.directory | (context.mode & 0o7777);
    node.metadata.uid = context.uid;
    node.metadata.gid = context.gid;
    return node;
  }

  async unlink(parent: Node, name: string) {
    name = valid_name(name);
    const child = await this.lookup(parent, name);
    if (!child) throw new FSError("ENOENT");
    if (this.#as_node(child).handle.kind !== "file") {
      throw new FSError("EISDIR");
    }
    await opfs_call(this.#directory(parent).removeEntry(name));
    this.#forget([...this.#as_node(parent).parts, name]);
  }

  async rmdir(parent: Node, name: string) {
    name = valid_name(name);
    const child = await this.lookup(parent, name);
    if (!child) throw new FSError("ENOENT");
    if (this.#as_node(child).handle.kind !== "directory") {
      throw new FSError("ENOTDIR");
    }
    await opfs_call(this.#directory(parent).removeEntry(name));
    this.#forget([...this.#as_node(parent).parts, name]);
  }

  async #copy(source: FileSystemHandle, destination: FileSystemDirectoryHandle, name: string) {
    // Portable File System handles provide no atomic recursive rename or
    // namespace transaction. Copy only into an absent destination and never
    // delete unrelated destination data. A failed copy may still leave the
    // partial destination created by this operation.
    if (source.kind === "file") {
      const input = await opfs_call((source as FileSystemFileHandle).getFile());
      const output = await opfs_call(destination.getFileHandle(name, { create: true }));
      const writable = await opfs_call(output.createWritable());
      // pipeTo closes the destination after success and aborts it if reading
      // the source fails, without materializing the complete file in memory.
      await opfs_call(input.stream().pipeTo(writable));
      return output;
    }
    const output = await opfs_call(destination.getDirectoryHandle(name, { create: true }));
    for await (const [child_name, child] of (source as FileSystemDirectoryHandle).entries()) {
      await this.#copy(child, output, child_name);
    }
    return output;
  }

  async rename(oldParent: Node, oldName: string, newParent: Node, newName: string) {
    oldName = valid_name(oldName);
    newName = valid_name(newName);
    const old_parent = this.#as_node(oldParent);
    const new_parent = this.#as_node(newParent);
    if (old_parent === new_parent && oldName === newName) return;
    const source = await this.lookup(old_parent, oldName);
    if (!source) throw new FSError("ENOENT");
    const source_node = this.#as_node(source);
    const old_parts = [...old_parent.parts, oldName];
    const new_parts = [...new_parent.parts, newName];
    if (
      source_node.handle.kind === "directory" &&
      new_parts.slice(0, old_parts.length).join("/") === old_parts.join("/")
    ) {
      throw new FSError("EINVAL", "cannot move a directory into itself");
    }

    const existing = await this.lookup(new_parent, newName);
    if (existing) {
      const existing_node = this.#as_node(existing);
      if (source_node.handle.kind === "directory" && existing_node.handle.kind !== "directory") {
        throw new FSError("ENOTDIR");
      }
      if (source_node.handle.kind === "file" && existing_node.handle.kind !== "file") {
        throw new FSError("EISDIR");
      }
      // Linux applications routinely publish updates by renaming a temporary
      // file over its destination. The portable browser API cannot make that
      // replacement atomic, but rejecting it prevents package installation and
      // similarly fundamental workflows. Keep the source until its replacement
      // has been copied so a failed operation still retains the new data.
      await opfs_call(
        this.#directory(new_parent).removeEntry(newName, {
          recursive: false,
        }),
      );
      this.#forget(new_parts);
    }

    const destination = this.#directory(new_parent);
    const cleanup_destination = () =>
      destination
        .removeEntry(newName, {
          recursive: source_node.handle.kind === "directory",
        })
        .catch(() => {});
    let copied: FileSystemHandle;
    try {
      copied = await this.#copy(source_node.handle, destination, newName);
    } catch (error) {
      await cleanup_destination();
      throw error;
    }
    try {
      await opfs_call(
        this.#directory(old_parent).removeEntry(oldName, {
          recursive: source_node.handle.kind === "directory",
        }),
      );
    } catch (error) {
      await cleanup_destination();
      throw error;
    }

    const moved = [...this.#nodes].filter(
      ([key]) => key === old_parts.join("/") || key.startsWith(`${old_parts.join("/")}/`),
    );
    moved.sort(([, left], [, right]) => left.parts.length - right.parts.length);
    for (const [key, node] of moved) {
      const relative = node.parts.slice(old_parts.length);
      let handle: FileSystemHandle = copied;
      for (const component of relative) {
        if (handle.kind !== "directory") throw new FSError("EIO");
        const child = await this.#child(handle as FileSystemDirectoryHandle, component);
        if (!child) throw new FSError("EIO");
        handle = child;
      }
      node.handle = handle;
      if (key === old_parts.join("/") || key.startsWith(`${old_parts.join("/")}/`)) {
        this.#nodes.delete(key);
        node.parts = [...new_parts, ...node.parts.slice(old_parts.length)];
        this.#nodes.set(node.parts.join("/"), node);
      }
    }
  }
}
