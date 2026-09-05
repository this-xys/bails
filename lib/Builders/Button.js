import { BaseBuilder, generateWAMessageFromContent, prepareWAMessageMedia, generateMessageIDV2, getBizBinaryNode, crypto } from './shared.js';
class Button extends BaseBuilder {
	#client;

	constructor(client) {
		super();
		if (!client) {
			throw new Error('Socket is required');
		}
		this.#client = client;

		this._buttons = [];
		this._data;
		this._currentSelectionIndex = -1;
		this._currentSectionIndex = -1;
		this._params = {};
	}

	setVideo(path, options = {}) {
		if (!path) throw new Error('Url or buffer needed');
		Buffer.isBuffer(path) ? (this._data = { video: path, ...options }) : (this._data = { video: { url: path }, ...options });
		return this;
	}

	setImage(path, options = {}) {
		if (!path) throw new Error('Url or buffer needed');
		Buffer.isBuffer(path) ? (this._data = { image: path, ...options }) : (this._data = { image: { url: path }, ...options });
		return this;
	}

	setDocument(path, options = {}) {
		if (!path) throw new Error('Url or buffer needed');
		Buffer.isBuffer(path) ? (this._data = { document: path, ...options }) : (this._data = { document: { url: path }, ...options });
		return this;
	}

	setMedia(obj) {
		if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
			throw new TypeError('Media must be a plain object');
		}

