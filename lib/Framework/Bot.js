import { Boom } from "@hapi/boom";
import makeWASocket from "../Socket/index.js";
import { DisconnectReason } from "../Types/index.js";
import { isJidGroup } from "../WABinary/index.js";
import defaultLogger from "../Utils/logger.js";
import { SQLiteStore } from "./Store/SQLiteStore.js";
import { Context } from "./Context.js";
import { SessionManager } from "./SessionManager.js";
import { StatsManager } from "./StatsManager.js";

export class Bot {
  constructor(config) {
    this.middlewares = [];
    this.messageQueue = [];
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.BASE_RECONNECT_DELAY = 1000;
    this.MAX_RECONNECT_DELAY = 30000;
    this.socket = null;
    this.sessions = null;
    this.stats = null;
    this.store = null;
    this.config = config;
    this.logger = config.logger ?? defaultLogger.child({ module: "Framework.Bot" });
  }

  use(middleware) {
    this.middlewares.push(middleware);
    return this;
  }

  command(cmd, handler) {
    this.use(async (ctx, next) => {
      const text = ctx.text;
      if (text === cmd || text?.startsWith(cmd + " ")) {
        await handler(ctx);
      }
      await next();
    });
    return this;
  }

  onText(handler) {
    this.use(async (ctx, next) => {
      if (ctx.text) {
        await handler(ctx);
      }
      await next();
    });
    return this;
  }

  async sendMessage(jid, content, options = {}) {
    if (this.isConnected && this.socket) {
      return this.socket.sendMessage(jid, content, options);
    }
    return new Promise((resolve, reject) => {
      this.messageQueue.push({ jid, content, options, resolve, reject });
      this.logger.info({ queueLength: this.messageQueue.length }, "socket not connected — message queued");
    });
  }

  drainQueue() {
    if (!this.isConnected || !this.socket || this.messageQueue.length === 0) return;
    this.logger.info({ pending: this.messageQueue.length }, "draining message queue");
    const queue = [...this.messageQueue];
    this.messageQueue = [];
    for (const msg of queue) {
      this.socket.sendMessage(msg.jid, msg.content, msg.options).then(msg.resolve).catch(msg.reject);
    }
  }

  rejectQueue(reason) {
    const queue = [...this.messageQueue];
    this.messageQueue = [];
    for (const msg of queue) {
      msg.reject(new Boom(reason, { statusCode: 401 }));
    }
    if (queue.length > 0) {
      this.logger.warn({ rejected: queue.length }, "message queue rejected — session terminated");
    }
  }

  async start() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.store) {
      const dbPath = this.config.dbPath ?? "baileys_store.db";
      this.store = await SQLiteStore.create(dbPath);
      this.sessions = new SessionManager(this.store);
    }
    this.socket = makeWASocket(this.config.socketConfig);
    if (this.config.enableStats && !this.stats) {
      this.stats = await StatsManager.create(this.config.dbPath ?? "baileys_store.db", (jid) => this.socket.groupMetadata(jid));
    }
    this.socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        const ctx = new Context(this, msg);
        try {
          if (this.stats && ctx.remoteJid && isJidGroup(ctx.remoteJid)) {
            const participant = msg.key.participant || msg.participant;
            if (participant) {
              const isSticker = !!msg.message?.stickerMessage;
              this.stats.observeMessage(ctx.remoteJid, participant, isSticker);
            }
          }
          await this.executeMiddlewares(ctx);
        } catch (err) {
          this.logger.error({ err }, "error executing middleware");
        }
      }
    });
    this.socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        this.logger.info("bot connected");
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.drainQueue();
      }
      if (connection === "close") {
        this.isConnected = false;
        const error = lastDisconnect?.error;
        const statusCode = error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        this.logger.warn({ statusCode }, "connection closed");
        if (isLoggedOut) {
          this.rejectQueue("session terminated (logged out)");
          this.logger.info("session logged out — not reconnecting");
        } else {
          this.reconnectAttempts++;
          const delay = Math.min(this.MAX_RECONNECT_DELAY, this.BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1));
          this.logger.info({ delay, attempt: this.reconnectAttempts }, "scheduling reconnect");
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.start().catch((err) => {
              this.logger.error({ err }, "reconnect failed");
            });
          }, delay);
        }
      }
    });
  }

  async executeMiddlewares(ctx) {
    let index = -1;
    const dispatch = async (i) => {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;
      const middleware = this.middlewares[i];
      if (middleware) {
        await middleware(ctx, () => dispatch(i + 1));
      }
    };
    await dispatch(0);
  }

  stop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectQueue("bot stopped");
    this.store?.close();
    this.stats?.close();
  }
}
