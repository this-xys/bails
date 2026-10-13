import { QueryIds, XWAPaths } from "../Types/index.js";
import { decryptMessageNode } from "../Utils/decode-wa-message.js";
import { generateProfilePicture } from "../Utils/messages-media.js";
import { getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren, isJidNewsletter, S_WHATSAPP_NET, jidDecode, jidNormalizedUser } from "../WABinary/index.js";
import { makeGroupsSocket } from "./groups.js";
import { makeMexWithFallback } from "./mex.js";
import { executeWMexQuery as genericExecuteWMexQuery, executeWMexQueryIgnoreResponse as genericExecuteWMexQueryIgnoreResponse } from "./mex.js";
import { Boom } from "@hapi/boom";
import { createHash } from "crypto";
import { proto } from "../../WAProto/index.js";
const parseNewsletterCreateResponse = (response) => {
  const { id, thread_metadata: thread, viewer_metadata: viewer, state } = response;
  const getUrlFromDirectPath = (directPath) => directPath ? `https://mmg.whatsapp.net${directPath}` : "";
  return { id, state: state?.type, owner: void 0, name: thread.name.text, nameTime: +thread.name.update_time, creation_time: parseInt(thread.creation_time, 10), description: thread.description.text, descriptionTime: +thread.description.update_time, invite: thread.invite, handle: thread.handle, subscribers: parseInt(thread.subscribers_count, 10), verification: thread.verification, picture: getUrlFromDirectPath(thread.picture?.direct_path), preview: getUrlFromDirectPath(thread.preview?.direct_path), reaction_codes: thread.settings?.reaction_codes?.value, mute_state: viewer.mute, viewer_metadata: viewer };
};

const parseNewsletterMetadata = (result) => {
  if (typeof result !== "object" || result === null) {
    return null;
  }
  if ("id" in result && typeof result.id === "string") {
    return result;
  }
  if ("result" in result && typeof result.result === "object" && result.result !== null && "id" in result.result) {
    return result.result;
  }
  return null;
};

