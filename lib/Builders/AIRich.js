import { BaseBuilder, Toolkit, extractIE, waitAllPromises, botMetadataSignature, botMetadataCertificate, crypto, generateWAMessageFromContent, prepareWAMessageMedia, generateMessageIDV2 } from './shared.js';

class AIRichError extends Error {
	constructor(message, code = 'AIRICH_ERROR', meta = {}) {
		super(message);
		this.name = 'AIRichError';
		this.code = code;
		Object.assign(this, meta);
	}
}
class ItemNotFoundError extends AIRichError {
	constructor(message, meta = {}) { super(message, 'ITEM_NOT_FOUND', meta); this.name = 'ItemNotFoundError'; }
}
class DuplicateIdError extends AIRichError {
	constructor(message, meta = {}) { super(message, 'DUPLICATE_ID', meta); this.name = 'DuplicateIdError'; }
}
class ContentValidationError extends AIRichError {
	constructor(message, meta = {}) { super(message, 'CONTENT_VALIDATION', meta); this.name = 'ContentValidationError'; }
}

const NON_BLOCK_SETTERS = new Set(['setQuoted', 'setUnifiedResponseData', 'setMentions']);

function withBlockTracking(target, { subField = '_submessages', secField = '_sections' } = {}) {
	target._blocks = new Map();
	target._lastBlock = null;

	return new Proxy(target, {
		get(target, prop, receiver) {
			const orig = Reflect.get(target, prop, receiver);
			if (typeof orig !== 'function') return orig;

			if (!/^(add|set)/.test(String(prop)) || NON_BLOCK_SETTERS.has(String(prop))) {
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
					throw new DuplicateIdError(`add*/set*: id "${id}" is already registered — each id must be unique (pass { replace: "${id}" } to update that block instead, or use a different id)`);
				}

				const subBefore = target[subField].length;
				const secBefore = target[secField].length;

				const result = orig.apply(target, args);

				const subItems = target[subField].splice(subBefore);
				const secItems = target[secField].splice(secBefore);

				if (insertAt) {
					const anchor = target._blocks.get(insertAt);
					if (!anchor) throw new ItemNotFoundError(`insertAt: no block registered with id "${insertAt}" (register it by passing { id: "${insertAt}" } on an earlier add*() call)`);

					const lastSub = anchor.subItems[anchor.subItems.length - 1];
					const subIdx = lastSub ? target[subField].indexOf(lastSub) + 1 : target[subField].length;
					target[subField].splice(subIdx, 0, ...subItems);

					const lastSec = anchor.secItems[anchor.secItems.length - 1];
					const secIdx = lastSec ? target[secField].indexOf(lastSec) + 1 : target[secField].length;
					target[secField].splice(secIdx, 0, ...secItems);
				} else if (replace) {
					const old = target._blocks.get(replace);
					if (!old) throw new ItemNotFoundError(`replace: no block registered with id "${replace}" (register it first with { id: "${replace}" })`);

					let subIdx = old.subItems.length > 0 ? target[subField].indexOf(old.subItems[0]) : target[subField].length;
					if (subIdx === -1) subIdx = target[subField].length;
					for (const item of old.subItems) {
						const i = target[subField].indexOf(item);
						if (i !== -1) target[subField].splice(i, 1);
					}
					target[subField].splice(subIdx, 0, ...subItems);

					let secIdx = old.secItems.length > 0 ? target[secField].indexOf(old.secItems[0]) : target[secField].length;
					if (secIdx === -1) secIdx = target[secField].length;
					for (const item of old.secItems) {
						const i = target[secField].indexOf(item);
						if (i !== -1) target[secField].splice(i, 1);
					}
					target[secField].splice(secIdx, 0, ...secItems);

					target._blocks.delete(replace);
					if (id) target._blocks.set(id, { subItems, secItems });
					else target._blocks.set(replace, { subItems, secItems });
				} else {
					target[subField].push(...subItems);
					target[secField].push(...secItems);
				}

				if (id) target._blocks.set(id, { subItems, secItems });

				target._lastBlock = !id && !replace && (subItems.length || secItems.length) ? { subItems, secItems } : null;

				return result === target ? receiver : result;
			};
		},
	});
}

