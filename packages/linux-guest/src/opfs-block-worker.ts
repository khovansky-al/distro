// SPDX-License-Identifier: MIT

import { opfsBlockErrorCode } from "./opfs-block-errors.js";

interface RequestMessage {
  id: number;
  type: "init" | "read" | "write" | "flush" | "close";
  file?: FileSystemFileHandle;
  directory?: FileSystemDirectoryHandle;
  name?: string;
  capacity?: number;
  segmentSize?: number;
  offset?: number;
  length?: number;
  data?: ArrayBuffer;
}

interface ErrorMessage {
  name: string;
  message: string;
  code: string;
}

let accesses: FileSystemSyncAccessHandle[] = [];
let capacity = 0;
let segmentSize = 0;
let operations = Promise.resolve();

function error_message(error: unknown): ErrorMessage {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const code = opfsBlockErrorCode(error);
  return { name, message, code };
}

function checked_range(offset: number | undefined, length: number | undefined) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset! < 0 ||
    length! < 0 ||
    offset! + length! > capacity
  ) {
    throw new RangeError("block request is outside the OPFS disk");
  }
  return { offset: offset!, length: length! };
}

async function dispatch(message: RequestMessage) {
  let result: Record<string, unknown> = {};
  const transfer: Transferable[] = [];
  switch (message.type) {
    case "init": {
      if (accesses.length || !message.file || !message.directory || !message.name)
        throw new DOMException("disk is already open", "InvalidStateError");
      if (
        !Number.isSafeInteger(message.capacity) ||
        message.capacity! <= 0 ||
        !Number.isSafeInteger(message.segmentSize) ||
        message.segmentSize! <= 0
      ) {
        throw new RangeError("OPFS disk and segment capacities must be positive safe integers");
      }
      capacity = message.capacity!;
      segmentSize = message.segmentSize!;
      const count = Math.ceil(capacity / segmentSize);
      try {
        for (let index = 0; index < count; index++) {
          const file =
            index === 0
              ? message.file
              : await message.directory.getFileHandle(`${message.name}.part${index}`, {
                  create: true,
                });
          const access = await file.createSyncAccessHandle();
          accesses.push(access);
          const expected = Math.min(segmentSize, capacity - index * segmentSize);
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
      } catch (error) {
        for (const access of accesses) access.close();
        accesses = [];
        capacity = 0;
        segmentSize = 0;
        throw error;
      }
      result = { capacity };
      break;
    }
    case "read": {
      if (!accesses.length) throw new DOMException("disk is closed", "InvalidStateError");
      const range = checked_range(message.offset, message.length);
      const data = new Uint8Array(range.length);
      let position = range.offset;
      let copied = 0;
      while (copied < data.byteLength) {
        const index = Math.floor(position / segmentSize);
        const offset = position - index * segmentSize;
        const length = Math.min(data.byteLength - copied, segmentSize - offset);
        const view = data.subarray(copied, copied + length);
        const amount = accesses[index]!.read(view, { at: offset });
        if (amount !== view.byteLength)
          throw new Error(`short OPFS read: ${amount}/${view.byteLength}`);
        copied += amount;
        position += amount;
      }
      result = { data: data.buffer };
      transfer.push(data.buffer);
      break;
    }
    case "write": {
      if (!accesses.length || !message.data)
        throw new DOMException("disk is closed", "InvalidStateError");
      const data = new Uint8Array(message.data);
      const range = checked_range(message.offset, data.byteLength);
      let position = range.offset;
      let written = 0;
      while (written < data.byteLength) {
        const index = Math.floor(position / segmentSize);
        const offset = position - index * segmentSize;
        const length = Math.min(data.byteLength - written, segmentSize - offset);
        const view = data.subarray(written, written + length);
        const amount = accesses[index]!.write(view, { at: offset });
        if (amount !== view.byteLength)
          throw new Error(`short OPFS write: ${amount}/${view.byteLength}`);
        written += amount;
        position += amount;
      }
      result = { written };
      break;
    }
    case "flush":
      if (!accesses.length) throw new DOMException("disk is closed", "InvalidStateError");
      for (const access of accesses) access.flush();
      break;
    case "close":
      for (const access of accesses) {
        access.flush();
        access.close();
      }
      accesses = [];
      capacity = 0;
      segmentSize = 0;
      break;
  }
  postMessage({ id: message.id, ok: true, ...result }, transfer);
}

addEventListener("message", (event: MessageEvent<RequestMessage>) => {
  const message = event.data;
  operations = operations
    .then(() => dispatch(message))
    .catch((error) => {
      postMessage({ id: message.id, ok: false, error: error_message(error) });
    });
});
