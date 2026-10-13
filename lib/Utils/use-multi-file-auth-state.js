import { Mutex } from "async-mutex";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { proto } from "../../WAProto/index.js";
import { initAuthCreds } from "./auth-utils.js";
import { BufferJSON } from "./generics.js";
import logger from "./logger.js";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { makeKeyedMutex } from "./make-mutex.js";
const fileLocks = new Map();

const getFileLock = (path) => {
  let mutex = fileLocks.get(path);
  if (!mutex) {
    mutex = new Mutex();
    fileLocks.set(path, mutex);
  }
  return mutex;
};

const pruneStaleAuthFiles = async (folder, { maxAgeDays = 14, categories = ["sender-key-memory"], dryRun = false } = {}) => {
  let entries;
  try {
    entries = await readdir(folder);
  } catch {
    return { scanned: 0, removed: 0 };
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1e3;
  let scanned = 0;
  let removed = 0;
  await Promise.all(entries.map(async (name) => {
    if (!categories.some((cat) => name.startsWith(`${cat}-`) && name.endsWith(".json"))) return;
    scanned++;
    const filePath = join(folder, name);
    try {
      const info = await stat(filePath);
      if (info.mtimeMs < cutoff) {
        if (!dryRun) await unlink(filePath).catch(() => {
        });
        removed++;
      }
    } catch {
    }
  }));
  return { scanned, removed };
};

const useMultiFileAuthState = async (folder) => {
  const writeData = async (data, file) => {
    const filePath = join(folder, fixFileName(file));
    const mutex = getFileLock(filePath);
    return mutex.acquire().then(async (release) => {
      try {
        await writeFile(filePath, JSON.stringify(data, BufferJSON.replacer), { mode: 384 });
      } finally {
        release();
      }
    });
  };
  const readData = async (file) => {
    try {
      const filePath = join(folder, fixFileName(file));
      const mutex = getFileLock(filePath);
      return await mutex.acquire().then(async (release) => {
        try {
          const data = await readFile(filePath, { encoding: "utf-8" });
          return JSON.parse(data, BufferJSON.reviver);
        } finally {
          release();
        }
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logger.error({ err: error, file }, "useMultiFileAuthState: error reading auth file");
      }
      return null;
    }
  };
  const removeData = async (file) => {
    try {
      const filePath = join(folder, fixFileName(file));
      const mutex = getFileLock(filePath);
      return mutex.acquire().then(async (release) => {
        try {
          await unlink(filePath);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            logger.error({ err: error, file }, "useMultiFileAuthState: error removing auth file");
          }
        } finally {
          release();
        }
      });
    } catch {
    }
  };
  const folderInfo = await stat(folder).catch(() => {
  });
  if (folderInfo) {
    if (!folderInfo.isDirectory()) {
      throw new Error(`found something that is not a directory at ${folder}, either delete it or specify a different location`);
    }
  } else {
    await mkdir(folder, { recursive: true, mode: 448 });
  }
  pruneStaleAuthFiles(folder).catch(() => {
  });
  const fixFileName = (file) => file?.replace(/\//g, "__")?.replace(/:/g, "-");
  const creds = await readData("creds.json") || initAuthCreds();
  return { state: { creds, keys: { get: async (type, ids) => {
    const data = {};
    await Promise.all(ids.map(async (id) => {
      let value = await readData(`${type}-${id}.json`);
      if (type === "app-state-sync-key" && value) {
        value = proto.Message.AppStateSyncKeyData.fromObject(value);
      }
      data[id] = value;
    }));
    return data;
  }, set: async (data) => {
    const tasks = [];
    for (const category in data) {
      for (const id in data[category]) {
        const value = data[category][id];
        const file = `${category}-${id}.json`;
        tasks.push(value ? writeData(value, file) : removeData(file));
      }
    }
    await Promise.all(tasks);
  }, async *list(type) {
    const prefix = `${type}-`;
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(prefix.length, -5);
      let value = await readData(entry.name);
      if (type === "app-state-sync-key" && value) {
        value = proto.Message.AppStateSyncKeyData.fromObject(value);
      }
      yield [id, value];
    }
  }, async *listIds(type) {
    const prefix = `${type}-`;
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".json")) continue;
      yield entry.name.slice(prefix.length, -5);
    }
  } } }, saveCreds: async () => {
    return writeData(creds, "creds.json");
  } };
};

