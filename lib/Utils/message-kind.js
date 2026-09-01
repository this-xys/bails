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