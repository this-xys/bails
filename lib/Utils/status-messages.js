import { proto } from "../../WAProto/index.js";
import { encodeNewsletterMessage, generateMessageIDV2 } from "./generics.js";
import { generateWAMessage, normalizeMessageContent } from "./messages.js";
import { WAMessageStatus } from "../Types/Message.js";
import { getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } from "../WABinary/index.js";
import { isJidNewsletter } from "../WABinary/jid-utils.js";
const NEWSLETTER_STATUS_MEDIA_TYPES = new Set(['audio', 'gif', 'image', 'video'])

const NEWSLETTER_STATUS_WEB_MEDIA_TYPES = new Set(['image', 'video'])

const NEWSLETTER_STATUS_INTERACTIONS = new Set(['question', 'question_response', 'question_reshare'])

const NEWSLETTER_STATUS_CONTENT_TYPES = new Set(['text', 'media', 'reaction'])

const NEWSLETTER_STATUS_CALLBACK_EVENTS = ['CB:ack', 'CB:status', 'CB:iq', 'CB:notification', 'CB:message']

const NEWSLETTER_STATUS_EDIT_REACTION_REVOKE = '7'

const NEWSLETTER_STATUS_EDIT_ADMIN_REVOKE = '8'

const NEWSLETTER_STATUS_ACK_CLASS = 'status'

const NEWSLETTER_STATUS_ACK_TIMEOUT_MS = 20000

const NEWSLETTER_STATUS_SERVER_ID_TIMEOUT_MS = 8000

export const getNewsletterStatusMediaType = message => {
    const content = normalizeMessageContent(message)
    if (content?.imageMessage) return 'image'
    if (content?.videoMessage) return content.videoMessage.gifPlayback ? 'gif' : 'video'
    if (content?.audioMessage) return 'audio'
    return undefined
}

const assertNewsletterJid = jid => {
    if (!isJidNewsletter(jid)) throw new TypeError('Newsletter status target must be a @newsletter JID')
}

const assertInteraction = interactionType => {
    if (interactionType !== undefined && !NEWSLETTER_STATUS_INTERACTIONS.has(interactionType)) {
        throw new TypeError(`Unsupported newsletter status interaction: ${interactionType}`)
    }
}

const assertMediaType = mediaType => {
    if (mediaType !== undefined && !NEWSLETTER_STATUS_MEDIA_TYPES.has(mediaType)) {
        throw new TypeError(`Unsupported newsletter status media type: ${mediaType}`)
    }
}

const isPresent = value => value !== undefined && value !== null && value !== ''

const NEWSLETTER_SERVER_ID_MIN = 99

const NEWSLETTER_SERVER_ID_MAX = 2147476647

const toNewsletterServerId = (value, label) => {
    const parsed = typeof value === 'number' ? value : Number(String(value).trim())
    if (!Number.isInteger(parsed) || parsed < NEWSLETTER_SERVER_ID_MIN || parsed > NEWSLETTER_SERVER_ID_MAX) {
        throw new TypeError(`${JSON.stringify(value)} is not a newsletter server id${label ? ` for ${label}` : ''}; the server accepts ${NEWSLETTER_SERVER_ID_MIN}..${NEWSLETTER_SERVER_ID_MAX}, and you get one from newsletterFetchMessages or a sent status`)
    }
    return String(parsed)
}

const toServerId = (value, label) => toNewsletterServerId(value, label)

const buildMetaNode = ({ interactionType, parentServerId, responseServerId, aiContent }) => {
    assertInteraction(interactionType)

    const attrs = {}
    if (interactionType) {
        attrs.interaction_type = interactionType
        if (interactionType === 'question_reshare') {
            if (!isPresent(parentServerId)) throw new TypeError('question_reshare requires parentServerId')
            if (!isPresent(responseServerId)) throw new TypeError('question_reshare requires responseServerId')
            attrs.parent_server_id = toServerId(parentServerId, 'parentServerId')
            attrs.response_server_id = String(responseServerId)
        }
        else if (interactionType === 'question_response' && isPresent(responseServerId)) {
            attrs.response_server_id = String(responseServerId)
        }
    }

    if (!interactionType && !aiContent) return undefined

    return {
        tag: 'meta',
        attrs,
        content: aiContent ? [{ tag: 'ai_content', attrs: {}, content: undefined }] : undefined
    }
}

export const withNewsletterStatusAttribution = content => ({
    ...content,
    contextInfo: {
        statusAttributions: [{ type: proto.StatusAttribution.Type.NEWSLETTER_STATUS }],
        featureEligibilities: { canBeReshared: true },
        ...(content?.contextInfo || {})
    }
})

const snapshotCallbackNode = (event, node) => ({
    event,
    tag: node?.tag,
    attrs: node?.attrs || {},
    children: Array.isArray(node?.content)
        ? node.content.map(child => ({ tag: child?.tag, attrs: child?.attrs || {} }))
        : []
})

const collectStatusCallbacks = sock => {
    const frames = []
    const listeners = []

    for (const event of NEWSLETTER_STATUS_CALLBACK_EVENTS) {
        const listener = node => {
            if (frames.length >= 40) return
            frames.push(snapshotCallbackNode(event, node))
        }
        sock.ws.on(event, listener)
        listeners.push([event, listener])
    }

    return {
        frames,
        stop: () => {
            for (const [event, listener] of listeners) {
                sock.ws.off(event, listener)
            }
        }
    }
}

const readIntAttr = (attrs, key) => {
    if (!isPresent(attrs?.[key])) return undefined
    const parsed = Number.parseInt(String(attrs[key]), 10)
    return Number.isFinite(parsed) ? parsed : undefined
}

export const parseNewsletterStatusAck = (node, { jid, messageId } = {}) => {
    if (!node || typeof node !== 'object') throw new TypeError('Newsletter status ack node is required')
    if (node.tag !== 'ack') {
        const error = new Error(`Newsletter status expected <ack>, got <${node.tag}>`)
        error.data = node
        throw error
    }

    const attrs = node.attrs || {}
    if (attrs.class !== undefined && attrs.class !== NEWSLETTER_STATUS_ACK_CLASS) {
        const error = new Error(`Newsletter status ack has class "${attrs.class}", expected "${NEWSLETTER_STATUS_ACK_CLASS}"`)
        error.data = node
        throw error
    }
    if (isPresent(messageId) && isPresent(attrs.id) && attrs.id !== messageId) {
        const error = new Error(`Newsletter status ack id mismatch: ${attrs.id} != ${messageId}`)
        error.data = node
        throw error
    }
    if (isPresent(jid) && isPresent(attrs.from) && attrs.from !== jid) {
        const error = new Error(`Newsletter status ack from mismatch: ${attrs.from} != ${jid}`)
        error.data = node
        throw error
    }

    return {
        class: attrs.class,
        from: attrs.from,
        id: attrs.id,
        t: readIntAttr(attrs, 't'),
        serverId: readIntAttr(attrs, 'server_id'),
        edit: attrs.edit,
        error: isPresent(attrs.error) ? String(attrs.error) : undefined,
        applicationError: readIntAttr(attrs, 'application_error'),
        backoff: readIntAttr(attrs, 'backoff'),
        node
    }
}