export {
  pruneStaleAuthFiles,
  useMultiFileAuthState
};

export const ENC_MAGIC = 'JAPENC1';

const ENC_ALGO = 'aes-256-gcm';

const SCRYPT_KEYLEN = 32;

const SALT_LEN = 16;

const IV_LEN = 12;

export function deriveKey(password, salt) {
    if (!password || typeof password !== 'string') {
        throw new Error('auth-secure: password must be a non-empty string');
    }
    return scryptSync(password, salt, SCRYPT_KEYLEN, { N: 16384, r: 8, p: 1 });
}

export function encryptJSON(value, password) {
    const salt = randomBytes(SALT_LEN);
    const iv = randomBytes(IV_LEN);
    const key = deriveKey(password, salt);
    const cipher = createCipheriv(ENC_ALGO, key, iv);
    const plain = Buffer.from(JSON.stringify(value, BufferJSON.replacer));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const b64u = (b) => b.toString('base64url');
    const out = [ENC_MAGIC, b64u(salt), b64u(iv), b64u(tag), b64u(ct)].join('.');
    key.fill(0);
    return out;
}

export function decryptJSON(payload, password) {
    if (typeof payload !== 'string' || !payload.startsWith(ENC_MAGIC + '.')) {
        throw new Error('auth-secure: not a JAP encrypted payload');
    }
    const parts = payload.split('.');
    if (parts.length !== 5) {
        throw new Error('auth-secure: malformed encrypted payload');
    }
    const [, saltB64, ivB64, tagB64, ctB64] = parts;
    let salt;
    let iv;
    let tag;
    let ct;
    try {
        salt = Buffer.from(saltB64, 'base64url');
        iv = Buffer.from(ivB64, 'base64url');
        tag = Buffer.from(tagB64, 'base64url');
        ct = Buffer.from(ctB64, 'base64url');
    } catch {
        throw new Error('auth-secure: malformed encrypted payload encoding');
    }
    if (salt.length !== SALT_LEN || iv.length !== IV_LEN || tag.length !== 16 || !ct.length) {
        throw new Error('auth-secure: malformed encrypted payload fields');
    }
    const key = deriveKey(password, salt);
    try {
        const decipher = createDecipheriv(ENC_ALGO, key, iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
        return JSON.parse(plain.toString('utf8'), BufferJSON.reviver);
    } catch (err) {
        throw new Error('auth-secure: decryption failed (wrong password or tampered data)', { cause: err });
    } finally {
        key.fill(0);
    }
}

export function isEncryptedPayload(value) {
    return typeof value === 'string' && value.startsWith(ENC_MAGIC + '.');
}

const secureFileLocks = new Map();

function lockFor(path) {
    let m = secureFileLocks.get(path);
    if (!m) {
        m = new Mutex();
        secureFileLocks.set(path, m);
    }
    return m;
}

export async function useEncryptedFileAuthState(folder, opts) {
    const { password, logger } = opts || {};
    if (!password)
        throw new Error('useEncryptedFileAuthState: opts.password is required');
    await fs.mkdir(folder, { recursive: true });

    const writeData = (data, file) => {
        const filePath = join(folder, fixFileName(file));
        return lockFor(filePath).runExclusive(async () => {
            const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
            await fs.writeFile(tmpPath, encryptJSON(data, password), { encoding: 'utf-8', mode: 0o600 });
            await fs.rename(tmpPath, filePath);
        });
    };
    const readData = async (file, { critical = false } = {}) => {
        const filePath = join(folder, fixFileName(file));
        return lockFor(filePath).runExclusive(async () => {
            let raw;
            try {
                raw = await fs.readFile(filePath, { encoding: 'utf-8' });
            } catch {
                return null;
            }
            const trimmed = raw.trim();
            if (!isEncryptedPayload(trimmed)) {
                try {
                    return JSON.parse(trimmed, BufferJSON.reviver);
                } catch {
                    return null;
                }
            }
            try {
                return decryptJSON(trimmed, password);
            } catch (err) {
                if (critical) {
                    throw new Error(`useEncryptedFileAuthState: cannot decrypt ${file} — wrong password or tampered data. ` +
                        'Refusing to start a fresh session over the existing one. ' +
                        'Fix the password, or delete the auth folder to intentionally reset.', { cause: err });
                }
                logger?.warn?.({ file, err: String(err) }, 'auth-secure: failed to decrypt auth file (wrong password?)');
                return null;
            }
        });
    };
    const removeData = (file) => {
        const filePath = join(folder, fixFileName(file));
        return lockFor(filePath)
            .runExclusive(() => fs.unlink(filePath))
            .catch(() => {});
    };

    const folderInfo = await fs.stat(folder).catch(() => {});
    if (folderInfo) {
        if (!folderInfo.isDirectory()) {
            throw new Error(`found "${folder}" which is not a directory`);
        }
    } else {
        await fs.mkdir(folder, { recursive: true });
    }

    const creds = (await readData('creds.json', { critical: true })) || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}.json`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            tasks.push(value ? writeData(value, file) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds.json'),
        clearState: async () => {
            try {
                const files = await fs.readdir(folder);
                await Promise.all(files
                    .filter((f) => f.endsWith('.json'))
                    .map((f) => fs.unlink(join(folder, f)).catch(() => {})));
            } catch { }
        }
    };
}

function fixFileName(file) {
    return file?.replace(/\//g, '__')?.replace(/:/g, '-');
}

export async function useEncryptedSingleFileAuthState(file, opts) {
    const { password, logger } = opts || {};
    if (!password)
        throw new Error('useEncryptedSingleFileAuthState: opts.password is required');
    const keyMap = {};
    const saveState = async (data) => {
        const tmpPath = `${file}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmpPath, encryptJSON(data, password), { encoding: 'utf-8', mode: 0o600 });
        await fs.rename(tmpPath, file);
    };
    let creds;
    let saveCreds;
    if (await existsAsync(file)) {
        const raw = (await fs.readFile(file, { encoding: 'utf-8' })).trim();
        const data = isEncryptedPayload(raw)
            ? decryptJSON(raw, password)
            : JSON.parse(raw, BufferJSON.reviver);
        creds = data.creds;
        saveCreds = async () => saveState({ creds, keys: keyMap });
        const { keys } = data;
        for (const type of Object.keys(keys || {})) {
            keyMap[type] = {};
            for (const id of Object.keys(keys[type])) {
                let value = keys[type][id];
                if (type === 'app-state-sync-key' && value) {
                    value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                keyMap[type][id] = value;
            }
        }
    } else {
        creds = initAuthCreds();
        saveCreds = async () => saveState({ creds, keys: keyMap });
        await saveCreds();
    }
    let flushTimer = null;
    const scheduleFlush = () => {
        if (flushTimer)
            clearTimeout(flushTimer);
        flushTimer = setTimeout(() => {
            flushTimer = null;
            saveCreds().catch((e) => logger?.warn?.({ err: String(e) }, 'auth-secure: scheduled flush failed'));
        }, 300);
    };
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids)
                        data[id] = keyMap?.[type]?.[id];
                    return data;
                },
                set: async (data) => {
                    for (const category of Object.keys(data)) {
                        keyMap[category] = keyMap[category] || {};
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            if (value)
                                keyMap[category][id] = value;
                            else
                                delete keyMap[category][id];
                        }
                    }
                    scheduleFlush();
                }
            }
        },
        saveCreds,
        flush: () => {
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            return saveCreds();
        },
        clearState: async () => {
            for (const k of Object.keys(keyMap))
                delete keyMap[k];
            await saveState({ creds: initAuthCreds(), keys: {} });
        }
    };
}

