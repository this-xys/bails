import { BufferJSON } from "./generics.js";

import { WAProto } from "../Types/index.js";

import { makeInMemoryStore } from "../Store/make-in-memory-store.js";

const labelAssociationId = la => `${la.chatId}:${la.messageId || ""}:${la.labelId}`;

function requireDriver(loader, pkgName, installHint) {
  return loader().catch(err => {
    const helpful = new Error(`\`${pkgName}\` is required for this store adapter. Install it: \`npm install ${installHint || pkgName}\`.`);
    helpful.cause = err;
    throw helpful;
  });
}

const SQLITE_CREATE_SCHEMA_SQL = `\nCREATE TABLE IF NOT EXISTS wa_store (\n  domain TEXT NOT NULL,\n  id TEXT NOT NULL,\n  value TEXT NOT NULL,\n  PRIMARY KEY (domain, id)\n);\nCREATE INDEX IF NOT EXISTS wa_store_domain_idx ON wa_store(domain);\n`;

export async function createSqliteStoreAdapter(opts = {}) {
  let db;
  let ownsConnection = false;
  if (opts.database) {
    db = opts.database;
  } else {
    const mod = await requireDriver(() => import("better-sqlite3"), "better-sqlite3");
    const Database = mod.default ?? mod;
    db = new Database(opts.dbPath || "wa-store.db");
    ownsConnection = true;
  }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  let stmts;
  return {
    async init() {
      db.exec("CREATE TABLE IF NOT EXISTS wa_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
      const applied = new Set(db.prepare("SELECT id FROM wa_migrations").all().map(r => r.id));
      if (!applied.has("0001_init")) {
        const tx = db.transaction(() => {
          db.exec(SQLITE_CREATE_SCHEMA_SQL);
          db.prepare("INSERT INTO wa_migrations (id, applied_at) VALUES (?, ?)").run("0001_init", Date.now());
        });
        tx();
      }
      stmts = {
        get: db.prepare("SELECT value FROM wa_store WHERE domain = ? AND id = ?"),
        set: db.prepare("INSERT INTO wa_store (domain, id, value) VALUES (?, ?, ?) ON CONFLICT(domain, id) DO UPDATE SET value = excluded.value"),
        del: db.prepare("DELETE FROM wa_store WHERE domain = ? AND id = ?"),
        list: db.prepare("SELECT id, value FROM wa_store WHERE domain = ?"),
        listDomains: db.prepare("SELECT DISTINCT domain FROM wa_store"),
        listDomainsPrefix: db.prepare("SELECT DISTINCT domain FROM wa_store WHERE domain LIKE ? ESCAPE '\\'"),
        clear: db.prepare("DELETE FROM wa_store WHERE domain = ?")
      };
    },
    async get(domain, id) {
      const row = stmts.get.get(domain, id);
      return row ? JSON.parse(row.value, BufferJSON.reviver) : undefined;
    },
    async set(domain, id, value) {
      stmts.set.run(domain, id, JSON.stringify(value, BufferJSON.replacer));
    },
    async delete(domain, id) {
      stmts.del.run(domain, id);
    },
    async list(domain) {
      return stmts.list.all(domain).map(r => [ r.id, JSON.parse(r.value, BufferJSON.reviver) ]);
    },
    async listDomains(prefix) {
      if (!prefix) return stmts.listDomains.all().map(r => r.domain);
      const escaped = prefix.replace(/[\\%_]/g, c => `\\${c}`);
      return stmts.listDomainsPrefix.all(`${escaped}%`).map(r => r.domain);
    },
    async clear(domain) {
      stmts.clear.run(domain);
    },
    async close() {
      if (ownsConnection) {
        try {
          db.close();
        } catch {}
      }
    }
  };
}

function mongoSerialize(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function mongoDeserialize(doc) {
  return JSON.parse(JSON.stringify(doc), BufferJSON.reviver);
}

export async function createMongoStoreAdapter(opts = {}) {
  const {MongoClient: MongoClient} = await requireDriver(() => import("mongodb"), "mongodb");
  let client;
  let ownsConnection = false;
  if (opts.client) {
    client = opts.client;
  } else {
    client = new MongoClient(opts.url || "mongodb://127.0.0.1:27017");
    ownsConnection = true;
  }
  let collection;
  return {
    async init() {
      if (ownsConnection) await client.connect();
      const db = client.db(opts.dbName || "wa_store");
      collection = db.collection(opts.collectionName || "wa_store");
      await collection.createIndex({
        domain: 1,
        id: 1
      }, {
        unique: true
      });
      await collection.createIndex({
        domain: 1
      });
    },
    async get(domain, id) {
      const doc = await collection.findOne({
        domain: domain,
        id: id
      });
      return doc ? mongoDeserialize(doc.value) : undefined;
    },
    async set(domain, id, value) {
      await collection.updateOne({
        domain: domain,
        id: id
      }, {
        $set: {
          domain: domain,
          id: id,
          value: mongoSerialize(value)
        }
      }, {
        upsert: true
      });
    },
    async delete(domain, id) {
      await collection.deleteOne({
        domain: domain,
        id: id
      });
    },
    async list(domain) {
      const docs = await collection.find({
        domain: domain
      }).toArray();
      return docs.map(d => [ d.id, mongoDeserialize(d.value) ]);
    },
    async listDomains(prefix) {
      const filter = prefix ? {
        domain: {
          $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
        }
      } : {};
      return await collection.distinct("domain", filter);
    },
    async clear(domain) {
      await collection.deleteMany({
        domain: domain
      });
    },
    async close() {
      if (ownsConnection) await client.close();
    }
  };
}

const MYSQL_CREATE_TABLE_SQL = `\nCREATE TABLE IF NOT EXISTS wa_store (\n  domain VARCHAR(255) NOT NULL,\n  id VARCHAR(512) NOT NULL,\n  value LONGTEXT NOT NULL,\n  PRIMARY KEY (domain, id),\n  KEY wa_store_domain_idx (domain)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n`;

export async function createMysqlStoreAdapter(opts = {}) {
  const mysql = await requireDriver(() => import("mysql2/promise"), "mysql2");
  let pool;
  let ownsConnection = false;
  if (opts.pool) {
    pool = opts.pool;
  } else {
    pool = mysql.createPool(opts);
    ownsConnection = true;
  }
  return {
    async init() {
      await pool.query("CREATE TABLE IF NOT EXISTS wa_migrations (id VARCHAR(64) PRIMARY KEY, applied_at BIGINT NOT NULL)");
      const [rows] = await pool.query("SELECT id FROM wa_migrations WHERE id = ?", [ "0001_init" ]);
      if (rows.length === 0) {
        await pool.query(MYSQL_CREATE_TABLE_SQL);
        await pool.query("INSERT INTO wa_migrations (id, applied_at) VALUES (?, ?)", [ "0001_init", Date.now() ]);
      }
    },
    async get(domain, id) {
      const [rows] = await pool.query("SELECT value FROM wa_store WHERE domain = ? AND id = ?", [ domain, id ]);
      return rows.length ? JSON.parse(rows[0].value, BufferJSON.reviver) : undefined;
    },
    async set(domain, id, value) {
      await pool.query("INSERT INTO wa_store (domain, id, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [ domain, id, JSON.stringify(value, BufferJSON.replacer) ]);
    },
    async delete(domain, id) {
      await pool.query("DELETE FROM wa_store WHERE domain = ? AND id = ?", [ domain, id ]);
    },
    async list(domain) {
      const [rows] = await pool.query("SELECT id, value FROM wa_store WHERE domain = ?", [ domain ]);
      return rows.map(r => [ r.id, JSON.parse(r.value, BufferJSON.reviver) ]);
    },
    async listDomains(prefix) {
      const [rows] = prefix ? await pool.query("SELECT DISTINCT domain FROM wa_store WHERE domain LIKE ?", [ `${prefix.replace(/[%_]/g, c => `\\${c}`)}%` ]) : await pool.query("SELECT DISTINCT domain FROM wa_store");
      return rows.map(r => r.domain);
    },
    async clear(domain) {
      await pool.query("DELETE FROM wa_store WHERE domain = ?", [ domain ]);
    },
    async close() {
      if (ownsConnection) await pool.end();
    }
  };
}

const POSTGRES_CREATE_TABLE_SQL = `\nCREATE TABLE IF NOT EXISTS wa_store (\n  domain TEXT NOT NULL,\n  id TEXT NOT NULL,\n  value TEXT NOT NULL,\n  PRIMARY KEY (domain, id)\n);\nCREATE INDEX IF NOT EXISTS wa_store_domain_idx ON wa_store(domain);\n`;

export async function createPostgresStoreAdapter(opts = {}) {
  const mod = await requireDriver(() => import("pg"), "pg");
  const {Pool: Pool} = mod.default ?? mod;
  let pool;
  let ownsConnection = false;
  if (opts.pool) {
    pool = opts.pool;
  } else {
    pool = new Pool(opts);
    ownsConnection = true;
  }
  return {
    async init() {
      await pool.query("CREATE TABLE IF NOT EXISTS wa_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)");
      const {rows: rows} = await pool.query("SELECT id FROM wa_migrations WHERE id = $1", [ "0001_init" ]);
      if (rows.length === 0) {
        await pool.query(POSTGRES_CREATE_TABLE_SQL);
        await pool.query("INSERT INTO wa_migrations (id, applied_at) VALUES ($1, $2)", [ "0001_init", Date.now() ]);
      }
    },
    async get(domain, id) {
      const {rows: rows} = await pool.query("SELECT value FROM wa_store WHERE domain = $1 AND id = $2", [ domain, id ]);
      return rows.length ? JSON.parse(rows[0].value, BufferJSON.reviver) : undefined;
    },
    async set(domain, id, value) {
      await pool.query("INSERT INTO wa_store (domain, id, value) VALUES ($1, $2, $3) ON CONFLICT (domain, id) DO UPDATE SET value = excluded.value", [ domain, id, JSON.stringify(value, BufferJSON.replacer) ]);
    },
    async delete(domain, id) {
      await pool.query("DELETE FROM wa_store WHERE domain = $1 AND id = $2", [ domain, id ]);
    },
    async list(domain) {
      const {rows: rows} = await pool.query("SELECT id, value FROM wa_store WHERE domain = $1", [ domain ]);
      return rows.map(r => [ r.id, JSON.parse(r.value, BufferJSON.reviver) ]);
    },
    async listDomains(prefix) {
      const {rows: rows} = prefix ? await pool.query("SELECT DISTINCT domain FROM wa_store WHERE domain LIKE $1", [ `${prefix.replace(/[%_]/g, c => `\\${c}`)}%` ]) : await pool.query("SELECT DISTINCT domain FROM wa_store");
      return rows.map(r => r.domain);
    },
    async clear(domain) {
      await pool.query("DELETE FROM wa_store WHERE domain = $1", [ domain ]);
    },
    async close() {
      if (ownsConnection) await pool.end();
    }
  };
}

const REDIS_DOMAINS_SET_KEY = "wa_store:domains";

const redisHashKey = domain => `wa_store:h:${domain}`;

export async function createRedisStoreAdapter(opts = {}) {
  const mod = await requireDriver(() => import("ioredis"), "ioredis");
  const Redis = mod.default ?? mod;
  let client;
  let ownsConnection = false;
  if (opts.client) {
    client = opts.client;
  } else {
    client = opts.url ? new Redis(opts.url, opts) : new Redis(opts);
    ownsConnection = true;
  }
  return {
    async init() {
      await client.ping();
    },
    async get(domain, id) {
      const raw = await client.hget(redisHashKey(domain), id);
      return raw === null ? undefined : JSON.parse(raw, BufferJSON.reviver);
    },
    async set(domain, id, value) {
      await client.sadd(REDIS_DOMAINS_SET_KEY, domain);
      await client.hset(redisHashKey(domain), id, JSON.stringify(value, BufferJSON.replacer));
    },
    async delete(domain, id) {
      await client.hdel(redisHashKey(domain), id);
    },
    async list(domain) {
      const raw = await client.hgetall(redisHashKey(domain));
      return Object.entries(raw).map(([id, v]) => [ id, JSON.parse(v, BufferJSON.reviver) ]);
    },
    async listDomains(prefix) {
      const domains = await client.smembers(REDIS_DOMAINS_SET_KEY);
      return prefix ? domains.filter(d => d.startsWith(prefix)) : domains;
    },
    async clear(domain) {
      await client.del(redisHashKey(domain));
      await client.srem(REDIS_DOMAINS_SET_KEY, domain);
    },
    async close() {
      if (ownsConnection) await client.quit();
    }
  };
}

export const makePersistentStore = async config => {
  const {adapter: adapter, ...inMemConfig} = config;
  if (!adapter) {
    throw new Error("makePersistentStore requires an `adapter` (see createSqliteStoreAdapter / createMongoStoreAdapter / createMysqlStoreAdapter / createPostgresStoreAdapter / createRedisStoreAdapter above)");
  }
  const store = makeInMemoryStore(inMemConfig);
  await adapter.init();
  const hydrate = async () => {
    const chats = (await adapter.list("chats")).map(([, v]) => v);
    if (chats.length) store.chats.upsert(...chats);
    const contacts = await adapter.list("contacts");
    for (const [id, value] of contacts) store.contacts[id] = value;
    const groupMetas = await adapter.list("groupMetadata");
    for (const [id, value] of groupMetas) store.groupMetadata[id] = value;
    const labels = await adapter.list("labels");
    for (const [id, value] of labels) store.labels.upsertById(id, value);
    const labelAssociations = await adapter.list("labelAssociations");
    if (labelAssociations.length) store.labelAssociations.upsert(...labelAssociations.map(([, v]) => v));
    const messageDomains = await adapter.listDomains("messages:");
    for (const domain of messageDomains) {
      const jid = domain.slice("messages:".length);
      const msgs = await adapter.list(domain);
      const array = [];
      const dict = {};
      const list = store.messages[jid] = {
        array: array,
        get: id => dict[id],
        upsert: (item, mode) => {
          const id = item.key.id || "";
          if (dict[id]) {
            const idx = array.findIndex(i => (i.key.id || "") === id);
            if (idx >= 0) array[idx] = item;
          } else if (mode === "append") {
            array.push(item);
          } else {
            array.unshift(item);
          }
          dict[id] = item;
        }
      };
      for (const [, value] of msgs) {
        list.upsert(WAProto.WebMessageInfo.fromObject(value), "append");
      }
    }
  };
  await hydrate();
  const bind = ev => {
    store.bind(ev);
    ev.on("chats.upsert", async newChats => {
      for (const c of newChats) await adapter.set("chats", c.id, store.chats.get(c.id) || c);
    });
    ev.on("chats.update", async updates => {
      for (const u of updates) {
        const chat = store.chats.get(u.id);
        if (chat) await adapter.set("chats", u.id, chat);
      }
    });
    ev.on("chats.delete", async deletions => {
      for (const id of deletions) await adapter.delete("chats", id);
    });
    ev.on("contacts.upsert", async contacts => {
      for (const c of contacts) await adapter.set("contacts", c.id, store.contacts[c.id] || c);
    });
    ev.on("contacts.update", async updates => {
      for (const u of updates) {
        const contact = store.contacts[u.id];
        if (contact) await adapter.set("contacts", u.id, contact);
      }
    });
    ev.on("messaging-history.set", async ({chats: newChats, contacts: newContacts, messages: newMessages}) => {
      for (const c of newChats) await adapter.set("chats", c.id, store.chats.get(c.id) || c);
      for (const c of newContacts) await adapter.set("contacts", c.id, store.contacts[c.id] || c);
      for (const msg of newMessages) {
        const jid = msg.key.remoteJidAlt || msg.key.remoteJid;
        await adapter.set(`messages:${jid}`, msg.key.id || "", msg);
      }
    });
    ev.on("messages.upsert", async ({messages: newMessages}) => {
      for (const msg of newMessages) {
        const jid = msg.key.remoteJidAlt || msg.key.remoteJid;
        await adapter.set(`messages:${jid}`, msg.key.id || "", msg);
      }
    });
    ev.on("messages.update", async updates => {
      for (const {key: key} of updates) {
        const jid = key.remoteJidAlt || key.remoteJid;
        const msg = store.messages[jid]?.get(key.id);
        if (msg) await adapter.set(`messages:${jid}`, key.id || "", msg);
      }
    });
    ev.on("messages.delete", async item => {
      if ("all" in item) {
        await adapter.clear(`messages:${item.jid}`);
      } else {
        const jid = item.keys[0].remoteJidAlt || item.keys[0].remoteJid;
        for (const k of item.keys) await adapter.delete(`messages:${jid}`, k.id || "");
      }
    });
    ev.on("message-receipt.update", async updates => {
      for (const {key: key} of updates) {
        const jid = key.remoteJidAlt || key.remoteJid;
        const msg = store.messages[jid]?.get(key.id);
        if (msg) await adapter.set(`messages:${jid}`, key.id || "", msg);
      }
    });
    ev.on("messages.reaction", async reactions => {
      for (const {key: key} of reactions) {
        const jid = key.remoteJidAlt || key.remoteJid;
        const msg = store.messages[jid]?.get(key.id);
        if (msg) await adapter.set(`messages:${jid}`, key.id || "", msg);
      }
    });
    ev.on("groups.update", async updates => {
      for (const u of updates) {
        const meta = store.groupMetadata[u.id];
        if (meta) await adapter.set("groupMetadata", u.id, meta);
      }
    });
    ev.on("group-participants.update", async ({id: id}) => {
      const meta = store.groupMetadata[id];
      if (meta) await adapter.set("groupMetadata", id, meta);
    });
    ev.on("labels.edit", async label => {
      if (label.deleted) await adapter.delete("labels", label.id); else await adapter.set("labels", label.id, label);
    });
    ev.on("labels.association", async ({type: type, association: association}) => {
      const id = labelAssociationId(association);
      if (type === "add") await adapter.set("labelAssociations", id, association); else if (type === "remove") await adapter.delete("labelAssociations", id);
    });
  };
  const fetchGroupMetadata = async (jid, sock) => {
    const meta = await store.fetchGroupMetadata(jid, sock);
    if (meta) await adapter.set("groupMetadata", jid, meta);
    return meta;
  };
  return {
    ...store,
    bind: bind,
    fetchGroupMetadata: fetchGroupMetadata,
    adapter: adapter,
    close: () => adapter.close()
  };
};