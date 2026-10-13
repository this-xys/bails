import { Boom } from "@hapi/boom";
import { jidDecode } from "../WABinary/index.js";
import { getStream, toBuffer } from "./messages-media.js";
export const getPhoneNumber = async (sock, jid) => {
    if (typeof jid !== 'string' || !jid.includes('@')) {
        throw new Boom('getPhoneNumber(jid) requires a JID string', { statusCode: 400 });
    }
    let decoded;
    try {
        decoded = jidDecode(jid);
    }
    catch {
        throw new Boom(`getPhoneNumber: invalid JID ${jid}`, { statusCode: 400 });
    }
    const { user, server } = decoded;
    if (server === 's.whatsapp.net') {
        return user;
    }
    if (server === 'lid') {
        const store = sock?.signalRepository?.lidMapping;
        if (!store || typeof store.getPNForLID !== 'function') {
            throw new Boom('getPhoneNumber: LID resolution needs an active socket', { statusCode: 400 });
        }
        try {
            const pn = await store.getPNForLID(`${user}@lid`);
            return typeof pn === 'string' && pn.includes('@') ? pn.split('@')[0] : null;
        }
        catch {
            return null;
        }
    }
    return null;
};

export const resolveSenderPn = async (sock, webMessage) => {
    const sender = webMessage?.key?.participant || webMessage?.key?.remoteJid;
    if (!sender || typeof sender !== 'string') {
        throw new Boom('resolveSenderPn(msg) needs a message with key.participant/remoteJid', { statusCode: 400 });
    }
    return getPhoneNumber(sock, sender);
};

export const getLidForPhone = async (sock, phone) => {
    const store = sock?.signalRepository?.lidMapping;
    if (!store || typeof store.getLIDForPN !== 'function') {
        throw new Boom('getLidForPhone(sock, ...) requires an active socket', { statusCode: 400 });
    }
    const pn = typeof phone === 'string' && phone.includes('@')
        ? phone
        : `${String(phone || '').replace(/\D/g, '')}@s.whatsapp.net`;
    if (!pn.split('@')[0]) {
        throw new Boom('getLidForPhone(phone) requires a phone number', { statusCode: 400 });
    }
    try {
        return (await store.getLIDForPN(pn)) || null;
    }
    catch {
        return null;
    }
};

export const validateE164 = (raw) => {
    if (typeof raw !== 'string') {
        throw new TypeError(`Invalid E.164 number: ${String(raw)}`);
    }
    let num = raw.trim();
    if (num.startsWith('+')) {
        num = num.slice(1);
    }
    if (!/^[1-9][0-9]{6,14}$/.test(num)) {
        throw new Error(`Invalid E.164 number: ${raw}`);
    }
    return `+${num}`;
};

