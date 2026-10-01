const DEFAULT_BASE_MS = 2000;
const DEFAULT_CAP_MS = 15 * 60 * 1000;
const MIN_DELAY_MS = 500;
export function computeReconnectDelay(attempts, { baseMs = DEFAULT_BASE_MS, capMs = DEFAULT_CAP_MS } = {}) {
    const n = Math.min(Math.max(Number(attempts) || 0, 0), 20);
    const raw = Math.min(baseMs * Math.pow(2, n), capMs);
    let delay = raw / 2 + Math.random() * raw;
    if (delay > capMs) {
        delay = capMs + (Math.random() * 60000 - 30000);
    }
    return Math.max(MIN_DELAY_MS, Math.round(delay));
}
export function createReconnectBackoff(opts = {}) {
    let attempts = 0;
    return {
        next() {
            return computeReconnectDelay(attempts++, opts);
        },
        reset() {
            attempts = 0;
        },
        get attempts() {
            return attempts;
        }
    };
}
