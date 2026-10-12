import { BaseBuilder } from './shared.js';

class Album extends BaseBuilder {
	#client;

	constructor(client) {
		super();
		if (!client || (typeof client.sendAlbumMessage !== 'function' && typeof client.sendMessage !== 'function')) {
			throw new Error('Socket is required');
		}
		this.#client = client;
		this._items = [];
		this._caption = '';
		this._delayMs = undefined;
		this._continueOnError = false;
	}

	static get MAX_ITEMS() { return 10; }

	#push(kind, source, caption, extra) {
		if (!source) throw new TypeError(`add${kind === 'image' ? 'Image' : 'Video'}(source) requires a Buffer, { url } or { stream }`);
		if (this._items.length >= Album.MAX_ITEMS) throw new RangeError(`An album holds at most ${Album.MAX_ITEMS} media`);
		this._items.push({ [kind]: source, ...(caption ? { caption: String(caption) } : {}), ...extra });
		return this;
	}

	addImage(source, caption, extra = {}) { return this.#push('image', source, caption, extra); }

	addVideo(source, caption, extra = {}) { return this.#push('video', source, caption, extra); }

	addMany(items) {
		if (!Array.isArray(items) || !items.length) throw new TypeError('addMany(items) requires a non-empty array');
		for (const it of items) {
			if (it?.image) this.#push('image', it.image, it.caption, Object.fromEntries(Object.entries(it).filter(([k]) => !['image', 'caption'].includes(k))));
			else if (it?.video) this.#push('video', it.video, it.caption, Object.fromEntries(Object.entries(it).filter(([k]) => !['video', 'caption'].includes(k))));
			else throw new TypeError('addMany(): every item needs an "image" or "video" property');
		}
		return this;
	}

	setCaption(caption) {
		if (typeof caption !== 'string') throw new TypeError('Caption must be a string');
		this._caption = caption;
		return this;
	}

	setDelay(ms) {
		if (!Number.isFinite(ms) || ms < 0) throw new TypeError('setDelay(ms) requires a non-negative number');
		this._delayMs = ms;
		return this;
	}

	setContinueOnError(v = true) {
		this._continueOnError = !!v;
		return this;
	}

	build() {
		if (this._items.length < 2) throw new Error('An album needs at least 2 media (use addImage()/addVideo())');
		return { album: [...this._items], ...(this._caption ? { caption: this._caption } : {}) };
	}

	async send(jid, options = {}) {
		const payload = this.build();
		const opts = { ...(this._delayMs !== undefined ? { delayMs: this._delayMs } : {}), ...options };
		if (typeof this.#client.sendAlbumMessage === 'function') {
			return this.#client.sendAlbumMessage(jid, payload.album, {
				...(payload.caption ? { caption: payload.caption } : {}),
				...(this._continueOnError ? { continueOnError: true } : {}),
				...opts,
			});
		}
		return this.#client.sendMessage(jid, payload, { ...opts, ...(this._continueOnError ? { albumContinueOnError: true } : {}) });
	}
}

export { Album };