async function existsAsync(path) {
    try {
        await fs.stat(path);
        return true;
    } catch {
        return false;
    }
}

export const BACKUP_MAGIC = 'JAPBACKUP1';

export async function backupAuthState(src, outFile, { password } = {}) {
    if (!password)
        throw new Error('backupAuthState: opts.password is required');
    const st = await fs.stat(src);
    const files = {};
    if (st.isDirectory()) {
        const names = (await fs.readdir(src)).filter((n) => n.endsWith('.json'));
        for (const n of names) {
            files[n] = (await fs.readFile(join(src, n), { encoding: 'utf-8' })).toString();
        }
    } else {
        files['auth.json'] = (await fs.readFile(src, { encoding: 'utf-8' })).toString();
    }
    const blob = {
        magic: BACKUP_MAGIC,
        createdAt: new Date().toISOString(),
        files: encryptJSON(files, password)
    };
    await fs.writeFile(outFile, JSON.stringify(blob), { encoding: 'utf-8' });
    return { outFile, files: Object.keys(files).length, createdAt: blob.createdAt };
}

export async function restoreAuthState(backupFile, dest, { password, single } = {}) {
    if (!password)
        throw new Error('restoreAuthState: opts.password is required');
    const blob = JSON.parse(await fs.readFile(backupFile, { encoding: 'utf-8' }));
    if (blob?.magic !== BACKUP_MAGIC)
        throw new Error('restoreAuthState: not a JAP auth backup');
    const files = decryptJSON(blob.files, password);
    const names = Object.keys(files);
    const toSingle = single || (names.length === 1 && dest.endsWith('.json') && names[0] === 'auth.json');
    if (toSingle) {
        await fs.mkdir(join(dest, '..').replace(/\\/g, '/'), { recursive: true }).catch(() => {});
        await fs.writeFile(dest, files[names[0]], { encoding: 'utf-8' });
    } else {
        await fs.mkdir(dest, { recursive: true });
        await Promise.all(names.map((n) => fs.writeFile(join(dest, n), files[n], { encoding: 'utf-8' })));
    }
    return { dest, files: names.length, createdAt: blob.createdAt };
}

