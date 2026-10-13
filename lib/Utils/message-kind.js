
const unwrapMessage = message => {
  let content = message;
  for (let i = 0; i < 5; i++) {
    const inner = content?.ephemeralMessage?.message || content?.viewOnceMessage?.message || content?.viewOnceMessageV2?.message || content?.viewOnceMessageV2Extension?.message || content?.documentWithCaptionMessage?.message || content?.editedMessage?.message;
    if (!inner) {
      break;
    }
    content = inner;
  }
  return content;
};

const resolveNativeFlowAddonKind = nativeFlow => {
  const firstButtonName = nativeFlow?.buttons?.[0]?.name;
  if (firstButtonName === "payment_info") return "payment_info";
  if (firstButtonName === "review_and_pay") return "order_details";
  return "interactive";
};

export const resolveButtonAddonKind = message => {
  const msg = unwrapMessage(message);
  if (!msg) return null;
  if (msg.listMessage) return "list";
  if (msg.buttonsMessage) return "interactive";
  const nativeFlow = msg.interactiveMessage?.nativeFlowMessage;
  if (nativeFlow) return resolveNativeFlowAddonKind(nativeFlow);
  return null;
};

export const parseInteractiveReply = message => {
  const msg = unwrapMessage(message);
  const empty = {
    kind: null,
    id: null,
    displayText: null,
    params: null
  };
  if (!msg) return empty;
  if (msg.buttonsResponseMessage) {
    const r = msg.buttonsResponseMessage;
    return {
      kind: "buttons_response",
      id: r.selectedButtonId || null,
      displayText: r.selectedDisplayText || null,
      params: null
    };
  }
  if (msg.listResponseMessage) {
    const r = msg.listResponseMessage;
    return {
      kind: "list_response",
      id: r.singleSelectReply?.selectedRowId || null,
      displayText: r.title || r.description || null,
      params: null
    };
  }
  if (msg.interactiveResponseMessage) {
    const r = msg.interactiveResponseMessage;
    let params = null;
    if (r.nativeFlowResponseMessage?.paramsJson) {
      try {
        params = JSON.parse(r.nativeFlowResponseMessage.paramsJson);
      } catch {
        params = null;
      }
    }
    return {
      kind: "native_flow_response",
      id: params?.id ?? r.nativeFlowResponseMessage?.name ?? null,
      displayText: r.body?.text || null,
      params: params
    };
  }
  if (msg.templateButtonReplyMessage) {
    const r = msg.templateButtonReplyMessage;
    return {
      kind: "template_button_reply",
      id: r.selectedId || null,
      displayText: r.selectedDisplayText || null,
      params: null
    };
  }
  return empty;
};

const MAX_MESSAGE_UNWRAP_DEPTH = 5;

const MAX_FLAG_SCAN_DEPTH = 8;

const STRONG_GROUP_STATUS_MESSAGE_KEYS = new Set([
    'groupStatusMentionMessage',
    'groupStatusMessage',
    'groupStatusMessageV2',
]);

const WRAPPED_MESSAGE_KEYS = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
    'statusMentionMessage',
    'groupStatusMentionMessage',
    'groupStatusMessage',
    'groupStatusMessageV2',
];

export function isGroupStatusValue(value) {
    return value === true || value === 1;
}

function canScanObject(value) {
    return value && typeof value === 'object' && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value);
}

function hasGroupStatusAttribution(statusAttributions) {
    if (!Array.isArray(statusAttributions)) return false;

    return statusAttributions.some(
        (sa) =>
            canScanObject(sa) &&
            (Boolean(sa.groupStatus) || sa.attributionData === 'groupStatus' || sa.type === 'GROUP_STATUS' || sa.type === 5)
    );
}

function hasGroupStatusContextInfo(contextInfo) {
    return (
        canScanObject(contextInfo) &&
        (isGroupStatusValue(contextInfo.isGroupStatus) || hasGroupStatusAttribution(contextInfo.statusAttributions))
    );
}

export function hasGroupStatusFlag(value, depth = 0, seenObjects = new WeakSet()) {
    if (!canScanObject(value) || depth > MAX_FLAG_SCAN_DEPTH || seenObjects.has(value)) {
        return false;
    }

    seenObjects.add(value);

    for (const [key, childValue] of Object.entries(value)) {
        if (key === 'quotedMessage') continue;

        if (STRONG_GROUP_STATUS_MESSAGE_KEYS.has(key) && canScanObject(childValue)) {
            return true;
        }

        if (key === 'isGroupStatus' && isGroupStatusValue(childValue)) {
            return true;
        }

        if (key === 'statusAttributions' && hasGroupStatusAttribution(childValue)) {
            return true;
        }

        if (key === 'contextInfo' && hasGroupStatusContextInfo(childValue)) {
            return true;
        }

        if (hasGroupStatusFlag(childValue, depth + 1, seenObjects)) {
            return true;
        }
    }

    return false;
}

export function getCurrentMessageContentVariants(message, depth = 0, seenObjects = new WeakSet()) {
    if (!canScanObject(message) || depth > MAX_MESSAGE_UNWRAP_DEPTH || seenObjects.has(message)) {
        return [];
    }

    seenObjects.add(message);

    const variants = [message];

    for (const key of WRAPPED_MESSAGE_KEYS) {
        const wrappedMessage = message[key]?.message;
        variants.push(...getCurrentMessageContentVariants(wrappedMessage, depth + 1, seenObjects));
    }

    return variants;
}

export function hasGroupStatusMessage(webMessage) {
    return getCurrentMessageContentVariants(webMessage?.message).some((message) => hasGroupStatusFlag(message));
}