const makeNewsletterSocket = (config) => {
  const sock = makeGroupsSocket(config);
  const { authState, ev, query, generateMessageTag, signalRepository } = sock;
  const { logger, newsletterMetadataCacheTtlMs, newsletterMetadataCacheMaxSize } = config;
  const { executeWMexQuery, probeQueryIds } = makeMexWithFallback({
    query,
    generateMessageTag,
    logger,
    overrides: config?.newsletterQueryIds
  });
  const executeWMexQueryIgnoreResponse = (variables, queryId) => {
    return genericExecuteWMexQueryIgnoreResponse(variables, queryId, query, generateMessageTag);
  };
  const newsletterMetaCache = new Map();
  const inviteToNewsletterJidCache = new Map();
  const inFlightNewsletterMeta = new Map();
  const cacheTtl = newsletterMetadataCacheTtlMs ?? 0;
  const cacheMaxSize = Math.max(16, newsletterMetadataCacheMaxSize || 256);
  const pruneCache = (cache) => {
    if (cache.size <= cacheMaxSize) {
      return;
    }
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== void 0) {
      cache.delete(oldestKey);
    }
  };
  const getFromMetaCache = (jid) => {
    if (cacheTtl <= 0) {
      return void 0;
    }
    const entry = newsletterMetaCache.get(jid);
    if (entry && Date.now() - entry.ts < cacheTtl) {
      return entry.data;
    }
    return void 0;
  };
  const setMetaCache = (jid, data) => {
    if (cacheTtl <= 0) {
      return;
    }
    newsletterMetaCache.set(jid, { data, ts: Date.now() });
    pruneCache(newsletterMetaCache);
  };
  const mergeNewsletterSettingsUpdate = (jid, update) => {
    if (cacheTtl <= 0 || !update || typeof update !== "object") {
      return;
    }
    const existing = newsletterMetaCache.get(jid);
    if (!existing) {
      return;
    }
    const next = { ...existing.data };
    const patch = update;
    if (typeof patch.name === "string") {
      next.name = patch.name;
    }
    if (typeof patch.description === "string") {
      next.description = patch.description;
    }
    newsletterMetaCache.set(jid, { data: next, ts: existing.ts });
  };
  ev.on("newsletter-settings.update", ({ id, update }) => {
    mergeNewsletterSettingsUpdate(id, update);
  });
  const newsletterQuery = (jid, type, content) => query({ tag: "iq", attrs: { id: generateMessageTag(), type, xmlns: "newsletter", to: jid }, content });
  const newsletterUpdate = async (jid, updates) => {
    const { settings, ...rest } = updates;
    const variables = { newsletter_id: jid, updates: { ...rest, settings: typeof settings === "undefined" ? null : settings } };
    return executeWMexQuery(variables, QueryIds.UPDATE_METADATA, "xwa2_newsletter_update");
  };
  const parseFetchedMessages = async (node, mode, { decrypt }) => {
    const messagesNode = mode === "messages" ? getBinaryNodeChild(node, "messages") : getBinaryNodeChild(getBinaryNodeChild(node, "message_updates"), "messages");
    if (!messagesNode) {
      return [];
    }
    const fromJid = messagesNode.attrs.jid;
    return Promise.all(getAllBinaryNodeChildren(messagesNode).map(async (messageNode) => {
      if (fromJid && !messageNode.attrs.from) {
        messageNode.attrs.from = fromJid;
      }
      const views = parseInt(getBinaryNodeChild(messageNode, "views_count")?.attrs?.count || "0", 10);
      const reactionNode = getBinaryNodeChild(messageNode, "reactions");
      const reactions = getBinaryNodeChildren(reactionNode, "reaction").map(({ attrs }) => ({ count: parseInt(attrs.count || "0", 10), code: attrs.code || "" }));
      const server_id = messageNode.attrs.server_id || messageNode.attrs.message_id || messageNode.attrs.id || "";
      const data = { server_id, views, reactions };
      if (decrypt) {
        const meId = authState.creds.me.id;
        const meLid = authState.creds.me.lid || "";
        const { fullMessage, decrypt: doDecrypt } = decryptMessageNode(messageNode, meId, meLid, signalRepository, logger);
        await doDecrypt();
        data.message = fullMessage;
      }
      return data;
    }));
  };
  const getNewsletterMetadata = async (type, key, viewRole) => {
    if (type === "jid") {
      const cached = getFromMetaCache(key);
      if (cached) {
        return cached;
      }
    } else {
      const mapped = inviteToNewsletterJidCache.get(key);
      if (mapped && (cacheTtl <= 0 || Date.now() - mapped.ts < cacheTtl)) {
        const cached = getFromMetaCache(mapped.jid);
        if (cached) {
          return cached;
        }
      }
    }
    const inflightKey = `${type}:${key}:${viewRole || ""}`;
    const inflight = inFlightNewsletterMeta.get(inflightKey);
    if (inflight) {
      return inflight;
    }
    const p = (async () => {
      const variables = { fetch_creation_time: true, fetch_full_image: true, fetch_viewer_metadata: true, input: { key, type: type.toUpperCase() } };
      if (viewRole) {
        variables.input.view_role = viewRole;
      }
      const result = await executeWMexQuery(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata);
      const parsed = parseNewsletterMetadata(result);
      if (parsed?.id) {
        setMetaCache(parsed.id, parsed);
        if (type === "invite") {
          inviteToNewsletterJidCache.set(key, { jid: parsed.id, ts: Date.now() });
          pruneCache(inviteToNewsletterJidCache);
        }
      }
      return parsed;
    })();
    inFlightNewsletterMeta.set(inflightKey, p);
    try {
      return await p;
    } finally {
      inFlightNewsletterMeta.delete(inflightKey);
    }
  };
  async function newsletterFetchMessages(...args) {
    if (args[0] === "invite" || args[0] === "jid") {
      const [type, key, count2, after2] = args;
      const attrs = { type, count: count2.toString() };
      if (type === "invite") {
        attrs.key = key;
      } else {
        attrs.jid = key;
      }
      if (typeof after2 === "number") {
        attrs.after = after2.toString();
      }
      const result2 = await newsletterQuery(S_WHATSAPP_NET, "get", [{ tag: "messages", attrs }]);
      return parseFetchedMessages(result2, "messages", { decrypt: true });
    }
    const [jid, count, since, after] = args;
    const messageUpdateAttrs = { count: count.toString() };
    if (typeof since === "number") {
      messageUpdateAttrs.since = since.toString();
    }
    if (typeof after === "number") {
      messageUpdateAttrs.after = after.toString();
    }
    const result = await query({ tag: "iq", attrs: { id: generateMessageTag(), type: "get", xmlns: "newsletter", to: jid }, content: [{ tag: "message_updates", attrs: messageUpdateAttrs }] });
    return parseFetchedMessages(result, "messages", { decrypt: false });
  }
  const isFollowingNewsletter = async (jid) => {
    try {
      const result = await getNewsletterMetadata("jid", jid, "GUEST");
      return result?.viewer_metadata?.mute === "OFF" || result?.viewer_metadata?.is_subscribed === true;
    } catch {
      return false;
    }
  };
  return {
    ...sock,
    executeWMexQuery,
    newsletterProbeQueryIds: probeQueryIds,
    ...makeNewsletterExtMethods({ query, generateMessageTag }),
    newsletterQuery, isFollowingNewsletter, newsletterCreate: async (name, description, picture) => {
    const variables = { input: { name, description: description ?? null } };
    if (picture) {
      const { img } = await generateProfilePicture(picture);
      variables.input.picture = img.toString("base64");
    }
    const rawResponse = await executeWMexQuery(variables, QueryIds.CREATE, XWAPaths.xwa2_newsletter_create);
    return parseNewsletterCreateResponse(rawResponse);
  }, newsletterUpdate, newsletterSubscribers: async (jid) => {
    return executeWMexQuery({ newsletter_id: jid }, QueryIds.SUBSCRIBERS, XWAPaths.xwa2_newsletter_subscribers);
  }, newsletterSubscribed: async () => {
    return executeWMexQuery({}, QueryIds.SUBSCRIBED, XWAPaths.xwa2_newsletter_subscribed);
  }, newsletterMetadata: getNewsletterMetadata, newsletterFetchAllParticipating: async (viewRole) => {
    const list = await executeWMexQuery({}, QueryIds.SUBSCRIBED, XWAPaths.xwa2_newsletter_subscribed);
    const items = Array.isArray(list) ? list : [];
    const data = {};
    const concurrency = 3;
    let i = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        const jid = item?.id;
        if (!jid || !isJidNewsletter(jid)) {
          continue;
        }
        const meta = await getNewsletterMetadata("jid", jid, viewRole);
        if (meta) {
          data[meta.id] = meta;
        }
      }
    });
    await Promise.all(workers);
    return data;
  }, newsletterFollow: (jid) => executeWMexQueryIgnoreResponse({ newsletter_id: jid }, QueryIds.FOLLOW), newsletterUnfollow: (jid) => executeWMexQueryIgnoreResponse({ newsletter_id: jid }, QueryIds.UNFOLLOW), newsletterMute: (jid) => executeWMexQueryIgnoreResponse({ newsletter_id: jid }, QueryIds.MUTE), newsletterUnmute: (jid) => executeWMexQueryIgnoreResponse({ newsletter_id: jid }, QueryIds.UNMUTE), newsletterUpdateName: async (jid, name) => newsletterUpdate(jid, { name }), newsletterUpdateDescription: async (jid, description) => newsletterUpdate(jid, { description }), newsletterUpdatePicture: async (jid, content) => {
    const { img } = await generateProfilePicture(content);
    return newsletterUpdate(jid, { picture: img.toString("base64") });
  }, newsletterRemovePicture: async (jid) => newsletterUpdate(jid, { picture: "" }), newsletterReactionMode: async (jid, mode) => newsletterUpdate(jid, { settings: { reaction_codes: { value: mode } } }), newsletterReactMessage: async (jid, serverId, reaction) => {
    await query({ tag: "message", attrs: { to: jid, ...reaction ? {} : { edit: "7" }, type: "reaction", server_id: serverId, id: generateMessageTag() }, content: [{ tag: "reaction", attrs: reaction ? { code: reaction } : {} }] });
  }, newsletterFetchMessages, newsletterFetchUpdates: async (jid, count, opts = {}) => {
    const { since, after, decrypt } = opts;
    const attrs = { count: count.toString() };
    if (typeof since === "number") {
      attrs.since = since.toString();
    }
    if (typeof after === "number") {
      attrs.after = after.toString();
    }
    const result = await newsletterQuery(jid, "get", [{ tag: "message_updates", attrs }]);
    return parseFetchedMessages(result, "updates", { decrypt: !!decrypt });
  }, subscribeNewsletterUpdates: async (jid) => {
    const result = await query({ tag: "iq", attrs: { id: generateMessageTag(), type: "set", xmlns: "newsletter", to: jid }, content: [{ tag: "live_updates", attrs: {}, content: [] }] });
    const liveUpdatesNode = getBinaryNodeChild(result, "live_updates");
    const duration = liveUpdatesNode?.attrs?.duration;
    return duration ? { duration } : null;
  }, newsletterAdminCount: async (jid) => {
    const response = await executeWMexQuery({ newsletter_id: jid }, QueryIds.ADMIN_COUNT, XWAPaths.xwa2_newsletter_admin_count);
    return response.admin_count;
  }, newsletterChangeOwner: async (jid, newOwnerJid) => {
    await executeWMexQueryIgnoreResponse({ newsletter_id: jid, user_id: newOwnerJid }, QueryIds.CHANGE_OWNER);
  }, newsletterDemote: async (jid, userJid) => {
    await executeWMexQueryIgnoreResponse({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE);
  }, newsletterDelete: async (jid) => {
    await executeWMexQueryIgnoreResponse({ newsletter_id: jid }, QueryIds.DELETE);
  }, newsletterAction: async (jid, type) => {
    const queryId = QueryIds[type.toUpperCase()];
    if (!queryId) {
      throw new Error(`Unknown newsletter action: ${type}`);
    }
    await executeWMexQueryIgnoreResponse({ newsletter_id: jid }, queryId);
  } };
};