const INTEGRITY_FILE = 'integrity.json';

function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

export async function writeAuthIntegrity(folder, { secret } = {}) {
    const names = (await fs.readdir(folder)).filter((n) => n.endsWith('.json') && n !== INTEGRITY_FILE);
    const sums = {};
    for (const n of names) {
        const raw = await fs.readFile(join(folder, n));
        sums[n] = secret ? createHmac('sha256', secret).update(raw).digest('hex') : sha256Hex(raw);
    }
    const snap = { createdAt: new Date().toISOString(), hmac: Boolean(secret), sums };
    await fs.writeFile(join(folder, INTEGRITY_FILE), JSON.stringify(snap, null, 2), { encoding: 'utf-8' });
    return snap;
}

export async function verifyAuthIntegrity(folder, { secret } = {}) {
    const snapRaw = await fs.readFile(join(folder, INTEGRITY_FILE), { encoding: 'utf-8' }).catch(() => null);
    if (!snapRaw)
        return { ok: false, error: 'no integrity snapshot', mismatched: [], missing: [], extra: [] };
    let snap;
    try {
        snap = JSON.parse(snapRaw);
    } catch {
        return { ok: false, error: 'integrity snapshot corrupt', mismatched: [], missing: [], extra: [] };
    }
    if (snap.hmac && !secret)
        return { ok: false, error: 'snapshot requires secret', mismatched: [], missing: [], extra: [] };
    if (!snap.hmac && secret)
        return { ok: false, error: 'snapshot has no HMAC but secret given', mismatched: [], missing: [], extra: [] };
    const mismatched = [];
    const missing = [];
    for (const [name, want] of Object.entries(snap.sums || {})) {
        const raw = await fs.readFile(join(folder, name)).catch(() => null);
        if (raw === null) {
            missing.push(name);
            continue;
        }
        const got = snap.hmac ? createHmac('sha256', secret).update(raw).digest('hex') : sha256Hex(raw);
        let equal = false;
        try {
            equal = timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));
        } catch { }
        if (!equal)
            mismatched.push(name);
    }
    const current = new Set((await fs.readdir(folder).catch(() => [])).filter((n) => n.endsWith('.json') && n !== INTEGRITY_FILE));
    const extra = [...current].filter((n) => !(n in (snap.sums || {})));
    const ok = mismatched.length === 0 && missing.length === 0;
    return { ok, mismatched, missing, extra };
}

