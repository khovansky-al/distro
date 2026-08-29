// SPDX-License-Identifier: MIT

import { Struct, U32LE, U64LE } from "@lowland/bytes";
import { assert } from "../util.ts";
import {
  VirtioController,
  type VirtioDevice,
  type Virtqueue,
  type VirtqueueBuffer,
} from "./core.ts";

const BlockDeviceFeatures = {
  SEG_MAX: 1n << 2n,
  RO: 1n << 5n,
  FLUSH: 1n << 9n,
} as const;

class BlockDeviceConfig extends Struct({
  capacity: U64LE,
  sizeMax: U32LE,
  segMax: U32LE,
}) {}

// One request may contain a header, this many data descriptors, and a status
// byte in an indirect descriptor table. Linux independently caps the total
// request size at 4 MiB, so coalescing cannot allocate an unbounded buffer.
const BLOCK_DEVICE_SEGMENT_MAXIMUM = 128;

class BlockDeviceRequest extends Struct({
  type: U32LE,
  reserved: U32LE,
  sector: U64LE,
}) {}

const BlockDeviceRequestType = {
  IN: 0,
  OUT: 1,
  FLUSH: 4,
  GET_ID: 8,
} as const;

const BlockDeviceStatus = {
  OK: 0,
  IOERR: 1,
  UNSUPP: 2,
} as const;

type MaybePromise<T> = T | Promise<T>;

/** The storage behind a block device. */
export interface BlockDeviceStorage {
  /** Reads into `target` at `offset`, returning the bytes read. */
  read(offset: number, target: Uint8Array): MaybePromise<number>;
  /** Writes `data` at `offset`, returning the bytes written. Without it the device is read-only. */
  write?(offset: number, data: Uint8Array): MaybePromise<number>;
  /** Flushes completed writes. Its presence advertises the flush feature. */
  flush?(): MaybePromise<void>;
  /** Releases storage resources when the device closes. */
  close?(): MaybePromise<void>;
  /** Total size in bytes. */
  capacity: number;
}

/**
 * A virtio block device backed by a storage object.
 *
 * @example Serve a read-only root filesystem image
 * ```ts
 * blockDevice({
 *   capacity: rootfs.byteLength,
 *   read(offset, target) {
 *     const source = rootfs.subarray(offset, offset + target.byteLength);
 *     target.set(source);
 *     return source.byteLength;
 *   },
 * })
 * ```
 */
export function blockDevice(storage: BlockDeviceStorage): VirtioDevice {
  const config = new Uint8Array(BlockDeviceConfig.size);
  const blockConfig = new BlockDeviceConfig(config);
  blockConfig.capacity = BigInt(storage.capacity / 512);
  blockConfig.segMax = BLOCK_DEVICE_SEGMENT_MAXIMUM;
  let features = BlockDeviceFeatures.SEG_MAX;
  if (storage.flush) features |= BlockDeviceFeatures.FLUSH;
  if (!storage.write) features |= BlockDeviceFeatures.RO;

  const settle = async <T>(value: MaybePromise<T>) =>
    typeof (value as PromiseLike<T>)?.then === "function"
      ? await (value as PromiseLike<T>)
      : (value as T);

  const request_buffer = (data: VirtqueueBuffer[]) => {
    if (data.length === 1) return data[0]!.array;
    const length = data.reduce((total, descriptor) => total + descriptor.array.byteLength, 0);
    if (!Number.isSafeInteger(length)) throw new RangeError("block request is too large");
    return new Uint8Array(length);
  };

  const gather = (data: VirtqueueBuffer[], target: Uint8Array) => {
    let offset = 0;
    for (const descriptor of data) {
      target.set(descriptor.array, offset);
      offset += descriptor.array.byteLength;
    }
  };

  const scatter = (source: Uint8Array, data: VirtqueueBuffer[], length: number) => {
    let offset = 0;
    for (const descriptor of data) {
      const copied = Math.min(descriptor.array.byteLength, length - offset);
      if (copied <= 0) break;
      descriptor.array.set(source.subarray(offset, offset + copied));
      offset += copied;
    }
  };

  async function notify(queue: Virtqueue) {
    for (const chain of queue) {
      const descs = [...chain];
      const header = descs[0];
      const status = descs[descs.length - 1];
      const data = descs.slice(1, -1);

      assert(header && !header.writable, "header must be readonly");
      assert(
        header.array.byteLength === BlockDeviceRequest.size,
        `header size is ${header.array.byteLength}`,
      );
      assert(status && status.writable, "status must be writable");
      assert(status.array.byteLength === 1, `status size is ${status.array.byteLength}`);
      const status_desc = status;

      const request = new BlockDeviceRequest(header.array);

      function set_status(value: number) {
        status_desc.array[0] = value;
      }

      let n = 0;
      let offset = Number(request.sector) * 512;
      try {
        switch (request.type) {
          case BlockDeviceRequestType.IN: {
            for (const desc of data) {
              assert(desc.writable, "data must be writable when IN");
            }
            const target = request_buffer(data);
            const read = target.byteLength ? await settle(storage.read(offset, target)) : 0;
            if (!Number.isSafeInteger(read) || read < 0 || read > target.byteLength) {
              throw new Error(`invalid block read count: ${read}/${target.byteLength}`);
            }
            if (data.length > 1) scatter(target, data, read);
            n = read;
            set_status(read === target.byteLength ? BlockDeviceStatus.OK : BlockDeviceStatus.IOERR);
            break;
          }
          case BlockDeviceRequestType.OUT: {
            if (!storage.write) {
              set_status(BlockDeviceStatus.UNSUPP);
              break;
            }
            for (const desc of data) {
              assert(!desc.writable, "data must be readonly when OUT");
            }
            const source = request_buffer(data);
            if (data.length > 1) gather(data, source);
            const written = source.byteLength ? await settle(storage.write(offset, source)) : 0;
            if (!Number.isSafeInteger(written) || written < 0 || written > source.byteLength) {
              throw new Error(`invalid block write count: ${written}/${source.byteLength}`);
            }
            n = written;
            set_status(
              written === source.byteLength ? BlockDeviceStatus.OK : BlockDeviceStatus.IOERR,
            );
            break;
          }
          case BlockDeviceRequestType.FLUSH: {
            if (!storage.flush) {
              set_status(BlockDeviceStatus.UNSUPP);
              break;
            }
            await settle(storage.flush());
            set_status(BlockDeviceStatus.OK);
            break;
          }
          case BlockDeviceRequestType.GET_ID: {
            console.log("GET_ID");
            set_status(BlockDeviceStatus.OK);
            break;
          }
          default:
            console.error("unknown request type", request.type);
            set_status(BlockDeviceStatus.UNSUPP);
        }
      } catch (error) {
        console.error("block device I/O failed", error);
        set_status(BlockDeviceStatus.IOERR);
      }

      chain.release(n);
    }
  }

  return new VirtioController(
    { deviceId: 2, features, config },
    {
      queues: [notify],
      async close() {
        let failure: unknown;
        try {
          await storage.flush?.();
        } catch (error) {
          failure = error;
        }
        try {
          await storage.close?.();
        } catch (error) {
          failure ??= error;
        }
        if (failure) throw failure;
      },
    },
  ).device;
}
