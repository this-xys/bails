import { BaseBuilder, Toolkit, extractIE, waitAllPromises, getSharp, getFfmpeg, botMetadataSignature, botMetadataCertificate, crypto, generateWAMessageFromContent, prepareWAMessageMedia, generateMessageIDV2 } from './shared.js';
class AIRich extends BaseBuilder {
	#client;

	constructor(client) {
		if (!client) {
			throw new Error('Socket is required');
		}

		super();
		this.#client = client;
		this._contextInfo = {};
		this._submessages = [];
		this._sections = [];
		this._richResponseSources = [];

		this._inlineImages = [];

		this._responseId = null;
		this._botResponseId = null;

		this._lastMessageKey = null;

		this._blocks = new Map();
		return new Proxy(this, {
			get(target, prop, receiver) {
				const orig = Reflect.get(target, prop, receiver);
				if (typeof orig !== 'function') return orig;

				if (!/^(add|set)/.test(String(prop))) {
					return (...args) => {
						const result = orig.apply(target, args);
						return result === target ? receiver : result;
					};
				}

				return (...args) => {
					const opts = args.find((a) => a && typeof a === 'object' && !Array.isArray(a) && !Buffer.isBuffer(a) && ('id' in a || 'insertAt' in a || 'replace' in a));
					const id = opts?.id;
					const insertAt = opts?.insertAt;
					const replace = opts?.replace;

					if (id && target._blocks.has(id) && replace !== id) {
						throw new Error(`add*/set*: id "${id}" is already registered — each id must be unique (pass { replace: "${id}" } to update that block instead, or use a different id)`);
					}

					const subBefore = target._submessages.length;
					const secBefore = target._sections.length;

					const result = orig.apply(target, args);

					const subItems = target._submessages.splice(subBefore);
					const secItems = target._sections.splice(secBefore);

					if (insertAt) {
						const anchor = target._blocks.get(insertAt);
						if (!anchor) throw new Error(`insertAt: no block registered with id "${insertAt}" (register it by passing { id: "${insertAt}" } on an earlier add*() call)`);

						const lastSub = anchor.subItems[anchor.subItems.length - 1];
						const subIdx = lastSub ? target._submessages.indexOf(lastSub) + 1 : target._submessages.length;
						target._submessages.splice(subIdx, 0, ...subItems);

						const lastSec = anchor.secItems[anchor.secItems.length - 1];
						const secIdx = lastSec ? target._sections.indexOf(lastSec) + 1 : target._sections.length;
						target._sections.splice(secIdx, 0, ...secItems);
					} else if (replace) {

						const old = target._blocks.get(replace);
						if (!old) throw new Error(`replace: no block registered with id "${replace}" (register it first with { id: "${replace}" })`);

						let subIdx = old.subItems.length > 0 ? target._submessages.indexOf(old.subItems[0]) : target._submessages.length;
						if (subIdx === -1) subIdx = target._submessages.length;
						for (const item of old.subItems) {
							const i = target._submessages.indexOf(item);
							if (i !== -1) target._submessages.splice(i, 1);
						}
						target._submessages.splice(subIdx, 0, ...subItems);

						let secIdx = old.secItems.length > 0 ? target._sections.indexOf(old.secItems[0]) : target._sections.length;
						if (secIdx === -1) secIdx = target._sections.length;
						for (const item of old.secItems) {
							const i = target._sections.indexOf(item);
							if (i !== -1) target._sections.splice(i, 1);
						}
						target._sections.splice(secIdx, 0, ...secItems);

						target._blocks.delete(replace);
						if (id) target._blocks.set(id, { subItems, secItems });
						else target._blocks.set(replace, { subItems, secItems });
					} else {
						target._submessages.push(...subItems);
						target._sections.push(...secItems);
					}

					if (id) target._blocks.set(id, { subItems, secItems });

					return result === target ? receiver : result;
				};
			},
		});
	}

	get items() {
		return this._sections.flatMap((s) => {
			const vm = s?.view_model;
			if (!vm) return [];
			return vm.primitives ?? (vm.primitive !== undefined ? [vm.primitive] : []);
		});
	}

	addSubmessage(submessage) {
		const items = Array.isArray(submessage) ? submessage : [submessage];

		for (const item of items) {
			if (typeof item !== 'object' || item === null || Array.isArray(item)) {
				throw new TypeError('Submessage must be a plain object or array of plain objects');
			}

			this._submessages.push(item);
		}

		return this;
	}

	addSection(section) {
		const items = Array.isArray(section) ? section : [section];

		for (const item of items) {
			if (typeof item !== 'object' || item === null || Array.isArray(item)) {
				throw new TypeError('Section must be a plain object or array of plain objects');
			}

			this._sections.push(item);
		}

		return this;
	}

	addText(text, { hyperlink = true, citation = true, latex = true } = {}) {
		if (typeof text != 'string') {
			throw new TypeError('Text must be a string');
		}

		const { text: extractedText, inline_entities } = extractIE(text, {
			hyperlink,
			citation,
			latex,
		});

		this._submessages.push({
			messageType: 2,
			messageText: extractedText,
		});

		this._sections.push(
			AIRich.newLayout('Single', {
				text: extractedText,
				...(inline_entities.length && {
					inline_entities,
				}),
				__typename: 'GenAIMarkdownTextUXPrimitive',
			})
		);

		return this;
	}

	addCode(language, code) {
		if (typeof language !== 'string' || typeof code !== 'string') {
			throw new TypeError('Language and code must be a string');
		}

		const meta = AIRich.tokenizer(code, language);

		this._submessages.push({
			messageType: 5,
			codeMetadata: {
				codeLanguage: language,
				codeBlocks: meta.codeBlock,
			},
		});

		this._sections.push(
			AIRich.newLayout('Single', {
				language,
				code_blocks: meta.unified_codeBlock,
				__typename: 'GenAICodeUXPrimitive',
			})
		);

		return this;
	}

	addTable(table, { hyperlink = true, citation = true, latex = true } = {}) {
		if (!Array.isArray(table)) {
			throw new TypeError('Table must be an array');
		}

		const meta = AIRich.toTableMetadata(table, { hyperlink, citation, latex });

		this._submessages.push({
			messageType: 4,
			tableMetadata: {
				title: meta.title,
				rows: meta.rows,
			},
		});

		this._sections.push(
			AIRich.newLayout('Single', {
				rows: meta.unified_rows,
				__typename: 'GenATableUXPrimitive',
			})
		);

		return this;
	}