export async function repairAuthState(folder, { password, backupFile, backupPassword, logger } = {}) {
    const report = { ok: true, checked: 0, quarantined: [], credsRestored: false };
    let names;
    try {
        names = (await fs.readdir(folder)).filter((n) => n.endsWith('.json') && n !== INTEGRITY_FILE);
    } catch (err) {
        return { ok: false, checked: 0, quarantined: [], credsRestored: false, error: String(err) };
    }
    const ts = Date.now();
    for (const n of names) {
        report.checked++;
        const p = join(folder, n);
        let valid = false;
        try {
            const raw = (await fs.readFile(p, { encoding: 'utf-8' })).trim();
            if (isEncryptedPayload(raw)) {
                if (password) {
                    decryptJSON(raw, password);
                    valid = true;
                } else {
                    valid = true;
                }
            } else {
                JSON.parse(raw, BufferJSON.reviver);
                valid = true;
            }
        } catch (err) {
            logger?.warn?.({ file: n, err: String(err) }, 'auth-secure: quarantining corrupt auth file');
        }
        if (!valid) {
            const q = join(folder, `.corrupt-${ts}-${n}`);
            try {
                await fs.rename(p, q);
                report.quarantined.push(n);
            } catch (err) {
                report.ok = false;
                report.error = `failed to quarantine ${n}: ${String(err)}`;
            }
        }
    }
    const credsGone = report.quarantined.includes('creds.json') || !(await existsAsync(join(folder, 'creds.json')));
    if (credsGone && backupFile) {
        try {
            const blob = JSON.parse(await fs.readFile(backupFile, { encoding: 'utf-8' }));
            const files = decryptJSON(blob.files, backupPassword || password);
            const credsRaw = files['creds.json'] || files['auth.json'];
            if (!credsRaw)
                throw new Error('backup has no creds');
            await fs.writeFile(join(folder, 'creds.json'), credsRaw, { encoding: 'utf-8' });
            report.credsRestored = true;
        } catch (err) {
            report.ok = false;
            report.error = `creds restore failed: ${String(err)}`;
        }
    } else if (credsGone) {
        report.ok = false;
        report.error = 'creds.json missing/corrupt and no backup provided (re-pair required)';
    }
    return report;
}

export function createRateLimiter({ max = 5, windowMs = 60 * 60 * 1000, minIntervalMs = 0, now = () => Date.now() } = {}) {
    const hits = new Map();
    const stats = { allowed: 0, blocked: 0 };
    function prune(arr, t) {
        while (arr.length && t - arr[0] >= windowMs)
            arr.shift();
        return arr;
    }
    return {
        stats,
        check(key = 'global') {
            const t = now();
            const arr = prune(hits.get(key) || [], t);
            if (minIntervalMs && arr.length && t - arr[arr.length - 1] < minIntervalMs) {
                stats.blocked++;
                return { allowed: false, retryAfterMs: minIntervalMs - (t - arr[arr.length - 1]) };
            }
            if (arr.length >= max) {
                stats.blocked++;
                return { allowed: false, retryAfterMs: windowMs - (t - arr[0]) };
            }
            arr.push(t);
            hits.set(key, arr);
            stats.allowed++;
            return { allowed: true, retryAfterMs: 0 };
        },
        reset(key) {
            if (key)
                hits.delete(key);
            else
                hits.clear();
        }
    };
}