export const jidToPhone = (jid) => {
    const match = typeof jid === 'string' ? jid.match(/^(\d+)(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/) : null;
    return match ? match[1] : '';
};

export const phoneToJid = (phone, isGroup = false) => {
    const digits = String(phone ?? '').replace(/[^0-9]/g, '');
    if (!digits) {
        throw new Error(`Cannot build a JID from "${phone}"`);
    }
    return `${digits}@${isGroup ? 'g.us' : 's.whatsapp.net'}`;
};

export const USERNAME_MIN_LENGTH = 3;

export const USERNAME_MAX_LENGTH = 35;

export const USERNAME_PIN_LENGTH = 4;

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

const DIGITS = '0123456789';

const LETTER_SET = new Set(LETTERS.split(''));

const ALLOWED_SET = new Set([...LETTERS.split(''), ...DIGITS.split(''), '_', '.']);

const RESERVED_SUFFIXES = ['.com', '.org', '.net', '.int', '.edu', '.gov', '.mil', '.arpa', '.html', '.htm', '.txt', '.xml'];

const RESERVED_WORDS = ['whatsapp', 'instagram', 'facebook', 'oculus'];

const PIN_PATTERN = /^[0-9]{4}$/;

export const UsernameValidationError = {
    INVALID_CHARACTER: 'INVALID_CHARACTER',
    INVALID_LENGTH: 'INVALID_LENGTH',
    INVALID_NO_LETTERS: 'INVALID_NO_LETTERS',
    INVALID_PERIODS: 'INVALID_PERIODS',
    INVALID_DOMAIN_SUFFIX: 'INVALID_DOMAIN_SUFFIX',
    INVALID_WWW_PREFIX: 'INVALID_WWW_PREFIX',
    INVALID_WORD: 'INVALID_WORD'
};

export const stripUsernamePrefix = (username) => {
    return typeof username === 'string' && username.startsWith('@') ? username.slice(1) : username;
};

export const displayUsername = (username) => {
    return '@' + stripUsernamePrefix(username);
};

export const validateUsername = (username) => {
    const value = stripUsernamePrefix(username);
    if (typeof value !== 'string') {
        return { isValid: false, errorType: UsernameValidationError.INVALID_CHARACTER };
    }
    const characters = Array.from(value);
    if (!characters.every(character => ALLOWED_SET.has(character))) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_CHARACTER };
    }
    if (value.length < USERNAME_MIN_LENGTH || value.length > USERNAME_MAX_LENGTH) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_LENGTH };
    }
    if (!characters.some(character => LETTER_SET.has(character))) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_NO_LETTERS };
    }
    if (value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_PERIODS };
    }
    const lowered = value.toLowerCase();
    if (lowered.startsWith('www.')) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_WWW_PREFIX };
    }
    if (RESERVED_SUFFIXES.some(suffix => lowered.endsWith(suffix))) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_DOMAIN_SUFFIX };
    }
    if (RESERVED_WORDS.some(word => lowered.includes(word))) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_WORD };
    }
    return { isValid: true };
};

export const isUsernamePin = (pin) => {
    return typeof pin === 'string' && PIN_PATTERN.test(pin);
};

export const DEFAULT_TEXT_PART_LENGTH = 4000;

export const splitText = (text, maxLen = DEFAULT_TEXT_PART_LENGTH) => {
    const limit = Number.isFinite(maxLen) && maxLen >= 2 ? Math.floor(maxLen) : DEFAULT_TEXT_PART_LENGTH;
    const out = [];
    let rest = String(text ?? '');
    while (rest.length > limit) {
        let cut = rest.lastIndexOf('\n', limit);
        if (cut < limit * 0.5) {
            cut = rest.lastIndexOf(' ', limit);
        }
        if (cut < limit * 0.5) {
            cut = limit;
            const prev = rest.charCodeAt(cut - 1);
            if (prev >= 0xd800 && prev <= 0xdbff) {
                cut -= 1;
            }
        }
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) {
        out.push(rest);
    }
    return out.filter(Boolean);
};