export function tokenizeCodeForRich(code, lang = 'javascript') {
	const keywordsMap = {
		javascript: new Set(['break', 'case', 'catch', 'continue', 'debugger', 'delete', 'do', 'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof', 'new', 'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'true', 'false', 'null', 'undefined', 'class', 'const', 'let', 'super', 'extends', 'export', 'import', 'yield', 'static', 'constructor', 'async', 'await', 'get', 'set']),
		typescript: new Set(['abstract', 'any', 'as', 'asserts', 'bigint', 'boolean', 'declare', 'enum', 'implements', 'infer', 'interface', 'is', 'keyof', 'module', 'namespace', 'never', 'readonly', 'require', 'number', 'object', 'override', 'private', 'protected', 'public', 'satisfies', 'string', 'symbol', 'type', 'unknown', 'using', 'from', 'break', 'case', 'catch', 'continue', 'do', 'else', 'finally', 'for', 'function', 'if', 'new', 'return', 'switch', 'this', 'throw', 'try', 'var', 'void', 'while', 'class', 'const', 'let', 'extends', 'import', 'export', 'async', 'await']),
		python: new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']),
		java: new Set(['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while']),
		golang: new Set(['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var']),
		c: new Set(['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'int', 'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while']),
		cpp: new Set(['alignas', 'alignof', 'and', 'auto', 'bool', 'break', 'case', 'catch', 'class', 'const', 'constexpr', 'continue', 'delete', 'do', 'double', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept', 'nullptr', 'operator', 'private', 'protected', 'public', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'while']),
		php: new Set(['abstract', 'and', 'array', 'as', 'break', 'callable', 'case', 'catch', 'class', 'clone', 'const', 'continue', 'declare', 'default', 'do', 'echo', 'else', 'elseif', 'empty', 'enddeclare', 'endfor', 'endforeach', 'endif', 'endswitch', 'endwhile', 'extends', 'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto', 'if', 'implements', 'include', 'include_once', 'instanceof', 'interface', 'match', 'namespace', 'new', 'null', 'or', 'private', 'protected', 'public', 'require', 'require_once', 'return', 'static', 'switch', 'throw', 'trait', 'try', 'use', 'var', 'while', 'yield']),
		rust: new Set(['as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while']),
		html: new Set(['html', 'head', 'body', 'div', 'span', 'p', 'a', 'img', 'video', 'audio', 'script', 'style', 'link', 'meta', 'form', 'input', 'button', 'table', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'section', 'article', 'header', 'footer', 'nav', 'main']),
		bash: new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'in', 'select', 'until', 'break', 'continue', 'return', 'export', 'readonly', 'local', 'declare']),
		markdown: new Set(['#', '##', '###', '####', '#####', '######']),
	};

	if (!lang || lang === 'txt' || lang === 'text' || lang === 'plaintext') {
		return {
			codeBlock: [{ codeContent: code, highlightType: 0 }],
			unified_codeBlock: [{ content: code, type: 'DEFAULT' }],
		};
	}

	const TYPE_MAP = { 0: 'DEFAULT', 1: 'KEYWORD', 2: 'METHOD', 3: 'STR', 4: 'NUMBER', 5: 'COMMENT' };

	const keywords = keywordsMap[lang.toLowerCase()] || new Set();
	const tokens = [];

	let i = 0;

	const push = (content, type) => {
		if (!content) return;
		const last = tokens[tokens.length - 1];
		if (last && last.highlightType === type) {
			last.codeContent += content;
		} else {
			tokens.push({ codeContent: content, highlightType: type });
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
			while (i < code.length && /\s/.test(code[i])) i++;
			push(code.slice(s, i), 0);
			continue;
		}

		if ((c === '/' && code[i + 1] === '/') || (c === '#' && ['python', 'bash'].includes(lang))) {
			let s = i;
			while (i < code.length && code[i] !== '\n') i++;
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
			while (i < code.length && /[0-9._]/.test(code[i])) i++;
			push(code.slice(s, i), 4);
			continue;
		}

		if (/[a-zA-Z_$]/.test(c)) {
			let s = i;
			while (i < code.length && isIdentifier(code[i])) i++;

			const word = code.slice(s, i);
			let type = 0;

			if (keywords.has(word)) {
				type = 1;
			} else if (lang === 'css') {
				let j = i;
				while (j < code.length && /\s/.test(code[j])) j++;
				if (code[j] === ':') type = 1;
			} else if (lang === 'html') {
				let p = s - 1;
				while (p >= 0 && /\s/.test(code[p])) p--;
				if (code[p] === '<' || (code[p] === '/' && code[p - 1] === '<')) type = 1;
			}

			if (type === 0) {
				let j = i;
				while (j < code.length && /\s/.test(code[j])) j++;
				if (code[j] === '(') type = 2;
			}

			push(word, type);
			continue;
		}

		push(c, 0);
		i++;
	}

	return {
		codeBlock: tokens,
		unified_codeBlock: tokens.map((t) => ({ content: t.codeContent, type: TYPE_MAP[t.highlightType] })),
	};
}

class AIRich extends BaseBuilder {
	#client;

	constructor(client, { dynamic = true, unsupportedTypeAlert = true } = {}) {
		if (!client) {
			throw new Error('Socket is required');
		}

		super();
		this.#client = client;
		this._contextInfo = {};
		this._sections = [];
		this._submessages = [];
		this._unsupportedTypeAlert = !!unsupportedTypeAlert;
		this._dynamic = !!dynamic;
		this._responseId = crypto.randomUUID();
		this._botResponseId = crypto.randomUUID();
		this._lastMessageKey = null;
		this._inlineImages = [];
		this._title = '';
		this._botMetadataExtra = {};
		this._forwardBotJid = '867051314767696@bot';
		this._embeddedScreens = [];
		this._verification = true;
		this._notification = false;
		this._notificationText = undefined;
		this._mentions = [];
		this._quoted = undefined;
		this._quotedParticipant = undefined;
		this._noContextInfo = false;
		this._unifiedResponseData = undefined;
		this._messageSecret = false;
		this._bypassDownload = true;

		return withBlockTracking(this, { subField: '_submessages', secField: '_sections' });
	}

	loadFrom(msg) {
		if (!msg) throw new Error('AI Rich message needed');

		const message = msg.message ?? msg;

		let richResponseMessage = message?.botForwardedMessage?.message?.richResponseMessage;
		if (!richResponseMessage) richResponseMessage = message?.botForwardedMessage?.richResponseMessage;
		if (!richResponseMessage) richResponseMessage = message?.richResponseMessage;
		if (!richResponseMessage) throw new Error('richResponseMessage not found');

		const messageContextInfo = message?.messageContextInfo ?? {};
		const botMetadata = messageContextInfo?.botMetadata ?? {};

		this._title = botMetadata?.messageDisclaimerText ?? '';
		this._contextInfo = structuredClone(richResponseMessage?.contextInfo ?? {});
		this._submessages = Array.isArray(richResponseMessage?.submessages) ? structuredClone(richResponseMessage.submessages) : [];
		this._sections = [];

		const unifiedData = richResponseMessage?.unifiedResponse?.data;
		if (unifiedData) {
			try {
				const decoded = Buffer.from(unifiedData, 'base64').toString('utf8');
				const unifiedResponse = JSON.parse(decoded);
				if (Array.isArray(unifiedResponse?.sections)) this._sections = structuredClone(unifiedResponse.sections);
			} catch {
				// malformed/foreign unifiedResponse.data — fall back to empty sections rather than
				// throw; submessages (already loaded above) still render on their own.
			}
		}

		this._blocks = new Map();
		this._lastBlock = null;

		this._extraPayload = {};
		for (const [key, value] of Object.entries(message ?? {})) {
			if (key !== 'messageContextInfo' && key !== 'botForwardedMessage' && key !== 'richResponseMessage') {
				this._extraPayload[key] = structuredClone(value);
			}
		}

		if (msg?.key?.remoteJid && msg?.key?.id) {
			this._lastMessageKey = { remoteJid: msg.key.remoteJid, fromMe: !!msg.key.fromMe, id: msg.key.id };
		}

		return this;
	}

	setResponseId(id) {
		if (typeof id !== 'string') throw new TypeError('ID must be a string');
		this._responseId = id;
		return this;
	}

	refreshResponseId() {
		this._responseId = crypto.randomUUID();
		return this;
	}

	setBotResponseId(id) {
		if (typeof id !== 'string') throw new TypeError('ID must be a string');
		this._botResponseId = id;
		return this;
	}

	refreshBotResponseId() {
		this._botResponseId = crypto.randomUUID();
		return this;
	}

	setTitle(title) {
		if (typeof title !== 'string') {
			throw new TypeError('setTitle(title) requires a string');
		}
		this._title = title;
		return this;
	}

	setBotMetadata(extra) {
		if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
			throw new TypeError('setBotMetadata(extra) requires a plain object');
		}
		this._botMetadataExtra = { ...this._botMetadataExtra, ...extra };
		return this;
	}

	setForwardBotJid(jid) {
		if (typeof jid !== 'string' || !jid.endsWith('@bot')) {
			throw new TypeError("setForwardBotJid(jid) requires a string ending in '@bot'");
		}
		this._forwardBotJid = jid;
		return this;
	}

	setForwardBotJID(jid) {
		return this.setForwardBotJid(jid);
	}

	setVerificationMetadata(enabled = true) {
		this._verification = !!enabled;
		return this;
	}

	setNotification(enabled = true, text) {
		this._notification = !!enabled;
		if (text !== undefined) {
			if (typeof text !== 'string') throw new TypeError('setNotification(enabled, text): text must be a string');
			this._notificationText = text;
		}
		return this;
	}

	setMentions(...jids) {
		const list = jids.flat();
		if (!list.every((j) => typeof j === 'string' && j)) throw new TypeError('setMentions(...jids) requires non-empty strings');
		this._mentions = list;
		return this;
	}

	setQuoted(quoted, participant) {
		if (quoted != null && (typeof quoted !== 'object' || Array.isArray(quoted))) throw new TypeError('setQuoted(quoted) requires a message object');
		this._quoted = quoted ?? undefined;
		this._quotedParticipant = participant;
		return this;
	}

	setNoContextInfo(enabled = true) {
		this._noContextInfo = !!enabled;
		return this;
	}

	setDynamicIDs(enabled = true) {
		this._dynamic = !!enabled;
		return this;
	}

	setUnifiedResponseData(data) {
		if (data == null) {
			this._unifiedResponseData = undefined;
			return this;
		}
		if (!(typeof data === 'string' || Buffer.isBuffer(data) || typeof data === 'object')) throw new TypeError('setUnifiedResponseData(data) requires an object, string or Buffer');
		this._unifiedResponseData = data;
		return this;
	}

	setMessageSecret(enabled = true) {
		this._messageSecret = !!enabled;
		return this;
	}

	setUnsupportedTypeAlert(enabled = true) {
		this._unsupportedTypeAlert = !!enabled;
		return this;
	}

	setByPassDownload(enabled = true) {
		this._bypassDownload = !!enabled;
		return this;
	}

	setCapabilities(capabilities) {
		if (!Array.isArray(capabilities)) throw new TypeError('setCapabilities(capabilities) requires an array');
		return this.setBotMetadata({ capabilityMetadata: { capabilities } });
	}

	setBotRenderingConfig(bloksVersioningId, pixelDensity = 1) {
		if (typeof bloksVersioningId !== 'string' || !bloksVersioningId) {
			throw new TypeError('setBotRenderingConfig(bloksVersioningId) requires a non-empty string');
		}
		if (typeof pixelDensity !== 'number') throw new TypeError('pixelDensity must be a number');
		return this.setBotMetadata({ botRenderingConfigMetadata: { bloksVersioningId, pixelDensity } });
	}

	setThreadType(type) {
		if (!(typeof type === 'string' || typeof type === 'number')) throw new TypeError('setThreadType(type) requires an enum name or number');
		return this.setBotMetadata({ botThreadInfo: { clientInfo: { type } } });
	}

	setImagineType(type) {
		if (!(typeof type === 'string' || typeof type === 'number')) throw new TypeError('setImagineType(type) requires an enum name or number');
		return this.setBotMetadata({ imagineMetadata: { imagineType: type } });
	}

	setSubscriptionUpsell(requestType) {
		if (!(typeof requestType === 'string' || typeof requestType === 'number')) throw new TypeError('setSubscriptionUpsell(requestType) requires an enum name or number');
		return this.setBotMetadata({ subscriptionUpsellMetadata: { requestType } });
	}

	addEmbeddedScreen(screen) {
		if (!screen || typeof screen !== 'object' || Array.isArray(screen)) {
			throw new TypeError('addEmbeddedScreen(screen) requires a plain object');
		}
		this._embeddedScreens.push(screen);
		return this;
	}

	createAlert(type) {
		if (this._unsupportedTypeAlert) {
			return {
				messageType: 2,
				messageText: `[ UNSUPPORTED_TYPE - ${type}]`,
			};
		}

		return undefined;
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

	assignId(id) {
		if (typeof id !== 'string' || !id) throw new TypeError('assignId(id) requires a non-empty string');
		if (this._blocks.has(id)) throw new Error(`assignId: id "${id}" is already registered`);
		if (!this._lastBlock) throw new Error('assignId: no untracked block to assign — call it immediately after an add*()/set*() that was passed no {id}');

		this._blocks.set(id, this._lastBlock);
		this._lastBlock = null;
		return this;
	}

	_addContent(section, submessage) {
		const sections = section === undefined || section === null ? [] : Array.isArray(section) ? section : [section];
		const submessages = submessage === undefined || submessage === null ? [] : Array.isArray(submessage) ? submessage : [submessage];

		if (!sections.length) {
			throw new ContentValidationError('At least one section is required');
		}

		for (const item of sections) {
			if (!item || typeof item !== 'object' || Array.isArray(item)) {
				throw new ContentValidationError('Sections must be plain objects');
			}
		}

		for (const item of submessages) {
			if (!item || typeof item !== 'object' || Array.isArray(item)) {
				throw new ContentValidationError('Submessages must be plain objects');
			}
		}

		this._sections.push(...sections);
		this._submessages.push(...submessages);

		return this;
	}

	addSection(section, options = {}) {
		return this._addContent(section, undefined, options);
	}

	addSubmessage(submessage, options = {}) {
		if (submessage === undefined || submessage === null) {
			throw new ContentValidationError('At least one submessage is required');
		}
		return this._addContent(undefined, submessage, options);
	}

	addText(text, { hyperlink = true, citation = true, latex = true, id, replace, insertAt } = {}) {
		if (typeof text !== 'string') {
			throw new TypeError('Text must be a string');
		}

		const { text: extractedText, inline_entities } = extractIE(text, { hyperlink, citation, latex });

		const section = AIRich.newLayout('Single', {
			text: extractedText,
			...(inline_entities.length && { inline_entities }),
			__typename: 'GenAIMarkdownTextUXPrimitive',
		});

		const submessages = [{ messageType: 2, messageText: text }];

		return this._addContent(section, submessages, { id, replace, insertAt });
	}

	addFOAText(text, { id, replace, insertAt } = {}) {
		if (typeof text !== 'string') {
			throw new TypeError('Text must be a string');
		}

		const section = AIRich.newLayout('Single', { text, __typename: 'FOATextPrimitive' });
		const submessages = [{ messageType: 2, messageText: text }];

		return this._addContent(section, submessages, { id, replace, insertAt });
	}

	addCode(language, code, { id, replace, insertAt } = {}) {
		if (typeof language !== 'string' || typeof code !== 'string') {
			throw new TypeError('Language and code must be a string');
		}

		const meta = tokenizeCodeForRich(code, language);

		const section = AIRich.newLayout('Single', {
			language,
			code_blocks: meta.unified_codeBlock,
			__typename: 'GenAICodeUXPrimitive',
		});

		const submessages = [
			{
				messageType: 5,
				codeMetadata: { codeLanguage: language, codeBlocks: meta.codeBlock },
			},
		];

		return this._addContent(section, submessages, { id, replace, insertAt });
	}

	addTable(table, { hyperlink = true, citation = true, latex = true, id, replace, insertAt } = {}) {
		if (!Array.isArray(table)) {
			throw new TypeError('Table must be an array');
		}

		const meta = AIRich.toTableMetadata(table, { hyperlink, citation, latex });

		const section = AIRich.newLayout('Single', { rows: meta.unified_rows, __typename: 'GenATableUXPrimitive' });

		const submessages = [
			{
				messageType: 4,
				tableMetadata: { title: meta.title, rows: meta.rows },
			},
		];

		return this._addContent(section, submessages, { id, replace, insertAt });
	}

	addSource(sources = [], { id, replace, insertAt } = {}) {
		if (!Array.isArray(sources)) {
			throw new TypeError('Sources must be an array of strings, arrays, or objects');
		}

		const isStringArray = sources.every((item) => typeof item === 'string');
		const isArrayFormat = sources.every((item) => Array.isArray(item) && item.every((value) => typeof value === 'string'));
		const isObjectFormat = sources.every((item) => item && typeof item === 'object' && !Array.isArray(item));

		if (!isStringArray && !isArrayFormat && !isObjectFormat) {
			throw new TypeError('Sources must be a string array, array of string arrays, or array of objects');
		}

		if (isStringArray) sources = [sources];

		const normalizedSources = sources.map((source) => {
			if (Array.isArray(source)) {
				const [icon, url, title, subtitle] = source;
				return { icon, url, title, subtitle };
			}

			return {
				icon: source.favicon ?? source.icon ?? '',
				url: source.url ?? '',
				title: source.title ?? '',
				subtitle: source.subtitle ?? '',
			};
		});

		const source = normalizedSources.map(({ icon, url, title, subtitle }) => ({
			source_type: 'THIRD_PARTY',
			source_display_name: title,
			source_subtitle: subtitle,
			source_url: url,
			favicon: {
				url: Toolkit.resolveMedia(this.#client, icon, 'image'),
				mime_type: 'image/jpeg',
				width: 16,
				height: 16,
			},
		}));

		const submessage = this.createAlert('GenAISearchResultPrimitive');

		const section = AIRich.newLayout('Single', { sources: source, __typename: 'GenAISearchResultPrimitive' });

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addReels(reelsItems = [], { id, replace, insertAt } = {}) {
		if (
			!(
				(reelsItems && typeof reelsItems === 'object' && !Array.isArray(reelsItems)) ||
				(Array.isArray(reelsItems) && reelsItems.every((item) => item && typeof item === 'object' && !Array.isArray(item)))
			)
		) {
			throw new TypeError('Reels items must be an object or an array of objects');
		}

		const items = Array.isArray(reelsItems) ? reelsItems : [reelsItems];

		const reels = items.map((item) => ({
			...item,
			_avatar: Toolkit.resolveMedia(this.#client, item.profileIconUrl ?? item.profile_url ?? item.profile ?? '', 'image'),
			_thumbnail: Toolkit.resolveMedia(this.#client, item.thumbnailUrl ?? item.thumbnail ?? '', 'image'),
		}));

		const section = AIRich.newLayout(
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
		);

		const submessages = [
			{
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
			},
		];

		return this._addContent(section, submessages, { id, replace, insertAt });
	}

	addImage(imageUrl, { width, height, status = 'READY', update_text, resolveUrl = false, id, replace, insertAt } = {}) {
		if (!(typeof imageUrl === 'string' || Buffer.isBuffer(imageUrl) || (Array.isArray(imageUrl) && imageUrl.every((v) => typeof v === 'string' || Buffer.isBuffer(v))))) {
			throw new TypeError('imageUrl must be string | buffer | array of string/buffer');
		}

		const list = Array.isArray(imageUrl)
			? imageUrl.map((v) => {
					const url = Toolkit.resolveMedia(this.#client, v, 'image', { resolveUrl });
					return { imagePreviewUrl: url, imageHighResUrl: url, sourceUrl: url };
				})
			: (() => {
					const url = Toolkit.resolveMedia(this.#client, imageUrl, 'image', { resolveUrl });
					return [{ imagePreviewUrl: url, imageHighResUrl: url, sourceUrl: url }];
				})();

		const sections = list.map(({ imagePreviewUrl }) =>
			AIRich.newLayout('Single', {
				media: { url: imagePreviewUrl, mime_type: 'image/png', width, height },
				imagine_type: 'IMAGE',
				status: { status, update_text },
				__typename: 'GenAIImaginePrimitive',
			})
		);

		const submessage = {
			messageType: 1,
			gridImageMetadata: {
				gridImageUrl: { imagePreviewUrl: list[0]?.imagePreviewUrl },
				imageUrls: list,
			},
		};

		return this._addContent(sections, submessage, { id, replace, insertAt });
	}

	addVideo(videoUrl, { autoFill = true, status = 'READY', estimatedTime, id, replace, insertAt } = {}) {
		const isObjectVideo = (v) => v && typeof v === 'object' && !Array.isArray(v) && v.url;

		const isValidPrimitive =
			typeof videoUrl === 'string' ||
			Buffer.isBuffer(videoUrl) ||
			isObjectVideo(videoUrl) ||
			(Array.isArray(videoUrl) && videoUrl.every((v) => typeof v === 'string' || Buffer.isBuffer(v) || isObjectVideo(v)));

		if (!isValidPrimitive) {
			throw new TypeError('videoUrl must be string | buffer | object | array');
		}

		const items = Array.isArray(videoUrl) ? videoUrl : [videoUrl];

		const alert = this.createAlert('GenAIImaginePrimitive (ANIMATE)');

		const sections = [];
		const submessages = [];

		for (const item of items) {
			const isObject = isObjectVideo(item);

			const url = isObject ? Toolkit.resolveMedia(this.#client, item.url ?? '', 'video') : Toolkit.resolveMedia(this.#client, item, 'video');

			const bufferPromise = autoFill ? Promise.resolve(url).then((u) => Toolkit.fetchBuffer(u)) : null;

			const file_length = isObject && item.file_length != null ? item.file_length : autoFill ? bufferPromise.then((b) => b?.length ?? 0) : 0;

			const duration =
				isObject && item.duration != null
					? item.duration
					: autoFill
						? bufferPromise.then((b) => Toolkit.getMp4Duration(b, { silent: true }))
						: 0;

			const thumbnail =
				isObject && item.thumbnail
					? Toolkit.resolveMedia(this.#client, item.thumbnail, 'image', { result: 'base64', resize: true, width: 300, height: 300 })
					: autoFill
						? bufferPromise?.then((b) => Toolkit.getMp4Preview(b, { time: 0, result: 'base64' }))
						: null;

			sections.push(
				AIRich.newLayout('Single', {
					media: {
						url,
						mime_type: isObject ? (item.mime_type ?? 'video/mp4') : 'video/mp4',
						file_length,
						duration,
					},
					imagine_type: 'ANIMATE',
					status: {
						status,
						estimated_completion_time: estimatedTime != null ? Math.floor((Date.now() + estimatedTime) / 1000) : undefined,
					},
					thumbnail: { raw_media: thumbnail },
					__typename: 'GenAIImaginePrimitive',
				})
			);
		}

		if (alert !== undefined) submessages.push(alert);

		if (submessages.length > 1) {
			throw new Error('Video content can only have one submessage');
		}

		return this._addContent(sections, submessages[0], { id, replace, insertAt });
	}

	addProduct(data = {}, { id, replace, insertAt } = {}) {
		if (!((data && typeof data === 'object' && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === 'object' && !Array.isArray(item))))) {
			throw new TypeError('Product items must be an object or an array of objects');
		}

		const items = Array.isArray(data) ? data : [data];

		const product = items.map((item) => ({
			title: item.title,
			brand: item.brand,
			price: item.price,
			sale_price: item.sale_price,
			product_url: item.product_url ?? item.url,
			image: { url: Toolkit.resolveMedia(this.#client, item.image_url ?? item.image, 'image') },
			additional_images: [{ url: Toolkit.resolveMedia(this.#client, item.icon_url ?? item.icon, 'image') }],
			__typename: 'GenAIProductItemCardPrimitive',
		}));

		const section = AIRich.newLayout(Array.isArray(data) ? 'HScroll' : 'Single', Array.isArray(data) ? product : product[0]);

		const submessage = this.createAlert('GenAIProductItemCardPrimitive');

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addPost(data = {}, { id, replace, insertAt } = {}) {
		if (!((data && typeof data === 'object' && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === 'object' && !Array.isArray(item))))) {
			throw new TypeError('Post items must be an object or an array of objects');
		}

		const posts = Array.isArray(data) ? data : [data];

		const primitives = posts.map((p) => ({
			title: p.title ?? '',
			subtitle: p.subtitle ?? '',
			username: p.username ?? '',
			profile_picture_url: Toolkit.resolveMedia(this.#client, p.profile_picture_url ?? p.profile_url ?? p.profile ?? '', 'image'),
			is_verified: !!(p.is_verified || p.verified),
			thumbnail_url: Toolkit.resolveMedia(this.#client, p.thumbnail_url ?? p.thumbnail ?? '', 'image'),
			post_caption: p.post_caption ?? p.caption ?? '',
			likes_count: p.likes_count ?? p.like ?? 0,
			comments_count: p.comments_count ?? p.comment ?? 0,
			shares_count: p.shares_count ?? p.share ?? 0,
			post_url: p.post_url ?? p.url ?? '',
			post_deeplink: p.post_deeplink ?? p.deeplink ?? '',
			source_app: p.source_app || p.source || 'INSTAGRAM',
			footer_label: p.footer_label ?? p.footer ?? '',
			footer_icon: Toolkit.resolveMedia(this.#client, p.footer_icon ?? p.icon ?? '', 'image'),
			is_carousel: posts.length > 1,
			orientation: p.orientation ?? 'LANDSCAPE',
			post_type: p.post_type ?? 'VIDEO',
			__typename: 'GenAIPostPrimitive',
		}));

		const section = AIRich.newLayout('HScroll', primitives);

		const submessage = this.createAlert('GenAIPostPrimitive');

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addMetadata(text, { id, replace, insertAt } = {}) {
		if (typeof text !== 'string') {
			throw new TypeError('Text must be a string');
		}

		const section = AIRich.newLayout('Single', { text, __typename: 'GenAIMetadataTextPrimitive' });
		const submessage = { messageType: 2, messageText: text };

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addTip(text, { id, replace, insertAt } = {}) {
		if (typeof text !== 'string') {
			throw new TypeError('Text must be a string');
		}

		const section = AIRich.newLayout('Single', { text: 'ⓘ ' + text, __typename: 'GenAIMetadataTextPrimitive' });
		const submessage = { messageType: 2, messageText: text };

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addWidget(data, { layout, id, replace, insertAt, ...options } = {}) {
		if (!((data && typeof data === 'object' && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === 'object' && !Array.isArray(item))))) {
			throw new TypeError('Widget must be an object or an array of objects');
		}

		const isArray = Array.isArray(data);
		const items = isArray ? data : [data];

		const widgets = items.map((item) => ({
			__typename: 'GenAI3PExtWidgetPrimitive',
			header: { __typename: 'GenAI3PExtWidgetStandardHeader', title: item.title ?? '', ...(item.header ?? {}) },
			body: {
				__typename: 'GenAI3PExtCalendarEventList',
				sections: item.sections ?? [],
				ctas: (item.actions ?? []).map((action) => ({
					__typename: 'GenAI3PExtWidgetCTA',
					label: action.label ?? '',
					state: action.state ?? 'PENDING',
					kind: action.kind ?? 'OTHER',
					tool_call_id: action.tool_call_id ?? action.id ?? '',
					...(action.toast && { toast: { __typename: 'GenAI3PExtWidgetToast', label: action.toast.label ?? action.label ?? '' } }),
				})),
				...(item.body ?? {}),
			},
		}));

		const section = AIRich.newLayout(layout ?? (isArray ? 'HScroll' : 'Single'), isArray ? widgets : widgets[0], options);

		const submessage = this.createAlert('GenAI3PExtWidgetStandardHeader');

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addFooterAction(data, { layout, id, replace, insertAt, ...options } = {}) {
		if (!((data && typeof data === 'object' && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === 'object' && !Array.isArray(item))))) {
			throw new TypeError('Footer action must be an object or an array of objects');
		}

		const isArray = Array.isArray(data);
		const items = isArray ? data : [data];

		const actions = items.map((item) => ({
			__typename: 'GenAIFooterActionPrimitive',
			cta_text: item.text ?? item.cta_text ?? '',
			cta_type: item.type ?? item.cta_type ?? 'OPEN_URL',
			cta_url: item.url ?? item.cta_url ?? '',
		}));

		const section = AIRich.newLayout(layout ?? (isArray ? 'HScroll' : 'Single'), isArray ? actions : actions[0], options);

		const submessage = this.createAlert('GenAIFooterActionPrimitive');

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addSuggest(suggestion, { scroll = true, layout, id, replace, insertAt } = {}) {
		if (!(typeof suggestion === 'string' || (Array.isArray(suggestion) && suggestion.every((v) => typeof v === 'string')))) {
			throw new TypeError('Suggestion must be a string or array of strings');
		}

		const suggest = Array.isArray(suggestion)
			? suggestion.map((text) => ({ prompt_text: text, prompt_type: 'SUGGESTED_PROMPT', __typename: 'GenAIFollowUpSuggestionPillPrimitive' }))
			: [{ prompt_text: suggestion, prompt_type: 'SUGGESTED_PROMPT', __typename: 'GenAIFollowUpSuggestionPillPrimitive' }];

		const type = layout ?? (suggest.length === 1 ? 'Single' : scroll ? 'HScroll' : 'ActionRow');

		const section = AIRich.newLayout(type, type === 'Single' ? suggest[0] : suggest, { __typename: 'GenAIUnifiedResponseSection' });

		const submessage = this.createAlert('GenAIFollowUpSuggestionPillPrimitive');

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addImageCard(previewUrl, fullUrl, { width, height, status = 'READY', update_text, resolveUrl = false, id, replace, insertAt } = {}) {
		const ok = (v) => typeof v === 'string' || Buffer.isBuffer(v);
		if (!ok(previewUrl)) throw new TypeError('addImageCard(previewUrl, fullUrl) requires previewUrl as string | Buffer');
		if (fullUrl != null && !ok(fullUrl)) throw new TypeError('addImageCard(previewUrl, fullUrl): fullUrl must be string | Buffer');

		const resolveImage = (value) => {
			if (!resolveUrl && typeof value === 'string' && /^https?:\/\//i.test(value)) {
				return value;
			}
			return Toolkit.resolveMedia(this.#client, value, 'image', { resolveUrl });
		};

		const preview = resolveImage(previewUrl);
		const full = fullUrl == null ? preview : resolveImage(fullUrl);

		const section = AIRich.newLayout('Single', {
			media: { url: preview, mime_type: 'image/png', width, height },
			imagine_type: 'IMAGE',
			status: { status, update_text },
			__typename: 'GenAIImaginePrimitive',
		});

		const submessage = {
			messageType: 1,
			gridImageMetadata: {
				gridImageUrl: { imagePreviewUrl: preview },
				imageUrls: [{ imagePreviewUrl: preview, imageHighResUrl: full, sourceUrl: full }],
			},
		};

		return this._addContent([section], submessage, { id, replace, insertAt });
	}

	addComment(comment = {}, { id, replace, insertAt } = {}) {
		const actor = comment.actorName ?? comment.actor_name ?? '';
		const body = comment.commentText ?? comment.comment_text ?? '';
		if (!actor && !body) throw new TypeError('addComment({ actorName?, commentText? }) requires at least one of them');
		let text = `💬 ${actor ? `${actor}: ` : ''}${body}`;
		if (comment.subtitle) text += `\n_${comment.subtitle}_`;
		return this.addText(text, { id, replace, insertAt });
	}

	addActionList(rows, { id, replace, insertAt } = {}) {
		if (!Array.isArray(rows) || !rows.length || !rows.every((r) => r && typeof r.title === 'string' && r.title)) {
			throw new TypeError('addActionList(rows) requires a non-empty array of { title, subtitle? }');
		}
		return this.addText(rows.map((r) => `▸ ${r.title}${r.subtitle ? ` — ${r.subtitle}` : ''}`).join('\n'), { id, replace, insertAt });
	}

	addChainOfThoughtStep(title, body, { id, replace, insertAt } = {}) {
		if (typeof title !== 'string' || !title) throw new TypeError('addChainOfThoughtStep(title, body?) requires a non-empty title');
		return this.addText(body ? `**${title}**\n${body}` : title, { id, replace, insertAt });
	}

	addThinking(title = 'Thinking', { icon = 'THINKING', is_in_progress = true, id, replace, insertAt } = {}) {
		if (typeof title !== 'string' || !title) throw new TypeError('addThinking(title) requires a non-empty string');
		return this.addProgressStatus(title, { icon, is_in_progress, id, replace, insertAt });
	}

	addPrimitive(typeName, payload, { id, replace, insertAt } = {}) {
		if (typeof typeName !== 'string' || !typeName) throw new TypeError('addPrimitive(typeName, payload) requires a non-empty typeName');
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('addPrimitive(typeName, payload) requires a plain-object payload');
		return this._addSinglePrimitive(typeName, payload, { id, replace, insertAt });
	}

	addContentRaw(section, submessage, { id, replace, insertAt } = {}) {
		if (!section) throw new TypeError('addContentRaw(section, submessage?) requires a section');
		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	_addSinglePrimitive(typeName, payload, { id, replace, insertAt } = {}) {
		const clean = AIRich._omitEmpty(payload);
		const section = AIRich.newLayout('Single', { ...clean, __typename: typeName }, { __typename: 'GenAIUnifiedResponseSection' });
		return this._addContent(section, this.createAlert(typeName), { id, replace, insertAt });
	}

	static _omitEmpty(value) {
		if (Array.isArray(value)) return value.map((v) => AIRich._omitEmpty(v));
		if (value && typeof value === 'object') {
			const out = {};
			for (const [k, v] of Object.entries(value)) {
				if (v === undefined || v === null || v === '') continue;
				const c = AIRich._omitEmpty(v);
				if (c && typeof c === 'object' && !Array.isArray(c) && !Object.keys(c).length) continue;
				out[k] = c;
			}
			return out;
		}
		return value;
	}

	addChainingSuggestionV2({ promptText, title, imageUri, externalConversationId, topic, cardId, id, replace, insertAt } = {}) {
		if (typeof promptText !== 'string' || !promptText) throw new TypeError('addChainingSuggestionV2({ promptText }) requires a non-empty string');
		return this._addSinglePrimitive(
			'GenAIChainingSuggestionPrimitive',
			{ prompt_text: promptText, title, image_uri: imageUri, external_conversation_id: externalConversationId, topic, card_id: cardId },
			{ id, replace, insertAt }
		);
	}

	addPlaceEntity({ placeId, name, imageUrl, motivation, key, latitude, longitude, itemType, address = {}, category = {}, rating, id, replace, insertAt } = {}) {
		if (typeof name !== 'string' || !name) throw new TypeError('addPlaceEntity({ name }) requires a non-empty string');
		return this._addSinglePrimitive(
			'GenAIPlaceEntityItem',
			{
				place_id: placeId,
				name,
				image_url: imageUrl,
				motivation,
				key,
				latitude: latitude === undefined ? undefined : String(latitude),
				longitude: longitude === undefined ? undefined : String(longitude),
				item_type: itemType,
				address: {
					street_address: address.streetAddress,
					region: address.region,
					country: address.country,
					postal_code: address.postalCode,
					locality: address.locality,
					street: address.street,
				},
				category: { display_name: category.displayName, category_id: category.categoryId },
				rating: rating === undefined ? undefined : { avg_rating: String(rating) },
			},
			{ id, replace, insertAt }
		);
	}

	addSearchResultV2({ searchQuery, metadata, postId, reelsUrl, reelsDeeplink, reelsTitle, thumbnailUrl, avatarUrl, creator, isVerified, sourceApp, timestamp, originalWidth, originalHeight, primitives, id, replace, insertAt } = {}) {
		if (!searchQuery && !reelsUrl && !postId && !(primitives && primitives.length)) {
			throw new TypeError('addSearchResultV2() needs at least one of: searchQuery, reelsUrl, postId, primitives');
		}
		return this._addSinglePrimitive(
			'GenAISearchResultV2Primitive',
			{
				metadata,
				search_query: searchQuery,
				primitives,
				post_id: postId,
				reels_url: reelsUrl,
				reels_deeplink: reelsDeeplink,
				thumbnail_url: thumbnailUrl,
				avatar_url: avatarUrl,
				creator,
				reels_title: reelsTitle,
				is_verified: isVerified,
				source_app: sourceApp,
				timestamp,
				original_width: originalWidth,
				original_height: originalHeight,
			},
			{ id, replace, insertAt }
		);
	}

	addContextualSources(sources, contextualSources, { id, replace, insertAt } = {}) {
		if (!Array.isArray(sources) || !sources.length) throw new TypeError('addContextualSources(sources) requires a non-empty array');
		const list = sources.map((s, i) => {
			if (!s || typeof s.uri !== 'string' || typeof s.displayName !== 'string') {
				throw new TypeError(`addContextualSources: sources[${i}] needs { displayName, uri }`);
			}
			return { favicon_uri: s.faviconUri, display_name: s.displayName, uri: s.uri };
		});
		const contextual = contextualSources === undefined ? undefined : typeof contextualSources === 'string' ? contextualSources : JSON.stringify(contextualSources);
		return this._addSinglePrimitive('GenAIContextualSourcesViewModel', { sources: list, contextual_sources: contextual }, { id, replace, insertAt });
	}

	addMediaItem({ url, mimeType, urlFallback, mediaId, fileLength, width, height, durationMs, expirationTimestampMs, thumbnail, encryption, id, replace, insertAt } = {}) {
		if (!url && !mediaId) throw new TypeError('addMediaItem() requires url and/or mediaId');
		const media = {
			url,
			mime_type: mimeType,
			url_fallback: urlFallback,
			media_id: mediaId,
			file_length: fileLength,
			width,
			height,
			duration: durationMs,
			expiration_timestamp_ms: expirationTimestampMs,
			thumbnail: thumbnail ? { raw_media: thumbnail } : undefined,
			encryption_data: encryption
				? {
						media_key: encryption.mediaKey,
						direct_path: encryption.directPath,
						file_sha256: encryption.fileSha256,
						file_enc_sha256: encryption.fileEncSha256,
						scans_sidecar: encryption.scansSidecar,
						scan_lengths: encryption.scanLengths,
						media_key_timestamp: encryption.mediaKeyTimestamp,
						file_length: encryption.fileLength,
					}
				: undefined,
		};
		return this._addSinglePrimitive('GenAIMediaItem', { media }, { id, replace, insertAt });
	}

	async build(
		jid,
		{ forwarded = true, notification = this._notification, notificationText, verificationMetadata = this._verification, includesUnifiedResponse = true, includesSubmessages = true, quoted = this._quoted, quotedParticipant = this._quotedParticipant, noContextInfo = this._noContextInfo, messageId, ...options } = {}
	) {
		const forward = forwarded
			? {
					forwardingScore: 1,
					isForwarded: true,
					forwardedAiBotMessageInfo: { botJid: this._forwardBotJid },
					forwardOrigin: 4,
				}
			: {};

		const disclaimer = notificationText ?? this._notificationText ?? (this._title || undefined);
		const notif = notification
			? {
					sessionTransparencyMetadata: {
						...(disclaimer ? { disclaimerText: disclaimer } : {}),
						hcaId: `hca_${Date.now()}`,
						sessionTransparencyType: 1,
					},
				}
			: {};

		const qObj = quoted
			? {
					stanzaId: quoted?.key?.id || quoted?.id,
					participant: quotedParticipant || quoted?.key?.participant || quoted?.participant || quoted?.key?.remoteJid,
					quotedType: 0,
					quotedMessage: typeof quoted === 'object' && quoted !== null ? (quoted.message ?? quoted) : undefined,
				}
			: {};

		const sections = this._footer
			? [...(await waitAllPromises(this._sections)), AIRich.newLayout('Single', { text: this._footer, __typename: 'GenAIMetadataTextPrimitive' })]
			: [...(await waitAllPromises(this._sections))];

		const embeddedScreens = await waitAllPromises(this._embeddedScreens);

		if (this._dynamic) {
			this.refreshResponseId();
			this.refreshBotResponseId();
		}

		return generateWAMessageFromContent(
			jid,
			{
				messageContextInfo: {
					deviceListMetadata: {},
					deviceListMetadataVersion: 2,
					...(this._messageSecret ? { messageSecret: crypto.randomBytes(32) } : {}),
					botMetadata: {
						messageDisclaimerText: this._title,
						...notif,
						...(verificationMetadata
							? {
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
								}
							: {}),
						botResponseId: this._botResponseId,
						...this._botMetadataExtra,
					},
				},
				...this._extraPayload,
				botForwardedMessage: {
					message: {
						richResponseMessage: {
							messageType: 1,
							submessages: includesSubmessages ? await waitAllPromises(this._submessages) : [],
							unifiedResponse: {
								data: includesUnifiedResponse
									? this._unifiedResponseData != null
										? Buffer.from(typeof this._unifiedResponseData === 'object' && !Buffer.isBuffer(this._unifiedResponseData) ? JSON.stringify(this._unifiedResponseData) : this._unifiedResponseData).toString('base64')
										: Buffer.from(
											Toolkit.stringifyEscaped({
												response_id: this._responseId,
												sections,
												...(embeddedScreens.length ? { embedded_screens: embeddedScreens } : {}),
											})
										).toString('base64')
									: '',
							},
							...(noContextInfo ? {} : { contextInfo: { ...forward, ...qObj, ...(this._mentions.length ? { mentionedJid: this._mentions } : {}), ...this._contextInfo } }),
						},
					},
				},
			},
			{ messageId: messageId || generateMessageIDV2(), ...options }
		);
	}

	async buildEdit(targetJid, targetId, { msg, messageId, ...options } = {}) {
		if (!msg) {
			msg = (await this.build(targetJid, options)).message;
		}

		const editedMessage = msg;

		if (!editedMessage) {
			throw new Error('buildEdit: msg does not contain botForwardedMessage');
		}

		return generateWAMessageFromContent(
			targetJid,
			{
				botForwardedMessage: {
					message: {
						protocolMessage: {
							key: { remoteJid: targetJid, fromMe: true, id: targetId },
							type: 14, // MESSAGE_EDIT
							editedMessage,
						},
					},
				},
			},
			{ messageId: messageId || generateMessageIDV2(), ...options }
		);
	}

	async sendEdit(jid, id, { msg, messageId, additionalNodes = [], ...options } = {}) {
		jid = jid ?? this._lastMessageKey?.remoteJid;
		id = id ?? this._lastMessageKey?.id;

		if (!jid) throw new Error('JID is required');
		if (!id) throw new Error('Message id is required');

		const msgEdit = await this.buildEdit(jid, id, { msg, messageId: messageId || generateMessageIDV2(), ...options });

		await this.#client.relayMessage(jid, msgEdit.message, { messageId: msgEdit.key.id, additionalNodes });

		return msgEdit;
	}

	async buildEditNative(targetJid, targetId, { msg, messageId, ...options } = {}) {
		if (!msg) {
			msg = (await this.build(targetJid, options)).message;
		}

		if (!msg) {
			throw new Error('buildEditNative: could not build message content');
		}

		return generateWAMessageFromContent(
			targetJid,
			{
				protocolMessage: {
					key: { remoteJid: targetJid, fromMe: true, id: targetId },
					type: 14, // MESSAGE_EDIT
					editedMessage: msg,
					timestampMs: Date.now(),
				},
				messageContextInfo: {
					botMetadata: {
						botResponseId: this._botResponseId,
						botInfrastructureDiagnostics: { botBackend: 1 }, // CLIPPY
					},
					accountEncryptionAttestation: { accountType: 2 }, // NON_E2EE
				},
			},
			{ messageId: messageId || generateMessageIDV2(), ...options }
		);
	}

	async sendEditNative(jid, id, { msg, messageId, additionalNodes = [], ...options } = {}) {
		jid = jid ?? this._lastMessageKey?.remoteJid;
		id = id ?? this._lastMessageKey?.id;

		if (!jid) throw new Error('JID is required');
		if (!id) throw new Error('Message id is required');

		const msgEdit = await this.buildEditNative(jid, id, { msg, messageId: messageId || generateMessageIDV2(), ...options });

		await this.#client.relayMessage(jid, msgEdit.message, { messageId: msgEdit.key.id, additionalNodes });

		return msgEdit;
	}

	async send(jid, { bypassDownload = this._bypassDownload, forwarded = true, notification = this._notification, includesUnifiedResponse = true, includesSubmessages = true, messageId, additionalNodes = [], skipImageFallback = false, nativeEdit = false, ...options } = {}) {
		if (!skipImageFallback && this._inlineImages.length) {
			for (const { url, caption } of this._inlineImages) {
				try {
					await this.#client.sendMessage(jid, { image: { url }, caption }, options.quoted ? { quoted: options.quoted } : {});
				} catch (err) {
					this.#client.logger?.warn?.({ err, url }, 'inline image fallback failed, continuing with rich card');
				}
			}
		}

		const msg = await this.build(jid, { forwarded, notification, includesUnifiedResponse, includesSubmessages, messageId, ...options });

		await this.#client.relayMessage(msg.key.remoteJid, msg.message, { messageId: msg.key.id, additionalNodes, ...options });

		if (includesUnifiedResponse && bypassDownload) {
			await (nativeEdit ? this.sendEditNative(jid, msg.key.id, { msg: msg.message }) : this.sendEdit(jid, msg.key.id, { msg: msg.message }));
		}

		this._lastMessageKey = msg.key;

		return msg;
	}

	static toTableMetadata(arr, { hyperlink = true, citation = true, latex = true } = {}) {
		if (!Array.isArray(arr) || !arr.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'))) {
			throw new TypeError('Table must be a nested array of strings');
		}

		const [header, ...rows] = arr;
		const maxLen = Math.max(header.length, ...rows.map((r) => r.length));
		const normalize = (r) => [...r, ...Array(maxLen - r.length).fill('')];

		const unified_rows = [{ is_header: true, cells: normalize(header) }, ...rows.map((r) => ({ is_header: false, cells: normalize(r) }))].map((row) => {
			const markdown_cells = row.cells.map((cell) => {
				const extracted = extractIE(cell, { hyperlink, citation, latex });
				return { text: extracted.text, ...(extracted.inline_entities.length ? { inline_entities: extracted.inline_entities } : {}) };
			});

			return { ...row, ...(markdown_cells.some((c) => c.inline_entities?.length) ? { markdown_cells } : {}) };
		});

		const rowsMeta = unified_rows.map((r) => ({ items: r.cells, ...(r.is_header ? { isHeading: true } : {}) }));

		return { title: '', rows: rowsMeta, unified_rows };
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

	static lockHeight(height) {
		const px = Number(height);
		if (!Number.isFinite(px) || px <= 0) {
			throw new TypeError('height must be a positive number of pixels');
		}
		return (
			'<style>html,body{margin:0;padding:0;height:' + px + 'px;max-height:' + px + 'px;overflow:hidden}' +
			'#__wrap{height:' + px + 'px;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y}</style>' +
			'<script>document.addEventListener("DOMContentLoaded",function(){' +
			'var w=document.createElement("div");w.id="__wrap";' +
			'while(document.body.firstChild)w.appendChild(document.body.firstChild);' +
			'document.body.appendChild(w)});<' + '/script>'
		);
	}

	get items() {
		return this._sections.flatMap((s) => {
			const vm = s?.view_model;
			if (!vm) return [];
			return vm.primitives ?? (vm.primitive !== undefined ? [vm.primitive] : []);
		});
	}

	get lastMessageKey() {
		return this._lastMessageKey ? { ...this._lastMessageKey } : null;
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

	addHTML(html, { trustedSources = [], height, url, textFallback = true } = {}) {
		if (typeof html !== 'string' || html.trim() === '') {
			throw new TypeError('addHTML(html) requires a non-empty HTML string');
		}
		if (!Array.isArray(trustedSources)) {
			throw new TypeError('addHTML() trustedSources must be an array of strings');
		}
		if (url !== undefined && (typeof url !== 'string' || url.trim() === '')) {
			throw new TypeError('addHTML() url must be a non-empty string (WebView base origin, e.g. https://example.com)');
		}
		const payload = height === undefined ? html : AIRich.lockHeight(height) + html;
		this._submessages.push({ messageType: 2, messageText: 'Aplikasi HTML' });
		this._sections.push({
			__typename: 'GenAIUnifiedResponseSection',
			...AIRich.newLayout('Single', {
				payload,
				...(url ? { url: String(url) } : {}),
				trusted_sources: trustedSources.map(String),
				__typename: 'GenAIaeacdsnwHtmlPrimitive',
			}),
		});
		if (textFallback) {
			this._sections.push(AIRich.newLayout('Single', { text: '[ Aplikasi HTML — buka di Android untuk melihat ]', __typename: 'FOATextPrimitive' }));
		}
		return this;
	}

	addHTMLCard(html, { title, label, trustedSources = [], height, url, screenTitle, tabHeader, textFallback = true } = {}) {
		if (typeof html !== 'string' || html.trim() === '') {
			throw new TypeError('addHTMLCard(html) requires a non-empty HTML string');
		}
		if (title) this.setTitle(title);
		const sheetTitle = screenTitle ?? title ?? 'Preview';
		const payload = height === undefined ? html : AIRich.lockHeight(height) + html;
		const htmlSection = {
			__typename: 'GenAIUnifiedResponseSection',
			...AIRich.newLayout('Single', {
				payload,
				...(url ? { url: String(url) } : {}),
				trusted_sources: trustedSources.map(String),
				__typename: 'GenAIaeacdsnwHtmlPrimitive',
			}),
		};
		this.addText(label ?? sheetTitle);
		this.addEmbeddedScreen({
			title: sheetTitle,
			content: [
				{
					__typename: 'FOAIDNixelButtonSheets',
					tabs: [{ id: 'tab_0', tab_header: tabHeader ?? sheetTitle, sections: [htmlSection], step_entries: [] }],
					step_entries: [],
				},
			],
		});
		return this;
	}

	addFile(url, { title = '', fileExtension = 'html', fileLength = 0, pageCount, previewImage, textFallback = true } = {}) {
		if (typeof url !== 'string' || url.trim() === '') {
			throw new TypeError('addFile(url) requires a non-empty url string');
		}
		const primitive = {
			title: String(title),
			url,
			file_extension: String(fileExtension).replace(/^\./, ''),
			file_length: Number(fileLength) || 0,
			__typename: 'GenAIFilePrimitive',
		};
		if (pageCount !== undefined) primitive.page_count = Number(pageCount) || 0;
		if (previewImage !== undefined) primitive.preview_image = previewImage;
		this._submessages.push({ messageType: 2, messageText: title || 'File' });
		this._sections.push(AIRich.newLayout('Single', primitive));
		if (textFallback) {
			this._sections.push(AIRich.newLayout('Single', { text: `File: ${title || url}`, __typename: 'FOATextPrimitive' }));
		}
		return this;
	}

	async addUploadedFile(content, { mimetype = 'text/html', fileName = 'app.html', title, id, textFallback = true } = {}) {
		const body = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
		if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
			throw new TypeError('addUploadedFile(content) requires a string or a buffer');
		}
		const prepared = await prepareWAMessageMedia({ document: Buffer.from(body), mimetype, fileName }, { upload: this.#client.waUploadToServer });
		const documentMessage = prepared.documentMessage;
		const mediaId = id ?? crypto.randomUUID();
		const b64 = (v) => (v === undefined || v === null ? undefined : Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('base64') : String(v));
		const media = {
			fileSha256: b64(documentMessage.fileSha256),
			mediaKey: b64(documentMessage.mediaKey),
			fileEncSha256: b64(documentMessage.fileEncSha256),
			directPath: documentMessage.directPath,
			mediaKeyTimestamp: documentMessage.mediaKeyTimestamp ? Number(documentMessage.mediaKeyTimestamp) : undefined,
			mimetype: documentMessage.mimetype,
		};
		for (const k of Object.keys(media)) if (media[k] === undefined) delete media[k];
		this.setBotMetadata({ unifiedResponseMutation: { mediaDetailsMetadataList: [{ id: mediaId, previewMedia: media, highResMedia: media }] } });
		this._submessages.push({ messageType: 2, messageText: title || fileName });
		this._sections.push(
			AIRich.newLayout('Single', {
				title: String(title || fileName),
				url: documentMessage.url ?? '',
				file_extension: fileName.includes('.') ? fileName.split('.').pop() : '',
				file_length: Number(documentMessage.fileLength) || 0,
				preview_image: { media_id: mediaId, mime_type: mimetype, url: documentMessage.url ?? '', url_fallback: '' },
				__typename: 'GenAIFilePrimitive',
			})
		);
		if (textFallback) {
			this._sections.push(AIRich.newLayout('Single', { text: `File: ${title || fileName}`, __typename: 'FOATextPrimitive' }));
		}
		return this;
	}

	addAddonAction(primitives = [], { actionType, alignment = 'END' } = {}) {
		if (!Array.isArray(primitives) || !primitives.length) {
			throw new TypeError('addAddonAction(primitives) requires a non-empty array of typed primitive objects');
		}
		const layout = AIRich.newLayout('AddonAction', primitives);
		if (actionType !== undefined) layout.view_model.addon_action_type = actionType;
		layout.view_model.addon_action_alignment = alignment;
		this._submessages.push({ messageType: 2, messageText: 'Addon Action' });
		this._sections.push(layout);
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

	addDivider() {
		this._submessages.push({ messageType: 2, messageText: '---' });
		this._sections.push(AIRich.newLayout('Single', { __typename: 'GenAIDividerPrimitive' }));
		return this;
	}

	addGenerating({ imagine_type = 'IMAGE', estimated_completion_time, textFallback = true } = {}) {
		this._submessages.push({ messageType: 2, messageText: '[ Processing... ]' });
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
			this._sections.push(AIRich.newLayout('Single', { text: '[ Processing... ]', __typename: 'FOATextPrimitive' }));
		}
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

	addInlineVideo() {
		this._submessages.push({ messageType: 2, messageText: 'INLINE_VIDEO' });
		this._sections.push(AIRich.newLayout('Single', {
			text: 'INLINE_VIDEO',
			__typename: 'GenAIMarkdownTextUXPrimitive',
		}));
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

	addLatexPro(expression, image = {}) {
		if (typeof expression !== 'string' || !expression) {
			throw new TypeError('addLatexPro(expression, image) requires a non-empty expression string');
		}
		if (!image?.url) {
			throw new TypeError('addLatexPro(expression, image) requires image.url — use addLatex() for a text-only expression');
		}
		const rendered = {
			latexExpression: expression,
			url: image.url,
		};
		if (image.width != null) rendered.width = image.width;
		if (image.height != null) rendered.height = image.height;
		if (image.fontHeight != null) rendered.fontHeight = image.fontHeight;
		if (image.topPadding != null) rendered.imageTopPadding = image.topPadding;
		if (image.leadingPadding != null) rendered.imageLeadingPadding = image.leadingPadding;
		if (image.bottomPadding != null) rendered.imageBottomPadding = image.bottomPadding;
		if (image.trailingPadding != null) rendered.imageTrailingPadding = image.trailingPadding;
		this._submessages.push({
			messageType: 8,
			latexMetadata: { text: expression, expressions: [rendered] },
		});
		this._sections.push(
			AIRich.newLayout('Single', { latex_expression: expression, image_url: image.url, __typename: 'GenAILatexUXPrimitive' })
		);
		return this;
	}

	addMap(annotations = [], options = {}) {
		if (!Array.isArray(annotations) || !annotations.length) {
			throw new TypeError('addMap(annotations) requires a non-empty array');
		}
		const mapped = annotations.map((a, i) => {
			if (typeof a?.latitude !== 'number' || typeof a?.longitude !== 'number') {
				throw new TypeError(`addMap(): annotation ${i} requires numeric "latitude" and "longitude"`);
			}
			return {
				annotationNumber: a.number ?? i + 1,
				latitude: a.latitude,
				longitude: a.longitude,
				title: a.title ?? '',
				body: a.body ?? '',
			};
		});
		const mapMetadata = { annotations: mapped };
		if (options.centerLatitude != null) mapMetadata.centerLatitude = options.centerLatitude;
		if (options.centerLongitude != null) mapMetadata.centerLongitude = options.centerLongitude;
		if (options.latitudeDelta != null) mapMetadata.latitudeDelta = options.latitudeDelta;
		if (options.longitudeDelta != null) mapMetadata.longitudeDelta = options.longitudeDelta;
		if (options.showInfoList != null) mapMetadata.showInfoList = options.showInfoList;
		this._submessages.push({ messageType: 7, mapMetadata });
		this._sections.push(AIRich.newLayout('Single', { annotations: mapped, __typename: 'GenAIMapUXPrimitive' }));
		if (options.textFallback !== false) {
			const list = mapped.map((a) => `${a.title || `Pin ${a.annotationNumber}`}: ${a.latitude}, ${a.longitude}`).join('\n');
			this._sections.push(AIRich.newLayout('Single', { text: `Peta:\n${list}`, __typename: 'FOATextPrimitive' }));
		}
		return this;
	}

	addGif(url, { loopCount, version, resolveUrl = false } = {}) {
		if (typeof url !== 'string' || !url) {
			throw new TypeError('addGif(url) requires a non-empty url string');
		}
		const resolved = Toolkit.resolveMedia(this.#client, url, 'video', { resolveUrl });
		const dynamicMetadata = { type: 2, url: resolved };
		if (loopCount != null) dynamicMetadata.loopCount = loopCount;
		if (version != null) dynamicMetadata.version = version;
		this._submessages.push({ messageType: 6, dynamicMetadata });
		this._sections.push(AIRich.newLayout('Single', { url: resolved, __typename: 'GenAIDynamicUXPrimitive' }));
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
				buttons: (data.buttons ?? []).map((b) => {
					const action = b.action ?? 'OPEN_DEEPLINK';
					const out = { label: b.label ?? '', action };
					if (action === 'OPEN_URL') out.url = b.url ?? b.deeplink ?? '';
					else out.deeplink = b.deeplink ?? b.url ?? '';
					return out;
				}),
				__typename: 'GenAIMetaSubsQuotaUpsellPrimitive',
			})
		);
		return this;
	}

	addQuotaUpsellCards(cards = []) {
		if (!Array.isArray(cards) || !cards.length) {
			throw new TypeError('addQuotaUpsellCards(cards) requires a non-empty array');
		}
		const primitives = cards.map((data, i) => {
			if (!data?.title) throw new TypeError(`addQuotaUpsellCards(): card ${i} requires a "title"`);
			return {
				title: data.title,
				body: data.body ?? '',
				body_line1: data.body_line1 ?? '',
				body_line2: data.body_line2 ?? '',
				buttons: (data.buttons ?? []).map((b) => {
					const action = b.action ?? 'OPEN_DEEPLINK';
					const out = { label: b.label ?? '', action };
					if (action === 'OPEN_URL') out.url = b.url ?? b.deeplink ?? '';
					else out.deeplink = b.deeplink ?? b.url ?? '';
					return out;
				}),
				__typename: 'GenAIMetaSubsQuotaUpsellPrimitive',
			};
		});
		this._submessages.push({ messageType: 2, messageText: cards.map((c) => c.title).join(', ') });
		this._sections.push(AIRich.newLayout('Single', primitives));
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

	addTasks(tasks = [], { textFallback = true } = {}) {
		if (!Array.isArray(tasks) || !tasks.length) {
			throw new TypeError('addTasks(tasks) requires a non-empty array');
		}
		const primitives = tasks.map((data, i) => {
			if (!data?.title) throw new TypeError(`addTasks(): task ${i} requires a "title"`);
			return {
				task_id: data.task_id ?? '',
				title: data.title,
				subtitle: data.subtitle ?? '',
				status: data.status ?? 'IN_PROGRESS',
				__typename: 'GenAITaskPrimitive',
			};
		});
		this._submessages.push({ messageType: 2, messageText: `Tugas: ${tasks.map((t) => t.title).join(', ')}` });
		this._sections.push(AIRich.newLayout('Single', primitives));
		if (textFallback) {
			const fallbackText = tasks.map((t) => (t.subtitle ? `${t.title} — ${t.subtitle}` : t.title)).join('\n');
			this._sections.push(AIRich.newLayout('Single', { text: `Tugas:\n${fallbackText}`, __typename: 'FOATextPrimitive' }));
		}
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

	get responseId() {
		return this._responseId;
	}
}

class ORich extends AIRich {}

export { AIRich, ORich };