export function withPairingGuard(sock, { maxPerHour = 5, globalMaxPerHour = 20, minIntervalMs = 30_000, logger, now } = {}) {
    if (!sock || typeof sock.requestPairingCode !== 'function') {
        throw new Error('withPairingGuard: sock.requestPairingCode not found');
    }
    const limiter = createRateLimiter({ max: maxPerHour, windowMs: 3_600_000, minIntervalMs, now });
    const global = createRateLimiter({ max: globalMaxPerHour, windowMs: 3_600_000, now });
    const original = sock.requestPairingCode.bind(sock);
    sock.requestPairingCode = async (phoneNumber, ...args) => {
        const perPhone = limiter.check(String(phoneNumber));
        const g = global.check('global');
        if (!perPhone.allowed || !g.allowed) {
            const retryAfterMs = Math.max(perPhone.retryAfterMs, g.retryAfterMs);
            logger?.warn?.({ phoneNumber: String(phoneNumber).slice(0, 4) + '****', retryAfterMs }, 'auth-secure: pairing-code request rate-limited');
            const err = new Error(`pairing-code rate limited, retry in ${Math.ceil(retryAfterMs / 1000)}s`);
            err.retryAfterMs = retryAfterMs;
            throw err;
        }
        return original(phoneNumber, ...args);
    };
    return { restore: () => { sock.requestPairingCode = original; }, limiter, global };
}

export function createQRGuard({ ttlMs = 60_000, now = () => Date.now(), onFirst, onBlocked } = {}) {
    let seenAt = 0;
    let current = null;
    const stats = { passed: 0, blocked: 0 };
    return {
        stats,
        handle(qr) {
            if (!qr)
                return null;
            const t = now();
            if (current !== null && t - seenAt < ttlMs) {
                stats.blocked++;
                onBlocked?.(stats.blocked);
                return null;
            }
            current = qr;
            seenAt = t;
            stats.passed++;
            onFirst?.(qr);
            return qr;
        },
        reset() {
            current = null;
            seenAt = 0;
        },
        get active() {
            return current !== null && now() - seenAt < ttlMs;
        }
    };
}

const SENSITIVE_EXACT = new Set([
    'qr', 'qrcode', 'pairingcode', 'pin', 'otp', 'seed', 'mnemonic', 'passphrase',
    'noisekey', 'privatekey', 'advsecretkey', 'mediakey', 'fileencsha256', 'mediakeytimestamp'
]);

const SENSITIVE_SUFFIX = ['key', 'token', 'secret', 'password', 'passwd', 'pwd', 'credential', 'cred', 'auth', 'noise', 'salt', 'iv', 'signature', 'ciphertext'];

const REDACTED = '[REDACTED]';

function isSensitiveKey(key) {
    if (typeof key !== 'string' || !key)
        return false;
    const norm = key.replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (!norm)
        return false;
    if (SENSITIVE_EXACT.has(norm))
        return true;
    return SENSITIVE_SUFFIX.some((s) => norm === s || norm.endsWith(s));
}

export function redactSecrets(value, { extraKeys = [], maxDepth = 12 } = {}) {
    const extra = new Set(extraKeys);
    const seen = new Map();
    const walk = (val, depth) => {
        if (val === null || typeof val !== 'object') {
            if (typeof val === 'string' && depth > 0 && (isEncryptedPayload(val) || /^[A-Za-z0-9+/=]{64,}$/.test(val) && val.length > 96)) {
                return REDACTED;
            }
            return val;
        }
        if (seen.has(val))
            return seen.get(val);
        if (val instanceof Date || val instanceof RegExp)
            return val;
        if (Buffer.isBuffer(val) || val instanceof Uint8Array)
            return val;
        if (depth >= maxDepth)
            return '[MAXDEPTH]';
        if (Array.isArray(val)) {
            const out = [];
            seen.set(val, out);
            for (const item of val)
                out.push(walk(item, depth + 1));
            return out;
        }
        const protoOf = Object.getPrototypeOf(val);
        if (protoOf !== null && protoOf !== Object.prototype) {
            return val;
        }
        const out = {};
        seen.set(val, out);
        for (const [k, v] of Object.entries(val)) {
            if (extra.has(k) || isSensitiveKey(k)) {
                out[k] = REDACTED;
            } else if ((Buffer.isBuffer(v) || v instanceof Uint8Array) && v.length > 0 && isSensitiveKey(k)) {
                out[k] = REDACTED;
            } else {
                out[k] = walk(v, depth + 1);
            }
        }
        return out;
    };
    return walk(value, 0);
}

