import { S_WHATSAPP_NET } from '../WABinary/index.js';
const DEFAULT_IDLE_THRESHOLD_MS = 600000;
const DEFAULT_CHECK_INTERVAL_MS = 120000;
export function setupConnectionWatchdog(sock, { idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS, checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS, probe = 'ping' } = {}) {
    let lastActivity = Date.now();
    let checking = false;
    let stopped = false;
    const onActivity = () => {
        lastActivity = Date.now();
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        sock.ev.off('messages.upsert', onActivity);
        sock.ev.off('connection.update', onConnectionUpdate);
    };
    const onConnectionUpdate = ({ connection }) => {
        if (connection === 'open') onActivity();
        if (connection === 'close') stop();
    };
    const killSocket = (reason) => {
        sock.logger?.warn?.(`[watchdog] ${reason} — ending socket to force a reconnect`);
        Promise.resolve(sock.end(new Error(`connection-watchdog: ${reason}`))).catch(() => { });
    };
    const timer = setInterval(async () => {
        if (checking || stopped) return;
        const idleMs = Date.now() - lastActivity;
        if (idleMs < idleThresholdMs) return;
        checking = true;
        try {
            if (!sock.ws?.isOpen) {
                killSocket(`websocket not open after ${Math.floor(idleMs / 1000)}s idle`);
                return;
            }
            if (probe === 'presence') {
                await sock.sendPresenceUpdate('available');
            } else {
                await sock.query({
                    tag: 'iq',
                    attrs: { id: sock.generateMessageTag(), to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:p' },
                    content: [{ tag: 'ping', attrs: {} }]
                });
            }
            lastActivity = Date.now();
        } catch (e) {
            killSocket(`${probe} probe failed (${e?.message ?? e})`);
        } finally {
            checking = false;
        }
    }, checkIntervalMs);
    timer.unref?.();
    sock.ev.on('messages.upsert', onActivity);
    sock.ev.on('connection.update', onConnectionUpdate);
    return stop;
}
