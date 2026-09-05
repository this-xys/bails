import { BaseBuilder, generateWAMessageFromContent, prepareWAMessageMedia, generateMessageIDV2, crypto } from './shared.js';
class Carousel extends BaseBuilder {
	#client;

	static MAX_CARDS = 10;

	constructor(client) {
		super();
		if (!client) {
			throw new Error('Socket is required');
		}

		this.#client = client;
		this._cards = [];
	}

	addCard(card) {
		const cards = Array.isArray(card) ? card : [card];
		const baseIndex = this._cards.length;

		for (const [index, c] of cards.entries()) {
			if (!c?.header?.hasMediaAttachment) {
				throw new Error(`Card [${baseIndex + index}] must include an image or video in header`);
			}
		}

		if (this._cards.length + cards.length > Carousel.MAX_CARDS) {
			throw new Error(`Carousel supports at most ${Carousel.MAX_CARDS} cards (got ${this._cards.length + cards.length})`);
		}

		this._cards.push(...cards);
		return this;
	}

	build(jid, { ...options } = {}) {
		return generateWAMessageFromContent(
			jid,
			{
				...this._extraPayload,
				interactiveMessage: {
					header: {
						hasMediaAttachment: false,
					},
					body: { text: this._body },
					footer: { text: this._footer },
					contextInfo: this._contextInfo,
					carouselMessage: {
						cards: this._cards,
					},
				},
			},
			{ ...options }
		);
	}

	async send(jid, { ...options } = {}) {
		if (this._cards.length === 0) throw new Error('Carousel requires at least one card (use addCard())');

		const msg = this.build(jid, options);

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

export { Carousel };
