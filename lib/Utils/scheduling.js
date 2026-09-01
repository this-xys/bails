export class MessageScheduler {
  queue=new Map;
  timer=null;
  sendMessage;
  options;
  constructor(sendMessage, options = {}) {
    this.sendMessage = sendMessage;
    this.options = {
      maxQueue: options.maxQueue ?? 1e3,
      checkInterval: options.checkInterval ?? 1e3,
      onSent: options.onSent ?? (() => {}),
      onFailed: options.onFailed ?? (() => {})
    };
  }
  generateId() {
    return `sched_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
  schedule(jid, content, scheduledTime, repeatOptions) {
    if (this.queue.size >= this.options.maxQueue) throw new Error(`Maximum queue size (${this.options.maxQueue}) reached`);
    if (scheduledTime.getTime() <= Date.now()) throw new Error("Scheduled time must be in the future");
    const scheduled = {
      id: this.generateId(),
      jid: jid,
      content: content,
      scheduledTime: scheduledTime,
      createdAt: new Date,
      status: "pending",
      repeatIntervalMs: repeatOptions?.repeatIntervalMs,
      maxRepeats: repeatOptions?.maxRepeats,
      repeatCount: 0
    };
    this.queue.set(scheduled.id, scheduled);
    this.ensureTimerRunning();
    return scheduled;
  }
  scheduleDelay(jid, content, delayMs, repeatOptions) {
    return this.schedule(jid, content, new Date(Date.now() + delayMs), repeatOptions);
  }
  cancel(id) {
    const s = this.queue.get(id);
    if (s?.status === "pending") {
      s.status = "cancelled";
      this.queue.delete(id);
      return true;
    }
    return false;
  }
  cancelForJid(jid) {
    let cancelled = 0;
    for (const [id, s] of this.queue) {
      if (s.jid === jid && s.status === "pending") {
        s.status = "cancelled";
        this.queue.delete(id);
        cancelled++;
      }
    }
    return cancelled;
  }
  getPending() {
    return Array.from(this.queue.values()).filter(s => s.status === "pending");
  }
  get(id) {
    return this.queue.get(id);
  }
  clearAll() {
    const count = this.queue.size;
    this.queue.clear();
    this.stopTimer();
    return count;
  }
  async processQueue() {
    const now = Date.now();
    for (const [id, s] of this.queue) {
      if (s.status !== "pending") continue;
      if (s.scheduledTime.getTime() > now) continue;
      try {
        const message = await this.sendMessage(s.jid, s.content);
        s.messageId = message?.key?.id ?? undefined;
        this.options.onSent(s, message);
        if (s.repeatIntervalMs && s.repeatIntervalMs > 0) {
          const nextCount = (s.repeatCount ?? 0) + 1;
          if (s.maxRepeats === undefined || nextCount < s.maxRepeats) {
            s.repeatCount = nextCount;
            s.scheduledTime = new Date(Date.now() + s.repeatIntervalMs);
            s.status = "pending";
            continue;
          }
        }
        s.status = "sent";
      } catch (error) {
        s.status = "failed";
        s.error = error?.message || String(error);
        this.options.onFailed(s, error);
      }
      this.queue.delete(id);
    }
    if (this.queue.size === 0) this.stopTimer();
  }
  ensureTimerRunning() {
    if (!this.timer) {
      this.timer = setInterval(() => this.processQueue(), this.options.checkInterval);
      this.timer?.unref?.();
    }
  }
  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  stop() {
    this.stopTimer();
  }
  start() {
    if (this.queue.size > 0) this.ensureTimerRunning();
  }
}

export const createMessageScheduler = (sendMessage, options) => new MessageScheduler(sendMessage, options);