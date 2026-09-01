import { generateMessageIDV2 } from "./generics.js";

import { generateWAMessageFromContent, normalizeMessageContent } from "./messages.js";

import { isJidGroup } from "../WABinary/index.js";

import { getButtonArgs, getButtonType } from "./button-helper-utils.js";

export class InteractiveValidationError extends Error {
  constructor(message, {context: context, errors: errors = [], warnings: warnings = [], example: example} = {}) {
    super(message);
    this.name = "InteractiveValidationError";
    this.context = context;
    this.errors = errors;
    this.warnings = warnings;
    this.example = example;
  }
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      context: this.context,
      errors: this.errors,
      warnings: this.warnings,
      example: this.example
    };
  }
  formatDetailed() {
    const lines = [ `[${this.name}] ${this.message}${this.context ? " (" + this.context + ")" : ""}` ];
    if (this.errors.length) {
      lines.push("Errors:");
      this.errors.forEach(e => lines.push("  - " + e));
    }
    if (this.warnings.length) {
      lines.push("Warnings:");
      this.warnings.forEach(w => lines.push("  - " + w));
    }
    if (this.example) {
      lines.push("Example payload:", JSON.stringify(this.example, null, 2));
    }
    return lines.join("\n");
  }
}

const EXAMPLE_PAYLOADS = {
  sendButtons: {
    text: "Choose an option",
    buttons: [ {
      id: "opt1",
      text: "Option 1"
    }, {
      id: "opt2",
      text: "Option 2"
    }, {
      name: "cta_url",
      buttonParamsJson: JSON.stringify({
        display_text: "Visit Site",
        url: "https://example.com"
      })
    } ],
    footer: "Footer text"
  },
  sendInteractiveMessage: {
    text: "Pick an action",
    interactiveButtons: [ {
      name: "quick_reply",
      buttonParamsJson: JSON.stringify({
        display_text: "Hello",
        id: "hello"
      })
    }, {
      name: "cta_copy",
      buttonParamsJson: JSON.stringify({
        display_text: "Copy Code",
        copy_code: "ABC123"
      })
    } ],
    footer: "Footer"
  }
};

const SEND_BUTTONS_ALLOWED_COMPLEX = new Set([ "cta_url", "cta_copy", "cta_call" ]);

const INTERACTIVE_ALLOWED_NAMES = new Set([ "quick_reply", "cta_url", "cta_copy", "cta_call", "cta_catalog", "cta_reminder", "cta_cancel_reminder", "address_message", "send_location", "open_webview", "mpm", "wa_payment_transaction_details", "automated_greeting_message_view_catalog", "galaxy_message", "single_select" ]);

const REQUIRED_FIELDS_MAP = {
  cta_url: [ "display_text", "url" ],
  cta_copy: [ "display_text", "copy_code" ],
  cta_call: [ "display_text", "phone_number" ],
  cta_catalog: [ "business_phone_number" ],
  cta_reminder: [ "display_text" ],
  cta_cancel_reminder: [ "display_text" ],
  address_message: [ "display_text" ],
  send_location: [ "display_text" ],
  open_webview: [ "title", "link" ],
  mpm: [ "product_id" ],
  wa_payment_transaction_details: [ "transaction_id" ],
  automated_greeting_message_view_catalog: [ "business_phone_number", "catalog_product_id" ],
  galaxy_message: [ "flow_token", "flow_id" ],
  single_select: [ "title", "sections" ],
  quick_reply: [ "display_text", "id" ]
};

function parseButtonParamsInternal(name, buttonParamsJson, errors, _warnings, index) {
  let parsed;
  try {
    parsed = JSON.parse(buttonParamsJson);
  } catch (e) {
    errors.push(`button[${index}] (${name}) invalid JSON: ${e.message}`);
    return null;
  }
  const required = REQUIRED_FIELDS_MAP[name] ?? [];
  for (const field of required) {
    if (!(field in parsed)) {
      errors.push(`button[${index}] (${name}) missing required field '${field}'`);
    }
  }
  if (name === "open_webview" && parsed.link) {
    const link = parsed.link;
    if (typeof link !== "object" || !link.url) {
      errors.push(`button[${index}] (open_webview) link.url required`);
    }
  }
  if (name === "single_select") {
    if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
      errors.push(`button[${index}] (single_select) sections must be a non-empty array`);
    }
  }
  return parsed;
}

