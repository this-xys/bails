import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { generateWAMessage, generateWAMessageFromContent } from './messages.js';
import { unixTimestampSeconds } from './generics.js';
const DEFAULT_ME = '628000000000@s.whatsapp.net';
const genId = () => 'MOCK' + randomBytes(8).toString('hex').toUpperCase();
const stubUpload = async () => ({
    mediaUrl: 'https://mock.local/media',
    directPath: '/mock/direct-path',
    handle: undefined
});
const stubMediaOptions = {
    upload: stubUpload,
    mediaCache: undefined,
    options: {}
};
export const createMockSocket = (options = {}) => {
    const { me = DEFAULT_ME, pushName = 'MockBot', autoConnect = true } = options;
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    const outbox = [];
    const eventLog = [];
    const readReceipts = [];
    const presenceLog = [];
    let connectionState = 'close';
    let waiters = [];
    const ev = {
        on: (event, listener) => { emitter.on(event, listener); return ev; },
        off: (event, listener) => { emitter.off(event, listener); return ev; },
        once: (event, listener) => { emitter.once(event, listener); return ev; },
        removeAllListeners: (event) => { emitter.removeAllListeners(event); return ev; },
        emit: (event, data) => {
            eventLog.push({ event, data });
            return emitter.emit(event, data);
        },
        process: (handler) => {
            const listener = (map) => handler(map);
            emitter.on('event', listener);
            return () => emitter.off('event', listener);
        },
        buffer: () => { },
        flush: () => false,
        isBuffering: () => false
    };
    const settleWaiters = () => {
        if (!waiters.length || !outbox.length) {
            return;
        }
        const pending = waiters;
        waiters = [];
        for (const w of pending) {
            const idx = outbox.findIndex((entry, i) => i >= w.fromIndex && (!w.filter || w.filter(entry)));
            if (idx !== -1) {
                clearTimeout(w.timer);
                w.resolve(outbox[idx]);
            }
            else {
                waiters.push(w);
            }
        }
    };
    const sock = {
        ev,
        user: { id: me, name: pushName },
        authState: { creds: { me: { id: me, name: pushName }, registered: true } },
        type: 'md',
        ws: { readyState: 1, close: () => { } },
        sendMessage: async (jid, content, opts = {}) => {
            if (!jid || typeof jid !== 'string') {
                throw new Error('mock sendMessage: jid must be a string');
            }
            const message = await generateWAMessage(jid, content, {
                userJid: me,
                logger: undefined,
                ...stubMediaOptions,
                ...opts
            });
            message.pushName = pushName;
            message.key.fromMe = true;
            const entry = { jid, content, options: opts, message };
            outbox.push(entry);
            ev.emit('messages.upsert', { messages: [message], type: 'notify' });
            settleWaiters();
            return message;
        },
        readMessages: async (keys) => {
            readReceipts.push(...(keys || []));
        },
        sendPresenceUpdate: async (type, toJid) => {
            presenceLog.push({ type, toJid: toJid ?? null });
        },
        presenceSubscribe: async () => { },
        groupMetadata: async (jid) => ({
            id: jid,
            subject: 'Mock Group',
            owner: me,
            participants: [{ id: me, admin: 'superadmin' }],
            creation: unixTimestampSeconds(new Date())
        }),
        onWhatsApp: async (...jids) => jids.map((jid) => ({
            jid: jid.includes('@') ? jid : `${jid}@s.whatsapp.net`,
            exists: true
        })),
        profilePictureUrl: async () => undefined,
        updateMediaMessage: async (msg) => msg,
        relayMessage: async (jid, content, opts = {}) => {
            const message = generateWAMessageFromContent(jid, content, {
                userJid: me,
                messageId: opts.messageId ?? genId()
            });
            outbox.push({ jid, content, options: opts, message });
            settleWaiters();
            return message.key.id;
        },
        end: () => {
            connectionState = 'close';
            ev.emit('connection.update', { connection: 'close' });
        },
        logout: async () => {
            connectionState = 'close';
            ev.emit('connection.update', { connection: 'close' });
        }
    };
    const receiveMessage = async (msg) => {
        if (!msg?.key?.remoteJid) {
            throw new Error('receiveMessage: msg.key.remoteJid is required');
        }
        ev.emit('messages.upsert', { messages: [msg], type: 'notify' });
        await new Promise((resolve) => setImmediate(resolve));
        return msg;
    };
    const receiveText = async (fromJid, text, opts = {}) => {
        const { groupJid, pushName: senderName = 'Tester', quoted } = opts;
        const remoteJid = groupJid ?? fromJid;
        const msg = {
            key: {
                remoteJid,
                fromMe: false,
                id: genId(),
                ...(groupJid ? { participant: fromJid } : {})
            },
            pushName: senderName,
            messageTimestamp: unixTimestampSeconds(new Date()),
            message: quoted
                ? { extendedTextMessage: { text, contextInfo: { quotedMessage: quoted.message, stanzaId: quoted.key?.id, participant: quoted.key?.participant ?? quoted.key?.remoteJid } } }
                : { conversation: text }
        };
        return receiveMessage(msg);
    };
    const waitForReply = (filter, timeoutMs = 2000) => new Promise((resolve, reject) => {
        const fromIndex = 0;
        const existing = outbox.findIndex((entry) => !filter || filter(entry));
        if (existing !== -1) {
            resolve(outbox[existing]);
            return;
        }
        const timer = setTimeout(() => {
            waiters = waiters.filter((w) => w.timer !== timer);
            reject(new Error(`waitForReply: no matching outgoing message within ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push({ filter, fromIndex, resolve, reject, timer });
    });
    const connect = () => {
        connectionState = 'open';
        ev.emit('connection.update', { connection: 'open' });
    };
    const disconnect = (error) => {
        connectionState = 'close';
        ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } });
    };
    const reset = () => {
        outbox.length = 0;
        eventLog.length = 0;
        readReceipts.length = 0;
        presenceLog.length = 0;
        for (const w of waiters) {
            clearTimeout(w.timer);
            w.reject(new Error('mock reset'));
        }
        waiters = [];
    };
    if (autoConnect) {
        connect();
    }
    return {
        sock,
        outbox,
        eventLog,
        readReceipts,
        presenceLog,
        receiveText,
        receiveMessage,
        waitForReply,
        connect,
        disconnect,
        reset,
        get connectionState() { return connectionState; }
    };
};