const extractNewsletterMetadata = (node, isCreate) => {
  const result = getBinaryNodeChild(node, "result")?.content?.toString();
  const parsed = JSON.parse(result || "{}");
  const metadataPath = parsed.data?.[isCreate ? XWAPaths.xwa2_newsletter_create : XWAPaths.xwa2_newsletter_metadata];
  const getUrlFromDirectPath = (directPath) => directPath ? `https://mmg.whatsapp.net${directPath}` : "";
  return { id: metadataPath?.id, state: metadataPath?.state?.type, creation_time: +metadataPath?.thread_metadata?.creation_time, name: metadataPath?.thread_metadata?.name?.text, nameTime: +metadataPath?.thread_metadata?.name?.update_time, description: metadataPath?.thread_metadata?.description?.text, descriptionTime: +metadataPath?.thread_metadata?.description?.update_time, invite: metadataPath?.thread_metadata?.invite, handle: metadataPath?.thread_metadata?.handle, picture: getUrlFromDirectPath(metadataPath?.thread_metadata?.picture?.direct_path), preview: getUrlFromDirectPath(metadataPath?.thread_metadata?.preview?.direct_path), reaction_codes: metadataPath?.thread_metadata?.settings?.reaction_codes?.value, subscribers: +metadataPath?.thread_metadata?.subscribers_count, verification: metadataPath?.thread_metadata?.verification, viewer_metadata: metadataPath?.viewer_metadata };
};