export function secureLogger(base, { extraKeys } = {}) {
    if (!base || typeof base !== 'object')
        throw new Error('secureLogger: base logger required');
    const wrap = (fn) => (...args) => fn(...args.map((a) => (a && typeof a === 'object' ? redactSecrets(a, { extraKeys }) : a)));
    const out = Object.create(Object.getPrototypeOf(base) || null);
    for (const k of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
        if (typeof base[k] === 'function')
            out[k] = wrap(base[k].bind(base));
    }
    if (typeof base.child === 'function') {
        out.child = (bindings) => secureLogger(base.child(redactSecrets(bindings || {}, { extraKeys })), { extraKeys });
    }
    for (const k of ['level', 'silent']) {
        if (k in base) {
            try {
                out[k] = base[k];
            } catch { }
        }
    }
    return out;
}

const CREDS_SECRET_FIELDS = [
    'noiseKey', 'pairingEphemeralKeyPair', 'signedIdentityKey', 'signedPreKey',
    'advSecretKey', 'pairingCode', 'accountSyncCounter', 'lastPropHash',
    'routingInfo', 'additionalData', 'me', 'account'
];

export async function secureLogout(sock, { authFolder, authFile, passes = 1, logger } = {}) {
    const report = { loggedOut: false, wiped: [], credsScrubbed: false };
    if (sock && typeof sock.logout === 'function') {
        try {
            await sock.logout('secure logout — revoking session');
            report.loggedOut = true;
        } catch (err) {
            logger?.warn?.({ err: String(err) }, 'auth-secure: remote logout failed, continuing with local wipe');
        }
    }
    const targets = [];
    if (authFolder) {
        const names = await fs.readdir(authFolder).catch(() => []);
        for (const n of names.filter((n) => n.endsWith('.json') || n.startsWith('.corrupt-')))
            targets.push(join(authFolder, n));
    }
    if (authFile)
        targets.push(authFile);
    for (const p of targets) {
        try {
            const st = await fs.stat(p);
            for (let i = 0; i < passes; i++) {
                const fh = await fs.open(p, 'r+');
                try {
                    await fh.write(randomBytes(Math.min(st.size, 1 << 20)), 0, Math.min(st.size, 1 << 20), 0);
                } finally {
                    await fh.close();
                }
            }
            await fs.unlink(p);
            report.wiped.push(p);
        } catch { }
    }
    const creds = sock?.authState?.creds || sock?.creds;
    if (creds && typeof creds === 'object') {
        for (const f of CREDS_SECRET_FIELDS) {
            try {
                delete creds[f];
            } catch { }
        }
        report.credsScrubbed = true;
    }
    return report;
}

const ALL_TYPES = [
    'pre-key',
    'session',
    'sender-key',
    'sender-key-memory',
    'app-state-sync-key',
    'app-state-sync-version',
    'lid-mapping',
    'device-list',
    'tctoken',
    'identity-key'
];

