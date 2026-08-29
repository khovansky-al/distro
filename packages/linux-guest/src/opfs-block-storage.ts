// SPDX-License-Identifier: MIT

import { opfsBlockErrorCode } from "./opfs-block-errors.ts";

export interface SegmentedOPFSStorageOptions {
  directory?: FileSystemDirectoryHandle;
  originPrivate?: boolean;
  name: string;
  create: boolean;
  capacity: number;
  segmentSize: number;
}

export interface SegmentedOPFSStorageStatistics {
  reads: number;
  writes: number;
  flushes: number;
  segmentFlushes: number;
}

function storage_directory(options: SegmentedOPFSStorageOptions) {
  if (options.originPrivate && !navigator.storage?.getDirectory) {
    throw new DOMException("this worker does not support OPFS", "NotSupportedError");
  }
  return options.originPrivate ? navigator.storage.getDirectory() : options.directory;
}

/** @internal */
export class SegmentedOPFSStorage {
  readonly capacity: number;
  readonly segmentSize: number;
  readonly #accesses: FileSystemSyncAccessHandle[];
  readonly #dirty = new Set<number>();
  readonly #statistics: SegmentedOPFSStorageStatistics = {
    reads: 0,
    writes: 0,
    flushes: 0,
    segmentFlushes: 0,
  };
  #closed = false;

  constructor(accesses: FileSystemSyncAccessHandle[], capacity: number, segmentSize: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("OPFS disk capacity must be a positive safe integer");
    }
    if (!Number.isSafeInteger(segmentSize) || segmentSize <= 0) {
      throw new RangeError("OPFS disk segment capacity must be a positive safe integer");
    }
    if (accesses.length !== Math.ceil(capacity / segmentSize)) {
      throw new RangeError("OPFS disk has the wrong number of segment handles");
    }
    this.#accesses = accesses;
    this.capacity = capacity;
    this.segmentSize = segmentSize;
  }

  static async open(options: SegmentedOPFSStorageOptions) {
    if (
      !Number.isSafeInteger(options.capacity) ||
      options.capacity <= 0 ||
      !Number.isSafeInteger(options.segmentSize) ||
      options.segmentSize <= 0
    ) {
      throw new RangeError("OPFS disk and segment capacities must be positive safe integers");
    }
    const directory = await storage_directory(options);
    if (!directory) {
      throw new DOMException("OPFS directory is unavailable", "NotSupportedError");
    }

    const accesses: FileSystemSyncAccessHandle[] = [];
    const count = Math.ceil(options.capacity / options.segmentSize);
    try {
      for (let index = 0; index < count; index++) {
        const file = await directory.getFileHandle(
          index === 0 ? options.name : `${options.name}.part${index}`,
          { create: index === 0 ? options.create : true },
        );
        const access = await file.createSyncAccessHandle();
        accesses.push(access);
        const expected = Math.min(
          options.segmentSize,
          options.capacity - index * options.segmentSize,
        );
        const current = access.getSize();
        if (current > expected) {
          throw new RangeError(
            `OPFS disk segment ${index} is ${current} bytes, larger than ${expected}`,
          );
        }
        if (current < expected) {
          access.truncate(expected);
          access.flush();
        }
        if (access.getSize() !== expected) {
          throw new DOMException(
            `OPFS disk segment ${index} did not grow to ${expected} bytes`,
            "QuotaExceededError",
          );
        }
      }
      return new SegmentedOPFSStorage(accesses, options.capacity, options.segmentSize);
    } catch (error) {
      for (const access of accesses) {
        try {
          access.close();
        } catch {
          // Preserve the initialization failure.
        }
      }
      throw error;
    }
  }

  #check_range(offset: number, length: number) {
    if (
      this.#closed ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.capacity
    ) {
      if (this.#closed) throw new DOMException("disk is closed", "InvalidStateError");
      throw new RangeError("block request is outside the OPFS disk");
    }
  }

  read(offset: number, target: Uint8Array) {
    this.#check_range(offset, target.byteLength);
    this.#statistics.reads += 1;
    let position = offset;
    let copied = 0;
    while (copied < target.byteLength) {
      const index = Math.floor(position / this.segmentSize);
      const segmentOffset = position - index * this.segmentSize;
      const length = Math.min(target.byteLength - copied, this.segmentSize - segmentOffset);
      const view = target.subarray(copied, copied + length);
      const amount = this.#accesses[index]!.read(view, { at: segmentOffset });
      if (amount !== view.byteLength) {
        throw new Error(`short OPFS read: ${amount}/${view.byteLength}`);
      }
      copied += amount;
      position += amount;
    }
    return copied;
  }

  write(offset: number, data: Uint8Array) {
    this.#check_range(offset, data.byteLength);
    this.#statistics.writes += 1;
    let position = offset;
    let written = 0;
    while (written < data.byteLength) {
      const index = Math.floor(position / this.segmentSize);
      const segmentOffset = position - index * this.segmentSize;
      const length = Math.min(data.byteLength - written, this.segmentSize - segmentOffset);
      const view = data.subarray(written, written + length);
      // Conservatively retain the dirty bit even if write() reports or throws
      // an error after modifying only part of the segment.
      this.#dirty.add(index);
      const amount = this.#accesses[index]!.write(view, { at: segmentOffset });
      if (amount !== view.byteLength) {
        throw new Error(`short OPFS write: ${amount}/${view.byteLength}`);
      }
      written += amount;
      position += amount;
    }
    return written;
  }

  flush() {
    if (this.#closed) throw new DOMException("disk is closed", "InvalidStateError");
    this.#statistics.flushes += 1;
    for (const index of Array.from(this.#dirty)) {
      this.#accesses[index]!.flush();
      this.#statistics.segmentFlushes += 1;
      this.#dirty.delete(index);
    }
  }

  close() {
    if (this.#closed) return;
    let failure: unknown;
    try {
      this.flush();
    } catch (error) {
      failure = error;
    }
    this.#closed = true;
    for (const access of this.#accesses) {
      try {
        access.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  statistics(): SegmentedOPFSStorageStatistics {
    return { ...this.#statistics };
  }
}

export interface SerializedOPFSBlockError {
  name: string;
  message: string;
  code: string;
}

export function serializeOPFSBlockError(error: unknown): SerializedOPFSBlockError {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const code = opfsBlockErrorCode(error);
  return { name, message, code };
}
