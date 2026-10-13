import { Button } from "../Builders/index.js";
export function buildPaymentAccount(accountType, identifierType, identifier, institution, beneficiaryName) {
	return {
		type: 'payment_account',
		payment_account: {
			account_type: accountType,
			identifier_type: identifierType,
			identifier_value: identifier,
			institution_name: institution,
			beneficiary_name: beneficiaryName,
		},
	};
}

export function buildPaymentParams({ amount, item, note = '', done = false, accounts = [] } = {}) {
	if (typeof amount !== 'number' || !Number.isFinite(amount)) {
		throw new TypeError('buildPaymentParams: spec.amount must be a finite number');
	}
	if (typeof item !== 'string' || !item) {
		throw new TypeError('buildPaymentParams: spec.item must be a non-empty string');
	}

	const value = amount * 100;
	const money = { value, offset: 100 };

	if (done) {
		const refId = `CPAY-${Date.now()}`;
		const item_ = {
			retailer_id: `item-${Date.now()}${Math.floor(Math.random() * 1e6)}`,
			name: item,
			amount: money,
			quantity: 1,
		};

		return JSON.stringify({
			currency: 'IDR',
			total_amount: money,
			reference_id: refId,
			type: 'physical-goods',
			additional_note: note,
			native_payment_methods: [],
			share_payment_status: true,
			payment_type: '',
			payment_method: 'confirm',
			payment_status: 'captured',
			payment_timestamp: Date.now(),
			payment_configuration: '',
			order: {
				status: 'completed',
				order_type: 'PAYMENT_REQUEST',
				subtotal: money,
				items: [item_],
			},
		});
	}

	if (!accounts.length) {
		throw new TypeError('buildPaymentParams: spec.accounts is required (and non-empty) when spec.done is not true');
	}

	const refId = `PAY-${Date.now()}`;
	const item_ = {
		name: item,
		amount: money,
		quantity: 1,
		description: note,
	};

	return JSON.stringify({
		currency: 'IDR',
		total_amount: money,
		reference_id: refId,
		type: 'physical-goods',
		additional_note: note,
		native_payment_methods: [],
		share_payment_status: false,
		payment_configuration: '',
		payment_type: 'upr',
		payment_settings: accounts,
		order: {
			status: 'pending',
			description: note,
			order_type: 'PAYMENT_REQUEST',
			items: [item_],
			subtotal: money,
			tax: { value: 0, offset: 100 },
			shipping: { value: 0, offset: 100 },
			discount: { value: 0, offset: 100 },
		},
	});
}

export async function sendPayment(client, jid, spec, { title = '', body = '', footer = '', image } = {}) {
	const params = buildPaymentParams(spec);
	const btn = new Button(client);

	if (title) btn.setTitle(title);
	if (body) btn.setBody(body);
	if (footer) btn.setFooter(footer);
	if (image) btn.setImage(image);

	btn.addButton('review_and_pay', params);

	return btn.send(jid);
}

const MAX_PAYMENT_SCAN_DEPTH = 8;

const PAYMENT_MESSAGE_KEYS = new Set([
    'paymentInviteMessage',
    'requestPaymentMessage',
    'sendPaymentMessage',
    'cancelPaymentRequestMessage',
    'declinePaymentRequestMessage',
]);

function canScanObject(value) {
    return value && typeof value === 'object' && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value);
}

function hasPaymentMessageKey(value, depth = 0, seenObjects = new WeakSet()) {
    if (!canScanObject(value) || depth > MAX_PAYMENT_SCAN_DEPTH || seenObjects.has(value)) {
        return false;
    }

    seenObjects.add(value);

    for (const [key, childValue] of Object.entries(value)) {
        if (key === 'quotedMessage') continue;

        if (PAYMENT_MESSAGE_KEYS.has(key) && canScanObject(childValue)) {
            return true;
        }

        if (hasPaymentMessageKey(childValue, depth + 1, seenObjects)) {
            return true;
        }
    }

    return false;
}