export const waitForNewsletterStatusServerId = (sock, { jid, messageId, timeoutMs = 8000 }) => {
    let settle
    const promise = new Promise(resolve => {
        let done = false
        const finish = value => {
            if (done) return
            done = true
            clearTimeout(timer)
            sock.ws.off('CB:status', onStatus)
            resolve(value)
        }
        const onStatus = node => {
            if (node?.tag !== 'status') return
            const attrs = node.attrs || {}
            if (isPresent(jid) && isPresent(attrs.from) && attrs.from !== jid) return
            if (isPresent(messageId) && isPresent(attrs.id) && attrs.id !== messageId) return
            const serverId = readIntAttr(attrs, 'server_id')
            if (serverId !== undefined) finish({ serverId, node })
        }
        const timer = setTimeout(() => finish(undefined), timeoutMs)
        sock.ws.on('CB:status', onStatus)
        settle = finish
    })
    promise.cancel = () => settle(undefined)
    return promise
}

const assertStatusServerResponse = (response, { jid, messageId, callbacks = [] }) => {
    if (!response) {
        const suffix = callbacks.length
            ? `; callbacks=${JSON.stringify(callbacks)}`
            : '; no ack/status/iq/notification/message callback observed'
        const error = new Error(`Newsletter status server ACK timed out for ${messageId}${suffix}`)
        error.data = { messageId, callbacks }
        throw error
    }

    const ack = parseNewsletterStatusAck(response, { jid, messageId })
    if (ack.error) {
        const details = [
            ack.applicationError !== undefined ? `application_error=${ack.applicationError}` : undefined,
            ack.backoff !== undefined ? `backoff=${ack.backoff}` : undefined
        ].filter(Boolean).join(', ')
        const hint = ack.error === '403' || ack.error === '401' || ack.error === 'not-authorized' || ack.error === 'forbidden'
            ? '; the channel may be missing the CHANNEL_STATUS_PRODUCER capability, check newsletterCanPostStatus(jid)'
            : ''
        const error = new Error(`Newsletter status rejected by server (${ack.error})${details ? `: ${details}` : ''}${hint}`)
        error.data = ack
        throw error
    }

    return ack
}

export const buildNewsletterAdminProfileStatusMessage = message => {
    if (!message || typeof message !== 'object') throw new TypeError('Newsletter status message is required')
    return proto.Message.create({
        newsletterAdminProfileStatusMessage: proto.Message.FutureProofMessage.create({
            message
        })
    })
}

const resolveStatusPayload = ({ message, payload }) => {
    if (payload !== undefined) {
        if (!(payload instanceof Uint8Array)) throw new TypeError('Newsletter status payload must be a Uint8Array')
        return payload
    }
    if (!message || typeof message !== 'object') throw new TypeError('Newsletter status message is required')
    return encodeNewsletterMessage(message)
}

export const buildNewsletterStatusNode = ({
    jid,
    message,
    payload,
    messageId,
    mediaType,
    mediaId,
    mediaHandle,
    parentServerId,
    responseServerId,
    interactionType,
    aiContent
}) => {
    assertNewsletterJid(jid)
    if (!messageId) throw new TypeError('Newsletter status messageId is required')
    assertMediaType(mediaType)
    assertInteraction(interactionType)

    const handle = isPresent(mediaHandle) ? mediaHandle : mediaId
    if (isPresent(handle) && !mediaType) {
        throw new TypeError('mediaId requires a media newsletter status')
    }
    if (mediaType && !isPresent(handle)) {
        throw new TypeError('Native newsletter status media requires the media handle returned by the newsletter upload')
    }
    if (interactionType === 'question_reshare' && !mediaType) {
        throw new TypeError('question_reshare requires media')
    }
    if (interactionType === 'question_response') {
        if (mediaType) throw new TypeError('question_response is published as a text status')
        if (!isPresent(parentServerId)) throw new TypeError('question_response requires parentServerId')
    }

    const attrs = {
        to: jid,
        id: messageId,
        type: mediaType ? 'media' : 'text'
    }
    if (mediaType) attrs.media_id = String(handle)
    if (interactionType === 'question_response') {
        attrs.server_id = toServerId(parentServerId, 'parentServerId')
    }

    const content = [{
        tag: 'plaintext',
        attrs: mediaType ? { mediatype: mediaType } : {},
        content: resolveStatusPayload({ message, payload })
    }]

    const metaNode = buildMetaNode({ interactionType, parentServerId, responseServerId, aiContent })
    if (metaNode) content.push(metaNode)

    return { tag: 'status', attrs, content }
}

export const buildNewsletterStatusReactionNode = ({ jid, messageId, parentServerId, reaction }) => {
    assertNewsletterJid(jid)
    if (!messageId) throw new TypeError('Newsletter status reaction messageId is required')
    if (!isPresent(parentServerId)) {
        throw new TypeError('Newsletter status reaction requires parentServerId')
    }

    const isRevoke = !isPresent(reaction)
    const attrs = {
        to: jid,
        id: messageId,
        server_id: toServerId(parentServerId, 'parentServerId'),
        type: 'reaction'
    }
    if (isRevoke) attrs.edit = NEWSLETTER_STATUS_EDIT_REACTION_REVOKE

    return {
        tag: 'status',
        attrs,
        content: [{
            tag: 'reaction',
            attrs: isRevoke ? {} : { code: reaction },
            content: undefined
        }]
    }
}

export const buildNewsletterStatusRevokeNode = ({ jid, statusId }) => {
    assertNewsletterJid(jid)
    if (!statusId) throw new TypeError('Newsletter status revoke requires the status id')

    return {
        tag: 'status',
        attrs: {
            to: jid,
            id: statusId,
            type: 'text',
            edit: NEWSLETTER_STATUS_EDIT_ADMIN_REVOKE
        },
        content: [{ tag: 'plaintext', attrs: {}, content: undefined }]
    }
}

