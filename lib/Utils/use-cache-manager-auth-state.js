import { proto } from "../../WAProto/index.js";

import { initAuthCreds } from "./auth-utils.js";

import { BufferJSON } from "./generics.js";

export const useCacheManagerAuthState = async (store, sessionKey) => {
  const defaultKey = file => `${sessionKey}:${file}`;
  const writeData = async (file, data) => {
    const ttl = file === "creds" ? 63115200 : undefined;
    await store.set(defaultKey(file), JSON.stringify(data, BufferJSON.replacer), ttl);
  };
  const readData = async file => {
    try {
      const data = await store.get(defaultKey(file));
      return data !== null && data !== undefined ? JSON.parse(data, BufferJSON.reviver) : null;
    } catch {
      return null;
    }
  };
  const removeData = async file => {
    try {
      await store.del(defaultKey(file));
    } catch {
      console.error(`[useCacheManagerAuthState] Error removing ${file} from session ${sessionKey}`);
    }
  };
  const clearState = async () => {
    try {
      const keys = await store.keys(`${sessionKey}*`);
      await Promise.all(keys.map(key => store.del(key)));
    } catch {}
  };
  const creds = await readData("creds") || initAuthCreds();
  return {
    clearState: clearState,
    state: {
      creds: creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            let value = await readData(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async data => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData("creds", creds)
  };
};