const _afSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const _autoFollowSockets = new WeakSet();

const _autoFollowTasks = new WeakMap();

const _autoFollowCompleted = new WeakSet();

const _resolveAutoFollowJid = async (sock, config = {}) => {
  const candidate = (config.autoFollowNewsletterJid || "").trim();
  if (!candidate) {
    return null;
  }
  if (candidate.endsWith("@newsletter")) {
    return candidate;
  }
  if (/^\d+$/.test(candidate)) {
    return `${candidate}@newsletter`;
  }
  if (candidate.includes("whatsapp.com/channel/") || candidate.includes("wa.me/channel/")) {
    try {
      const metadata = await sock.newsletterMetadata?.("invite", candidate);
      return metadata?.id || null;
    } catch {
      return null;
    }
  }
  return null;
};

const _runAutoFollow = async (sock, config = {}) => {
  if (!sock?.query || !sock?.generateMessageTag) {
    return false;
  }
  if (_autoFollowCompleted.has(sock)) {
    return true;
  }
  const existingTask = _autoFollowTasks.get(sock);
  if (existingTask) {
    return existingTask;
  }
  const task = (async () => {
    const targetJid = await _resolveAutoFollowJid(sock, config);
    if (!targetJid) {
      return false;
    }
    try {
      if (typeof sock.isFollowingNewsletter === "function" && await sock.isFollowingNewsletter(targetJid)) {
        _autoFollowCompleted.add(sock);
        return true;
      }
    } catch {
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await sock.newsletterFollow(targetJid);
        _autoFollowCompleted.add(sock);
        return true;
      } catch {
        if (attempt === 2) {
          return false;
        }
        await _afSleep(4e3 * (attempt + 1));
      }
    }
    return false;
  })();
  _autoFollowTasks.set(sock, task);
  try {
    await task;
  } finally {
    _autoFollowTasks.delete(sock);
  }
};

const DEFAULT_AUTO_FOLLOW_NEWSLETTER_JID = "120363401404146384@newsletter";
const triggerAutoFollow = (sock, userConfig = {}) => {
  const config = { ...userConfig, autoFollowNewsletterJid: userConfig.autoFollowNewsletterJid || DEFAULT_AUTO_FOLLOW_NEWSLETTER_JID };
  if (config.autoFollowNewsletterOnConnect === false) {
    return;
  }
  if (_autoFollowSockets.has(sock)) {
    return;
  }
  _autoFollowSockets.add(sock);
  const delayMs = Number.isFinite(config.autoFollowNewsletterDelayMs) ? Math.max(0, config.autoFollowNewsletterDelayMs) : 9e4;
  if (sock?.ev?.on) {
    const onConnectionUpdate = async (update) => {
      if (update?.connection !== "open" || _autoFollowCompleted.has(sock)) {
        return;
      }
      sock.ev.off?.("connection.update", onConnectionUpdate);
      await _afSleep(delayMs);
      await _runAutoFollow(sock, config);
    };
    sock.ev.on("connection.update", onConnectionUpdate);
  }
};