const sendStatusNode = async (sock, node, { jid, messageId, timeoutMs }) => {
    const diagnostics = collectStatusCallbacks(sock)
    const responsePromise = sock.waitForMessage(messageId, timeoutMs)

    try {
        await sock.sendNode(node)
        const response = await responsePromise
        return assertStatusServerResponse(response, { jid, messageId, callbacks: diagnostics.frames })
    }
    finally {
        diagnostics.stop()
    }
}

export const makeNewsletterStatusSender = (sock, config) => async (jid, content, options = {}) => {
    assertNewsletterJid(jid)
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
        throw new TypeError('Newsletter status content must be an object')
    }

    const userJid = sock.authState?.creds?.me?.id
    if (!userJid) throw new TypeError('Not authenticated')

    const {
        mediaId,
        mediaHandle: requestedMediaHandle,
        parentServerId,
        responseServerId,
        interactionType: requestedInteractionType,
        aiContent,
        statusAttribution = true,
        messageId: requestedMessageId,
        ackTimeoutMs,
        resolveServerId,
        serverIdTimeoutMs,
        transport,
        ...messageOptions
    } = options

    if (transport !== undefined) {
        config.logger?.warn?.({ transport }, 'newsletter status "transport" option is obsolete, the verified status-publish transport is always used')
    }

    let uploadedMediaHandle
    const upload = async (...args) => {
        const result = await sock.waUploadToServer(...args)
        if (args[1]?.newsletter) {
            uploadedMediaHandle = result?.handle ?? result?.media_id ?? result?.mediaId ?? result?.fbid ?? uploadedMediaHandle
        }
        return result
    }

    const preparedContent = prepareModernMessageContent(content)
    const fullMsg = await generateWAMessage(jid, statusAttribution ? withNewsletterStatusAttribution(preparedContent) : preparedContent, {
        logger: config.logger,
        userJid,
        upload,
        mediaCache: config.mediaCache,
        options: config.options,
        ...messageOptions,
        messageId: requestedMessageId || generateMessageIDV2(userJid)
    })

    const normalized = normalizeMessageContent(fullMsg.message)
    const mediaType = getNewsletterStatusMediaType(fullMsg.message)
    if (!mediaType && (normalized?.documentMessage || normalized?.stickerMessage)) {
        throw new TypeError('Native newsletter status supports text, image, video, gif, and audio')
    }
    if (mediaType && !NEWSLETTER_STATUS_WEB_MEDIA_TYPES.has(mediaType)) {
        config.logger?.warn?.({ mediaType }, 'newsletter status media type is not published by WhatsApp Web itself, the server may reject it')
    }

    const interactionType = requestedInteractionType || (content.question ? 'question' : undefined)
    if (interactionType === 'question' && !mediaType) {
        config.logger?.warn?.('WhatsApp Web only publishes question newsletter statuses on top of media, a text question status may be rejected')
    }

    const node = buildNewsletterStatusNode({
        jid,
        message: fullMsg.message,
        messageId: fullMsg.key.id,
        mediaType,
        mediaHandle: requestedMediaHandle ?? mediaId ?? uploadedMediaHandle,
        parentServerId,
        responseServerId,
        interactionType,
        aiContent
    })

    const echo = resolveServerId === false
        ? null
        : waitForNewsletterStatusServerId(sock, {
            jid,
            messageId: fullMsg.key.id,
            timeoutMs: serverIdTimeoutMs ?? NEWSLETTER_STATUS_SERVER_ID_TIMEOUT_MS
        })

    let ack
    try {
        ack = await sendStatusNode(sock, node, {
            jid,
            messageId: fullMsg.key.id,
            timeoutMs: ackTimeoutMs ?? NEWSLETTER_STATUS_ACK_TIMEOUT_MS
        })
    }
    catch (error) {
        echo?.cancel()
        throw error
    }

    const delivered = echo ? await echo : undefined

    fullMsg.status = WAMessageStatus.SERVER_ACK
    fullMsg.newsletterStatusServerId = ack.serverId ?? delivered?.serverId
    fullMsg.newsletterStatusAck = ack
    fullMsg.newsletterStatusResponse = ack.node
    if (delivered) fullMsg.newsletterStatusDelivered = delivered.node
    return fullMsg
}

export const makeNewsletterStatusReactionSender = sock => async (jid, parentServerId, reaction, options = {}) => {
    assertNewsletterJid(jid)
    const userJid = sock.authState?.creds?.me?.id
    if (!userJid) throw new TypeError('Not authenticated')

    const messageId = options.messageId || generateMessageIDV2(userJid)
    const node = buildNewsletterStatusReactionNode({ jid, messageId, parentServerId, reaction })
    const ack = await sendStatusNode(sock, node, {
        jid,
        messageId,
        timeoutMs: options.ackTimeoutMs ?? NEWSLETTER_STATUS_ACK_TIMEOUT_MS
    })

    return {
        key: {
            remoteJid: jid,
            fromMe: true,
            id: messageId
        },
        status: WAMessageStatus.SERVER_ACK,
        newsletterStatusServerId: ack.serverId,
        newsletterStatusAck: ack,
        newsletterStatusResponse: ack.node
    }
}

export const makeNewsletterStatusRevokeSender = sock => async (jid, statusId, options = {}) => {
    assertNewsletterJid(jid)
    const userJid = sock.authState?.creds?.me?.id
    if (!userJid) throw new TypeError('Not authenticated')

    const node = buildNewsletterStatusRevokeNode({ jid, statusId })
    const ack = await sendStatusNode(sock, node, {
        jid,
        messageId: statusId,
        timeoutMs: options.ackTimeoutMs ?? NEWSLETTER_STATUS_ACK_TIMEOUT_MS
    })

    return {
        key: {
            remoteJid: jid,
            fromMe: true,
            id: statusId
        },
        status: WAMessageStatus.SERVER_ACK,
        newsletterStatusAck: ack,
        newsletterStatusResponse: ack.node
    }
}

const decodeStatusPayload = plaintext => {
    const bytes = plaintext?.content
    if (!bytes || Array.isArray(bytes)) return undefined
    return proto.Message.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
}

