import { BaseBuilder, Toolkit, RowBuilder, generateWAMessageFromContent, prepareWAMessageMedia, generateMessageIDV2, crypto } from './shared.js';
class ButtonV2 extends BaseBuilder {
	#client;

	constructor(client) {
		super();
		if (!client) {
			throw new Error('Socket is required');
		}

		this.#client = client;
		this._image;
		this._data;
		this._buttons = [];
	}

	addButton(displayText = '', buttonId = crypto.randomUUID()) {
		if (!displayText) throw new TypeError('addButton(displayText) requires a non-empty label');
		this._buttons.push({
			buttonId,
			buttonText: { displayText },
			type: 1,
		});
		return this;
	}

	addRawButton(obj) {
		if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
			throw new TypeError('Buttons must be a plain object');
		}

		this._buttons.push(obj);
		return this;
	}

	setThumbnail(path) {
		if (!path) throw new Error('Url or buffer needed');
		this._image = path;
		return this;
	}

	setMedia(obj) {
		if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
			throw new TypeError('Media must be a plain object');
		}

		this._data = obj;
		return this;
	}

	button(displayText, buttonId) {
		return this.addButton(displayText, buttonId);
	}

	row(cb) {
		const r = new RowBuilder();
		cb(r);
		r.buttons.forEach((b) => this._buttons.push(b));
		return this;
	}

	async build(jid, { viewOnce = true, ...options } = {}) {
		const _thumbnail = !this._data && this._image ? await Toolkit.resize(Buffer.isBuffer(this._image) ? this._image : await Toolkit.fetchBuffer(this._image, {}, { silent: true }), 300, 300) : null;
		const msg = generateWAMessageFromContent(
			jid,
			{
				...this._extraPayload,
				buttonsMessage: {
					contentText: this._body,
					footerText: this._footer,
					...(this._data
						? this._data
						: {
								headerType: 6,
								locationMessage: {
									degreesLatitude: 0,
									degreesLongitude: 0,
									name: this._title,
									address: this._subtitle,
									jpegThumbnail: _thumbnail,
								},
							}),
					viewOnce,
					contextInfo: this._contextInfo,
					buttons: [...this._buttons],
				},
			},
			{ ...options }
		);
		return msg;
	}

	async send(jid, { ...options } = {}) {
		if (this._buttons.length < 1) throw new Error('ButtonV2 requires at least one button');
		const msg = await this.build(jid, options);

		await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
			messageId: msg.key.id,
			additionalNodes: [
				{
					tag: 'biz',
					attrs: {},
					content: [
						{
							tag: 'interactive',
							attrs: { type: 'native_flow', v: '1' },
							content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
						},
					],
				},
			],
			...options,
		});
		return msg;
	}
}

export { ButtonV2 };