	addLinks(links = []) {
		if (!Array.isArray(links)) throw new TypeError('links must be an array');
		links.forEach((linkField, index) => {
			if (!linkField || typeof linkField !== 'object') throw new TypeError('Each link must be an object');
			const prefix = 'SS_' + index;
			const url = linkField.url || '';
			const text = String(linkField.text ?? '');
			const sources = Array.isArray(linkField.sources) ? linkField.sources.map((sourceField) => ({
				source_type: 'THIRD_PARTY',
				source_display_name: sourceField?.displayName || sourceField?.title || 'Source',
				source_subtitle: sourceField?.subtitle || '',
				source_url: sourceField?.url || url,
			})) : [];
			const entity = {
				key: prefix,
				metadata: {
					reference_id: index + 1,
					reference_url: url,
					reference_title: linkField.title || 'Source',
					reference_display_name: linkField.displayName || linkField.title || 'Source',
					sources,
					__typename: 'GenAISearchCitationItem',
				},
			};
			const section = AIRich.newLayout('Single', {
				text: `${text} {{${prefix}}}${url}{{/${prefix}}}`,
				inline_entities: [entity],
				__typename: 'GenAIMarkdownTextUXPrimitive',
			});
			this._sections.push(section);
			this._submessages.push({
				messageType: 2,
				messageText: `${text} {{${prefix}}}¹{{/${prefix}}} `,
				inlineEntities: [entity],
			});
		});
		return this;
	}

	addContentItems(items = []) {
		if (!Array.isArray(items)) throw new TypeError('items must be an array');
		this._submessages.push({
			messageType: 9,
			contentItemsMetadata: { itemsMetadata: items, contentType: 1 },
		});
		this._sections.push(AIRich.newLayout('Single', {
			items,
			content_type: 1,
			__typename: 'GenAIContentItemsUXPrimitive',
		}));
		return this;
	}

	addInlineVideo() {
		this._submessages.push({ messageType: 2, messageText: 'INLINE_VIDEO' });
		this._sections.push(AIRich.newLayout('Single', {
			text: 'INLINE_VIDEO',
			__typename: 'GenAIMarkdownTextUXPrimitive',
		}));
		return this;
	}

