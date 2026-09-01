import EventEmitter from "events";

import { createReadStream } from "fs";

import { writeFile } from "fs/promises";

import { createInterface } from "readline";

import { delay } from "./generics.js";

import { makeMutex } from "./make-mutex.js";

export const captureEventStream = (ev, filename) => {
  const originalEmit = ev.emit.bind(ev);
  const writeMutex = makeMutex();
  const patchedEmit = (event, ...rest) => {
    const line = JSON.stringify({
      timestamp: Date.now(),
      event: event,
      data: rest[0]
    }) + "\n";
    const result = originalEmit(event, ...rest);
    void writeMutex.mutex(async () => {
      await writeFile(filename, line, {
        flag: "a"
      });
    });
    return result;
  };
  ev.emit = patchedEmit;
};

export const readAndEmitEventStream = (filename, delayIntervalMs = 0) => {
  const ev = new EventEmitter;
  const fireEvents = async () => {
    const fileStream = createReadStream(filename);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const {event: event, data: data} = JSON.parse(line);
        ev.emit(event, data);
        if (delayIntervalMs) await delay(delayIntervalMs);
      } catch {}
    }
    fileStream.destroy();
  };
  return {
    ev: ev,
    task: fireEvents()
  };
};