export async function migrateAuthState({ from, to, batchSize = 100, skipExisting = true, logger, verify = true }) {
    if (!from?.keys?.list && !from?.keys?.listIds) {
        throw new Error('migrateAuthState: source store does not implement list(type) or listIds(type)');
    }
    if (!to?.keys?.set) {
        throw new Error('migrateAuthState: destination store does not implement set(data)');
    }
    if (!Number.isInteger(batchSize) || batchSize < 1) {
        throw new TypeError('migrateAuthState: batchSize must be a positive integer');
    }
    const result = { creds: { copied: false }, counts: {}, verified: false, warnings: [] };
    Object.assign(to.creds, from.creds);
    result.creds.copied = true;
    logger?.info?.('migrateAuthState: creds copied');

    for (const type of ALL_TYPES) {
        let existingIds = null;
        if (skipExisting && to.keys.listIds) {
            existingIds = new Set();
            try {
                for await (const id of to.keys.listIds(type)) existingIds.add(id);
            }
            catch (error) {
                result.warnings.push(`failed to enumerate existing destination ids for ${type}: ${String(error)}`);
                existingIds = null;
            }
        }
        const batch = {};
        let total = 0;
        const flush = async () => {
            const ids = Object.keys(batch);
            if (!ids.length) return;
            await to.keys.set({ [type]: { ...batch } });
            for (const id of ids) delete batch[id];
            total += ids.length;
        };
        try {
            if (from.keys.list) {
                for await (const [id, value] of from.keys.list(type)) {
                    if (existingIds?.has(id)) continue;
                    batch[id] = value;
                    if (Object.keys(batch).length >= batchSize) await flush();
                }
            }
            else {
                for await (const id of from.keys.listIds(type)) {
                    if (existingIds?.has(id)) continue;
                    const data = await from.keys.get(type, [id]);
                    if (data[id] !== undefined) batch[id] = data[id];
                    if (Object.keys(batch).length >= batchSize) await flush();
                }
            }
        }
        catch (error) {
            result.warnings.push(`failed to enumerate source records for ${type}: ${String(error)}`);
        }
        await flush();
        result.counts[type] = total;
        logger?.info?.({ type, count: total }, 'migrateAuthState: copied type');
    }
    if (verify) result.verified = await verifyMigration(from, to, result.warnings, logger);
    logger?.info?.({ counts: result.counts, verified: result.verified, warnings: result.warnings.length }, 'migrateAuthState: done');
    return result;
}

async function collectIds(state, type) {
    try {
        const out = new Set();
        if (state.keys.listIds) {
            for await (const id of state.keys.listIds(type)) out.add(id);
        }
        else if (state.keys.list) {
            for await (const [id] of state.keys.list(type)) out.add(id);
        }
        else return null;
        return out;
    }
    catch {
        return null;
    }
}

async function verifyMigration(from, to, warnings, logger) {
    let ok = true;
    for (const type of ALL_TYPES) {
        const fromIds = await collectIds(from, type);
        const toIds = await collectIds(to, type);
        if (!fromIds || !toIds) {
            warnings.push(`verification skipped for ${type}: unable to enumerate one side`);
            ok = false;
            continue;
        }
        for (const id of fromIds) if (!toIds.has(id)) {
            warnings.push(`destination missing ${type}:${id}`);
            ok = false;
        }
        for (const id of toIds) if (!fromIds.has(id)) {
            warnings.push(`destination has unexpected ${type}:${id}`);
            ok = false;
        }
    }
    logger?.info?.({ ok }, 'migrateAuthState: verification complete');
    return ok;
}

export { ALL_TYPES };

const refKey = ({ namespace, id }) => `${String(namespace)}\0${String(id)}`;

const compareRefs = (a, b) => refKey(a).localeCompare(refKey(b));

export const makeLockManager = () => {
    const keyed = makeKeyedMutex();
    const held = new Map();
    const mark = (key, delta) => {
        const next = (held.get(key) || 0) + delta;
        if (next > 0) held.set(key, next);
        else held.delete(key);
    };
    const withOne = async (ref, work) => {
        if (!ref || ref.namespace == null || ref.id == null) throw new TypeError('lock ref requires namespace and id');
        if (typeof work !== 'function') throw new TypeError('lock work must be a function');
        const key = refKey(ref);
        return keyed.mutex(key, async () => {
            mark(key, 1);
            try { return await work(); }
            finally { mark(key, -1); }
        });
    };
    return {
        withLock: withOne,
        withLocks(refs, work) {
            if (!Array.isArray(refs)) throw new TypeError('refs must be an array');
            if (typeof work !== 'function') throw new TypeError('lock work must be a function');
            const unique = new Map();
            for (const ref of refs) {
                if (!ref || ref.namespace == null || ref.id == null) throw new TypeError('lock ref requires namespace and id');
                unique.set(refKey(ref), ref);
            }
            const sorted = [...unique.values()].sort(compareRefs);
            const acquire = (i) => i >= sorted.length
                ? Promise.resolve().then(work)
                : withOne(sorted[i], () => acquire(i + 1));
            return acquire(0);
        },
        isLocked(ref) {
            if (!ref || ref.namespace == null || ref.id == null) return false;
            return held.has(refKey(ref));
        }
    };
};