export {
  extractNewsletterMetadata,
  makeNewsletterSocket,
  triggerAutoFollow
};

export const EXT_QUERY_IDS = Object.freeze({
    UPDATE_USER_SETTING: '31938993655691868',
    ADMIN_CAPABILITIES: '9801384413216421',
    ENFORCEMENTS: '27835373536068060',
    CHANNEL_REPORTS: '35936238352686172',
    CREATE_REPORT_APPEAL: '27103316329328467',
    POLL_VOTERS: '9407762219322536',
    REACTION_SENDER_LIST: '29575462448733991',
    PIN_MESSAGES: '27165709459706559',
    UNPIN_MESSAGES: '28007176042216937',
    LABEL_AI_CONTENT: '27909718265289596',
    PAID_PARTNERSHIP_LABEL: '26102375079404865',
    CREATE_ADMIN_INVITE: '9387141988078609',
    REVOKE_ADMIN_INVITE: '9656078347839416',
    ACCEPT_ADMIN_INVITE: '9580828702035549',
    DIRECTORY_LIST: '26125047313831973',
    DIRECTORY_SEARCH: '26301059626252132',
    DIRECTORY_CATEGORIES: '35266481849605779',
    INSIGHTS: '9853618868050977',
    FOLLOWERS: '27472091235714801',
    QUESTION_RESPONSE_STATE: '24636260219323456',
    RECOMMENDED: '25806748772361516',
    SIMILAR: '26217043484590756',
    UPDATE_TEXT_STATUS: '9152604461510864',
    TEXT_STATUS_LIST: '24072923595647473',
    ABOUT_STATUS: '24535500086059408',
});

export const NEWSLETTER_SERVER_ID_MIN = 99;

export const NEWSLETTER_SERVER_ID_MAX = 2147476647;

export const toNewsletterServerId = (value, label) => {
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isInteger(parsed) || parsed < NEWSLETTER_SERVER_ID_MIN || parsed > NEWSLETTER_SERVER_ID_MAX) {
        throw new TypeError(`${JSON.stringify(value)} is not a newsletter server id${label ? ` for ${label}` : ''}; expected an integer in ${NEWSLETTER_SERVER_ID_MIN}..${NEWSLETTER_SERVER_ID_MAX} (get one from newsletterFetchMessages or a sent message)`);
    }
    return String(parsed);
};

export const toNewsletterServerIds = (serverIds) => {
    const list = Array.isArray(serverIds) ? serverIds : [serverIds];
    if (!list.length) throw new TypeError('a newsletter server id is required');
    return list.map((id) => toNewsletterServerId(id));
};

const assertNewsletterJid = (jid) => {
    if (typeof jid !== 'string' || !jid.endsWith('@newsletter')) throw new TypeError(`${JSON.stringify(jid)} is not a newsletter jid`);
    return jid;
};

const REACTION_SETTINGS = new Set(['ALL', 'BASIC', 'NONE', 'BLOCKLIST']);

const readInt = (attrs, key) => {
    const raw = attrs?.[key];
    if (raw === undefined || raw === null || raw === '') return undefined;
    const n = Number.parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : undefined;
};

export const extractNewsletterMessageMeta = (stanza) => {
    const meta = getBinaryNodeChild(stanza, 'meta');
    if (!meta) return undefined;
    const result = {};
    const adminProfile = getBinaryNodeChild(meta, 'admin_profile');
    if (adminProfile) {
        const name = getBinaryNodeChild(adminProfile, 'name');
        const picture = getBinaryNodeChild(adminProfile, 'picture');
        const content = name?.content;
        result.adminProfile = {
            id: adminProfile.attrs?.id,
            name: typeof content === 'string' ? content : content instanceof Uint8Array ? Buffer.from(content).toString('utf-8') : undefined,
            pictureId: picture?.attrs?.id,
            pictureDirectPath: picture?.attrs?.direct_path,
        };
    }
    if (getBinaryNodeChild(meta, 'paid_partnership')) result.paidPartnership = true;
    if (getBinaryNodeChild(meta, 'ai_content')) result.aiContent = true;
    const editTimestamp = readInt(meta.attrs, 'msg_edit_t');
    if (editTimestamp !== undefined) result.editTimestamp = editTimestamp;
    const originalTimestamp = readInt(meta.attrs, 'original_msg_t');
    if (originalTimestamp !== undefined) result.originalTimestamp = originalTimestamp;
    return Object.keys(result).length ? result : undefined;
};

const decodePlaintext = (node) => {
    if (!node?.content) return undefined;
    const buf = typeof node.content === 'string' ? Buffer.from(node.content, 'binary') : Buffer.from(node.content);
    return proto.Message.decode(buf).toJSON();
};

