import { Boom } from "@hapi/boom";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fetchWithTimeout } from "./fetch-timeout.js";
export const MINI_APP_DEFAULT_BUTTON_TEXT = '🚀 Open App';

const MAX_THUMBNAIL_BYTES = 512 * 1024;

const resolveThumbnail = async (thumbnail) => {
    if (!thumbnail) {
        return undefined;
    }
    if (Buffer.isBuffer(thumbnail)) {
        return thumbnail;
    }
    if (typeof thumbnail === 'string') {
        let res;
        try {
            res = await fetchWithTimeout(thumbnail);
        }
        catch (err) {
            throw new Boom(`miniApp.thumbnail: failed to fetch ${thumbnail} (${err?.message || err})`, { statusCode: 400 });
        }
        if (!res.ok) {
            throw new Boom(`miniApp.thumbnail: fetch failed with HTTP ${res.status}`, { statusCode: 400 });
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length || buf.length > MAX_THUMBNAIL_BYTES) {
            throw new Boom(`miniApp.thumbnail: must be 1–${MAX_THUMBNAIL_BYTES} bytes`, { statusCode: 400 });
        }
        return buf;
    }
    throw new Boom('miniApp.thumbnail must be a Buffer or a URL string', { statusCode: 400 });
};

const normalizeFlowConfig = (flow) => {
    if (!flow) {
        return undefined;
    }
    const cfg = typeof flow === 'string' ? { id: flow } : flow;
    if (!cfg || typeof cfg !== 'object' || !cfg.id || typeof cfg.id !== 'string') {
        throw new Boom('miniApp.flow.id is required (your published WhatsApp Flow ID)', { statusCode: 400 });
    }
    return cfg;
};

const appendUrlParams = (link, params) => {
    if (!params || typeof params !== 'object' || !Object.keys(params).length) {
        return link;
    }
    let u;
    try {
        u = new URL(link);
    }
    catch {
        throw new Boom(`miniApp.url is not a valid URL: ${link}`, { statusCode: 400 });
    }
    for (const [k, v] of Object.entries(params)) {
        u.searchParams.set(k, String(v));
    }
    return u.toString();
};

export const buildMiniAppContent = async ({ title, body, text, url, appUrl, flow, params, buttonText, buttons = [], footer, thumbnail, useWebview = true, onThumbnailError, ...passthrough } = {}) => {
    const link = url || appUrl;
    const flowCfg = normalizeFlowConfig(flow);
    if ((!link || typeof link !== 'string') && !flowCfg) {
        throw new Boom('miniApp needs either `url` (webview app) or `flow` (WhatsApp Flow) — or both', { statusCode: 400 });
    }
    const mainText = body || text;
    if (!mainText || typeof mainText !== 'string') {
        throw new Boom('miniApp.body (or text) is required', { statusCode: 400 });
    }
    const finalUrl = link ? appendUrlParams(link, params) : undefined;
    let thumb;
    try {
        thumb = await resolveThumbnail(thumbnail);
    }
    catch (err) {
        if (typeof onThumbnailError === 'function') {
            try {
                onThumbnailError(err);
            }
            catch { }
        }
    }
    const cardTitle = title || 'Mini App';
    const nativeFlow = [
        ...(finalUrl ? [{ buttonText: buttonText || MINI_APP_DEFAULT_BUTTON_TEXT, url: finalUrl, useWebview }] : []),
        ...(flowCfg ? [{ buttonText: flowCfg.cta || '📝 Open', flow: flowCfg }] : []),
        ...buttons
    ];
    const content = {
        text: mainText,
        footer: footer ?? cardTitle,
        nativeFlow,
        ...passthrough
    };
    if (finalUrl) {
        const externalAdReply = {
            title: cardTitle,
            body: mainText.slice(0, 120),
            url: finalUrl,
            mediaType: 1,
            largeThumbnail: !!thumb
        };
        if (thumb) {
            externalAdReply.thumbnail = thumb;
        }
        content.externalAdReply = content.externalAdReply || externalAdReply;
    }
    return content;
};

export const sendMiniApp = async (sock, jid, miniApp, options = {}) => {
    if (!sock || typeof sock.sendMessage !== 'function') {
        throw new Boom('sendMiniApp(sock, ...) requires an active Baileys socket', { statusCode: 400 });
    }
    return sock.sendMessage(jid, await buildMiniAppContent(miniApp), options);
};