export function buildInteractiveButtons(buttons = []) {
  return buttons.map((btn, i) => {
    if (btn.name && btn.buttonParamsJson) return btn;
    if (btn.id || btn.text || btn.displayText) {
      return {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: btn.text ?? btn.displayText ?? `Button ${i + 1}`,
          id: btn.id ?? `quick_${i + 1}`
        })
      };
    }
    if (btn.buttonId && btn.buttonText?.displayText) {
      return {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: btn.buttonText.displayText,
          id: btn.buttonId
        })
      };
    }
    return btn;
  });
}

export function validateAuthoringButtons(buttons) {
  const errors = [];
  const warnings = [];
  if (buttons === null) return {
    errors: [],
    warnings: [],
    valid: true,
    cleaned: []
  };
  if (!Array.isArray(buttons)) {
    errors.push("buttons must be an array");
    return {
      errors: errors,
      warnings: warnings,
      valid: false,
      cleaned: []
    };
  }
  const SOFT_CAP = 25;
  if (buttons.length === 0) {
    warnings.push("buttons array is empty");
  } else if (buttons.length > SOFT_CAP) {
    warnings.push(`buttons count (${buttons.length}) exceeds soft cap of ${SOFT_CAP}; may be rejected by client`);
  }
  const cleaned = buttons.map((btn, idx) => {
    if (btn === null || typeof btn !== "object") {
      errors.push(`button[${idx}] is not an object`);
      return btn;
    }
    if (btn.name && btn.buttonParamsJson) {
      if (typeof btn.buttonParamsJson !== "string") {
        errors.push(`button[${idx}] buttonParamsJson must be string`);
      } else {
        try {
          JSON.parse(btn.buttonParamsJson);
        } catch (e) {
          errors.push(`button[${idx}] buttonParamsJson is not valid JSON: ${e.message}`);
        }
      }
      return btn;
    }
    if (btn.id || btn.text || btn.displayText) return btn;
    if (btn.buttonId && btn.buttonText?.displayText) return btn;
    warnings.push(`button[${idx}] unrecognized shape; passing through unchanged`);
    return btn;
  });
  return {
    errors: errors,
    warnings: warnings,
    valid: errors.length === 0,
    cleaned: cleaned
  };
}

export function validateSendButtonsPayload(data) {
  const errors = [];
  const warnings = [];
  if (!data || typeof data !== "object") {
    return {
      valid: false,
      errors: [ "payload must be an object" ],
      warnings: warnings
    };
  }
  if (!data.text || typeof data.text !== "string") {
    errors.push("text is mandatory and must be a string");
  }
  if (!Array.isArray(data.buttons) || data.buttons.length === 0) {
    errors.push("buttons is mandatory and must be a non-empty array");
  } else {
    data.buttons.forEach((btn, i) => {
      if (!btn || typeof btn !== "object") {
        errors.push(`button[${i}] must be an object`);
        return;
      }
      if (btn.id && btn.text) {
        if (typeof btn.id !== "string" || typeof btn.text !== "string") {
          errors.push(`button[${i}] legacy quick reply id/text must be strings`);
        }
        return;
      }
      if (btn.name && btn.buttonParamsJson) {
        if (!SEND_BUTTONS_ALLOWED_COMPLEX.has(btn.name)) {
          errors.push(`button[${i}] name '${btn.name}' not allowed in sendButtons (allowed: ${[ ...SEND_BUTTONS_ALLOWED_COMPLEX ].join(", ")})`);
          return;
        }
        if (typeof btn.buttonParamsJson !== "string") {
          errors.push(`button[${i}] buttonParamsJson must be string`);
          return;
        }
        parseButtonParamsInternal(btn.name, btn.buttonParamsJson, errors, warnings, i);
        return;
      }
      errors.push(`button[${i}] invalid shape — expected {id, text} or {name, buttonParamsJson} with name in [${[ ...SEND_BUTTONS_ALLOWED_COMPLEX ].join(", ")}]`);
    });
  }
  return {
    valid: errors.length === 0,
    errors: errors,
    warnings: warnings
  };
}