		this._data = obj;
		return this;
	}

	clearButtons() {
		this._buttons = [];
		return this;
	}

	setParams(obj) {
		this._params = obj;
		return this;
	}

	#flattenBloks(tree, out, ctx = { n: 0, refs: new Map(), pending: [] }, id = 'root') {
		if (!tree || typeof tree !== 'object') throw new TypeError('setBloksWidget: every node needs a "component" type');
		const { component, children, child, ref, ...rest } = tree;
		if (typeof component !== 'string' || !component) throw new TypeError('setBloksWidget: every node needs a "component" type');

		const isTreeNode = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.component === 'string';
		const isRefMarker = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.$ref === 'string' && Object.keys(v).length === 1;

		const node = { id, component };
		for (const [k, v] of Object.entries(rest)) {
			if (isRefMarker(v)) {
				node[k] = null;
				ctx.pending.push({ node, key: k, refName: v.$ref });
			} else if (isTreeNode(v)) {
				node[k] = this.#flattenBloks(v, out, ctx, `n${ctx.n++}`);
			} else {
				node[k] = v;
			}
		}

		if (Array.isArray(children)) {
			node.children = children.map((c) => this.#flattenBloks(c, out, ctx, `n${ctx.n++}`));
		} else if (child) {
			node.child = this.#flattenBloks(child, out, ctx, `n${ctx.n++}`);
		}

		if (ref) ctx.refs.set(ref, id);

		out.push(node);
		return id;
	}

	setBloksWidget(tree, { uuid = crypto.randomUUID(), catalogId = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json', surfaceId, version = 'v0.9' } = {}) {
		const components = [];
		const ctx = { n: 0, refs: new Map(), pending: [] };
		this.#flattenBloks(tree, components, ctx);
		for (const { node, key, refName } of ctx.pending) {
			const resolved = ctx.refs.get(refName);
			if (!resolved) throw new Error(`setBloksWidget: ref "${refName}" (used on "${key}") was never declared with ref: "${refName}" on any node`);
			node[key] = resolved;
		}

		this._bloksWidget = {
			uuid,
			data: JSON.stringify({
				version,
				createSurface: {
					surfaceId: surfaceId ?? `starcore-widget=${uuid}`,
					catalogId,
					components,
				},
			}),
			type: 'im_a2ui',
		};

		return this;
	}

	addButton(name, params) {
		if (typeof name !== 'string' || !name.trim()) {
			throw new TypeError('addButton(name, params) requires a non-empty string name');
		}

		this._buttons.push({
			name,
			buttonParamsJson: typeof params === 'string' ? params : JSON.stringify(params),
		});

		return this;
	}

	makeRow(header = '', title = '', description = '', id = '') {
		if (this._currentSelectionIndex === -1 || this._currentSectionIndex === -1) {
			throw new Error('You need to create a selection and a section first');
		}
		if (!title || !id) {
			throw new TypeError('makeRow() requires both a title and an id');
		}
		const buttonParams = JSON.parse(this._buttons[this._currentSelectionIndex].buttonParamsJson);
		buttonParams.sections[this._currentSectionIndex].rows.push({ header, title, description, id });
		this._buttons[this._currentSelectionIndex].buttonParamsJson = JSON.stringify(buttonParams);
		return this;
	}

	makeSection(title = '', highlight_label = '') {
		if (this._currentSelectionIndex === -1) {
			throw new Error('You need to create a selection first');
		}
		const buttonParams = JSON.parse(this._buttons[this._currentSelectionIndex].buttonParamsJson);
		buttonParams.sections.push({ title, highlight_label, rows: [] });
		this._currentSectionIndex = buttonParams.sections.length - 1;
		this._buttons[this._currentSelectionIndex].buttonParamsJson = JSON.stringify(buttonParams);
		return this;
	}

	addSelection(title, options = {}) {
		if (!title) throw new TypeError('addSelection(title) requires a non-empty title');
		this._buttons.push({ ...options, name: 'single_select', buttonParamsJson: JSON.stringify({ title, sections: [] }) });
		this._currentSelectionIndex = this._buttons.length - 1;
		this._currentSectionIndex = -1;
		return this;
	}

	addReply(display_text = '', id = '', options = {}) {
		if (!display_text || !id) {
			throw new TypeError('addReply(display_text, id) requires both a label and a unique id');
		}
		this._buttons.push({
			name: 'quick_reply',
			buttonParamsJson: JSON.stringify({
				display_text,
				id,
				...options,
			}),
		});
		return this;
	}

	addCall(display_text = '', phone_number = '', options = {}) {
		if (!display_text || !phone_number) {
			throw new TypeError('addCall(display_text, phone_number) requires both a label and a phone number');
		}
		this._buttons.push({
			name: 'cta_call',
			buttonParamsJson: JSON.stringify({
				display_text,
				phone_number,
				...options,
			}),
		});
		return this;
	}

	addReminder(display_text = '', id = '', options = {}) {
		if (!display_text || !id) {
			throw new TypeError('addReminder(display_text, id) requires both a label and a unique id');
		}
		this._buttons.push({
			name: 'cta_reminder',
			buttonParamsJson: JSON.stringify({
				display_text,
				id,
				...options,
			}),
		});
		return this;
	}

	addCancelReminder(display_text = '', id = '', options = {}) {
		if (!display_text || !id) {
			throw new TypeError('addCancelReminder(display_text, id) requires both a label and a unique id');
		}
		this._buttons.push({
			name: 'cta_cancel_reminder',
			buttonParamsJson: JSON.stringify({
				display_text,
				id,
				...options,
			}),
		});
		return this;
	}

	addAddress(display_text = '', id = '', options = {}) {
		if (!display_text || !id) {
			throw new TypeError('addAddress(display_text, id) requires both a label and a unique id');
		}
		this._buttons.push({
			name: 'address_message',
			buttonParamsJson: JSON.stringify({
				display_text,
				id,
				...options,
			}),
		});
		return this;
	}

	addLocation(options = {}) {
		this._buttons.push({
			name: 'send_location',
			buttonParamsJson: JSON.stringify(options),
		});
		return this;
	}

	addUrl(display_text = '', url = '', webview_interaction = false, options = {}) {
		if (!display_text || !url) {
			throw new TypeError('addUrl(display_text, url) requires both a label and a url');
		}
		this._buttons.push({
			...options,
			name: 'cta_url',
			buttonParamsJson: JSON.stringify({
				display_text,
				url,
				merchant_url: url,
				webview_interaction,
				...options,
			}),
		});
		return this;
	}

	addCopy(display_text = '', copy_code = '', options = {}) {
		if (!display_text || !copy_code) {
			throw new TypeError('addCopy(display_text, copy_code) requires both a label and the text to copy');
		}
		this._buttons.push({
			name: 'cta_copy',
			buttonParamsJson: JSON.stringify({
				display_text,
				copy_code,
				...options,
			}),
		});
		return this;
	}

	addOpenWebview(title = '', url = '', options = {}) {
		if (!title || !url) {
			throw new TypeError('addOpenWebview(title, url) requires both a title and a url');
		}
		this._buttons.push({
			name: 'open_webview',
			buttonParamsJson: JSON.stringify({
				title,
				link: { url },
				...options,
			}),
		});
		return this;
	}

	addCatalog(display_text = '', options = {}) {
		this._buttons.push({
			name: 'cta_catalog',
			buttonParamsJson: JSON.stringify({
				...(display_text ? { display_text } : {}),
				...options,
			}),
		});
		return this;
	}

	addViewCatalog(options = {}) {
		this._buttons.push({
			name: 'automated_greeting_message_view_catalog',
			buttonParamsJson: JSON.stringify(options),
		});
		return this;
	}

	addCallPermission(display_text = '', options = {}) {
		this._buttons.push({
			name: 'call_permission_request',
			buttonParamsJson: JSON.stringify({
				...(display_text ? { display_text } : {}),
				...options,
			}),
		});
		return this;
	}

	addPaymentInfo(payload = {}) {
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
			throw new TypeError('addPaymentInfo(payload) requires a plain object');
		}
		this._buttons.push({
			name: 'payment_info',
			buttonParamsJson: JSON.stringify(payload),
		});
		return this;
	}

	addReviewAndPay(payload = {}) {
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
			throw new TypeError('addReviewAndPay(payload) requires a plain object');
		}
		this._buttons.push({
			name: 'review_and_pay',
			buttonParamsJson: JSON.stringify(payload),
		});
		return this;
	}

	addTransactionDetails(payload = {}) {
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
			throw new TypeError('addTransactionDetails(payload) requires a plain object');
		}
		this._buttons.push({
			name: 'wa_payment_transaction_details',
			buttonParamsJson: JSON.stringify(payload),
		});
		return this;
	}

	addMultiProduct(payload = {}) {
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
			throw new TypeError('addMultiProduct(payload) requires a plain object');
		}
		this._buttons.push({
			name: 'mpm',
			buttonParamsJson: JSON.stringify(payload),
		});
		return this;
	}

	addPaymentKeyInfo(payload = {}) {
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new TypeError('addPaymentKeyInfo(payload) requires a plain object');
		this._buttons.push({ name: 'payment_key_info', buttonParamsJson: JSON.stringify(payload) });
		return this;
	}

	addBookingConfirmation(payload = {}) {
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new TypeError('addBookingConfirmation(payload) requires a plain object');
		this._buttons.push({ name: 'booking_confirmation', buttonParamsJson: JSON.stringify(payload) });
		return this;
	}

	addCardMessage(payload = {}) {
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new TypeError('addCardMessage(payload) requires a plain object');
		this._buttons.push({ name: 'card_message', buttonParamsJson: JSON.stringify(payload) });
		return this;
	}

	addOrderDetails(payload = {}) {
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new TypeError('addOrderDetails(payload) requires a plain object');
		this._buttons.push({ name: 'order_details', buttonParamsJson: JSON.stringify(payload) });
		return this;
	}

	addOrderStatus(payload = {}) {
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new TypeError('addOrderStatus(payload) requires a plain object');
		this._buttons.push({ name: 'order_status', buttonParamsJson: JSON.stringify(payload) });
		return this;
	}

	addPaymentStatus(payload = {}) {
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new TypeError('addPaymentStatus(payload) requires a plain object');
		this._buttons.push({ name: 'payment_status', buttonParamsJson: JSON.stringify(payload) });
		return this;
	}

	addPaymentMethod(payload = {}) {
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new TypeError('addPaymentMethod(payload) requires a plain object');
		this._buttons.push({ name: 'payment_method', buttonParamsJson: JSON.stringify(payload) });
		return this;
	}

	addTrackOrder(id, display_text = '🚚 Track order') {
		if (!id) throw new TypeError('addTrackOrder(id) requires a non-empty id');
		this._buttons.push({ name: 'track_order', buttonParamsJson: JSON.stringify({ id, display_text }) });
		return this;
	}

	addReorder(id, display_text = '🔁 Reorder') {
		if (!id) throw new TypeError('addReorder(id) requires a non-empty id');
		this._buttons.push({ name: 'reorder', buttonParamsJson: JSON.stringify({ id, display_text }) });
		return this;
	}

	addCancelOrder(id, display_text = '❌ Cancel order') {
		if (!id) throw new TypeError('addCancelOrder(id) requires a non-empty id');
		this._buttons.push({ name: 'cancel_order', buttonParamsJson: JSON.stringify({ id, display_text }) });
		return this;
	}

	addClearChat() {
		this._buttons.push({ name: 'clear_chat', buttonParamsJson: '{}' });
		return this;
	}

	addNavigateToScreen(screen, data = {}) {
		if (!screen) throw new TypeError('addNavigateToScreen(screen) requires a non-empty screen');
		this._buttons.push({ name: 'navigateToScreen', buttonParamsJson: JSON.stringify({ screen_name: screen, data }) });
		return this;
	}

	addFlow(flow = {}, display_text = '') {
		if (typeof flow !== 'object' || flow === null || Array.isArray(flow) || !flow.id) throw new TypeError('addFlow(flow) requires a plain object with flow.id');
		this._buttons.push({

			name: 'flow',
			buttonParamsJson: JSON.stringify({
				flow_message_version: flow.version || '3',

				flow_token: flow.token || generateMessageIDV2(),
				flow_id: flow.id,
				flow_cta: display_text || flow.cta || 'Continue',
				flow_action: flow.action || 'navigate',
				flow_action_payload: flow.actionPayload || { screen: flow.screen || 'WELCOME', data: flow.data || {} },
			}),
		});
		return this;
	}

	addVoiceCall(id, display_text = '📞 Voice call') {
		if (!id) throw new TypeError('addVoiceCall(id) requires a non-empty id');
		this._buttons.push({ name: 'voice_call', buttonParamsJson: JSON.stringify({ display_text, id }) });
		return this;
	}

	addVideoCall(id, display_text = '🎥 Video call') {
		if (!id) throw new TypeError('addVideoCall(id) requires a non-empty id');
		this._buttons.push({ name: 'video_call_button', buttonParamsJson: JSON.stringify({ display_text, id }) });
		return this;
	}

	static #validateAgainstSchema(schema, data, label) {
		for (const [key, type] of Object.entries(schema)) {
			if (data[key] === undefined) continue;
			const expectsArray = Array.isArray(type);
			if (expectsArray) {
				if (!Array.isArray(data[key]) || !data[key].every((v) => typeof v === type[0])) {
					throw new TypeError(`${label}.${key} must be an array of ${type[0]}`);
				}
			} else if (typeof data[key] !== type) {
				throw new TypeError(`${label}.${key} must be a ${type}`);
			}
		}
	}

	setLimitedTimeOffer({ text = '', url = '', copy_code = '', expiration_time } = {}) {
		const data = { text, url, copy_code, expiration_time };
		Button.#validateAgainstSchema(Button.paramsList.limited_time_offer, data, 'limited_time_offer');
		this._params = { ...this._params, limited_time_offer: data };
		return this;
	}

	setBottomSheet({ in_thread_buttons_limit, divider_indices = [], list_title = '', button_title = '' } = {}) {
		const data = { in_thread_buttons_limit, divider_indices, list_title, button_title };
		Button.#validateAgainstSchema(Button.paramsList.bottom_sheet, data, 'bottom_sheet');
		this._params = { ...this._params, bottom_sheet: data };
		return this;
	}

	setTapTargetConfiguration({ title = '', description = '', canonical_url = '', domain = '', buttonIndex = 0 } = {}) {
		const data = { title, description, canonical_url, domain, buttonIndex };
		Button.#validateAgainstSchema(Button.paramsList.tap_target_configuration, data, 'tap_target_configuration');
		this._params = { ...this._params, tap_target_configuration: data };
		return this;
	}

	static paramsList = {
		limited_time_offer: {
			text: 'string',
			url: 'string',
			copy_code: 'string',
			expiration_time: 'number',
		},
		bottom_sheet: {
			in_thread_buttons_limit: 'number',
			divider_indices: ['number'],
			list_title: 'string',
			button_title: 'string',
		},
		tap_target_configuration: {
			title: 'string',
			description: 'string',
			canonical_url: 'string',
			domain: 'string',
			buttonIndex: 'number',
		},
	};

	static #SPECIAL_FLOW = {
		review_and_pay: { v: '1', name: 'order_details' },
		payment_info: { v: '1', name: 'payment_info' },
		mpm: { v: '2', name: 'mpm' },
		cta_catalog: { v: '2', name: 'cta_catalog' },
		send_location: { v: '2', name: 'send_location' },
		call_permission_request: { v: '2', name: 'call_permission_request' },
		wa_payment_transaction_details: { v: '2', name: 'wa_payment_transaction_details' },
		payment_key_info: { v: '1', name: 'payment_key_info' },
		booking_confirmation: { v: '1', name: 'booking_confirmation' },
		automated_greeting_message_view_catalog: { v: '2', name: 'automated_greeting_message_view_catalog' },
	};

	async toCard() {
		return {
			body: {
				text: this._body,
			},
			footer: {
				text: this._footer,
			},
			header: {
				title: this._title,
				subtitle: this._subtitle,
				hasMediaAttachment: !!this._data,
				...(this._data
					? await prepareWAMessageMedia(this._data, { upload: this.#client.waUploadToServer }).catch((e) => {
							if (String(e).includes('Invalid media type')) return this._data;
							throw e;
						})
					: {}),
			},
			nativeFlowMessage: {
				messageParamsJson: JSON.stringify(this._params),
				buttons: this._buttons,
			},
		};
	}

	#isLoneSingleSelect() {
		return this._buttons.length === 1 && this._buttons[0].name === 'single_select';
	}

	#toListMessage() {
		const { title: buttonText, sections } = JSON.parse(this._buttons[0].buttonParamsJson);
		return {
			listMessage: {
				title: this._title || undefined,
				description: this._body || undefined,
				footerText: this._footer || undefined,
				buttonText: buttonText || undefined,
				listType: 1,
				sections: (sections || []).map((s) => ({
					title: s.title,
					rows: (s.rows || []).map((r) => ({
						title: r.title || r.header || '',
						description: r.description || '',
						rowId: r.id || '',
					})),
				})),
				contextInfo: this._contextInfo,
			},
		};
	}

	async build(jid, { ...options } = {}) {
		if (this._buttons.length === 0 && !this._bloksWidget) {
			throw new Error('Button requires at least one button (use addReply/addUrl/addCall/addSelection/addButton/...) or a Bloks widget (setBloksWidget())');
		}

		if (this._buttons.length > 0 && this.#isLoneSingleSelect()) {
			return generateWAMessageFromContent(jid, { ...this._extraPayload, ...this.#toListMessage() }, { ...options });
		}

		const message = this._buttons.length > 0 ? await this.toCard() : {};

		return generateWAMessageFromContent(
			jid,
			{
				...(this._bloksWidget && {
					messageContextInfo: { messageSecret: crypto.randomBytes(32) },
				}),
				...this._extraPayload,
				interactiveMessage: {
					...message,
					...(this._bloksWidget && { bloksWidget: this._bloksWidget }),
					contextInfo: this._contextInfo,
				},
			},
			{ ...options }
		);
	}

	async send(jid, { ...options } = {}) {
		const msg = await this.build(jid, options);

		const bizNode = getBizBinaryNode(msg.message);

		await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
			messageId: msg.key.id,
			additionalNodes: [bizNode],
			...options,
		});
		return msg;
	}
}

class CardBuilder {

	constructor(client) {
		this._card = new Button(client);
	}

	image(url) {
		this._card.setImage(url);
		return this;
	}

	title(t) {
		this._card.setTitle(t);
		return this;
	}

	text(t) {
		this._card.setBody(t);
		return this;
	}

	button(displayText, id) {
		this._card.addReply(displayText, id);
		return this;
	}
}

export { Button, CardBuilder };
