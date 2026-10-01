import { DisconnectReason } from '../Types/index.js';
import { isFatalDisconnect, mapDisconnectReason } from './disconnect-reason.js';
import defaultLogger from './logger.js';

export const autoReconnect = (socketFactory, options = {}) => {
    const {
        onSocket,
        onOpen,
        onLoggedOut,
        onFatal,
        maxAttempts = Infinity,
        baseDelayMs = 1000,
        maxDelayMs = 30000,
        jitter = 0.25,
        logger = defaultLogger.child({ module: 'auto-reconnect' }),
    } = options;

    let sock = null;
    let attempts = 0;
    let timer = null;
    let stopped = false;
    let started = false;

    const delayFor = (attempt) => {
        const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
        const wiggle = exp * jitter * (Math.random() * 2 - 1);
        return Math.max(0, Math.round(exp + wiggle));
    };

    const scheduleRestart = (delay) => {
        if (stopped || timer) {
            return;
        }
        timer = setTimeout(() => {
            timer = null;
            connect().catch((err) => logger.error({ err }, 'reconnect attempt failed'));
        }, delay);
    };

    const connect = async () => {
        if (stopped) {
            return null;
        }
        const previous = sock;
        if (previous) {
            try {
                await previous.end?.();
            }
            catch { }
        }
        let current;
        try {
            current = await socketFactory();
        }
        catch (err) {
            attempts += 1;
            if (attempts > maxAttempts) {
                logger.error({ err, attempts: attempts - 1 }, 'socket factory failed and max attempts reached — giving up');
                return null;
            }
            const delay = delayFor(attempts);
            logger.warn({ err, attempt: attempts, delay }, 'socket factory failed — retrying');
            scheduleRestart(delay);
            return null;
        }
        sock = current;
        let closeHandled = false;
        try {
            onSocket?.(current);
        }
        catch (err) {
            logger.warn({ err }, 'onSocket handler threw');
        }
        current.ev.on('connection.update', (update) => {
            if (sock !== current) {
                return;
            }
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                attempts = 0;
                try {
                    onOpen?.(current);
                }
                catch (err) {
                    logger.warn({ err }, 'onOpen handler threw');
                }
                return;
            }
            if (connection !== 'close' || stopped || closeHandled) {
                return;
            }
            closeHandled = true;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
                logger.info('session logged out — not reconnecting');
                try {
                    onLoggedOut?.(lastDisconnect?.error);
                }
                catch (err) {
                    logger.warn({ err }, 'onLoggedOut handler threw');
                }
                return;
            }
            if (isFatalDisconnect(mapDisconnectReason(statusCode))) {
                logger.warn({ statusCode }, 'fatal disconnect — not reconnecting');
                try {
                    onFatal?.(lastDisconnect?.error, statusCode);
                }
                catch (err) {
                    logger.warn({ err }, 'onFatal handler threw');
                }
                return;
            }
            attempts += 1;
            if (attempts > maxAttempts) {
                logger.warn({ attempts: attempts - 1 }, 'max reconnect attempts reached — giving up');
                return;
            }
            const immediate = statusCode === DisconnectReason.restartRequired && attempts === 1;
            const delay = immediate ? 0 : delayFor(attempts);
            logger.info({ attempt: attempts, delay, statusCode }, 'scheduling reconnect');
            scheduleRestart(delay);
        });
        return current;
    };

    const start = async () => {
        if (started && !stopped) {
            logger.warn('start() called while already running — returning the live socket');
            return sock;
        }
        stopped = false;
        started = true;
        attempts = 0;
        return connect();
    };

    const stop = async () => {
        stopped = true;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        try {
            await sock?.end?.();
        }
        catch { }
    };

    return {
        start,
        stop,
        get socket() {
            return sock;
        },
        get attempts() {
            return attempts;
        },
    };
};