export function validateSendInteractiveMessagePayload(data) {
  const errors = [];
  const warnings = [];
  if (!data || typeof data !== "object") {
    return {
      valid: false,
      errors: [ "payload must be an object" ],
      warnings: warnings
    };
  }
  if (!data.text || typeof data.text !== "string") {
    errors.push("text is mandatory and must be a string");
  }
  if (!Array.isArray(data.interactiveButtons) || data.interactiveButtons.length === 0) {
    errors.push("interactiveButtons is mandatory and must be a non-empty array");
  } else {
    data.interactiveButtons.forEach((btn, i) => {
      if (!btn || typeof btn !== "object") {
        errors.push(`interactiveButtons[${i}] must be an object`);
        return;
      }
      if (!btn.name || typeof btn.name !== "string") {
        errors.push(`interactiveButtons[${i}] missing name`);
        return;
      }
      if (!INTERACTIVE_ALLOWED_NAMES.has(btn.name)) {
        errors.push(`interactiveButtons[${i}] name '${btn.name}' not allowed`);
        return;
      }
      if (!btn.buttonParamsJson || typeof btn.buttonParamsJson !== "string") {
        errors.push(`interactiveButtons[${i}] buttonParamsJson must be a non-empty string`);
        return;
      }
      parseButtonParamsInternal(btn.name, btn.buttonParamsJson, errors, warnings, i);
    });
  }
  return {
    valid: errors.length === 0,
    errors: errors,
    warnings: warnings
  };
}

export function validateInteractiveMessageContent(content) {
  const errors = [];
  const warnings = [];
  if (!content || typeof content !== "object") {
    return {
      errors: [ "content must be an object" ],
      warnings: warnings,
      valid: false
    };
  }
  const interactive = content.interactiveMessage;
  if (!interactive) return {
    errors: errors,
    warnings: warnings,
    valid: true
  };
  const nativeFlow = interactive.nativeFlowMessage;
  if (!nativeFlow) {
    errors.push("interactiveMessage.nativeFlowMessage missing");
    return {
      errors: errors,
      warnings: warnings,
      valid: false
    };
  }
  if (!Array.isArray(nativeFlow.buttons)) {
    errors.push("nativeFlowMessage.buttons must be an array");
    return {
      errors: errors,
      warnings: warnings,
      valid: false
    };
  }
  if (nativeFlow.buttons.length === 0) {
    warnings.push("nativeFlowMessage.buttons is empty");
  }
  nativeFlow.buttons.forEach((btn, i) => {
    if (!btn || typeof btn !== "object") {
      errors.push(`buttons[${i}] is not an object`);
      return;
    }
    if (!btn.buttonParamsJson) {
      warnings.push(`buttons[${i}] missing buttonParamsJson (may fail to render)`);
    } else if (typeof btn.buttonParamsJson !== "string") {
      errors.push(`buttons[${i}] buttonParamsJson must be string`);
    } else {
      try {
        JSON.parse(btn.buttonParamsJson);
      } catch (e) {
        warnings.push(`buttons[${i}] buttonParamsJson invalid JSON (${e.message})`);
      }
    }
    if (!btn.name) {
      warnings.push(`buttons[${i}] missing name; defaulting to quick_reply`);
      btn.name = "quick_reply";
    }
  });
  return {
    errors: errors,
    warnings: warnings,
    valid: errors.length === 0
  };
}

export function convertToInteractiveMessage(content) {
  const btns = content.interactiveButtons;
  if (btns && btns.length > 0) {
    const interactiveMessage = {
      nativeFlowMessage: {
        buttons: btns.map(btn => ({
          name: btn.name ?? "quick_reply",
          buttonParamsJson: btn.buttonParamsJson
        })),
        messageParamsJson: ""
      }
    };
    if (content.title || content.subtitle) {
      interactiveMessage.header = {
        title: content.title ?? content.subtitle ?? "",
        ...content.title && content.subtitle ? {
          subtitle: content.subtitle
        } : {}
      };
    }
    if (content.text) {
      interactiveMessage.body = {
        text: content.text
      };
    }
    if (content.footer) {
      interactiveMessage.footer = {
        text: content.footer
      };
    }
    const newContent = {
      ...content
    };
    delete newContent.interactiveButtons;
    delete newContent.title;
    delete newContent.subtitle;
    delete newContent.text;
    delete newContent.footer;
    return {
      ...newContent,
      interactiveMessage: interactiveMessage
    };
  }
  return content;
}

