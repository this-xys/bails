import { Boom } from "@hapi/boom";
import { jidNormalizedUser } from "../WABinary/index.js";

async function loadBetterSqlite3() {
  try {
    const mod = await import("better-sqlite3");
    return mod.default ?? mod;
  } catch (err) {
    const helpful = new Error("`better-sqlite3` is required for the Framework StatsManager. Install it as a peer dependency: `npm install better-sqlite3` (or `yarn add better-sqlite3`).");
    helpful.cause = err;
    throw helpful;
  }
}

export class StatsManager {
  constructor(db, groupMetaFn) {
    this.db = db;
    this.groupMetaFn = groupMetaFn;
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS group_stats (
				group_jid    TEXT NOT NULL,
				user_jid     TEXT NOT NULL,
				msg_count    INTEGER NOT NULL DEFAULT 0,
				sticker_count INTEGER NOT NULL DEFAULT 0,
				last_active  INTEGER NOT NULL,
				PRIMARY KEY (group_jid, user_jid)
			)
		`);
    this.insertStmt = this.db.prepare(`
			INSERT INTO group_stats (group_jid, user_jid, msg_count, sticker_count, last_active)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(group_jid, user_jid) DO UPDATE SET
				msg_count     = msg_count + excluded.msg_count,
				sticker_count = sticker_count + excluded.sticker_count,
				last_active   = excluded.last_active
		`);
    this.getStatsStmt = this.db.prepare("SELECT user_jid, msg_count, sticker_count, last_active FROM group_stats WHERE group_jid = ?");
    this.getTopMsgStmt = (limit) => this.db.prepare(`SELECT user_jid AS jid, msg_count AS count FROM group_stats WHERE group_jid = ? ORDER BY msg_count DESC LIMIT ${limit}`);
    this.getTopStickerStmt = (limit) => this.db.prepare(`SELECT user_jid AS jid, sticker_count AS count FROM group_stats WHERE group_jid = ? ORDER BY sticker_count DESC LIMIT ${limit}`);
  }

  static async create(dbPath, groupMetaFn) {
    const Database = await loadBetterSqlite3();
    return new StatsManager(new Database(dbPath), groupMetaFn);
  }

  observeMessage(groupJid, userJid, isSticker) {
    const normalizedGroupJid = jidNormalizedUser(groupJid);
    const normalizedUserJid = jidNormalizedUser(userJid);
    const msgCount = 1;
    const stickerCount = isSticker ? 1 : 0;
    const now = Date.now();
    this.insertStmt.run(normalizedGroupJid, normalizedUserJid, msgCount, stickerCount, now);
  }

  getTopUsers(groupJid, limit = 10) {
    const safeLimit = Math.max(1, Math.floor(limit));
    const normalizedGroupJid = jidNormalizedUser(groupJid);
    return this.getTopMsgStmt(safeLimit).all(normalizedGroupJid);
  }

  getTopStickers(groupJid, limit = 10) {
    const safeLimit = Math.max(1, Math.floor(limit));
    const normalizedGroupJid = jidNormalizedUser(groupJid);
    return this.getTopStickerStmt(safeLimit).all(normalizedGroupJid);
  }

  async getGhosts(groupJid, socketConnected, inactiveDays = 30) {
    if (!socketConnected) {
      throw new Boom("Socket not connected — cannot fetch group metadata for ghost detection", { statusCode: 503 });
    }
    const normalizedGroupJid = jidNormalizedUser(groupJid);
    const cutoff = Date.now() - inactiveDays * 24 * 60 * 60 * 1000;
    const rows = this.getStatsStmt.all(normalizedGroupJid);
    const statsMap = new Map();
    for (const row of rows) {
      statsMap.set(jidNormalizedUser(row.user_jid), row.last_active);
    }
    const groupMeta = await this.groupMetaFn(groupJid);
    return groupMeta.participants
      .map((p) => {
        const normalizedJid = jidNormalizedUser(p.id);
        const lastActive = statsMap.get(normalizedJid);
        if (!lastActive) return { jid: normalizedJid, isTotalGhost: true };
        if (lastActive < cutoff) return { jid: normalizedJid, isTotalGhost: false, lastActive };
        return null;
      })
      .filter((g) => g !== null);
  }

  close() {
    this.db.close();
  }
}