export function hasPaymentMessage(webMessage) {
    return hasPaymentMessageKey(webMessage?.message);
}

function findQuotedPaymentContext(value, depth = 0, seenObjects = new WeakSet()) {
    if (!canScanObject(value) || depth > MAX_PAYMENT_SCAN_DEPTH || seenObjects.has(value)) {
        return null;
    }

    seenObjects.add(value);

    const contextInfo = value.contextInfo;

    if (
        canScanObject(contextInfo) &&
        typeof contextInfo.participant === 'string' &&
        canScanObject(contextInfo.quotedMessage) &&
        hasPaymentMessageKey(contextInfo.quotedMessage)
    ) {
        return {
            participant: contextInfo.participant,
            stanzaId: typeof contextInfo.stanzaId === 'string' ? contextInfo.stanzaId : undefined,
        };
    }

    for (const [key, childValue] of Object.entries(value)) {
        if (key === 'quotedMessage') continue;
        const found = findQuotedPaymentContext(childValue, depth + 1, seenObjects);
        if (found) return found;
    }

    return null;
}

export function getQuotedPaymentContext(webMessage) {
    return findQuotedPaymentContext(webMessage?.message);
}

const ENVELOPE_TTL_MS = 60 * 60 * 1000;

const MAX_ENTRIES_PER_GROUP = 1000;

const registry = new Map();

const NON_CONTENT_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);

function hasReadableContent(message) {
    if (!message || typeof message !== 'object') return false;
    return Object.keys(message).some((key) => !NON_CONTENT_KEYS.has(key));
}

function pruneGroup(groupMap) {
    const now = Date.now();

    for (const [id, entry] of groupMap) {
        if (now - entry.ts > ENVELOPE_TTL_MS) {
            groupMap.delete(id);
        }
    }

    while (groupMap.size > MAX_ENTRIES_PER_GROUP) {
        const oldestKey = groupMap.keys().next().value;
        if (oldestKey === undefined) break;
        groupMap.delete(oldestKey);
    }
}

export function recordMessageEnvelope(webMessage, isPayment) {
    const remoteJid = webMessage?.key?.remoteJid;
    const id = webMessage?.key?.id;
    const participant = webMessage?.key?.participant;

    if (!remoteJid?.endsWith('@g.us') || !id || !participant) return;

    let groupMap = registry.get(remoteJid);
    if (!groupMap) {
        groupMap = new Map();
        registry.set(remoteJid, groupMap);
    }

    const contentState = isPayment ? 'payment' : hasReadableContent(webMessage?.message) ? 'other' : 'unreadable';

    groupMap.set(id, {
        participant,
        contentState,
        stealth: Boolean(webMessage?.stealthMeta),
        ts: Date.now(),
    });

    pruneGroup(groupMap);
}

export function verifyQuotedAuthor({ groupJid, stanzaId, participant }) {
    if (!stanzaId) return { corroborated: false, contradicted: false };

    const entry = registry.get(groupJid)?.get(stanzaId);
    if (!entry) return { corroborated: false, contradicted: false };

    if (entry.participant !== participant) {
        return { corroborated: false, contradicted: true };
    }

    if (entry.contentState === 'other') {
        return { corroborated: false, contradicted: true };
    }

    return { corroborated: true, contradicted: false };
}

export function __clearEnvelopeRegistry() {
    registry.clear();
}

export function extractPaymentAmount(webMessage) {
    try {
        const msg =
            webMessage?.message?.requestPaymentMessage ||
            webMessage?.message?.sendPaymentMessage ||
            webMessage?.message?.paymentInviteMessage;

        if (!msg) return null;

        if (msg.amount && msg.amount.value !== undefined) {
            const raw = typeof msg.amount.value === 'object' ? msg.amount.value.low ?? 0 : Number(msg.amount.value);
            const offset = msg.amount.offset || 100;
            return {
                value: raw / offset,
                currencyCode: msg.amount.currencyCode || msg.currencyCodeIso4217 || '???',
            };
        }

        if (msg.amount1000 !== undefined) {
            const raw = typeof msg.amount1000 === 'object' ? msg.amount1000.low ?? 0 : Number(msg.amount1000);
            return { value: raw / 1000, currencyCode: msg.currencyCodeIso4217 || '???' };
        }

        return null;
    } catch {
        return null;
    }
}