export const createMiniAppLink = (baseUrl, params = {}, { secret } = {}) => {
    let u;
    try {
        u = new URL(baseUrl);
    }
    catch {
        throw new Boom(`miniApp.url is not a valid URL: ${baseUrl}`, { statusCode: 400 });
    }
    for (const [k, v] of Object.entries(params || {})) {
        u.searchParams.set(k, String(v));
    }
    if (secret) {
        const payload = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
        u.searchParams.set('sig', createHmac('sha256', secret).update(payload).digest('hex'));
    }
    return u.toString();
};

export const parseMiniAppParams = (link, { secret } = {}) => {
    let u;
    try {
        u = new URL(link);
    }
    catch {
        throw new Boom(`miniApp.url is not a valid URL: ${link}`, { statusCode: 400 });
    }
    const out = {};
    for (const [k, v] of u.searchParams.entries()) {
        if (k !== 'sig') {
            out[k] = v;
        }
    }
    if (secret) {
        const sig = u.searchParams.get('sig') || '';
        const payload = Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
        const expect = createHmac('sha256', secret).update(payload).digest('hex');
        const ok = sig.length === expect.length && (() => { try { return timingSafeEqual(Buffer.from(sig), Buffer.from(expect)); } catch { return false; } })();
        if (!ok) {
            throw new Boom('miniApp.params: invalid signature', { statusCode: 403 });
        }
    }
    return out;
};

export const buildFlowDataExchange = (action, data = {}, { version = '3.0', token } = {}) => {
    if (!action || typeof action !== 'string') {
        throw new Boom('flow action is required (e.g. navigate, data_exchange)', { statusCode: 400 });
    }
    return { version, action, data, ...(token ? { token } : {}) };
};

export const HTML_APP_MESSAGE_CEILING = 1024 * 1024;

export const HTML_APP_BYTE_BUDGET = 960 * 1024;

export const HTML_APP_BYTE_LIMIT = HTML_APP_BYTE_BUDGET;

export const wireBytes = (html) => Buffer.byteLength(
    JSON.stringify(String(html)).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')),
    'utf-8'
);

const STORAGE_APIS = ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'caches'];

const strip = (html) => html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/data:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]*;base64,[A-Za-z0-9+/=]+/gi, 'data:');

const hasVisibilityGuard = (source) => /document\.(hidden|visibilityState)|visibilitychange|IntersectionObserver|cancelAnimationFrame|clearInterval/.test(source);

