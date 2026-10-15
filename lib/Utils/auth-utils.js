import NodeCache from "@cacheable/node-cache";
import { Boom } from "@hapi/boom";
import { AsyncLocalStorage } from "async_hooks";
import { randomBytes } from "crypto";
import { DEFAULT_CACHE_TTLS } from "../Defaults/index.js";
import { Curve, signedKeyPair } from "./crypto.js";
import { delay, generateRegistrationId } from "./generics.js";
import { makeLockManager } from "./lock-manager.js";
import { PreKeyManager } from "./pre-key-manager.js";
const txStorage = new AsyncLocalStorage();
const LEGACY_NAMESPACE = "__legacy__";
const lockKeyForRef = (namespace, id) => `${namespace}\0${id}`;
const lockKeyForRecord = (r) => lockKeyForRef(r.type, r.id);
function makeCacheableSignalKeyStore(store, logger, _cache) {
  const cache = _cache || new NodeCache({ stdTTL: DEFAULT_CACHE_TTLS.SIGNAL_STORE, useClones: false, deleteOnExpire: true });
  const cacheLocks = makeLockManager();
  function getUniqueId(type, id) {
    return `${type}.${id}`;
  }
  return { async get(type, ids) {
    const data = {};
    const idsToFetch = [];
    await Promise.all(ids.map((id) => cacheLocks.withLock({ namespace: type, id }, async () => {
      const item = await cache.get(getUniqueId(type, id));
      if (typeof item !== "undefined" && item !== null) {
        data[id] = item;
      } else {
        idsToFetch.push(id);
      }
    })));
    if (idsToFetch.length) {
      logger?.trace({ items: idsToFetch.length }, "loading from store");
      const fetched = await store.get(type, idsToFetch);
      await Promise.all(idsToFetch.map((id) => cacheLocks.withLock({ namespace: type, id }, async () => {
        const current = await cache.get(getUniqueId(type, id));
        if (typeof current !== "undefined") {
          if (current !== null) data[id] = current;
          return;
        }
        const item = fetched[id];
        if (item !== null && item !== void 0) {
          data[id] = item;
          await cache.set(getUniqueId(type, id), item);
        }
      })));
    }
    return data;
  }, async set(data) {
    const refs = [];
    for (const type in data) {
      for (const id in data[type]) {
        refs.push({ namespace: type, id });
      }
    }
    await cacheLocks.withLocks(refs, async () => {
      await store.set(data);
      let updated = 0;
      for (const type in data) {
        for (const id in data[type]) {
          const value = data[type][id];
          if (value === null || value === void 0) {
            await cache.del(getUniqueId(type, id));
          } else {
            await cache.set(getUniqueId(type, id), value);
          }
          updated += 1;
        }
      }
      logger?.trace({ keys: updated }, "updated cache after durable write");
    });
  }, async *list(type) {
    if (typeof store.list !== "function") {
      throw new Error("SignalKeyStore.list is not implemented by the wrapped store");
    }
    yield* store.list(type);
  }, async *listIds(type) {
    if (typeof store.listIds === "function") {
      yield* store.listIds(type);
      return;
    }
    if (typeof store.list === "function") {
      for await (const [id] of store.list(type)) {
        yield id;
      }
      return;
    }
    throw new Error("SignalKeyStore.listIds is not implemented by the wrapped store");
  }, async clear() {
    await cache.flushAll();
    await store.clear?.();
  } };
}
const addTransactionCapability = (state, logger, { maxCommitRetries, delayBetweenTriesMs }) => {
  const locks = makeLockManager();
  const preKeyManager = new PreKeyManager(state, logger);
  const storeToken = Symbol("signalTxStore");
  function getContext() {
    return txStorage.getStore()?.get(storeToken);
  }
  function isInTransaction() {
    return !!getContext();
  }
  async function commitWithRetry(mutations) {
    if (Object.keys(mutations).length === 0) {
      logger?.trace("no mutations in transaction");
      return;
    }
    logger?.trace("committing transaction");
    for (let attempt = 0; attempt < maxCommitRetries; attempt++) {
      try {
        await state.set(mutations);
        logger?.trace({ mutationCount: Object.keys(mutations).length }, "committed transaction");
        return;
      } catch (error) {
        const retriesLeft = maxCommitRetries - attempt - 1;
        logger?.warn(`failed to commit mutations, retries left=${retriesLeft}`);
        if (retriesLeft === 0) {
          throw error;
        }
        await delay(delayBetweenTriesMs);
      }
    }
  }
  return { get: async (type, ids) => {
    const ctx = getContext();
    if (!ctx) {
      return state.get(type, ids);
    }
    const cached = ctx.cache[type] || {};
    const missing = ids.filter((id) => !(id in cached));
    if (missing.length > 0) {
      ctx.dbQueries++;
      logger?.trace({ type, count: missing.length }, "fetching missing keys in transaction");
      const fetched = await locks.withLock({ namespace: "__type__", id: type }, () => state.get(type, missing));
      ctx.cache[type] = ctx.cache[type] || {};
      Object.assign(ctx.cache[type], fetched);
    }
    const result = {};
    for (const id of ids) {
      const value = ctx.cache[type]?.[id];
      if (value !== void 0 && value !== null) {
        result[id] = value;
      }
    }
    return result;
  }, set: async (data) => {
    const ctx = getContext();
    if (!ctx) {
      const types = Object.keys(data);
      const lockRefs = [];
      for (const type of types) {
        const bucket = data[type];
        if (!bucket) continue;
        for (const id of Object.keys(bucket)) {
          lockRefs.push({ namespace: type, id });
        }
      }
      await locks.withLocks(lockRefs, async () => {
        if ("pre-key" in data) {
          await preKeyManager.validateDeletions(data, "pre-key");
        }
        let hasAny = false;
        for (const t of types) {
          const bucket = data[t];
          if (bucket && Object.keys(bucket).length > 0) {
            hasAny = true;
            break;
          }
        }
        if (hasAny) {
          await state.set(data);
        }
      });
      return;
    }
    if (ctx.sealed) {
      logger?.warn({ types: Object.keys(data) }, "transaction context is sealed; ignoring detached write");
      return;
    }
    logger?.trace({ types: Object.keys(data) }, "caching in transaction");
    for (const key_ in data) {
      const key = key_;
      ctx.cache[key] = ctx.cache[key] || {};
      ctx.mutations[key] = ctx.mutations[key] || {};
      if (key === "pre-key") {
        await preKeyManager.processOperations(data, key, ctx.cache, ctx.mutations, true);
      } else {
        Object.assign(ctx.cache[key], data[key]);
        Object.assign(ctx.mutations[key], data[key]);
      }
    }
  }, isInTransaction, transaction: async (work, key) => {
    const lockKey = lockKeyForRef(LEGACY_NAMESPACE, key);
    const stores = txStorage.getStore();
    const existing = stores?.get(storeToken);
    if (existing?.heldLocks.has(lockKey)) {
      logger?.trace({ key }, "reusing held legacy lock");
      return work();
    }
    return locks.withLock({ namespace: LEGACY_NAMESPACE, id: key }, async () => {
      if (existing) {
        existing.heldLocks.add(lockKey);
        try {
          return await work();
        } finally {
          existing.heldLocks.delete(lockKey);
        }
      }
      const ctx = { cache: {}, mutations: {}, dbQueries: 0, heldLocks: new Set([lockKey]), sealed: false };
      const next = new Map(stores);
      next.set(storeToken, ctx);
      logger?.trace("entering transaction");
      try {
        const result = await txStorage.run(next, work);
        ctx.sealed = true;
        await commitWithRetry(ctx.mutations);
        logger?.trace({ dbQueries: ctx.dbQueries }, "transaction completed");
        return result;
      } catch (err) {
        ctx.sealed = true;
        logger?.error({ err }, "transaction failed, rolling back");
        throw err;
      }
    });
  }, transactWith: async (scope, work) => {
    const stores = txStorage.getStore();
    const existing = stores?.get(storeToken);
    const needsAcquire = scope.records.filter((r) => !existing?.heldLocks.has(lockKeyForRecord(r)));
    const newLockKeys = needsAcquire.map(lockKeyForRecord);
    const lockRefs = needsAcquire.map((r) => ({ namespace: r.type, id: r.id }));
    return locks.withLocks(lockRefs, async () => {
      if (existing) {
        for (const k of newLockKeys) existing.heldLocks.add(k);
        try {
          return await work();
        } finally {
          for (const k of newLockKeys) existing.heldLocks.delete(k);
        }
      }
      const ctx = { cache: {}, mutations: {}, dbQueries: 0, heldLocks: new Set(newLockKeys), sealed: false };
      const next = new Map(stores);
      next.set(storeToken, ctx);
      logger?.trace({ records: scope.records.length }, "entering transactWith");
      try {
        const result = await txStorage.run(next, work);
        ctx.sealed = true;
        await commitWithRetry(ctx.mutations);
        logger?.trace({ dbQueries: ctx.dbQueries }, "transactWith completed");
        return result;
      } catch (err) {
        ctx.sealed = true;
        logger?.error({ err }, "transactWith failed, rolling back");
        throw err;
      }
    });
  }, ...state.list ? { list: (type) => state.list(type) } : {}, ...state.listIds ? { listIds: (type) => state.listIds(type) } : {}, disposeTransactionStorage: () => {
  } };
};
const assertMeId = (creds) => {
  const id = creds.me?.id;
  if (!id) {
    throw new Boom("Cannot proceed: socket is not authenticated yet (creds.me.id is missing)", { statusCode: 401 });
  }
  return id;
};
const initAuthCreds = () => {
  const identityKey = Curve.generateKeyPair();
  return { noiseKey: Curve.generateKeyPair(), pairingEphemeralKeyPair: Curve.generateKeyPair(), signedIdentityKey: identityKey, signedPreKey: signedKeyPair(identityKey, 1), registrationId: generateRegistrationId(), advSecretKey: randomBytes(32).toString("base64"), processedHistoryMessages: [], nextPreKeyId: 1, firstUnuploadedPreKeyId: 1, accountSyncCounter: 0, accountSettings: { unarchiveChats: false }, registered: false, pairingCode: void 0, lastPropHash: void 0, routingInfo: void 0, additionalData: void 0 };
};
export {
  addTransactionCapability,
  assertMeId,
  initAuthCreds,
  makeCacheableSignalKeyStore
};