export async function sendInteractiveMessage(sock, jid, content, options = {}) {
  if (!sock) {
    throw new InteractiveValidationError("Socket is required", {
      context: "sendInteractiveMessage"
    });
  }
  if (Array.isArray(content.interactiveButtons)) {
    const strict = validateSendInteractiveMessagePayload(content);
    if (!strict.valid) {
      throw new InteractiveValidationError("Interactive authoring payload invalid", {
        context: "sendInteractiveMessage.validateSendInteractiveMessagePayload",
        errors: strict.errors,
        warnings: strict.warnings,
        example: EXAMPLE_PAYLOADS.sendInteractiveMessage
      });
    }
    if (strict.warnings.length) {
      sock.logger?.warn?.(strict.warnings, "[button-sender] sendInteractiveMessage warnings");
    }
  }
  const convertedContent = convertToInteractiveMessage(content);
  const {errors: cErr, warnings: cWarn, valid: cValid} = validateInteractiveMessageContent(convertedContent);
  if (!cValid) {
    throw new InteractiveValidationError("Converted interactive content invalid", {
      context: "sendInteractiveMessage.validateInteractiveMessageContent",
      errors: cErr,
      warnings: cWarn,
      example: convertToInteractiveMessage(EXAMPLE_PAYLOADS.sendInteractiveMessage)
    });
  }
  if (cWarn.length) sock.logger?.warn?.(cWarn, "[button-sender] Interactive content warnings");
  const userJid = sock.authState?.creds?.me?.id ?? sock.user?.id ?? "";
  const fullMsg = generateWAMessageFromContent(jid, convertedContent, {
    userJid: userJid,
    messageId: generateMessageIDV2(userJid),
    timestamp: new Date
  });
  const normalizedContent = normalizeMessageContent(fullMsg.message);
  const buttonType = normalizedContent ? getButtonType(normalizedContent) : undefined;
  const additionalNodes = [ ...options.additionalNodes ?? [] ];
  if (buttonType && normalizedContent) {
    const bizNode = getButtonArgs(normalizedContent);
    additionalNodes.push(bizNode);
    if (!isJidGroup(jid)) {
      additionalNodes.push({
        tag: "bot",
        attrs: {
          biz_bot: "1"
        }
      });
    }
  }
  await sock.relayMessage(jid, fullMsg.message, {
    messageId: fullMsg.key.id,
    useCachedGroupMetadata: options.useCachedGroupMetadata,
    additionalAttributes: options.additionalAttributes ?? {},
    statusJidList: options.statusJidList,
    additionalNodes: additionalNodes
  });
  if (sock.config?.emitOwnEvents && !isJidGroup(jid)) {
    process.nextTick(() => {
      if (sock.processingMutex?.mutex && sock.upsertMessage) {
        void sock.processingMutex.mutex(() => sock.upsertMessage(fullMsg, "append"));
      }
    });
  }
  return fullMsg;
}

