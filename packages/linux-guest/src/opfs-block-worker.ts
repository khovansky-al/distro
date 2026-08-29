// SPDX-License-Identifier: MIT

import { SegmentedOPFSStorage, serializeOPFSBlockError } from "./opfs-block-storage.ts";

interface RequestMessage {
  id: number;
  type: "init" | "read" | "write" | "flush" | "statistics" | "close";
  directory?: FileSystemDirectoryHandle;
  originPrivate?: boolean;
  name?: string;
  create?: boolean;
  capacity?: number;
  segmentSize?: number;
  offset?: number;
  length?: number;
  data?: ArrayBuffer;
}

let storage: SegmentedOPFSStorage | undefined;
let operations = Promise.resolve();

async function dispatch(message: RequestMessage) {
  let result: Record<string, unknown> = {};
  const transfer: Transferable[] = [];
  switch (message.type) {
    case "init": {
      if (storage || !message.name)
        throw new DOMException("disk is already open", "InvalidStateError");
      storage = await SegmentedOPFSStorage.open({
        directory: message.directory,
        originPrivate: message.originPrivate,
        name: message.name,
        create: message.create ?? true,
        capacity: message.capacity!,
        segmentSize: message.segmentSize!,
      });
      result = { capacity: storage.capacity };
      break;
    }
    case "read": {
      if (!storage) throw new DOMException("disk is closed", "InvalidStateError");
      if (!Number.isSafeInteger(message.length) || message.length! < 0) {
        throw new RangeError("block request has an invalid length");
      }
      const data = new Uint8Array(message.length!);
      storage.read(message.offset!, data);
      result = { data: data.buffer };
      transfer.push(data.buffer);
      break;
    }
    case "write": {
      if (!storage || !message.data) throw new DOMException("disk is closed", "InvalidStateError");
      const data = new Uint8Array(message.data);
      const written = storage.write(message.offset!, data);
      result = { written };
      break;
    }
    case "flush":
      if (!storage) throw new DOMException("disk is closed", "InvalidStateError");
      storage.flush();
      break;
    case "statistics":
      if (!storage) throw new DOMException("disk is closed", "InvalidStateError");
      result = { statistics: storage.statistics() };
      break;
    case "close": {
      const opened = storage;
      storage = undefined;
      opened?.close();
      break;
    }
  }
  postMessage({ id: message.id, ok: true, ...result }, transfer);
}

addEventListener("message", (event: MessageEvent<RequestMessage>) => {
  const message = event.data;
  operations = operations
    .then(() => dispatch(message))
    .catch((error) => {
      postMessage({ id: message.id, ok: false, error: serializeOPFSBlockError(error) });
    });
});
