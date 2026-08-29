// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { SegmentedOPFSStorage } from "../src/opfs-block-storage.ts";

function accessHandle(size: number) {
  const bytes = new Uint8Array(size);
  let flushes = 0;
  let closes = 0;
  let failNextFlush = false;
  const handle = {
    read(target: ArrayBufferView, options?: { at?: number }) {
      const output = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
      output.set(bytes.subarray(options?.at ?? 0, (options?.at ?? 0) + output.byteLength));
      return output.byteLength;
    },
    write(source: ArrayBufferView, options?: { at?: number }) {
      const input = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      bytes.set(input, options?.at ?? 0);
      return input.byteLength;
    },
    truncate() {},
    getSize() {
      return bytes.byteLength;
    },
    flush() {
      flushes += 1;
      if (failNextFlush) {
        failNextFlush = false;
        throw new DOMException("flush failed", "InvalidStateError");
      }
    },
    close() {
      closes += 1;
    },
  } as unknown as FileSystemSyncAccessHandle;
  return {
    handle,
    bytes,
    get flushes() {
      return flushes;
    },
    get closes() {
      return closes;
    },
    failFlush() {
      failNextFlush = true;
    },
  };
}

test("segmented OPFS storage flushes only dirty segments", () => {
  const segments = [accessHandle(4), accessHandle(4), accessHandle(4)];
  const storage = new SegmentedOPFSStorage(
    segments.map(({ handle }) => handle),
    12,
    4,
  );

  assert.equal(storage.write(1, Uint8Array.of(1, 2)), 2);
  storage.flush();
  assert.deepEqual(
    segments.map(({ flushes }) => flushes),
    [1, 0, 0],
  );

  storage.flush();
  assert.deepEqual(
    segments.map(({ flushes }) => flushes),
    [1, 0, 0],
  );

  assert.equal(storage.write(3, Uint8Array.of(3, 4, 5)), 3);
  storage.flush();
  assert.deepEqual(
    segments.map(({ flushes }) => flushes),
    [2, 1, 0],
  );
  assert.deepEqual([...segments[0]!.bytes], [0, 1, 2, 3]);
  assert.deepEqual([...segments[1]!.bytes], [4, 5, 0, 0]);

  storage.write(5, Uint8Array.of(6));
  segments[1]!.failFlush();
  assert.throws(() => storage.flush(), { name: "InvalidStateError" });
  assert.equal(segments[1]!.flushes, 2);
  storage.flush();
  assert.equal(segments[1]!.flushes, 3, "a failed flush keeps the segment dirty");

  assert.deepEqual(storage.statistics(), {
    reads: 0,
    writes: 3,
    flushes: 5,
    segmentFlushes: 4,
  });
  storage.close();
  assert.deepEqual(
    segments.map(({ closes }) => closes),
    [1, 1, 1],
  );
});