const parseStatusAdminProfile = meta => {
    const adminProfile = meta && getBinaryNodeChild(meta, 'admin_profile')
    if (!adminProfile) return undefined

    const name = getBinaryNodeChild(adminProfile, 'name')
    const picture = getBinaryNodeChild(adminProfile, 'picture')
    const content = name?.content
    return {
        id: adminProfile.attrs?.id,
        name: typeof content === 'string'
            ? content
            : content instanceof Uint8Array
                ? Buffer.from(content).toString('utf-8')
                : undefined,
        pictureId: picture?.attrs?.id,
        pictureDirectPath: picture?.attrs?.direct_path
    }
}

const parseStatusNode = status => {
    const plaintext = getBinaryNodeChild(status, 'plaintext')
    const reaction = getBinaryNodeChild(status, 'reaction')
    const meta = getBinaryNodeChild(status, 'meta')
    const reactions = getBinaryNodeChild(status, 'reactions')
    const viewsCount = getBinaryNodeChild(status, 'views_count')
    const responsesCount = getBinaryNodeChild(status, 'responses_count')
    return {
        id: status.attrs?.id,
        serverId: readIntAttr(status.attrs, 'server_id'),
        t: readIntAttr(status.attrs, 't'),
        isSender: status.attrs?.is_sender === 'true',
        type: status.attrs?.type,
        edit: status.attrs?.edit,
        mediaType: plaintext?.attrs?.mediatype,
        interactionType: meta?.attrs?.interaction_type,
        reaction: reaction ? reaction.attrs?.code ?? '' : undefined,
        adminProfile: parseStatusAdminProfile(meta),
        paidPartnership: meta ? !!getBinaryNodeChild(meta, 'paid_partnership') : false,
        aiContent: meta ? !!getBinaryNodeChild(meta, 'ai_content') : false,
        editTimestamp: readIntAttr(meta?.attrs, 'msg_edit_t'),
        originalTimestamp: readIntAttr(meta?.attrs, 'original_msg_t'),
        reactionCounts: reactions
            ? getBinaryNodeChildren(reactions, 'reaction').map(entry => ({
                code: entry.attrs?.code,
                count: readIntAttr(entry.attrs, 'count')
            }))
            : undefined,
        viewsCount: readIntAttr(viewsCount?.attrs, 'count'),
        responsesCount: readIntAttr(responsesCount?.attrs, 'count'),
        message: decodeStatusPayload(plaintext),
        node: status
    }
}

export const parseNewsletterStatusUpdatesResponse = node => {
    const updates = getBinaryNodeChild(node, 'status_updates')
    if (!updates) {
        const children = Array.isArray(node?.content) ? node.content.map(child => child?.tag) : []
        const error = new Error(`Newsletter status updates response has no <status_updates> child, got [${children.join(', ')}]`)
        error.data = node
        throw error
    }

    return parseNewsletterStatusesResponse(updates)
}

export const makeNewsletterStatusUpdatesFetcher = sock => async (jid, options = {}) => {
    assertNewsletterJid(jid)

    const { count = 20, since, before, after } = options
    const attrs = { count: String(count) }
    if (isPresent(since)) attrs.since = String(since)
    if (isPresent(before)) attrs.before = toServerId(before, 'before')
    else if (isPresent(after)) attrs.after = toServerId(after, 'after')

    const result = await sock.query({
        tag: 'iq',
        attrs: {
            to: jid,
            xmlns: 'newsletter',
            type: 'get'
        },
        content: [{ tag: 'status_updates', attrs, content: undefined }]
    })

    return parseNewsletterStatusUpdatesResponse(result)
}

export const parseNewsletterStatusesResponse = node => {
    const statuses = getBinaryNodeChild(node, 'statuses')
    if (!statuses) {
        const children = Array.isArray(node?.content) ? node.content.map(child => child?.tag) : []
        const error = new Error(`Newsletter statuses response has no <statuses> child, got [${children.join(', ')}]`)
        error.data = node
        throw error
    }

    return {
        jid: statuses.attrs?.jid,
        t: readIntAttr(statuses.attrs, 't'),
        statuses: getBinaryNodeChildren(statuses, 'status').map(parseStatusNode)
    }
}

export const makeNewsletterStatusFetcher = sock => async (jid, options = {}) => {
    assertNewsletterJid(jid)

    const { count = 20, before, after, viewRole } = options
    const attrs = { type: 'jid', jid }
    if (isPresent(viewRole)) attrs.view_role = String(viewRole).toLowerCase()
    attrs.count = String(count)
    if (isPresent(before)) attrs.before = toServerId(before, 'before')
    else if (isPresent(after)) attrs.after = toServerId(after, 'after')

    const result = await sock.query({
        tag: 'iq',
        attrs: {
            to: S_WHATSAPP_NET,
            xmlns: 'newsletter',
            type: 'get'
        },
        content: [{ tag: 'statuses', attrs, content: undefined }]
    })

    return parseNewsletterStatusesResponse(result)
}

export { NEWSLETTER_STATUS_CONTENT_TYPES, NEWSLETTER_STATUS_MEDIA_TYPES, NEWSLETTER_STATUS_WEB_MEDIA_TYPES }