export const checkHtmlApp = (html, { height, maxBytes = HTML_APP_BYTE_BUDGET } = {}) => {
    if (typeof html !== 'string') {
        throw new TypeError('checkHtmlApp requires an HTML string');
    }

    const bytes = Buffer.byteLength(html, 'utf-8');
    const wire = wireBytes(html);
    const source = strip(html);
    const problems = [];
    const warnings = [];

    if (wire > maxBytes) {
        problems.push(`${Math.round(wire / 1024)}KB on the wire, over the ${Math.round(maxBytes / 1024)}KB budget — a message past ${Math.round(HTML_APP_MESSAGE_CEILING / 1024)}KB is dropped by the receiving client, which logs it and renders nothing, so this one would arrive as silence`);
    }

    if (wire > bytes * 1.15) {
        warnings.push(`escaping inflates this page from ${Math.round(bytes / 1024)}KB to ${Math.round(wire / 1024)}KB — every non-ASCII character is rewritten as \\uXXXX, so emoji and accents cost up to three times their size`);
    }

    const remote = [...source.matchAll(/\b(?:src|href)\s*=\s*["']?(https?:)?\/\//gi)];
    if (remote.length) {
        problems.push(`${remote.length} remote subresource${remote.length === 1 ? '' : 's'} — the page runs in an opaque origin with no network, so every one of them fails silently; embed as data: URIs instead`);
    }

    if (/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new\s+EventSource/.test(source)) {
        problems.push('a call over the HTTP stack — fetch, XHR, sendBeacon and EventSource were measured dead in this WebView, and no securitypolicyviolation fires to tell the page why');
    }

    const socket = /new\s+WebSocket/.test(source);
    const peer = /RTCPeerConnection/.test(source);
    if (socket && !/wss:\/\//.test(source)) {
        problems.push('a WebSocket on something other than wss:// — the page is not a secure context, and a cleartext ws:// endpoint sends the room and every move in the open');
    }
    if ((socket || peer) && !hasVisibilityGuard(source)) {
        warnings.push('a live connection with nothing closing it — the bubble outlives the screen, so close or pause the socket on visibilitychange');
    }

    const storage = STORAGE_APIS.filter(api => source.includes(api));
    if (storage.length) {
        problems.push(`${storage.join(', ')} — every storage API throws SecurityError in an opaque origin, so the catch branch always runs`);
    }

    if (/crypto\.subtle/.test(source)) {
        problems.push('crypto.subtle needs a secure context and this page is not one');
    }

    const rafLoop = /requestAnimationFrame/.test(source);
    const interval = /setInterval\s*\(/.test(source);
    if ((rafLoop || interval) && !hasVisibilityGuard(source)) {
        problems.push('an animation or timer loop with nothing to stop it — the bubble stays alive while the chat scrolls, so it keeps burning CPU and battery off-screen; gate it on document.hidden or an IntersectionObserver');
    }

    const reportsHeight = /AndroidBridge\s*\.\s*updateSize/.test(source);
    if (height === undefined && !reportsHeight) {
        const pinned = /(?:html|body)[^{}]*\{[^{}]*height\s*:\s*\d/i.test(source);
        if (!pinned) {
            warnings.push('no height settled — pass height or autoHeight to sendHtmlApp, or call AndroidBridge.updateSize yourself, or the host and the page measure each other and the card shudders');
        }
    }

    if (/aspect-ratio\s*:/i.test(source)) {
        warnings.push('aspect-ratio makes the height depend on the width, which is the layout chase the host cannot settle');
    }

    if (/<canvas[^>]*style\s*=\s*["'][^"']*height\s*:\s*auto/i.test(source)) {
        warnings.push('a canvas at height:auto resizes with the bubble; give it pixel dimensions');
    }

    const dataUris = [...html.matchAll(/data:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]*;base64,([A-Za-z0-9+/=]+)/gi)];
    const embedded = dataUris.reduce((total, match) => total + match[1].length, 0);
    if (embedded > bytes * 0.6 && dataUris.length) {
        warnings.push(`${Math.round(embedded / 1024)}KB of the page is embedded media — shrink it before the byte budget forces you to`);
    }

    return { ok: problems.length === 0, bytes, wireBytes: wire, embeddedBytes: embedded, problems, warnings };
};

const escapeForScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

export const htmlMultiplayerPrelude = ({ url, room, seat, reconnectMs = 1500, maxReconnectMs = 15000 }) => {
    if (typeof url !== 'string' || !url.startsWith('wss://')) {
        throw new TypeError('htmlMultiplayerPrelude requires a wss:// url, since the page is not a secure context');
    }
    if (typeof room !== 'string' || room.trim() === '') {
        throw new TypeError('htmlMultiplayerPrelude requires a non-empty room id');
    }
    const config = escapeForScript({ url, room, seat: seat ?? null, reconnectMs, maxReconnectMs });
    return `<script>
(function () {
  var cfg = ${config};
  var listeners = [];
  var queue = [];
  var sock = null;
  var backoff = cfg.reconnectMs;
  var closed = false;

  var api = {
    room: cfg.room,
    seat: cfg.seat,
    connected: false,
    send: function (payload) {
      var frame = JSON.stringify({ room: cfg.room, seat: cfg.seat, data: payload });
      if (sock && sock.readyState === 1) sock.send(frame); else queue.push(frame);
    },
    on: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn }) } },
    close: function () { closed = true; if (sock) try { sock.close() } catch (e) {} }
  };

  function emit(kind, detail) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](kind, detail) } catch (e) {}
    }
  }

  function open() {
    if (closed || (sock && (sock.readyState === 0 || sock.readyState === 1))) return;
    try { sock = new WebSocket(cfg.url) } catch (e) { emit('error', e); return schedule() }

    sock.onopen = function () {
      backoff = cfg.reconnectMs;
      api.connected = true;
      sock.send(JSON.stringify({ join: cfg.room, seat: cfg.seat }));
      while (queue.length && sock.readyState === 1) sock.send(queue.shift());
      emit('open', null);
    };
    sock.onmessage = function (event) {
      var parsed = event.data;
      try { parsed = JSON.parse(event.data) } catch (e) {}
      emit('message', parsed);
    };
    sock.onclose = function (event) {
      api.connected = false;
      emit('close', event.code);
      schedule();
    };
    sock.onerror = function () { api.connected = false };
  }

  function schedule() {
    if (closed || document.hidden) return;
    setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, cfg.maxReconnectMs);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (sock) try { sock.close() } catch (e) {}
    } else if (!closed) {
      backoff = cfg.reconnectMs;
      open();
    }
  });

  window.addEventListener('pagehide', function () { api.close() });

  window.room = api;
  open();
})();
</script>
`;
};

export const withHtmlMultiplayer = (html, options) => {
    if (typeof html !== 'string' || html.trim() === '') {
        throw new TypeError('withHtmlMultiplayer requires an HTML string');
    }
    return htmlMultiplayerPrelude(options) + html;
};
