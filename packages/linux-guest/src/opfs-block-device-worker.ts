// SPDX-License-Identifier: MIT

import { blockDevice, serveDevice } from "@lowland/kernel";
import {
  SegmentedOPFSStorage,
  type SegmentedOPFSStorageOptions,
  serializeOPFSBlockError,
} from "./opfs-block-storage.ts";

type InitializeMessage = {
  type: "initialize";
} & SegmentedOPFSStorageOptions;

try {
  const configuration = await new Promise<InitializeMessage>((resolve, reject) => {
    addEventListener(
      "message",
      (event: MessageEvent<InitializeMessage>) => {
        if (event.data?.type !== "initialize") {
          reject(new TypeError("OPFS block device received no initialization message"));
          return;
        }
        resolve(event.data);
      },
      { once: true },
    );
  });
  const storage = await SegmentedOPFSStorage.open(configuration);
  postMessage({ type: "initialized", ok: true, capacity: storage.capacity });
  const serve = await new Promise<{ type: "serve" }>((resolve) => {
    addEventListener("message", (event: MessageEvent<{ type: "serve" }>) => resolve(event.data), {
      once: true,
    });
  });
  if (serve?.type !== "serve") throw new TypeError("OPFS block device was not served");
  serveDevice(self, blockDevice(storage));
} catch (error) {
  postMessage({ type: "initialized", ok: false, error: serializeOPFSBlockError(error) });
}