const extractEditedContent = (updateEntry) => updateEntry?.update?.message?.editedMessage?.message || null;

export const bindPaymentGuard = (sock, hooks) => {
    const {
        isPaymentMessage,
        recordEnvelope = () => {},
        onDetect = () => {},
        treatDecryptFailureAsSuspicious = true,
    } = hooks || {};

    if (typeof isPaymentMessage !== 'function') {
        throw new Error('bindPaymentGuard: hooks.isPaymentMessage é obrigatório');
    }

    const onUpsert = ({ messages }) => {
        for (const webMessage of messages || []) {
            const remoteJid = webMessage?.key?.remoteJid;
            if (!remoteJid?.endsWith('@g.us')) continue;

            const isPayment = isPaymentMessage(webMessage);
            recordEnvelope(webMessage, isPayment);

            if (isPayment) {
                onDetect({
                    type: 'direct',
                    remoteJid,
                    participant: webMessage.key?.participant,
                    messageId: webMessage.key?.id,
                });
            }
        }
    };

    const onUpdate = (updates) => {
        for (const u of updates || []) {
            const editedContent = extractEditedContent(u);
            if (!editedContent) continue;

            const remoteJid = u.key?.remoteJid;
            if (!remoteJid?.endsWith('@g.us')) continue;

            const syntheticWebMessage = { message: editedContent, key: u.key };
            const isPayment = isPaymentMessage(syntheticWebMessage);
            recordEnvelope(syntheticWebMessage, isPayment);

            if (isPayment) {
                onDetect({
                    type: 'edited',
                    remoteJid,
                    participant: u.key?.participant,
                    messageId: u.key?.id,
                });
            }
        }
    };

    const onDecryptFailed = (failInfo) => {
        const remoteJid = failInfo?.remoteJid;
        if (!remoteJid?.endsWith('@g.us')) return;

        recordEnvelope(
            { key: { remoteJid, id: failInfo.messageId, participant: failInfo.participant }, message: null },
            false
        );

        if (treatDecryptFailureAsSuspicious) {
            onDetect({
                type: 'undecryptable',
                remoteJid,
                participant: failInfo.participant,
                messageId: failInfo.messageId,
                isPreKeyError: failInfo.isPreKeyError,
                errorMessage: failInfo.errorMessage,
            });
        }
    };

    sock.ev.on('messages.upsert', onUpsert);
    sock.ev.on('messages.update', onUpdate);
    sock.ev.on('messages.decrypt-failed', onDecryptFailed);

    return function unbindPaymentGuard() {
        sock.ev.off('messages.upsert', onUpsert);
        sock.ev.off('messages.update', onUpdate);
        sock.ev.off('messages.decrypt-failed', onDecryptFailed);
    };
};

export const SplitPaymentStatus = Object.freeze({ PENDING: 0, PAID: 1 })

export const ReminderFrequency = Object.freeze({
    REMINDER_FREQUENCY_UNKNOWN: 0,
    WEEKLY: 1,
    BI_WEEKLY: 2,
    MONTHLY: 3,
    QUARTERLY: 4
})

export const ReminderStatus = Object.freeze({
    REMINDER_STATUS_UNKNOWN: 0,
    ACTIVE: 1,
    CANCELLED_BY_CREATOR: 2,
    STOPPED_BY_RECEIVER: 3,
    EXPIRED: 4,
    PAID: 5
})

export const MONEY_OFFSET = 1000

