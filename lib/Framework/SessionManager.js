export class SessionManager {
  constructor(store) {
    this.store = store;
  }

  key(jid) {
    return `session_${jid}`;
  }

  get(jid) {
    return this.store.get(this.key(jid));
  }

  set(jid, data) {
    this.store.set(this.key(jid), data);
  }

  update(jid, updater) {
    const prev = this.get(jid);
    this.set(jid, updater(prev));
  }

  delete(jid) {
    this.store.del(this.key(jid));
  }

  has(jid) {
    return this.get(jid) !== undefined;
  }
}
