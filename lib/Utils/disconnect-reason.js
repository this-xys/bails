import { DisconnectReason } from '../Types/index.js';
const REASON_BY_CODE = new Map([
    [DisconnectReason.loggedOut, 'logged-out'],
    [DisconnectReason.forbidden, 'forbidden'],
    [DisconnectReason.multideviceMismatch, 'multi-device-mismatch'],
    [DisconnectReason.connectionClosed, 'connection-closed'],
    [DisconnectReason.connectionReplaced, 'connection-replaced'],
    [DisconnectReason.timedOut, 'timed-out'],
    [DisconnectReason.badSession, 'bad-session'],
    [DisconnectReason.restartRequired, 'restart-required'],
    [DisconnectReason.unavailableService, 'unavailable-service'],
    [429, 'rate-limited']
]);
export const mapDisconnectReason = (code) => {
    if (code === undefined || code === null) {
        return 'connection-lost';
    }
    return REASON_BY_CODE.get(code) ?? 'unknown';
};
export const isFatalDisconnect = (reason) => reason === 'logged-out' || reason === 'forbidden' || reason === 'multi-device-mismatch';
export const isRateLimited = (reason) => reason === 'rate-limited';
export const shouldClearAuth = (reason) => isFatalDisconnect(reason) || reason === 'bad-session';
export const shouldReconnect = (reason) => !isFatalDisconnect(reason);
export const getDisconnectInfo = (input) => {
    const code = typeof input === 'number'
        ? input
        : input?.error?.output?.statusCode ?? input?.output?.statusCode ?? input?.statusCode;
    const reason = mapDisconnectReason(code);
    return { code, reason, fatal: isFatalDisconnect(reason), clearAuth: shouldClearAuth(reason), reconnect: shouldReconnect(reason), rateLimited: isRateLimited(reason) };
};