const drop = (object) => {
    for (const key of Object.keys(object)) {
        if (object[key] === undefined || object[key] === null) {
            delete object[key]
        }
    }
    return object
}

export const money = (amount, currencyCode, offset = MONEY_OFFSET) => {
    const value = Number(amount)
    if (!Number.isFinite(value) || value < 0) {
        throw new TypeError('money needs a non-negative amount')
    }
    if (typeof currencyCode !== 'string' || currencyCode.length !== 3) {
        throw new TypeError('money needs a three letter currency code, like IDR or USD')
    }
    if (!Number.isInteger(offset) || offset <= 0) {
        throw new TypeError('money offset must be a positive integer')
    }
    return { value: Math.round(value * offset), offset, currencyCode: currencyCode.toUpperCase() }
}

export const readMoney = (value) => {
    if (!value?.offset) {
        return undefined
    }
    return {
        amount: Number(value.value) / Number(value.offset),
        currencyCode: value.currencyCode
    }
}

export const buildSplitPayment = ({ splitId, total, currency, description, requesterJid, participants = [], createdAt } = {}) => {
    if (!splitId) {
        throw new TypeError('buildSplitPayment needs a splitId, the update message is keyed on it')
    }
    if (!participants.length) {
        throw new TypeError('buildSplitPayment needs at least one participant')
    }
    return drop({
        splitId: String(splitId),
        totalAmount: total === undefined ? undefined : money(total, currency),
        description,
        requesterJid,
        participants: participants.map((participant, index) => {
            if (!participant?.jid) {
                throw new TypeError(`participant ${index} needs a jid`)
            }
            return drop({
                jid: participant.jid,
                amount: participant.amount === undefined ? undefined : money(participant.amount, participant.currency ?? currency),
                status: participant.status ?? SplitPaymentStatus.PENDING
            })
        }),
        createdAtMs: createdAt === undefined ? Date.now() : Number(createdAt)
    })
}

export const buildSplitPaymentUpdate = ({ splitId, participantJid } = {}) => {
    if (!splitId || !participantJid) {
        throw new TypeError('buildSplitPaymentUpdate needs both splitId and participantJid')
    }
    return { splitId: String(splitId), participantJid }
}

export const buildPaymentReminder = ({
    reminderId,
    instanceId,
    description,
    frequency = ReminderFrequency.MONTHLY,
    status = ReminderStatus.ACTIVE,
    amount,
    currency,
    payeeVpa,
    payeeJid,
    payerJid
} = {}) => {
    if (!reminderId) {
        throw new TypeError('buildPaymentReminder needs a reminderId')
    }
    return drop({
        reminderId: String(reminderId),
        instanceId: instanceId === undefined ? undefined : String(instanceId),
        description,
        frequency,
        status,
        amount: amount === undefined ? undefined : money(amount, currency),
        payeeVpa,
        payeeJid,
        payerJid
    })
}

export const readSplitPayment = (msg) => {
    const message = msg?.message ?? msg
    const split = message?.splitPaymentMessage
    if (!split) {
        return null
    }
    return drop({
        splitId: split.splitId,
        total: readMoney(split.totalAmount),
        description: split.description,
        requesterJid: split.requesterJid,
        createdAtMs: split.createdAtMs === undefined ? undefined : Number(split.createdAtMs),
        participants: (split.participants ?? []).map(participant => drop({
            jid: participant.jid,
            amount: readMoney(participant.amount),
            status: participant.status
        }))
    })
}

export const readPaymentReminder = (msg) => {
    const message = msg?.message ?? msg
    const reminder = message?.paymentReminderMessage
    if (!reminder) {
        return null
    }
    return drop({
        reminderId: reminder.reminderId,
        instanceId: reminder.instanceId,
        description: reminder.description,
        frequency: reminder.frequency,
        status: reminder.status,
        amount: readMoney(reminder.amount),
        payeeVpa: reminder.payeeVpa,
        payeeJid: reminder.payeeJid,
        payerJid: reminder.payerJid
    })
}