export async function sendInteractiveMessageV2(sock, jid, content, options = {}) {
  if (!sock) {
    throw new InteractiveValidationError("Socket is required", {
      context: "sendInteractiveMessageV2"
    });
  }
  const hasThumb = !!content.thumbnailUrl;
  const hasFilePath = !!content.filePath;
  const hasFileUrl = !!content.fileUrl;
  const shouldForce = options.forceExternalAdReply === true;
  async function bufferFromUrl(url) {
    try {
      const {default: axios} = await (import("axios"));
      const res = await axios.get(url, {
        responseType: "arraybuffer"
      });
      return Buffer.from(res.data);
    } catch (e) {
      sock.logger?.warn?.({
        err: e
      }, "[button-sender] Failed to fetch buffer from URL");
      return null;
    }
  }
  if ((hasThumb || hasFilePath || hasFileUrl || shouldForce) && !content.document && !content.image && !content.video) {
    try {
      let fileBuffer;
      let fileName = "file.pdf";
      let mimeType = "application/pdf";
      if (hasFilePath) {
        const {readFileSync: readFileSync} = await (import("fs"));
        fileBuffer = readFileSync(content.filePath);
        fileName = content.filePath.split("/").pop() ?? fileName;
        mimeType = content.mimetype ?? "application/octet-stream";
      } else if (hasFileUrl) {
        const buf = await bufferFromUrl(content.fileUrl);
        fileBuffer = buf ?? Buffer.from("dummy", "utf-8");
        fileName = content.fileUrl.split("/").pop() ?? fileName;
        mimeType = content.mimetype ?? "application/octet-stream";
      } else {
        fileBuffer = Buffer.from("dummy", "utf-8");
      }
      content.document = fileBuffer;
      content.fileName = content.fileName ?? fileName;
      content.mimetype = content.mimetype ?? mimeType;
    } catch (e) {
      sock.logger?.warn?.({
        err: e
      }, "[button-sender] Failed to build dummy document");
    }
  }
  let jpegThumb = null;
  if (hasThumb) jpegThumb = await bufferFromUrl(content.thumbnailUrl);
  if (hasThumb || hasFilePath || hasFileUrl || shouldForce) {
    const thumbUrl = content.thumbnailUrl ?? options.thumbnailUrl ?? "";
    const existingCtx = content.contextInfo ?? {};
    const existingEar = existingCtx.externalAdReply ?? {};
    content.contextInfo = {
      ...existingCtx,
      externalAdReply: {
        ...existingEar,
        mediaType: 1,
        containsAutoReply: true,
        title: existingEar.title ?? `© ${globalThis.ownername ?? "Evernight AI"}`,
        body: existingEar.body ?? "Virtual Assistant",
        sourceUrl: existingEar.sourceUrl ?? "https://example.com",
        mediaUrl: thumbUrl,
        thumbnailUrl: thumbUrl,
        renderLargerThumbnail: true,
        ...jpegThumb ? {
          jpegThumbnail: jpegThumb
        } : {}
      }
    };
  }
  return sendInteractiveMessage(sock, jid, content, options);
}

export async function sendButtons(sock, jid, data = {
  text: "",
  buttons: []
}, options = {}) {
  if (!sock) {
    throw new InteractiveValidationError("Socket is required", {
      context: "sendButtons"
    });
  }
  const {text: text = "", footer: footer = "", title: title, subtitle: subtitle, buttons: buttons = []} = data;
  const strict = validateSendButtonsPayload({
    text: text,
    buttons: buttons,
    title: title,
    subtitle: subtitle,
    footer: footer
  });
  if (!strict.valid) {
    throw new InteractiveValidationError("Buttons payload invalid", {
      context: "sendButtons.validateSendButtonsPayload",
      errors: strict.errors,
      warnings: strict.warnings,
      example: EXAMPLE_PAYLOADS.sendButtons
    });
  }
  if (strict.warnings.length) {
    sock.logger?.warn?.(strict.warnings, "[button-sender] sendButtons warnings");
  }
  const {errors: errors, warnings: warnings, cleaned: cleaned} = validateAuthoringButtons(buttons);
  if (errors.length) {
    throw new InteractiveValidationError("Authoring button objects invalid", {
      context: "sendButtons.validateAuthoringButtons",
      errors: errors,
      warnings: warnings,
      example: EXAMPLE_PAYLOADS.sendButtons.buttons
    });
  }
  if (warnings.length) {
    sock.logger?.warn?.(warnings, "[button-sender] Button validation warnings");
  }
  const interactiveButtons = buildInteractiveButtons(cleaned);
  const payload = {
    text: text,
    footer: footer,
    interactiveButtons: interactiveButtons
  };
  if (title) payload.title = title;
  if (subtitle) payload.subtitle = subtitle;
  return sendInteractiveMessage(sock, jid, payload, options);
}