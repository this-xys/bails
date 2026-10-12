export class Expiring {
	constructor(client, builder, seconds = 30) {
		if (!client?.sendMessage) throw new TypeError('Expiring: client with sendMessage() is required');
		if (!builder || typeof builder.send !== 'function') throw new TypeError('Expiring: builder must expose send()');
		this._client = client;
		this._builder = builder;
		this._seconds = Math.max(1, Number(seconds) || 30);
	}

	async send(jid, opts = {}) {
		const res = await this._builder.send(jid, opts);
		const key = res?.key ?? (res?.remoteJid ? res : null);
		if (key?.id) {
			const t = setTimeout(async () => {
				try { await this._client.sendMessage(key.remoteJid ?? jid, { delete: key }); } catch { /* already gone */ }
			}, this._seconds * 1000);
			t.unref?.();
		}
		return res;
	}
}
export { Expiring as ExpiringButton };
