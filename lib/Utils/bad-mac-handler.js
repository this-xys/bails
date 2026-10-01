import fs from 'node:fs/promises';
import path from 'node:path';
const noop = () => { };
const PRESERVE = ['creds.json', 'app-state-sync-key', 'app-state-sync-version'];
export const isBadMacError = (error) => {
    const msg = error?.message || String(error ?? '');
    return msg.includes('Bad MAC') || msg.includes('MAC verification failed');
};
export const isSessionError = (error) => {
    const msg = error?.message || String(error ?? '');
    return msg.includes('Session') || msg.includes('signal protocol') || msg.includes('decrypt') || isBadMacError(error);
};
export class BadMacHandler {
    constructor(options = {}) {
        this.errorCount = 0;
        this.maxRetries = options.maxRetries ?? 5;
        this.resetInterval = options.resetInterval ?? 300000;
        this.lastReset = Date.now();
        this.authFolder = options.authFolder;
        this.logger = options.logger ?? {};
        this.onLimit = options.onLimit;
    }
    isBadMacError(error) {
        return isBadMacError(error);
    }
    isSessionError(error) {
        return isSessionError(error);
    }
    async clearProblematicSessionFiles({ dryRun = false } = {}) {
        if (!this.authFolder) {
            (this.logger.warn ?? noop).call(this.logger, '[bad-mac] authFolder not configured — nothing cleared');
            return [];
        }
        const removed = [];
        try {
            for (const file of await fs.readdir(this.authFolder)) {
                if (PRESERVE.some((p) => file.includes(p))) continue;
                if (!(file.startsWith('session-') || file.includes('sender-key'))) continue;
                const full = path.join(this.authFolder, file);
                if (!(await fs.stat(full)).isFile()) continue;
                if (!dryRun) await fs.unlink(full);
                removed.push(file);
            }
        } catch (err) {
            (this.logger.error ?? noop).call(this.logger, { err }, '[bad-mac] failed to clear session files');
            return removed;
        }
        if (removed.length) (this.logger.warn ?? noop).call(this.logger, `[bad-mac] ${dryRun ? 'would remove' : 'removed'} ${removed.length} session file(s); creds preserved`);
        return removed;
    }
    incrementErrorCount() {
        if (Date.now() - this.lastReset > this.resetInterval) {
            this.resetErrorCount();
        }
        this.errorCount++;
    }
    resetErrorCount() {
        this.errorCount = 0;
        this.lastReset = Date.now();
    }
    hasReachedLimit() {
        return this.errorCount >= this.maxRetries;
    }
    handleError(error, context = 'unknown') {
        if (!isBadMacError(error)) return false;
        this.incrementErrorCount();
        (this.logger.warn ?? noop).call(this.logger, `[bad-mac] ${context}: ${error.message} (${this.errorCount}/${this.maxRetries})`);
        if (this.hasReachedLimit()) this.onLimit?.(this.getStats());
        return true;
    }
    createSafeWrapper(fn, context) {
        return async (...args) => {
            try {
                return await fn(...args);
            } catch (error) {
                if (this.handleError(error, context)) return null;
                throw error;
            }
        };
    }
    getStats() {
        return {
            errorCount: this.errorCount,
            maxRetries: this.maxRetries,
            lastReset: new Date(this.lastReset).toISOString(),
            timeUntilReset: Math.max(0, this.resetInterval - (Date.now() - this.lastReset))
        };
    }
}