export const whatsappify = (text) => {
    if (typeof text !== 'string' || !text) {
        return text;
    }
    const stash = [];
    const hold = (m) => `\u0000${stash.push(m) - 1}\u0000`;
    let t = text.replace(/```[\s\S]*?```/g, hold).replace(/`[^`\n]+`/g, hold);
    for (let i = 0; i < 3; i++) {
        t = t.replace(/\*\*\*([^*\n]+)\*\*\*/g, '*$1*');
        t = t.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
        t = t.replace(/__([^_\n]+)__/g, '*$1*');
    }
    t = t.replace(/_{2,}([^_\n]+)_{2,}/g, '_$1_');
    t = t.replace(/~~([^~\n]+)~~/g, '~$1~');
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
    t = t.replace(/\*{3,}/g, '*').replace(/_{3,}/g, '_');
    t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
    return t.trim();
};

export const sendLongText = async (sock, jid, text, { quoted, format = true, maxLen = DEFAULT_TEXT_PART_LENGTH, delayMs = 250 } = {}) => {
    if (!sock || typeof sock.sendMessage !== 'function') {
        throw new TypeError('sendLongText(sock, ...) requires a socket with sendMessage');
    }
    const body = format ? whatsappify(String(text ?? '')) : String(text ?? '');
    const parts = splitText(body, maxLen);
    const ids = [];
    for (let i = 0; i < parts.length; i++) {
        try {
            const result = await sock.sendMessage(jid, { text: parts[i] }, quoted ? { quoted } : undefined);
            if (result?.key?.id) {
                ids.push(result.key.id);
            }
        }
        catch (error) {
            return { ok: false, ids, error };
        }
        if (delayMs > 0 && i < parts.length - 1) {
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    return { ok: true, ids };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chains = new Map();

const enqueue = (jid, fn) => {
    const prev = chains.get(jid) || Promise.resolve();
    const next = prev.catch(() => { }).then(fn);
    chains.set(jid, next);
    next.finally(() => {
        if (chains.get(jid) === next) {
            chains.delete(jid);
        }
    });
    return next;
};

const extractText = (content) => {
    if (!content || typeof content !== 'object') {
        return '';
    }
    return content.text || content.caption || '';
};

const computeDelayMs = (text, { wpm, minDelayMs, maxDelayMs, jitter }) => {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const natural = words <= 0 ? minDelayMs : (words / Math.max(1, wpm)) * 60000;
    const clamped = Math.min(Math.max(natural, minDelayMs), maxDelayMs);
    const wobble = 1 + (Math.random() * 2 - 1) * Math.max(0, Math.min(1, jitter));
    return Math.round(clamped * wobble);
};

export const sendHumanized = async (sock, jid, content, { wpm = 200, minDelayMs = 900, maxDelayMs = 12000, jitter = 0.25, typing = true, queue = true } = {}, sendOptions = {}) => {
    if (!sock || typeof sock.sendMessage !== 'function') {
        throw new Boom('sendHumanized(sock, ...) requires an active Baileys socket', { statusCode: 400 });
    }
    const run = async () => {
        if (typing && typeof sock.sendPresenceUpdate === 'function') {
            try {
                if (typeof sock.presenceSubscribe === 'function') {
                    await sock.presenceSubscribe(jid).catch(() => { });
                }
                await sock.sendPresenceUpdate('composing', jid);
            }
            catch { }
        }
        await sleep(computeDelayMs(extractText(content), { wpm, minDelayMs, maxDelayMs, jitter }));
        try {
            return await sock.sendMessage(jid, content, sendOptions);
        }
        finally {
            if (typing && typeof sock.sendPresenceUpdate === 'function') {
                try {
                    await sock.sendPresenceUpdate('paused', jid);
                }
                catch { }
            }
        }
    };
    return queue ? enqueue(jid, run) : run();
};

export const MAX_VOICE_NOTE_BYTES = 64 * 1024 * 1024;

export const isOggBuffer = (buf) => Buffer.isBuffer(buf) && buf.length > 4 && buf.subarray(0, 4).toString('latin1') === 'OggS';

const resolveAudioBuffer = async (audio) => {
    if (Buffer.isBuffer(audio)) {
        return audio;
    }
    if (audio == null || (typeof audio !== 'string' && typeof audio !== 'object')) {
        throw new Boom('voice note audio must be a Buffer, a file path, a URL, { url } or a stream', { statusCode: 400 });
    }
    const input = typeof audio === 'string' ? { url: audio } : audio;
    let buf;
    try {
        const { stream } = await getStream(input, { maxContentLength: MAX_VOICE_NOTE_BYTES });
        buf = await toBuffer(stream);
    }
    catch (err) {
        throw new Boom(`voice note: cannot read audio (${err?.message || err})`, { statusCode: 400 });
    }
    if (buf.length > MAX_VOICE_NOTE_BYTES) {
        throw new Boom(`voice note: audio exceeds ${MAX_VOICE_NOTE_BYTES} bytes`, { statusCode: 413 });
    }
    return buf;
};

export const buildVoiceNoteContent = async (audio, { convert = true, waveform, seconds, ...passthrough } = {}) => {
    let buf = await resolveAudioBuffer(audio);
    if (convert && !isOggBuffer(buf)) {
        const { MediaManager } = await import('../Framework/MediaManager.js');
        buf = await MediaManager.convertToVoiceNote(buf);
    }
    return { audio: buf, ptt: true, mimetype: 'audio/ogg; codecs=opus', waveform, seconds, ...passthrough };
};

export const sendVoiceNote = async (sock, jid, audio, { convert, waveform, seconds, ...sendOptions } = {}) => {
    if (!sock || typeof sock.sendMessage !== 'function') {
        throw new Boom('sendVoiceNote(sock, ...) requires an active Baileys socket', { statusCode: 400 });
    }
    return sock.sendMessage(jid, await buildVoiceNoteContent(audio, { convert, waveform, seconds }), sendOptions);
};

const participantJids = (participants) => (participants || [])
    .map((p) => (typeof p === 'string' ? p : p?.id))
    .filter((j) => typeof j === 'string' && j.includes('@'));

export const buildTagContent = (participants, text = '', { hide = false } = {}) => {
    const mentions = participantJids(participants);
    if (!mentions.length) {
        throw new Boom('tagAll: no participants to mention', { statusCode: 400 });
    }
    const body = hide
        ? String(text || '')
        : `${String(text || '')}\n${mentions.map((j) => `@${j.split('@')[0]}`).join(' ')}`.trim();
    return { text: body, mentions };
};

const assertGroupSock = (sock, jid) => {
    if (!sock || typeof sock.sendMessage !== 'function' || typeof sock.groupMetadata !== 'function') {
        throw new Boom('tagAll(sock, ...) requires an active Baileys socket with groupMetadata', { statusCode: 400 });
    }
    if (typeof jid !== 'string' || !jid.endsWith('@g.us')) {
        throw new Boom('tagAll only works in groups (@g.us)', { statusCode: 400 });
    }
};

export const tagAll = async (sock, jid, text = '', options = {}) => {
    assertGroupSock(sock, jid);
    const meta = await sock.groupMetadata(jid);
    return sock.sendMessage(jid, buildTagContent(meta.participants, text), options);
};

export const hideTag = async (sock, jid, text = '', options = {}) => {
    assertGroupSock(sock, jid);
    const meta = await sock.groupMetadata(jid);
    return sock.sendMessage(jid, buildTagContent(meta.participants, text, { hide: true }), options);
};

const MENTION_RE = /(?<![\w.])@(\d{5,20})(?![\w]|\.\w)/g;

const INVITE_RE = /(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([0-9A-Za-z]{16,32})/;

export const parseMentions = (text) => {
    if (typeof text !== 'string' || !text) {
        return [];
    }
    const seen = new Set();
    const out = [];
    for (const m of text.matchAll(MENTION_RE)) {
        const jid = `${m[1]}@s.whatsapp.net`;
        if (!seen.has(jid)) {
            seen.add(jid);
            out.push(jid);
        }
    }
    return out;
};

export const extractGroupInviteCode = (link) => {
    if (typeof link !== 'string' || !link) {
        return null;
    }
    const m = link.match(INVITE_RE);
    return m ? m[1] : null;
};

export const joinGroupViaLink = async (sock, linkOrCode) => {
    const code = extractGroupInviteCode(linkOrCode) ?? (/^[0-9A-Za-z]{16,32}$/.test(String(linkOrCode ?? '')) ? String(linkOrCode) : null);
    if (!code) {
        throw new Error(`joinGroupViaLink: no invite code found in ${JSON.stringify(linkOrCode)}`);
    }
    return sock.groupAcceptInvite(code);
};