const decodeMessageNodes = (parent, newsletterJid, logger) => {
    const out = [];
    for (const child of getBinaryNodeChildren(parent, 'message')) {
        const plaintext = getBinaryNodeChild(child, 'plaintext');
        if (!plaintext?.content) continue;
        try {
            const full = proto.WebMessageInfo.fromObject({
                key: { remoteJid: newsletterJid, id: child.attrs.id || child.attrs.server_id, fromMe: child.attrs.is_sender === 'true' },
                message: decodePlaintext(plaintext),
                messageTimestamp: child.attrs.t ? +child.attrs.t : undefined,
            }).toJSON();
            if (child.attrs.server_id) full.key.server_id = child.attrs.server_id;
            const meta = extractNewsletterMessageMeta(child);
            if (meta) {
                full.newsletterMeta = meta;
                if (meta.adminProfile?.name) full.pushName = meta.adminProfile.name;
            }
            out.push(full);
        } catch (error) {
            logger?.error?.({ error }, 'Failed to decode newsletter message');
        }
    }
    return out;
};

export const makeNewsletterExtMethods = (sock) => {
    const { query, generateMessageTag, logger } = sock;
    const nl = (to, type, content) => query({ tag: 'iq', attrs: { id: generateMessageTag(), type, xmlns: 'newsletter', to }, content });
    const fetchMyAddOns = async (options, type) => {
        const attrs = { limit: String(options.limit ?? 100) };
        if (type) attrs.type = type;
        if (options.jid) attrs.jid = options.jid;
        const result = await nl(S_WHATSAPP_NET, 'get', [{ tag: 'my_addons', attrs, content: undefined }]);
        const addOns = getBinaryNodeChild(result, 'my_addons');
        if (!addOns) return [];
        return getBinaryNodeChildren(addOns, 'messages').map((group) => ({
            jid: group.attrs?.jid,
            messages: getBinaryNodeChildren(group, 'message').map((entry) => {
                const reaction = getBinaryNodeChild(entry, 'reaction');
                const votes = getBinaryNodeChild(entry, 'votes');
                return {
                    serverId: entry.attrs?.server_id ? Number(entry.attrs.server_id) : undefined,
                    reaction: reaction ? { code: reaction.attrs?.code, t: reaction.attrs?.t ? Number(reaction.attrs.t) : undefined } : undefined,
                    pollVote: votes ? { t: votes.attrs?.t ? Number(votes.attrs.t) : undefined, hashes: getBinaryNodeChildren(votes, 'vote').map((v) => Buffer.from(v.content ?? []).toString('hex')) } : undefined,
                };
            }),
        }));
    };
    const mex = (variables, id, path) => genericExecuteWMexQuery(variables, id, path, query, generateMessageTag);
    const Q = EXT_QUERY_IDS;
    const base = (jid, extra = {}) => ({ newsletter_id: assertNewsletterJid(jid), ...extra });
    const labelOp = (id, path) => (jid, serverId, messageType = 'MESSAGE') =>
        mex(base(jid, { server_id: toNewsletterServerId(serverId), message_type: messageType }), id, path);

    return {
        newsletterUpdateUserSetting: async (jid, type, muted) => {
            const input = { newsletter_id: assertNewsletterJid(jid), type: type === 'FOLLOWER_NOTIFICATIONS' ? 'MUTE_FOLLOWER_ACTIVITY' : 'MUTE_ADMIN_ACTIVITY', value: muted ? 'ON' : 'OFF' };
            const r = await mex({ input }, Q.UPDATE_USER_SETTING, 'xwa2_newsletter_update_user_setting');
            return r;
        },
        newsletterAdminCapabilities: async (jid) => (await mex(base(jid), Q.ADMIN_CAPABILITIES, 'xwa2_newsletter_admin_capabilities'))?.capabilities ?? [],
        newsletterEnforcements: (jid, locale = 'en_US') => mex(base(jid, { locale }), Q.ENFORCEMENTS, 'xwa2_channel_enforcements'),
        newsletterReports: async (locale = 'en_US') => (await mex({ locale }, Q.CHANNEL_REPORTS, 'xwa2_channels_reports'))?.channels_reports ?? [],
        newsletterAppealReport: (reportId, reason) => mex({ report_id: String(reportId), reason }, Q.CREATE_REPORT_APPEAL, 'xwa2_create_channel_report_appeal_v2'),
        newsletterPollVoters: (jid, serverId, options = {}) => mex({ input: { newsletter_id: assertNewsletterJid(jid), server_id: toNewsletterServerId(serverId), limit: options.limit ?? 100, vote_hash: options.voteHash } }, Q.POLL_VOTERS, 'voter_list'),
        newsletterReactionSenders: (jid, serverId) => mex({ input: { id: assertNewsletterJid(jid), server_id: toNewsletterServerId(serverId) } }, Q.REACTION_SENDER_LIST, 'xwa2_newsletters_reaction_sender_list'),
        newsletterPinMessages: (jid, serverIds) => mex(base(jid, { input: { message_ids: toNewsletterServerIds(serverIds) } }), Q.PIN_MESSAGES, 'xwa2_newsletter_pin_messages'),
        newsletterUnpinMessages: (jid, serverIds) => mex(base(jid, { input: { message_ids: toNewsletterServerIds(serverIds) } }), Q.UNPIN_MESSAGES, 'xwa2_newsletter_unpin_messages'),
        newsletterLabelAiContent: labelOp(Q.LABEL_AI_CONTENT, 'xwa2_newsletter_label_ai_content'),
        newsletterLabelPaidPartnership: labelOp(Q.PAID_PARTNERSHIP_LABEL, 'xwa2_newsletter_label_paid_partnership'),
        newsletterCreateAdminInvite: (jid, userJid) => mex(base(jid, { user_id: userJid }), Q.CREATE_ADMIN_INVITE, 'xwa2_newsletter_admin_invite_create'),
        newsletterRevokeAdminInvite: (jid, userJid) => mex(base(jid, { user_id: userJid }), Q.REVOKE_ADMIN_INVITE, 'xwa2_newsletter_admin_invite_revoke'),
        newsletterAcceptAdminInvite: (jid) => mex(base(jid), Q.ACCEPT_ADMIN_INVITE, 'xwa2_newsletter_admin_invite_accept'),
        newsletterDirectoryList: (o = {}) => mex({ fetch_status_metadata: o.fetchStatusMetadata ?? false, input: { view: o.view ?? 'RECOMMENDED', filters: { country_codes: o.countryCodes ?? [], categories: o.categories ?? [] }, limit: o.limit ?? 20, start_cursor: o.cursorToken } }, Q.DIRECTORY_LIST, 'xwa2_newsletters_directory_list'),
        newsletterDirectorySearch: (text, o = {}) => mex({ fetch_status_metadata: o.fetchStatusMetadata ?? false, input: { search_text: text, categories: o.categories ?? [], limit: o.limit ?? 20, start_cursor: o.cursorToken } }, Q.DIRECTORY_SEARCH, 'xwa2_newsletters_directory_search'),
        newsletterDirectoryCategories: (o = {}) => mex({ fetch_status_metadata: o.fetchStatusMetadata ?? false, input: { categories: o.categories ?? [], country_code: o.countryCode || undefined, per_category_limit: o.perCategoryLimit ?? 10 } }, Q.DIRECTORY_CATEGORIES, 'xwa2_newsletters_directory_category_preview'),
        newsletterInsights: (jid, o = {}) => mex({ input: { newsletter_id: assertNewsletterJid(jid), metrics: o.metrics ?? ['NET_FOLLOWS', 'UNFOLLOWS'] } }, Q.INSIGHTS, 'xwa2_newsletter_admin_insights'),
        newsletterFollowers: (jid, o = {}) => mex({ input: { newsletter_id: assertNewsletterJid(jid), count: o.count ?? 100 } }, Q.FOLLOWERS, 'xwa2_newsletter_followers'),
        newsletterQuestionResponseState: (jid, serverId, responseServerId, state) => mex(base(jid, { server_id: toNewsletterServerId(serverId), response_server_id: toNewsletterServerId(responseServerId), state }), Q.QUESTION_RESPONSE_STATE, 'xwa2_newsletter_question_response_state_update'),
        newsletterRecommended: (o = {}) => mex({ fetch_status_metadata: o.fetchStatusMetadata ?? false, input: { limit: o.limit ?? 20, country_codes: o.countryCodes ?? [] } }, Q.RECOMMENDED, 'xwa2_newsletters_recommended'),
        newsletterSimilar: (jid, o = {}) => mex({ fetch_status_metadata: o.fetchStatusMetadata ?? false, input: { newsletter_id: assertNewsletterJid(jid), limit: o.limit ?? 20, country_codes: o.countryCodes ?? [] } }, Q.SIMILAR, 'xwa2_newsletters_similar'),
        newsletterFetchMessageUpdates: async (jid, options = {}) => {
            assertNewsletterJid(jid);
            const { count = 20, since, before, after } = options;
            const attrs = { count: String(count) };
            if (since !== undefined) attrs.since = String(since);
            if (before !== undefined) attrs.before = String(before);
            else if (after !== undefined) attrs.after = String(after);
            const result = await nl(jid, 'get', [{ tag: 'message_updates', attrs, content: undefined }]);
            const updates = getBinaryNodeChild(result, 'message_updates');
            const messages = updates && getBinaryNodeChild(updates, 'messages');
            return { jid: messages?.attrs?.jid ?? jid, messages: messages ? decodeMessageNodes(messages, messages.attrs?.jid ?? jid, logger) : [] };
        },
        newsletterQuestionResponses: async (jid, serverId, options = {}) => {
            assertNewsletterJid(jid);
            const id = toNewsletterServerId(serverId);
            const { count = 20, before, filter, searchText } = options;
            const attrs = { server_id: id, count: String(count) };
            if (before !== undefined) attrs.before = String(before);
            const content = [];
            if (filter) content.push({ tag: 'filters', attrs: {}, content: [{ tag: filter, attrs: {}, content: undefined }] });
            if (searchText) content.push({ tag: 'search', attrs: { text: searchText }, content: undefined });
            const result = await nl(jid, 'get', [{ tag: 'question_responses', attrs, content: content.length ? content : undefined }]);
            const responses = getBinaryNodeChild(result, 'question_responses');
            if (!responses) return { jid, serverId: Number(id), responses: [] };
            return {
                jid: result.attrs?.from ?? jid,
                serverId: responses.attrs?.server_id ? Number(responses.attrs.server_id) : Number(id),
                responses: getBinaryNodeChildren(responses, 'question_response').map((entry) => {
                    const messageNode = getBinaryNodeChild(entry, 'message');
                    const sender = getBinaryNodeChild(entry, 'sender');
                    const picture = sender && getBinaryNodeChild(sender, 'picture');
                    const flags = getBinaryNodeChild(entry, 'flags');
                    const plaintext = messageNode && getBinaryNodeChild(messageNode, 'plaintext');
                    return {
                        id: messageNode?.attrs?.id,
                        t: messageNode?.attrs?.t ? Number(messageNode.attrs.t) : undefined,
                        isSender: messageNode?.attrs?.is_sender === 'true',
                        responseServerId: messageNode?.attrs?.response_server_id,
                        sender: { lid: sender?.attrs?.lid, notifyName: sender?.attrs?.notify_name, pictureDirectPath: picture?.attrs?.direct_path },
                        replied: flags ? !!getBinaryNodeChild(flags, 'replied') : false,
                        starred: flags ? !!getBinaryNodeChild(flags, 'starred') : false,
                        message: decodePlaintext(plaintext),
                    };
                }),
            };
        },
        newsletterMyAddOns: (options = {}) => fetchMyAddOns(options, undefined),
        newsletterStatusMyAddOns: (options = {}) => fetchMyAddOns(options, 'status'),
        newsletterSendPollVote: async (jid, parentServerId, options) => {
            const names = Array.isArray(options) ? options : [options];
            const votes = names.map((name) => ({ tag: 'vote', attrs: {}, content: createHash('sha256').update(String(name), 'utf-8').digest() }));
            const id = generateMessageTag();
            await query({ tag: 'message', attrs: { to: assertNewsletterJid(jid), id, type: 'poll', server_id: toNewsletterServerId(parentServerId) }, content: [{ tag: 'meta', attrs: { polltype: 'vote' } }, { tag: 'votes', attrs: {}, content: votes }] });
            return { id };
        },
        newsletterUpdateReactions: async (jid, setting) => {
            const s = String(setting || '').toUpperCase();
            if (!REACTION_SETTINGS.has(s)) throw new TypeError(`reaction setting must be one of ${[...REACTION_SETTINGS].join(', ')}`);
            return mex({ newsletter_id: assertNewsletterJid(jid), updates: { settings: { reaction_codes: { value: s } } } }, '24250201037901610', 'xwa2_newsletter_update');
        },

        updateTextStatus: (text, o = {}) => {
            const input = { text: text === '' ? null : text ?? null, ephemeral_duration_sec: o.ephemeralDurationSec ?? 0 };
            if (o.emoji) input.emoji = { content: o.emoji };
            return mex({ input }, Q.UPDATE_TEXT_STATUS, 'xwa2_update_text_status');
        },
        fetchTextStatus: (jids) => mex({ input: (Array.isArray(jids) ? jids : [jids]).map((jid) => ({ jid: jidNormalizedUser(jid) })) }, Q.TEXT_STATUS_LIST, 'xwa2_text_status_list'),
        fetchAbout: async (jid) => {
            const { user } = jidDecode(jidNormalizedUser(jid)) || {};
            if (!user) throw new Boom('Invalid user jid', { statusCode: 400 });
            const response = await mex({ user: { user_id: user } }, Q.ABOUT_STATUS, 'xwa2_users_updates_since');
            const updates = Array.isArray(response) ? response[0]?.updates : undefined;
            return { jid: jidNormalizedUser(jid), status: updates?.[0]?.text ?? null, response };
        },
    };
};
