export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const fetchWithTimeout = (url, init = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([init.signal, timeoutSignal])
        : (init.signal ?? timeoutSignal);
    return fetch(url, { ...init, signal });
};