	addSource(sources = [], { resolveUrl = false } = {}) {

		const isObjArray = Array.isArray(sources) && sources.every((item) => item && typeof item === 'object' && !Array.isArray(item));
		const isStrArrayArray = Array.isArray(sources) && sources.every((item) => Array.isArray(item) && item.every((v) => typeof v === 'string'));
		const isFlatStrArray = Array.isArray(sources) && sources.every((item) => typeof item === 'string');

		if (!isObjArray && !isStrArrayArray && !isFlatStrArray) {
			throw new TypeError('addSource(): pass an array of objects { icon, url, title, subtitle } or string arrays [iconUrl, url, text]');
		}

		let normalized;
		if (isObjArray) {
			normalized = sources.map((item) => ({
				icon: item.icon ?? item.iconUrl ?? item.favicon ?? '',
				url: item.url ?? '',
				text: item.title ?? item.displayName ?? item.text ?? '',
				subtitle: item.subtitle ?? 'AI',
			}));
		} else {
			const arr = isFlatStrArray ? [sources] : sources;
			normalized = arr.map(([icon = '', url = '', text = '']) => ({ icon, url, text, subtitle: 'AI' }));
		}

		const source = normalized.map(({ icon, url, text, subtitle }) => ({
			source_type: 'THIRD_PARTY',
			source_display_name: text,
			source_subtitle: subtitle,
			source_url: url,
			favicon: {
				url: Toolkit.resolveMedia(this.#client, icon, 'image', { resolveUrl }),
				mime_type: 'image/jpeg',
				width: 16,
				height: 16,
			},
		}));

		this._sections.push(
			AIRich.newLayout('Single', {
				sources: source,
				__typename: 'GenAISearchResultPrimitive',
			})
		);

		return this;
	}

	addReels(reelsItems = [], { resolveUrl = false } = {}) {
		if (
			!(
				(reelsItems && typeof reelsItems === 'object' && !Array.isArray(reelsItems)) ||
				(Array.isArray(reelsItems) && reelsItems.every((item) => item && typeof item === 'object' && !Array.isArray(item)))
			)
		) {
			throw new TypeError('Reels items must be an object or an array of objects');
		}

		if (!Array.isArray(reelsItems)) {
			reelsItems = [reelsItems];
		}

		const reels = reelsItems.map((item) => ({
			...item,
			_avatar: Toolkit.resolveMedia(this.#client, item.profileIconUrl ?? item.profile_url ?? item.profile ?? '', 'image', { resolveUrl }),
			_thumbnail: Toolkit.resolveMedia(this.#client, item.thumbnailUrl ?? item.thumbnail ?? '', 'image', { resolveUrl }),
		}));

		this._submessages.push({
			messageType: 9,
			contentItemsMetadata: {
				contentType: 1,
				itemsMetadata: reels.map((item) => ({
					reelItem: {
						title: item.username ?? '',
						profileIconUrl: item._avatar,
						thumbnailUrl: item._thumbnail,
						videoUrl: item.videoUrl ?? item.url ?? '',
					},
				})),
			},
		});

		reels.forEach((item, idx) => {
			this._richResponseSources.push({
				provider: 'Evernight AI',
				thumbnailCDNURL: item._thumbnail,
				sourceProviderURL: item.videoUrl ?? item.url ?? '',
				sourceQuery: '',
				faviconCDNURL: item._avatar,
				citationNumber: idx + 1,
				sourceTitle: item.username ?? '',
			});
		});

		this._sections.push(
			AIRich.newLayout(
				'HScroll',
				reels.map((item) => ({
					reels_url: item.videoUrl ?? item.url ?? '',
					thumbnail_url: item._thumbnail,
					creator: item.username ?? item.title ?? '',
					avatar_url: item._avatar,
					reels_title: item.reels_title ?? item.title ?? '',
					likes_count: item.likes_count ?? item.like ?? 0,
					shares_count: item.shares_count ?? item.share ?? 0,
					view_count: item.view_count ?? item.view ?? 0,
					reel_source: item.reel_source ?? item.source ?? 'IG',
					is_verified: !!(item.is_verified || item.verified),
					__typename: 'GenAIReelPrimitive',
				}))
			)
		);

		return this;
	}

	addImage(imageUrl, { resolveUrl = false, instant = false } = {}) {
		if (!(typeof imageUrl === 'string' || Buffer.isBuffer(imageUrl) || (Array.isArray(imageUrl) && imageUrl.every((v) => typeof v === 'string' || Buffer.isBuffer(v))))) {
			throw new TypeError('imageUrl must be string | buffer | array of string/buffer');
		}
		if (instant !== false && instant !== true && instant !== 'only') {
			throw new TypeError(`instant must be false, true, or 'only' — got ${JSON.stringify(instant)}`);
		}

		const list = Array.isArray(imageUrl)
			? imageUrl.map((v) => {
					const url = Toolkit.resolveMedia(this.#client, v, 'image', { resolveUrl });
					return {
						imagePreviewUrl: url,
						imageHighResUrl: url,
						sourceUrl: url,
					};
				})
			: (() => {
					const url = Toolkit.resolveMedia(this.#client, imageUrl, 'image', { resolveUrl });
					return [
						{
							imagePreviewUrl: url,
							imageHighResUrl: url,
							sourceUrl: url,
						},
					];
				})();

		const buildCard = instant !== 'only';

		if (buildCard) {
			this._submessages.push({
				messageType: 1,
				gridImageMetadata: {
					gridImageUrl: {
						imagePreviewUrl: list[0]?.imagePreviewUrl,
					},
					imageUrls: list,
				},
			});
		}

		list.forEach(({ imagePreviewUrl }) => {
			if (buildCard) {
				this._sections.push(
					AIRich.newLayout('Single', {
						media: {
							url: imagePreviewUrl,
							mime_type: 'image/png',
						},
						imagine_type: 'IMAGE',
						status: { status: 'READY' },
						__typename: 'GenAIImaginePrimitive',
					})
				);
			}

			if (instant) {
				this._inlineImages.push({ url: imagePreviewUrl, caption: undefined });
			}
		});

		return this;
	}

	addInlineImage(imageUrl, { text = '', alignment = 'center', tapLinkUrl = '', resolveUrl = false } = {}) {
		if (!(typeof imageUrl === 'string' || Buffer.isBuffer(imageUrl) || (imageUrl && typeof imageUrl === 'object'))) {
			throw new TypeError('imageUrl must be string | buffer | { imagePreviewUrl, imageHighResUrl, sourceUrl }');
		}

		const ALIGNMENT_ENUM = { leading: 0, trailing: 1, center: 2 };
		const ALIGNMENT_NAME = ['AI_RICH_RESPONSE_IMAGE_LAYOUT_LEADING_ALIGNED', 'AI_RICH_RESPONSE_IMAGE_LAYOUT_TRAILING_ALIGNED', 'AI_RICH_RESPONSE_IMAGE_LAYOUT_CENTER_ALIGNED'];
		const alignmentNum = typeof alignment === 'number' ? alignment : (ALIGNMENT_ENUM[String(alignment).toLowerCase()] ?? ALIGNMENT_ENUM.center);

		const url =
			imageUrl && typeof imageUrl === 'object'
				? {
						imagePreviewUrl: imageUrl.imagePreviewUrl || imageUrl.url,
						imageHighResUrl: imageUrl.imageHighResUrl || imageUrl.url,
						sourceUrl: imageUrl.sourceUrl || imageUrl.url,
					}
				: (() => {
						const resolved = Toolkit.resolveMedia(this.#client, imageUrl, 'image', { resolveUrl });
						return { imagePreviewUrl: resolved, imageHighResUrl: resolved, sourceUrl: resolved };
					})();

		this._submessages.push({
			messageType: 3,
			imageMetadata: {
				imageUrl: url,
				imageText: text,
				alignment: alignmentNum,
				tapLinkUrl,
			},
		});

		this._sections.push(
			AIRich.newLayout('Single', {
				image_url: {
					image_preview_url: url.imagePreviewUrl || '',
					image_high_res_url: url.imageHighResUrl || '',
					source_url: url.sourceUrl || '',
				},
				image_text: text,
				alignment: ALIGNMENT_NAME[alignmentNum],
				tap_link_url: tapLinkUrl,
				__typename: 'GenAIInlineImageUXPrimitive',
			})
		);

		this._inlineImages.push({
			url: url.sourceUrl || url.imageHighResUrl || url.imagePreviewUrl,
			caption: text || undefined,
		});

		return this;
	}

	addVideo(videoUrl, { autoFill = false, resolveUrl = false } = {}) {
		const isObjectVideo = (v) => v && typeof v === 'object' && v.url;

		const isValidPrimitive =
			typeof videoUrl === 'string' ||
			Buffer.isBuffer(videoUrl) ||
			isObjectVideo(videoUrl) ||
			(Array.isArray(videoUrl) && videoUrl.every((v) => typeof v === 'string' || Buffer.isBuffer(v) || isObjectVideo(v)));

		if (!isValidPrimitive) {
			throw new TypeError('videoUrl must be string | buffer | object | array');
		}

		const items = Array.isArray(videoUrl) ? videoUrl : [videoUrl];

		this._submessages.push({
			messageType: 2,
			messageText: '[ Video tidak dapat dimuat ]',
		});

		items.forEach((item) => {
			const isObject = isObjectVideo(item);

			const url = isObject
				? Toolkit.resolveMedia(this.#client, item.url ?? '', 'video', { resolveUrl })
				: Toolkit.resolveMedia(this.#client, item, 'video', { resolveUrl });

			const bufferPromise = autoFill ? Promise.resolve(url).then((u) => Toolkit.fetchBuffer(u)) : null;

			const file_length = isObject && item.file_length != null ? item.file_length : autoFill ? bufferPromise.then((b) => b?.length ?? 0) : 0;

			const duration =
				isObject && item.duration != null
					? item.duration
					: autoFill
						? bufferPromise.then((b) =>
								Toolkit.getMp4Duration(b, {
									silent: true,
								})
							)
						: 0;

			const thumbnail =
				isObject && item.thumbnail
					? Toolkit.resolveMedia(this.#client, item.thumbnail, 'image', {
							result: 'base64',
							resize: true,
							width: 300,
							height: 300,
						})
					: autoFill
						? bufferPromise
							? bufferPromise.then((b) =>
									Toolkit.getMp4Preview(b, {
										time: 0,
										result: 'base64',
									})
								)
							: null
						: null;

			this._sections.push(
				AIRich.newLayout('Single', {
					media: {
						url,
						mime_type: isObject ? (item.mime_type ?? 'video/mp4') : 'video/mp4',
						file_length,
						duration,
					},
					imagine_type: 'ANIMATE',
					status: { status: 'READY' },
					thumbnail: {
						raw_media: thumbnail,
					},
					__typename: 'GenAIImaginePrimitive',
				})
			);
		});

		return this;
	}

	addProduct(data = {}, { resolveUrl = false } = {}) {
		if (!((data && typeof data === 'object' && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === 'object' && !Array.isArray(item))))) {
			throw new TypeError('Product items must be an object or an array of objects');
		}

		const itemsToCheck = Array.isArray(data) ? data : [data];
		const missingTitleAt = itemsToCheck.findIndex((item) => !item.title);
		if (missingTitleAt !== -1) {
			throw new TypeError(`addProduct() item[${missingTitleAt}] is missing a required "title"`);
		}

		this._submessages.push({
			messageType: 2,
			messageText: '[ Produk tidak dapat dimuat ]',
		});

		const items = Array.isArray(data) ? data : [data];

		const product = items.map((item) => ({
			title: item.title,
			brand: item.brand,
			price: item.price,
			sale_price: item.sale_price,
			product_url: item.product_url ?? item.url,
			image: {
				url: Toolkit.resolveMedia(this.#client, item.image_url ?? item.image, 'image', { resolveUrl }),
			},
			additional_images: [
				{
					url: Toolkit.resolveMedia(this.#client, item.icon_url ?? item.icon, 'image', { resolveUrl }),
				},
			],
			__typename: 'GenAIProductItemCardPrimitive',
		}));

		this._sections.push(AIRich.newLayout(Array.isArray(data) ? 'HScroll' : 'Single', Array.isArray(data) ? product : product[0]));

		return this;
	}

	addPost(data = {}, { resolveUrl = false } = {}) {
		if (!((data && typeof data === 'object' && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === 'object' && !Array.isArray(item))))) {
			throw new TypeError('Post items must be an object or an array of objects');
		}

		const posts = Array.isArray(data) ? data : [data];

		this._submessages.push({
			messageType: 2,
			messageText: '[ Postingan tidak dapat dimuat ]',
		});

		const primitives = posts.map((p) => ({
			title: p.title ?? '',
			subtitle: p.subtitle ?? '',
			username: p.username ?? '',
			profile_picture_url: Toolkit.resolveMedia(this.#client, p.profile_picture_url ?? p.profile_url ?? p.profile ?? '', 'image', { resolveUrl }),
			is_verified: !!(p.is_verified || p.verified),
			thumbnail_url: Toolkit.resolveMedia(this.#client, p.thumbnail_url ?? p.thumbnail ?? '', 'image', { resolveUrl }),
			post_caption: p.post_caption ?? p.caption ?? '',
			likes_count: p.likes_count ?? p.like ?? 0,
			comments_count: p.comments_count ?? p.comment ?? 0,
			shares_count: p.shares_count ?? p.share ?? 0,
			post_url: p.post_url ?? p.url ?? '',
			post_deeplink: p.post_deeplink ?? p.deeplink ?? '',
			source_app: p.source_app || p.source || 'INSTAGRAM',
			footer_label: p.footer_label ?? p.footer ?? '',
			footer_icon: Toolkit.resolveMedia(this.#client, p.footer_icon ?? p.icon ?? '', 'image', { resolveUrl }),
			is_carousel: posts.length > 1,
			orientation: p.orientation ?? 'LANDSCAPE',
			post_type: p.post_type ?? 'VIDEO',
			__typename: 'GenAIPostPrimitive',
		}));

		this._sections.push(AIRich.newLayout('HScroll', primitives));

		return this;
	}

	setResponseId(id) {
		if (typeof id !== 'string' || !id) throw new TypeError('setResponseId(id) requires a non-empty string');
		this._responseId = id;
		return this;
	}

	refreshResponseId() {
		this._responseId = crypto.randomUUID();
		return this;
	}

	setBotResponseId(id) {
		if (typeof id !== 'string' || !id) throw new TypeError('setBotResponseId(id) requires a non-empty string');
		this._botResponseId = id;
		return this;
	}

	refreshBotResponseId() {
		this._botResponseId = crypto.randomUUID();
		return this;
	}

	hasId(id) {
		return typeof id === 'string' && this._blocks.has(id);
	}

	getIds() {
		return [...this._blocks.keys()];
	}

	peek(id) {
		const block = this._blocks.get(id);
		if (!block) return null;

		return { id, sections: [...block.secItems], submessages: [...block.subItems] };
	}

	delete(id) {
		const block = this._blocks.get(id);
		if (!block) throw new Error(`delete(id): no block registered with id "${id}"`);

		for (const item of block.subItems) {
			const idx = this._submessages.indexOf(item);
			if (idx !== -1) this._submessages.splice(idx, 1);
		}
		for (const item of block.secItems) {
			const idx = this._sections.indexOf(item);
			if (idx !== -1) this._sections.splice(idx, 1);
		}

		this._blocks.delete(id);
		return this;
	}

	addMetadata(text) {
		if (typeof text !== 'string' || !text) throw new TypeError('addMetadata(text) requires a non-empty string');

		this._submessages.push({
			messageType: 2,
			messageText: text,
		});

		this._sections.push(
			AIRich.newLayout('Single', {
				text,
				__typename: 'GenAIMetadataTextPrimitive',
			})
		);

		return this;
	}

	addTip(text) {
		if (typeof text !== 'string' || !text) {
			throw new TypeError('addTip(text) requires a non-empty string');
		}

		this._submessages.push({
			messageType: 2,
			messageText: text,
		});

		this._sections.push(
			AIRich.newLayout('Single', {
				text,
				__typename: 'GenAIMetadataTextPrimitive',
			})
		);

		return this;
	}

	addHeading(text) {
		if (typeof text !== 'string' || !text) {
			throw new TypeError('addHeading(text) requires a non-empty string');
		}

		this._submessages.push({
			messageType: 2,
			messageText: text,
		});

		this._sections.push(
			AIRich.newLayout('Single', {
				text,
				__typename: 'FOATextPrimitive',
			})
		);

		return this;
	}

	addWidget(data = {}, { layout } = {}) {
		const items = Array.isArray(data) ? data : [data];

		if (layout === 'Single' && items.length > 1) {
			throw new TypeError(`addWidget(): layout "Single" can only hold one widget (got ${items.length}) — use "HScroll"/"ActionRow" (or omit layout) for multiple`);
		}

		items.forEach((item, i) => {

			const hasTitle = item?.title || item?.header?.title;
			if (!hasTitle) {
				throw new TypeError(`addWidget() item[${i}] is missing a required "title" (or "header.title")`);
			}
			const ctas = item.ctas ?? item.actions;
			if (!Array.isArray(ctas) || !ctas.length) {
				throw new TypeError(`addWidget() item[${i}] requires a non-empty "ctas" (or "actions") array`);
			}
		});

		this._submessages.push({
			messageType: 2,
			messageText: items.map((item) => item.header?.title ?? item.title).join(', '),
		});

		this._widgetCtaCounter ??= 0;

		const widgets = items.map((item) => {
			const ctas = item.ctas ?? item.actions;

			const headerTitle = item.header?.title ?? item.title;
			const headerSubtitle = item.header?.subtitle ?? item.subtitle ?? undefined;
			return {
				header: {
					title: headerTitle,
					...(headerSubtitle !== undefined && { subtitle: headerSubtitle }),
					__typename: 'GenAI3PExtWidgetStandardHeader',
				},
				body: {
					sections: item.sections ?? [],
					ctas: ctas.map((cta) => ({
						label: cta.label ?? '',
						state: cta.state ?? 'PENDING',
						kind: cta.kind ?? 'OTHER',
						tool_call_id: cta.tool_call_id ?? cta.id ?? String(this._widgetCtaCounter++).padStart(2, '0'),
						...(cta.toast !== false && {
							toast: { label: typeof cta.toast === 'string' ? cta.toast : headerTitle, __typename: 'GenAI3PExtWidgetToast' },
						}),
						__typename: 'GenAI3PExtWidgetCTA',
					})),
					__typename: item.body_typename ?? 'GenAI3PExtCalendarEventList',
				},
				__typename: 'GenAI3PExtWidgetPrimitive',
			};
		});

		const resolvedLayout = layout ?? (Array.isArray(data) ? 'HScroll' : 'Single');
		const asArray = resolvedLayout !== 'Single';

		this._sections.push(AIRich.newLayout(resolvedLayout, asArray ? widgets : widgets[0]));

		return this;
	}

	addFooterAction(actions) {
		const items = Array.isArray(actions) ? actions : [actions];

		items.forEach((item, i) => {
			if (!item?.text || !item?.url) {
				throw new TypeError(`addFooterAction() item[${i}] requires both "text" and "url"`);
			}
		});

		const primitives = items.map((item) => ({
			cta_text: item.text,
			cta_type: item.type ?? 'OPEN_URL',
			cta_url: item.url,
			__typename: 'GenAIFooterActionPrimitive',
		}));

		this._sections.push(AIRich.newLayout('HScroll', primitives));

		return this;
	}

	addDivider() {
		this._submessages.push({ messageType: 2, messageText: '---' });
		this._sections.push(AIRich.newLayout('Single', { __typename: 'GenAIDividerPrimitive' }));
		return this;
	}

	addSpacer(spacing = 1) {
		if (typeof spacing !== 'number' || spacing < 0) {
			throw new TypeError('addSpacer(spacing) requires a non-negative number');
		}
		this._submessages.push({ messageType: 2, messageText: `spasi ${spacing}` });
		this._sections.push(AIRich.newLayout('Single', { spacing, __typename: 'GenAISpacerPrimitive' }));
		return this;
	}

	addLatex(expression) {
		if (typeof expression !== 'string' || !expression) {
			throw new TypeError('addLatex(expression) requires a non-empty string');
		}
		this._submessages.push({
			messageType: 8,
			latexMetadata: { text: expression, expressions: [{ latexExpression: expression }] },
		});
		this._sections.push(AIRich.newLayout('Single', { latex_expression: expression, __typename: 'GenAILatexUXPrimitive' }));
		return this;
	}

	addTask(data = {}) {
		if (!data?.title) {
			throw new TypeError('addTask() requires a "title"');
		}
		this._submessages.push({ messageType: 2, messageText: `Tugas: ${data.title}` });
		this._sections.push(
			AIRich.newLayout('Single', {
				task_id: data.task_id ?? '',
				title: data.title,
				subtitle: data.subtitle ?? '',
				status: data.status ?? 'IN_PROGRESS',
				__typename: 'GenAITaskPrimitive',
			})
		);

		if (data.textFallback !== false) {
			const fallbackText = data.subtitle ? `${data.title} — ${data.subtitle}` : data.title;
			this._sections.push(AIRich.newLayout('Single', { text: `Tugas: ${fallbackText}`, __typename: 'FOATextPrimitive' }));
		}
		return this;
	}

	addProgressStatus(title, { icon = 'SEARCH', is_in_progress = true, target_secondary_screen_id, target_secondary_screen_tab_id } = {}) {
		if (typeof title !== 'string' || !title) {
			throw new TypeError('addProgressStatus(title) requires a non-empty string');
		}
		this._submessages.push({ messageType: 2, messageText: title });
		const primitive = {
			title,
			icon,
			is_in_progress,
			meta_search_apps: [],
			__typename: 'GenAIBotProgressStatusPrimitive',
		};

		if (target_secondary_screen_id != null) primitive.target_secondary_screen_id = target_secondary_screen_id;
		if (target_secondary_screen_tab_id != null) primitive.target_secondary_screen_tab_id = target_secondary_screen_tab_id;
		this._sections.push(AIRich.newLayout('Single', primitive));
		return this;
	}

	addThinkingStatus(title, { icon = 'THINKING', is_in_progress = true, target_secondary_screen_id, target_secondary_screen_tab_id, textFallback = true } = {}) {
		if (typeof title !== 'string' || !title) {
			throw new TypeError('addThinkingStatus(title) requires a non-empty string');
		}
		this._submessages.push({ messageType: 2, messageText: title });
		const primitive = {
			title,
			icon,
			is_in_progress,
			meta_search_apps: [],
			__typename: 'GenAIBotThinkingStatusPrimitive',
		};

		if (target_secondary_screen_id != null) primitive.target_secondary_screen_id = target_secondary_screen_id;
		if (target_secondary_screen_tab_id != null) primitive.target_secondary_screen_tab_id = target_secondary_screen_tab_id;
		this._sections.push(AIRich.newLayout('Single', primitive));

		if (textFallback) {
			this._sections.push(AIRich.newLayout('Single', { text: title, __typename: 'FOATextPrimitive' }));
		}
		return this;
	}

	addQuotaUpsell(data = {}) {
		if (!data?.title) {
			throw new TypeError('addQuotaUpsell() requires a "title"');
		}
		this._submessages.push({ messageType: 2, messageText: data.title });
		this._sections.push(
			AIRich.newLayout('Single', {
				title: data.title,
				body: data.body ?? '',
				body_line1: data.body_line1 ?? '',
				body_line2: data.body_line2 ?? '',
				buttons: (data.buttons ?? []).map((b) => ({
					label: b.label ?? '',
					action: b.action ?? 'OPEN_DEEPLINK',
					deeplink: b.deeplink ?? '',
				})),
				__typename: 'GenAIMetaSubsQuotaUpsellPrimitive',
			})
		);
		return this;
	}

	addBloks(data = {}) {
		if (!data?.type) {
			throw new TypeError('addBloks() requires a "type"');
		}
		this._submessages.push({ messageType: 2, messageText: 'Bloks' });
		const primitive = {
			type: data.type,
			data: data.data ?? '{}',
			uuid: data.uuid ?? '',
			versioning_id: data.versioning_id ?? '',
			__typename: 'FOABloksPrimitive',
		};

		if (data.initial_response != null) primitive.initial_response = data.initial_response;
		this._sections.push(AIRich.newLayout('Single', primitive));

		if (data.textFallback !== false) {
			this._sections.push(AIRich.newLayout('Single', { text: `Bloks: ${data.type}`, __typename: 'FOATextPrimitive' }));
		}
		return this;
	}

	addSuggest(suggestion, { scroll = true, layout } = {}) {
		if (!(typeof suggestion === 'string' || (Array.isArray(suggestion) && suggestion.every((v) => typeof v === 'string')))) {
			throw new TypeError('Suggestion must be a string or array of strings');
		}

		const suggest = Array.isArray(suggestion)
			? suggestion.map((text) => ({
					prompt_text: text,
					prompt_type: 'SUGGESTED_PROMPT',
					__typename: 'GenAIFollowUpSuggestionPillPrimitive',
				}))
			: [
					{
						prompt_text: suggestion,
						prompt_type: 'SUGGESTED_PROMPT',
						__typename: 'GenAIFollowUpSuggestionPillPrimitive',
					},
				];

		const type = layout ?? (suggest.length === 1 ? 'Single' : scroll ? 'HScroll' : 'ActionRow');

		this._sections.push(AIRich.newLayout(type, type === 'Single' ? suggest[0] : suggest, { __typename: 'GenAIUnifiedResponseSection' }));

		return this;
	}

	async build({ forwarded = true, notification = false, includesUnifiedResponse = true, includesSubmessages = true, quoted, quotedParticipant, ...options } = {}) {
		const forward = forwarded
			? {
					forwardingScore: 1,
					isForwarded: true,
					forwardedAiBotMessageInfo: { botJid: '0@bot' },
					forwardOrigin: 4,
				}
			: {};

		const notif = notification
			? {
					sessionTransparencyMetadata: {
						disclaimerText: '~ Ahmad tumbuh kembang',
						hcaId: `hca_${Date.now()}`,
						sessionTransparencyType: 1,
					},
				}
			: {};

		const qObj = quoted
			? {
					stanzaId: quoted?.key?.id || quoted?.id,
					participant: quotedParticipant || quoted?.key?.participant || quoted?.key?.remoteJid,
					quotedType: 0,
					quotedMessage: typeof quoted === 'object' && quoted !== null ? (quoted.message ?? quoted) : undefined,
				}
			: {};

		const sections = this._footer
			? [
					...(await waitAllPromises(this._sections)),
					AIRich.newLayout('Single', {
						text: this._footer,
						__typename: 'GenAIMetadataTextPrimitive',
					}),
				]
			: [...(await waitAllPromises(this._sections))];

		const responseId = this._responseId ?? crypto.randomUUID();
		const botResponseId = this._botResponseId ?? crypto.randomUUID();

		return {
			messageContextInfo: {
				deviceListMetadata: {},
				deviceListMetadataVersion: 2,
				botMetadata: {
					messageDisclaimerText: this._title,
					richResponseSourcesMetadata: { sources: this._richResponseSources },
					botResponseId: botResponseId,
					verificationMetadata: {
						proofs: [
							{
								certificateChain: [botMetadataCertificate(), botMetadataCertificate(892)],
								version: 1,
								useCase: 1,
								signature: botMetadataSignature(),
							},
						],
					},
					...notif,
				},
			},
			...this._extraPayload,
			botForwardedMessage: {
				message: {
					richResponseMessage: {
						messageType: 1,
						submessages: includesSubmessages ? await waitAllPromises(this._submessages) : [],
						unifiedResponse: {
							data: includesUnifiedResponse ? Buffer.from(JSON.stringify({ response_id: responseId, sections })).toString('base64') : '',
						},
						contextInfo: {
							...forward,
							...qObj,
							...this._contextInfo,
						},
					},
				},
			},
		};
	}

	async send(jid, { forwarded, notification, includesUnifiedResponse, includesSubmessages, skipImageFallback = false, quoted, messageId, ...options } = {}) {
		const msg = await this.build({ forwarded, notification, includesUnifiedResponse, includesSubmessages, quoted, ...options });

		if (!skipImageFallback && this._inlineImages.length) {
			for (const { url, caption } of this._inlineImages) {
				try {
					await this.#client.sendMessage(jid, { image: { url }, caption }, quoted ? { quoted } : {});
				} catch (err) {

					this.#client.logger?.warn?.({ err, url }, 'inline image fallback failed, continuing with rich card');
				}
			}
		}

		messageId = messageId || generateMessageIDV2();

		await this.#client.relayMessage(jid, msg, { messageId, ...options });

		this._lastMessageKey = { remoteJid: jid, fromMe: true, id: messageId };

		return { key: this._lastMessageKey, message: msg };
	}

	async buildEdit(targetJid, targetId, { msg, messageId, ...options } = {}) {
		const editedMessage = msg || (await this.build({ ...options }));

		if (!editedMessage) {
			throw new Error('buildEdit: no message content to edit (build() returned nothing)');
		}

		return generateWAMessageFromContent(
			targetJid,
			{
				protocolMessage: {
					key: {
						remoteJid: targetJid,
						fromMe: true,
						id: targetId,
					},
					type: 14,
					editedMessage,
				},
			},
			{ messageId: messageId || generateMessageIDV2(), ...options }
		);
	}

	async sendEdit(jid, id, { msg, messageId, additionalNodes = [], ...options } = {}) {
		jid = jid ?? this._lastMessageKey?.remoteJid;
		id = id ?? this._lastMessageKey?.id;

		if (!jid) {
			throw new Error('sendEdit: no jid — pass one explicitly, or call send() first');
		}

		if (!id) {
			throw new Error('sendEdit: no message id — pass one explicitly, or call send() first');
		}

		const msgEdit = await this.buildEdit(jid, id, {
			msg,
			messageId: messageId || generateMessageIDV2(),
			...options,
		});

		await this.#client.relayMessage(jid, msgEdit.message, {
			messageId: msgEdit.key.id,
			additionalNodes,
		});

		return msgEdit;
	}

	static tokenizer(code, lang = 'javascript') {
		const keywordsMap = {
			javascript: new Set([
				'break',
				'case',
				'catch',
				'continue',
				'debugger',
				'delete',
				'do',
				'else',
				'finally',
				'for',
				'function',
				'if',
				'in',
				'instanceof',
				'new',
				'return',
				'switch',
				'this',
				'throw',
				'try',
				'typeof',
				'var',
				'void',
				'while',
				'with',
				'true',
				'false',
				'null',
				'undefined',
				'class',
				'const',
				'let',
				'super',
				'extends',
				'export',
				'import',
				'yield',
				'static',
				'constructor',
				'async',
				'await',
				'get',
				'set',
			]),

			typescript: new Set([
				'abstract',
				'any',
				'as',
				'asserts',
				'bigint',
				'boolean',
				'declare',
				'enum',
				'implements',
				'infer',
				'interface',
				'is',
				'keyof',
				'module',
				'namespace',
				'never',
				'readonly',
				'require',
				'number',
				'object',
				'override',
				'private',
				'protected',
				'public',
				'satisfies',
				'string',
				'symbol',
				'type',
				'unknown',
				'using',
				'from',
				'break',
				'case',
				'catch',
				'continue',
				'do',
				'else',
				'finally',
				'for',
				'function',
				'if',
				'new',
				'return',
				'switch',
				'this',
				'throw',
				'try',
				'var',
				'void',
				'while',
				'class',
				'const',
				'let',
				'extends',
				'import',
				'export',
				'async',
				'await',
			]),

			python: new Set([
				'False',
				'None',
				'True',
				'and',
				'as',
				'assert',
				'async',
				'await',
				'break',
				'class',
				'continue',
				'def',
				'del',
				'elif',
				'else',
				'except',
				'finally',
				'for',
				'from',
				'global',
				'if',
				'import',
				'in',
				'is',
				'lambda',
				'nonlocal',
				'not',
				'or',
				'pass',
				'raise',
				'return',
				'try',
				'while',
				'with',
				'yield',
			]),

			java: new Set([
				'abstract',
				'assert',
				'boolean',
				'break',
				'byte',
				'case',
				'catch',
				'char',
				'class',
				'const',
				'continue',
				'default',
				'do',
				'double',
				'else',
				'enum',
				'extends',
				'final',
				'finally',
				'float',
				'for',
				'goto',
				'if',
				'implements',
				'import',
				'instanceof',
				'int',
				'interface',
				'long',
				'native',
				'new',
				'package',
				'private',
				'protected',
				'public',
				'return',
				'short',
				'static',
				'strictfp',
				'super',
				'switch',
				'synchronized',
				'this',
				'throw',
				'throws',
				'transient',
				'try',
				'void',
				'volatile',
				'while',
			]),

			golang: new Set([
				'break',
				'case',
				'chan',
				'const',
				'continue',
				'default',
				'defer',
				'else',
				'fallthrough',
				'for',
				'func',
				'go',
				'goto',
				'if',
				'import',
				'interface',
				'map',
				'package',
				'range',
				'return',
				'select',
				'struct',
				'switch',
				'type',
				'var',
			]),

			c: new Set([
				'auto',
				'break',
				'case',
				'char',
				'const',
				'continue',
				'default',
				'do',
				'double',
				'else',
				'enum',
				'extern',
				'float',
				'for',
				'goto',
				'if',
				'int',
				'long',
				'register',
				'return',
				'short',
				'signed',
				'sizeof',
				'static',
				'struct',
				'switch',
				'typedef',
				'union',
				'unsigned',
				'void',
				'volatile',
				'while',
			]),

			cpp: new Set([
				'alignas',
				'alignof',
				'and',
				'auto',
				'bool',
				'break',
				'case',
				'catch',
				'class',
				'const',
				'constexpr',
				'continue',
				'delete',
				'do',
				'double',
				'else',
				'enum',
				'explicit',
				'export',
				'extern',
				'false',
				'float',
				'for',
				'friend',
				'if',
				'inline',
				'int',
				'long',
				'mutable',
				'namespace',
				'new',
				'noexcept',
				'nullptr',
				'operator',
				'private',
				'protected',
				'public',
				'return',
				'short',
				'signed',
				'sizeof',
				'static',
				'struct',
				'switch',
				'template',
				'this',
				'throw',
				'true',
				'try',
				'typedef',
				'typename',
				'union',
				'unsigned',
				'using',
				'virtual',
				'void',
				'while',
			]),

			php: new Set([
				'abstract',
				'and',
				'array',
				'as',
				'break',
				'callable',
				'case',
				'catch',
				'class',
				'clone',
				'const',
				'continue',
				'declare',
				'default',
				'do',
				'echo',
				'else',
				'elseif',
				'empty',
				'enddeclare',
				'endfor',
				'endforeach',
				'endif',
				'endswitch',
				'endwhile',
				'extends',
				'final',
				'finally',
				'fn',
				'for',
				'foreach',
				'function',
				'global',
				'goto',
				'if',
				'implements',
				'include',
				'include_once',
				'instanceof',
				'interface',
				'match',
				'namespace',
				'new',
				'null',
				'or',
				'private',
				'protected',
				'public',
				'require',
				'require_once',
				'return',
				'static',
				'switch',
				'throw',
				'trait',
				'try',
				'use',
				'var',
				'while',
				'yield',
			]),

			rust: new Set([
				'as',
				'break',
				'const',
				'continue',
				'crate',
				'else',
				'enum',
				'extern',
				'false',
				'fn',
				'for',
				'if',
				'impl',
				'in',
				'let',
				'loop',
				'match',
				'mod',
				'move',
				'mut',
				'pub',
				'ref',
				'return',
				'self',
				'Self',
				'static',
				'struct',
				'super',
				'trait',
				'true',
				'type',
				'unsafe',
				'use',
				'where',
				'while',
			]),

			html: new Set([
				'html',
				'head',
				'body',
				'div',
				'span',
				'p',
				'a',
				'img',
				'video',
				'audio',
				'script',
				'style',
				'link',
				'meta',
				'form',
				'input',
				'button',
				'table',
				'tr',
				'td',
				'th',
				'ul',
				'ol',
				'li',
				'section',
				'article',
				'header',
				'footer',
				'nav',
				'main',
			]),

			bash: new Set([
				'if',
				'then',
				'else',
				'elif',
				'fi',
				'for',
				'while',
				'do',
				'done',
				'case',
				'esac',
				'function',
				'in',
				'select',
				'until',
				'break',
				'continue',
				'return',
				'export',
				'readonly',
				'local',
				'declare',
			]),

			markdown: new Set(['#', '##', '###', '####', '#####', '######']),
		};

		if (!lang || lang === 'txt' || lang === 'text' || lang === 'plaintext') {
			return {
				codeBlock: [
					{
						codeContent: code,
						highlightType: 0,
					},
				],
				unified_codeBlock: [
					{
						content: code,
						type: 'DEFAULT',
					},
				],
			};
		}

		const TYPE_MAP = {
			0: 'DEFAULT',
			1: 'KEYWORD',
			2: 'METHOD',
			3: 'STR',
			4: 'NUMBER',
			5: 'COMMENT',
		};

		const keywords = keywordsMap[lang.toLowerCase()] || new Set();
		const tokens = [];

		let i = 0;

		const push = (content, type) => {
			if (!content) return;

			const last = tokens[tokens.length - 1];

			if (last && last.highlightType === type) {
				last.codeContent += content;
			} else {
				tokens.push({
					codeContent: content,
					highlightType: type,
				});
			}
		};

		const isIdentifier = (char) => {
			switch (lang.toLowerCase()) {
				case 'css':
					return /[a-zA-Z0-9_$-]/.test(char);

				case 'html':
					return /[a-zA-Z0-9_$:-]/.test(char);

				default:
					return /[a-zA-Z0-9_$]/.test(char);
			}
		};

		while (i < code.length) {
			const c = code[i];

			if (/\s/.test(c)) {
				let s = i;

				while (i < code.length && /\s/.test(code[i])) {
					i++;
				}

				push(code.slice(s, i), 0);
				continue;
			}

			if ((c === '/' && code[i + 1] === '/') || (c === '#' && ['python', 'bash'].includes(lang))) {
				let s = i;

				while (i < code.length && code[i] !== '\n') {
					i++;
				}

				push(code.slice(s, i), 5);
				continue;
			}

			if (c === '"' || c === "'" || c === '`') {
				let s = i;
				const q = c;

				i++;

				while (i < code.length) {
					if (code[i] === '\\' && i + 1 < code.length) {
						i += 2;
					} else if (code[i] === q) {
						i++;
						break;
					} else {
						i++;
					}
				}

				push(code.slice(s, i), 3);
				continue;
			}

			if (/[0-9]/.test(c)) {
				let s = i;

				while (i < code.length && /[0-9._]/.test(code[i])) {
					i++;
				}

				push(code.slice(s, i), 4);
				continue;
			}

			if (/[a-zA-Z_$]/.test(c)) {
				let s = i;

				while (i < code.length && isIdentifier(code[i])) {
					i++;
				}

				const word = code.slice(s, i);

				let type = 0;

				if (keywords.has(word)) {
					type = 1;
				} else if (lang === 'css') {
					let j = i;

					while (j < code.length && /\s/.test(code[j])) {
						j++;
					}

					if (code[j] === ':') {
						type = 1;
					}
				} else if (lang === 'html') {
					let p = s - 1;

					while (p >= 0 && /\s/.test(code[p])) {
						p--;
					}

					if (code[p] === '<' || (code[p] === '/' && code[p - 1] === '<')) {
						type = 1;
					}
				}

				if (type === 0) {
					let j = i;

					while (j < code.length && /\s/.test(code[j])) {
						j++;
					}

					if (code[j] === '(') {
						type = 2;
					}
				}

				push(word, type);
				continue;
			}

			push(c, 0);
			i++;
		}

		return {
			codeBlock: tokens,
			unified_codeBlock: tokens.map((t) => ({
				content: t.codeContent,
				type: TYPE_MAP[t.highlightType],
			})),
		};
	}

	static toTableMetadata(arr, { hyperlink = true, citation = true, latex = true } = {}) {
		if (!Array.isArray(arr) || !arr.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'))) {
			throw new TypeError('Table must be a nested array of strings');
		}

		const [header, ...rows] = arr;

		const maxLen = Math.max(header.length, ...rows.map((r) => r.length));

		const normalize = (r) => [...r, ...Array(maxLen - r.length).fill('')];

		const unified_rows = [
			{
				is_header: true,
				cells: normalize(header),
			},
			...rows.map((r) => ({
				is_header: false,
				cells: normalize(r),
			})),
		].map((row) => {
			const markdown_cells = row.cells.map((cell) => {
				const extracted = extractIE(cell, { hyperlink, citation, latex });

				return {
					text: extracted.text,
					...(extracted.inline_entities.length ? { inline_entities: extracted.inline_entities } : {}),
				};
			});

			return {
				...row,
				...(markdown_cells.some((c) => c.inline_entities?.length) ? { markdown_cells } : {}),
			};
		});

		const rowsMeta = unified_rows.map((r) => ({
			items: r.cells,
			...(r.is_header ? { isHeading: true } : {}),
		}));

		return {
			title: '',
			rows: rowsMeta,
			unified_rows,
		};
	}

	addGenerating({ imagine_type = 'IMAGE', estimated_completion_time, textFallback = true } = {}) {
		this._submessages.push({ messageType: 2, messageText: '[ Sedang diproses... ]' });
		this._sections.push(
			AIRich.newLayout('Single', {
				media: { url: '', mime_type: imagine_type === 'ANIMATE' ? 'video/mp4' : 'image/png' },
				imagine_type,
				status: {
					status: 'GENERATING',
					estimated_completion_time: estimated_completion_time ?? Math.floor(Date.now() / 1000) + 30,
				},
				__typename: 'GenAIImaginePrimitive',
			})
		);

		if (textFallback) {
			this._sections.push(AIRich.newLayout('Single', { text: '[ Sedang diproses... ]', __typename: 'FOATextPrimitive' }));
		}
		return this;
	}

	static async sendSupportPayload(client, jid, text, { ticketId = crypto.randomUUID(), isAiMessage = true, shouldShowSystemMessage = true, version = 1 } = {}) {
		if (!client) throw new Error('Socket is required');
		if (typeof text !== 'string' || !text) throw new TypeError('sendSupportPayload(client, jid, text) requires a non-empty string text');

		const msg = {
			conversation: text,
			messageContextInfo: {
				messageSecret: crypto.randomBytes(32),
				supportPayload: JSON.stringify({
					version,
					is_ai_message: isAiMessage,
					should_show_system_message: shouldShowSystemMessage,
					ticket_id: ticketId,
				}),
			},
		};

		return client.relayMessage(jid, msg, {
			additionalNodes: [
				{ tag: 'bot', attrs: { biz_bot: '1' } },
				{ tag: 'biz', attrs: {} },
			],
		});
	}

	static async sendPairedMedia(client, jid, { image, video } = {}) {
		if (!client) throw new Error('Socket is required');
		if (!image || !video) throw new TypeError('sendPairedMedia() requires both "image" and "video"');

		const imagePrepared = await prepareWAMessageMedia(
			{ image: typeof image === 'string' ? { url: image } : image },
			{ upload: client.waUploadToServer }
		);
		const videoPrepared = await prepareWAMessageMedia(
			{ video: typeof video === 'string' ? { url: video } : video },
			{ upload: client.waUploadToServer }
		);

		const imageMsg = generateWAMessageFromContent(
			jid,
			{
				imageMessage: {
					...imagePrepared.imageMessage,
					contextInfo: { pairedMediaType: 5, statusSourceType: 0 },
				},
			},
			{}
		);

		await client.relayMessage(jid, imageMsg.message, { messageId: imageMsg.key.id });

		await client.relayMessage(
			jid,
			{
				videoMessage: {
					...videoPrepared.videoMessage,
					contextInfo: { pairedMediaType: 6, statusSourceType: 0 },
				},
				messageContextInfo: {
					messageAssociation: { associationType: 12, parentMessageKey: imageMsg.key },
				},
			},
			{}
		);

		return imageMsg.key;
	}

	static newLayout(name, data, extra = {}) {
		return {
			...extra,
			view_model: {
				[Array.isArray(data) ? 'primitives' : 'primitive']: data,
				__typename: `GenAI${name}LayoutViewModel`,
			},
		};
	}
}

class ORich extends AIRich {}

export { AIRich, ORich };