const requireObject = (value, name) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`)
    }
    return value
}

const requireKey = (value, name = 'key') => {
    requireObject(value, name)
    if (!value.id) {
        throw new TypeError(`${name}.id is required`)
    }
    return value
}

const enumValue = (enumObject, value, fallback) => {
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
        const key = value.trim().toUpperCase()
        if (key in enumObject) return enumObject[key]
    }
    return fallback
}

export const STATUS_NOTIFICATION_TYPES = Object.freeze({
    ...proto.Message.StatusNotificationMessage.StatusNotificationType,
    STATUS_GROUP_STATUS_REPLY: 4
})

const toSeconds = value => value instanceof Date ? Math.floor(value.getTime() / 1000) : value

const toMilliseconds = value => value instanceof Date ? value.getTime() : value

const makeInnerCommentMessage = content => {
    const data = requireObject(content, 'comment.content')
    if (data.raw && typeof data.raw === 'object') return data.raw
    if (typeof data.text === 'string') {
        return {
            extendedTextMessage: proto.Message.ExtendedTextMessage.create({
                text: data.text,
                contextInfo: data.contextInfo
            })
        }
    }
    const keys = Object.keys(data)
    if (keys.some(key => key.endsWith('Message'))) return data
    throw new TypeError('comment.content supports text, raw, or protobuf message fields')
}

export const makeQuestionMessage = input => {
    const data = requireObject(input, 'question')
    if (typeof data.text !== 'string' || !data.text.length) {
        throw new TypeError('question.text is required')
    }
    return {
        questionMessage: proto.Message.FutureProofMessage.create({
            message: {
                extendedTextMessage: proto.Message.ExtendedTextMessage.create({
                    text: data.text,
                    contextInfo: {
                        ...(data.contextInfo || {}),
                        isQuestion: true
                    }
                })
            }
        })
    }
}

export const makeQuestionResponseMessage = input => {
    const data = requireObject(input, 'questionResponse')
    requireKey(data.key, 'questionResponse.key')
    return {
        questionResponseMessage: proto.Message.QuestionResponseMessage.create({
            key: data.key,
            text: data.text ?? ''
        })
    }
}

export const makeQuestionReplyMessage = input => {
    const data = requireObject(input, 'questionReply')
    if (typeof data.text !== 'string' || !data.text.length) {
        throw new TypeError('questionReply.text is required')
    }
    if (data.serverQuestionId === undefined || data.serverQuestionId === null) {
        throw new TypeError('questionReply.serverQuestionId is required')
    }
    const quoted = {
        serverQuestionId: Number(data.serverQuestionId)
    }
    if (data.quotedQuestion) quoted.quotedQuestion = data.quotedQuestion
    if (data.quotedResponse) quoted.quotedResponse = data.quotedResponse
    return {
        questionReplyMessage: proto.Message.FutureProofMessage.create({
            message: {
                extendedTextMessage: proto.Message.ExtendedTextMessage.create({
                    text: data.text,
                    contextInfo: {
                        ...(data.contextInfo || {}),
                        questionReplyQuotedMessage: quoted
                    }
                })
            }
        })
    }
}

export const makeStatusQuestionAnswerMessage = input => {
    const data = requireObject(input, 'statusQuestionAnswer')
    requireKey(data.key, 'statusQuestionAnswer.key')
    return {
        statusQuestionAnswerMessage: proto.Message.StatusQuestionAnswerMessage.create({
            key: data.key,
            text: data.text ?? ''
        })
    }
}

export const makeStatusQuotedMessage = input => {
    const data = requireObject(input, 'statusQuoted')
    requireKey(data.originalStatusId, 'statusQuoted.originalStatusId')
    const type = enumValue(
        proto.Message.StatusQuotedMessage.StatusQuotedMessageType,
        data.type,
        proto.Message.StatusQuotedMessage.StatusQuotedMessageType.QUESTION_ANSWER
    )
    return {
        statusQuotedMessage: proto.Message.StatusQuotedMessage.create({
            type,
            text: data.text,
            thumbnail: data.thumbnail,
            originalStatusId: data.originalStatusId
        })
    }
}

export const makeStatusStickerInteractionMessage = input => {
    const data = requireObject(input, 'statusStickerInteraction')
    requireKey(data.key, 'statusStickerInteraction.key')
    if (!data.stickerKey) {
        throw new TypeError('statusStickerInteraction.stickerKey is required')
    }
    const type = enumValue(
        proto.Message.StatusStickerInteractionMessage.StatusStickerType,
        data.type,
        proto.Message.StatusStickerInteractionMessage.StatusStickerType.REACTION
    )
    return {
        statusStickerInteractionMessage: proto.Message.StatusStickerInteractionMessage.create({
            key: data.key,
            stickerKey: data.stickerKey,
            type
        })
    }
}

export const makeStatusNotificationMessage = input => {
    const data = requireObject(input, 'statusNotification')
    requireKey(data.responseMessageKey, 'statusNotification.responseMessageKey')
    requireKey(data.originalMessageKey, 'statusNotification.originalMessageKey')
    const type = enumValue(
        STATUS_NOTIFICATION_TYPES,
        data.type,
        STATUS_NOTIFICATION_TYPES.UNKNOWN
    )
    return {
        statusNotificationMessage: proto.Message.StatusNotificationMessage.create({
            responseMessageKey: data.responseMessageKey,
            originalMessageKey: data.originalMessageKey,
            type
        })
    }
}

export const makeNewsletterAdminInviteMessage = input => {
    const data = requireObject(input, 'newsletterAdminInvite')
    if (!data.newsletterJid) {
        throw new TypeError('newsletterAdminInvite.newsletterJid is required')
    }
    return {
        newsletterAdminInviteMessage: proto.Message.NewsletterAdminInviteMessage.create({
            newsletterJid: data.newsletterJid,
            newsletterName: data.newsletterName,
            jpegThumbnail: data.jpegThumbnail,
            caption: data.caption,
            inviteExpiration: data.inviteExpiration,
            contextInfo: data.contextInfo
        })
    }
}

export const makeNewsletterFollowerInviteMessage = input => {
    const data = requireObject(input, 'newsletterFollowerInvite')
    if (!data.newsletterJid) {
        throw new TypeError('newsletterFollowerInvite.newsletterJid is required')
    }
    return {
        newsletterFollowerInviteMessageV2: proto.Message.NewsletterFollowerInviteMessage.create({
            newsletterJid: data.newsletterJid,
            newsletterName: data.newsletterName,
            jpegThumbnail: data.jpegThumbnail,
            caption: data.caption,
            contextInfo: data.contextInfo
        })
    }
}

export const makePollAddOptionMessage = input => {
    const data = requireObject(input, 'pollAddOption')
    requireKey(data.pollCreationMessageKey, 'pollAddOption.pollCreationMessageKey')
    const addOption = typeof data.option === 'string'
        ? { optionName: data.option }
        : data.addOption || data.option
    if (!addOption?.optionName) {
        throw new TypeError('pollAddOption.option is required')
    }
    return {
        pollAddOptionMessage: proto.Message.PollAddOptionMessage.create({
            pollCreationMessageKey: data.pollCreationMessageKey,
            addOption,
            metadata: data.metadata
        })
    }
}

export const makeCommentMessage = input => {
    const data = requireObject(input, 'comment')
    requireKey(data.targetMessageKey, 'comment.targetMessageKey')
    const message = data.message || (data.content ? makeInnerCommentMessage(data.content) : null)
    requireObject(message, 'comment.message')
    return {
        commentMessage: proto.Message.CommentMessage.create({
            message,
            targetMessageKey: data.targetMessageKey
        })
    }
}

export const makeEventInviteMessage = input => {
    const data = requireObject(input, 'eventInvite')
    if (!data.eventId) {
        throw new TypeError('eventInvite.eventId is required')
    }
    return {
        eventInviteMessage: proto.Message.EventInviteMessage.create({
            contextInfo: data.contextInfo,
            eventId: data.eventId,
            eventTitle: data.eventTitle,
            jpegThumbnail: data.jpegThumbnail,
            startTime: toSeconds(data.startTime),
            caption: data.caption,
            isCanceled: data.isCanceled,
            endTime: toSeconds(data.endTime),
            callLink: data.callLink
        })
    }
}

export const makeScheduledCallCreationMessage = input => {
    const data = requireObject(input, 'scheduledCall')
    if (!data.scheduledTimestampMs) {
        throw new TypeError('scheduledCall.scheduledTimestampMs is required')
    }
    const callType = enumValue(
        proto.Message.ScheduledCallCreationMessage.CallType,
        data.callType,
        proto.Message.ScheduledCallCreationMessage.CallType.UNKNOWN
    )
    return {
        scheduledCallCreationMessage: proto.Message.ScheduledCallCreationMessage.create({
            scheduledTimestampMs: toMilliseconds(data.scheduledTimestampMs),
            callType,
            title: data.title
        })
    }
}

export const makeScheduledCallEditMessage = input => {
    const data = requireObject(input, 'scheduledCallEdit')
    requireKey(data.key, 'scheduledCallEdit.key')
    const editType = enumValue(
        proto.Message.ScheduledCallEditMessage.EditType,
        data.editType,
        proto.Message.ScheduledCallEditMessage.EditType.CANCEL
    )
    return {
        scheduledCallEditMessage: proto.Message.ScheduledCallEditMessage.create({
            key: data.key,
            editType
        })
    }
}

export const makeGroupStatusReactionMessage = input => {
    const data = requireObject(input, 'groupStatusReaction')
    requireKey(data.key, 'groupStatusReaction.key')
    return {
        groupStatusMessageV2: proto.Message.FutureProofMessage.create({
            message: {
                reactionMessage: proto.Message.ReactionMessage.create({
                    key: data.key,
                    text: data.text ?? '',
                    groupingKey: data.groupingKey,
                    senderTimestampMs: data.senderTimestampMs || Date.now()
                })
            }
        })
    }
}

export const makeNewsletterStatusAttribution = input => {
    const data = requireObject(input, 'newsletterStatus')
    if (!data.newsletterJid) {
        throw new TypeError('newsletterStatus.newsletterJid is required')
    }
    if (data.messageId === undefined || data.messageId === null) {
        throw new TypeError('newsletterStatus.messageId is required')
    }
    return proto.StatusAttribution.create({
        type: proto.StatusAttribution.Type.NEWSLETTER_STATUS,
        actionUrl: data.actionUrl,
        statusReshare: {
            source: proto.StatusAttribution.StatusReshare.Source.CHANNEL_RESHARE,
            metadata: {
                duration: data.duration,
                channelJid: data.newsletterJid,
                channelMessageId: Number(data.messageId),
                hasMultipleReshares: data.hasMultipleReshares ?? false
            }
        }
    })
}

export const makeGroupStatusAttribution = input => {
    const data = requireObject(input, 'groupStatusAttribution')
    if (!data.authorJid) {
        throw new TypeError('groupStatusAttribution.authorJid is required')
    }
    return proto.StatusAttribution.create({
        type: proto.StatusAttribution.Type.GROUP_STATUS,
        actionUrl: data.actionUrl,
        groupStatus: {
            authorJid: data.authorJid
        }
    })
}

export const STATUS_AUDIENCE_DEFAULT_LIST_NAME = 'Close friends'

export const STATUS_AUDIENCE_DEFAULT_EMOJI = '⭐'

export const makeStatusAudienceMetadata = input => {
    const data = typeof input === 'string' ? { listName: input } : requireObject(input, 'statusAudience')
    const audienceType = enumValue(
        proto.ContextInfo.StatusAudienceMetadata.AudienceType,
        data.audienceType,
        proto.ContextInfo.StatusAudienceMetadata.AudienceType.CLOSE_FRIENDS
    )
    const listName = data.listName === undefined ? STATUS_AUDIENCE_DEFAULT_LIST_NAME : String(data.listName)
    const listEmoji = data.listEmoji === undefined ? STATUS_AUDIENCE_DEFAULT_EMOJI : String(data.listEmoji)
    return proto.ContextInfo.StatusAudienceMetadata.create({
        audienceType,
        listName,
        listEmoji
    })
}

export const makeMessageAssociation = input => {
    const data = requireObject(input, 'messageAssociation')
    const parentMessageKey = data.parentMessageKey ?? data.key
    requireKey(parentMessageKey, 'messageAssociation.parentMessageKey')
    const associationType = enumValue(
        proto.MessageAssociation.AssociationType,
        data.associationType ?? data.type,
        proto.MessageAssociation.AssociationType.UNKNOWN
    )
    return proto.MessageAssociation.create({
        associationType,
        parentMessageKey,
        messageIndex: data.messageIndex
    })
}

export const makeStatusAddYoursAssociation = input => {
    const data = input && typeof input === 'object' && !Array.isArray(input) && input.id
        ? { key: input }
        : requireObject(input, 'addYours')
    const parentMessageKey = data.key ?? data.parentMessageKey
    requireKey(parentMessageKey, 'addYours.key')
    const associationType = enumValue(
        proto.MessageAssociation.AssociationType,
        data.type ?? data.associationType,
        proto.MessageAssociation.AssociationType.STATUS_ADD_YOURS
    )
    return proto.MessageAssociation.create({
        associationType,
        parentMessageKey,
        messageIndex: data.messageIndex
    })
}

export const makeStatusMentionMessage = input => {
    const data = requireObject(input, 'statusMention')
    requireKey(data.key, 'statusMention.key')
    const field = data.group ? 'groupStatusMentionMessage' : 'statusMentionMessage'
    return {
        [field]: proto.Message.FutureProofMessage.create({
            message: {
                protocolMessage: proto.Message.ProtocolMessage.create({
                    key: data.key,
                    type: proto.Message.ProtocolMessage.Type.STATUS_MENTION_MESSAGE
                })
            }
        })
    }
}

const modernBuilders = [
    ['question', makeQuestionMessage],
    ['questionReply', makeQuestionReplyMessage],
    ['questionResponse', makeQuestionResponseMessage],
    ['statusQuestionAnswer', makeStatusQuestionAnswerMessage],
    ['statusQuoted', makeStatusQuotedMessage],
    ['statusStickerInteraction', makeStatusStickerInteractionMessage],
    ['statusNotification', makeStatusNotificationMessage],
    ['newsletterAdminInvite', makeNewsletterAdminInviteMessage],
    ['newsletterFollowerInvite', makeNewsletterFollowerInviteMessage],
    ['pollAddOption', makePollAddOptionMessage],
    ['comment', makeCommentMessage],
    ['eventInvite', makeEventInviteMessage],
    ['scheduledCall', makeScheduledCallCreationMessage],
    ['scheduledCallEdit', makeScheduledCallEditMessage],
    ['groupStatusReaction', makeGroupStatusReactionMessage],
    ['statusMention', makeStatusMentionMessage]
]

export const prepareModernMessageContent = content => {
    if (!content || typeof content !== 'object' || Array.isArray(content)) return content
    let output = { ...content }
    const attributions = Array.isArray(output.contextInfo?.statusAttributions)
        ? [...output.contextInfo.statusAttributions]
        : []
    if (output.newsletterStatus) {
        attributions.push(makeNewsletterStatusAttribution(output.newsletterStatus))
        delete output.newsletterStatus
    }
    if (output.groupStatusAttribution) {
        attributions.push(makeGroupStatusAttribution(output.groupStatusAttribution))
        delete output.groupStatusAttribution
    }
    if (Array.isArray(output.statusAttributions)) {
        attributions.push(...output.statusAttributions)
        delete output.statusAttributions
    }
    const carried = []
    const audience = output.statusAudience
    if (audience !== undefined && audience !== null) {
        carried.push('statusAudience')
        output.contextInfo = {
            ...(output.contextInfo || {}),
            statusAudienceMetadata: makeStatusAudienceMetadata(audience)
        }
        delete output.statusAudience
    }
    if (attributions.length) {
        output.contextInfo = {
            ...(output.contextInfo || {}),
            statusAttributions: attributions
        }
    }
    if (output.addYours !== undefined && output.addYours !== null) {
        carried.push('addYours')
        output.messageAssociation = makeStatusAddYoursAssociation(output.addYours)
        delete output.addYours
    }
    else if (output.messageAssociation !== undefined && output.messageAssociation !== null) {
        carried.push('messageAssociation')
        output.messageAssociation = makeMessageAssociation(output.messageAssociation)
    }
    for (const [key, builder] of modernBuilders) {
        if (output[key] !== undefined && output[key] !== null) {
            if (carried.length) {
                throw new TypeError(
                    `${carried.join(' and ')} cannot be combined with ${key}: ${key} builds its own message and keeps no room for them. `
                    + 'Build it with the low-level makers and generateWAMessageFromContent instead.'
                )
            }
            return {
                raw: true,
                ...builder(output[key])
            }
        }
    }
    return output
}

export const StatusLinkType = Object.freeze({
    RASTERIZED_LINK_PREVIEW: 1,
    RASTERIZED_LINK_TRUNCATED: 2,
    RASTERIZED_LINK_FULL_URL: 3
})

export const STICKER_DEFAULT_AREA = Object.freeze({ x: 0.25, y: 0.4, width: 0.5, height: 0.2 })

const trimUndefined = (object) => {
    for (const key of Object.keys(object)) {
        if (object[key] === undefined) {
            delete object[key]
        }
    }
    return object
}

const fraction = (value, name) => {
    const number = Number(value)
    if (!Number.isFinite(number) || number < 0 || number > 1) {
        throw new TypeError(`${name} must be between 0 and 1, the client reads these as a fraction of the media`)
    }
    return number
}

export const stickerArea = ({ x, y, width, height } = STICKER_DEFAULT_AREA) => {
    const left = fraction(x, 'x')
    const top = fraction(y, 'y')
    const right = fraction(left + Number(width), 'x + width')
    const bottom = fraction(top + Number(height), 'y + height')
    if (right <= left || bottom <= top) {
        throw new TypeError('a sticker area needs a positive width and height')
    }
    return [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom }
    ]
}

const annotation = (area, fields) => ({
    polygonVertices: Array.isArray(area) ? area : stickerArea(area),
    ...fields
})

export const locationSticker = ({ latitude, longitude, name, area, skipConfirmation } = {}) => {
    const degreesLatitude = Number(latitude)
    const degreesLongitude = Number(longitude)
    if (!Number.isFinite(degreesLatitude) || !Number.isFinite(degreesLongitude)) {
        throw new TypeError('locationSticker needs a numeric latitude and longitude')
    }
    return annotation(area, {
        location: { degreesLatitude, degreesLongitude, ...(name ? { name } : {}) },
        ...(skipConfirmation === undefined ? {} : { shouldSkipConfirmation: !!skipConfirmation })
    })
}

export const channelSticker = ({ jid, name, serverMessageId = 0, accessibilityText, area } = {}) => {
    if (typeof jid !== 'string' || !jid.endsWith('@newsletter')) {
        throw new TypeError('channelSticker needs the channel jid, the one ending in @newsletter')
    }
    return annotation(area, {
        newsletter: {
            newsletterJid: jid,
            serverMessageId: Number(serverMessageId),
            ...(name ? { newsletterName: name } : {}),
            ...(accessibilityText ? { accessibilityText } : {})
        }
    })
}

export const linkSticker = ({ url, title, area, linkType = StatusLinkType.RASTERIZED_LINK_PREVIEW } = {}) => {
    if (typeof url !== 'string' || !url) {
        throw new TypeError('linkSticker needs a url')
    }
    return annotation(area, {
        tapAction: { tapUrl: url, ...(title ? { title } : {}) },
        statusLinkType: linkType
    })
}

export const musicSticker = ({
    songId,
    title,
    author,
    mediaId,
    artworkDirectPath,
    artworkSha256,
    artworkEncSha256,
    artworkMediaKey,
    artistAttribution,
    countryBlocklist,
    isExplicit,
    startTimeMs = 0,
    derivedStartTimeMs,
    durationMs,
    area
} = {}) => {
    if (!songId && !mediaId) {
        throw new TypeError('musicSticker needs at least a songId or a musicContentMediaId')
    }
    const bytes = value => (value === undefined ? undefined : Buffer.isBuffer(value) ? value : Buffer.from(value, 'base64'))
    const embeddedMusic = {
        ...(songId ? { songId: String(songId) } : {}),
        ...(mediaId ? { musicContentMediaId: String(mediaId) } : {}),
        ...(title ? { title } : {}),
        ...(author ? { author } : {}),
        ...(artistAttribution ? { artistAttribution } : {}),
        ...(artworkDirectPath ? { artworkDirectPath } : {}),
        ...(isExplicit === undefined ? {} : { isExplicit: !!isExplicit }),
        musicSongStartTimeInMs: Number(startTimeMs),
        ...(derivedStartTimeMs === undefined ? {} : { derivedContentStartTimeInMs: Number(derivedStartTimeMs) }),
        ...(durationMs === undefined ? {} : { overlapDurationInMs: Number(durationMs) })
    }
    for (const [key, value] of [
        ['artworkSha256', artworkSha256],
        ['artworkEncSha256', artworkEncSha256],
        ['artworkMediaKey', artworkMediaKey],
        ['countryBlocklist', countryBlocklist]
    ]) {
        const buffer = bytes(value)
        if (buffer) {
            embeddedMusic[key] = buffer
        }
    }
    return annotation(area, { embeddedContent: { embeddedMusic } })
}

export const messageSticker = ({ stanzaId, message, area } = {}) => {
    if (!message) {
        throw new TypeError('messageSticker needs the message it embeds')
    }
    return annotation(area, {
        embeddedContent: { embeddedMessage: { ...(stanzaId ? { stanzaId } : {}), message } }
    })
}

const ACTIONS = ['location', 'newsletter', 'embeddedAction', 'tapAction']

export const normalizeStickers = (stickers) => {
    const list = Array.isArray(stickers) ? stickers : [stickers]
    return list.filter(Boolean).map((sticker, index) => {
        const vertices = sticker.polygonVertices
        if (!Array.isArray(vertices) || vertices.length !== 4) {
            throw new TypeError(`sticker ${index} needs four polygonVertices, the client reads corner 0 and corner 2`)
        }
        const actions = ACTIONS.filter(name => sticker[name] !== undefined && sticker[name] !== null)
        if (actions.length > 1) {
            throw new TypeError(`sticker ${index} sets ${actions.join(' and ')}, but the client reads only one action per sticker`)
        }
        return proto.InteractiveAnnotation.fromObject(sticker)
    })
}

export const readStickers = (message) => {
    const media = message?.imageMessage ?? message?.videoMessage ?? message
    const annotations = media?.interactiveAnnotations
    if (!Array.isArray(annotations) || !annotations.length) {
        return []
    }
    return annotations.map(item => {
        const [topLeft, , bottomRight] = item.polygonVertices ?? []
        const music = item.embeddedContent?.embeddedMusic
        return {
            kind: item.location
                ? 'location'
                : item.newsletter
                    ? 'channel'
                    : item.tapAction
                        ? 'link'
                        : music
                            ? 'music'
                            : item.embeddedContent?.embeddedMessage
                                ? 'message'
                                : 'unknown',
            area: topLeft && bottomRight
                ? { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y }
                : undefined,
            location: item.location ?? undefined,
            channel: item.newsletter ?? undefined,
            link: item.tapAction ? { url: item.tapAction.tapUrl, title: item.tapAction.title, linkType: item.statusLinkType } : undefined,
            music: music ? { songId: music.songId, title: music.title, author: music.author } : undefined,
            message: item.embeddedContent?.embeddedMessage ?? undefined,
            annotation: item
        }
    })
}

export const MusicMessageStyle = Object.freeze({ UNKNOWN: 0, VINYL: 1 })

export const MUSIC_ALLOWED_HOSTS = Object.freeze([
    '.whatsapp.net',
    '.whatsapp.com',
    '.fbcdn.net',
    '.facebook.com',
    '.instagram.com',
    '.cdninstagram.com'
])

export const isMusicHostAllowed = (value) => {
    let host
    try {
        host = new URL(String(value)).hostname.toLowerCase()
    }
    catch {
        return false
    }
    return MUSIC_ALLOWED_HOSTS.some(suffix => host.endsWith(suffix) || host === suffix.slice(1))
}

const assertMusicHost = (value, label) => {
    if (value === undefined) {
        return undefined
    }
    if (!isMusicHostAllowed(value)) {
        throw new TypeError(
            `${label} must be hosted on ${MUSIC_ALLOWED_HOSTS.join(', ')} — the client refuses any other host `
            + 'and draws nothing. Both uris come from Meta music catalog entries, so carry them over from a '
            + 'message you received rather than pointing at your own file'
        )
    }
    return value
}

const embeddedMusicOf = (options) => musicSticker(options).embeddedContent.embeddedMusic

export const buildMusicMessage = ({ songUri, artworkUri, style = MusicMessageStyle.VINYL, contextInfo, ...music } = {}) =>
    trimUndefined({
        embeddedMusic: embeddedMusicOf(music),
        songUri: assertMusicHost(songUri, 'songUri'),
        artworkUri: assertMusicHost(artworkUri, 'artworkUri'),
        style,
        contextInfo
    })

export const readMusicMessage = (msg) => {
    const message = msg?.message ?? msg
    const music = message?.musicMessage
    if (!music) {
        return null
    }
    const embedded = music.embeddedMusic ?? {}
    return {
        songId: embedded.songId,
        mediaId: embedded.musicContentMediaId,
        title: embedded.title,
        author: embedded.author,
        artistAttribution: embedded.artistAttribution,
        isExplicit: embedded.isExplicit,
        startTimeMs: embedded.musicSongStartTimeInMs,
        durationMs: embedded.overlapDurationInMs,
        songUri: music.songUri,
        artworkUri: music.artworkUri,
        style: music.style,
        embeddedMusic: embedded
    }
}

export const withMusicAttribution = (content, music = {}) => {
    if (!content || typeof content !== 'object') {
        throw new Error('withMusicAttribution: content must be a status content object');
    }
    const { title, authorName, songId, artistAttribution, isExplicit, actionUrl } = music || {};
    if (!title && !songId) {
        throw new Error('withMusicAttribution: music needs at least { title } or { songId }');
    }
    const attribution = {
        type: 3,
        ...(actionUrl ? { actionUrl } : {}),
        music: {
            ...(title ? { title } : {}),
            ...(authorName ? { authorName } : {}),
            ...(songId ? { songId } : {}),
            ...(artistAttribution ? { artistAttribution } : {}),
            ...(typeof isExplicit === 'boolean' ? { isExplicit } : {})
        }
    };
    return {
        ...content,
        contextInfo: {
            ...(content.contextInfo || {}),
            statusAttributionType: 3,
            statusAttributions: [...(content.contextInfo?.statusAttributions || []), attribution]
        }
    };
};
