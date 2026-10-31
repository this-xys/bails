import {
  BaseBuilder,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  getBizBinaryNode
} from "./shared.js";
class Carousel extends BaseBuilder {
  #client;
  static MAX_CARDS = 10;
  constructor(client) {
    super();
    if (!client) {
      throw new Error("Socket is required");
    }
    this.#client = client;
    this._cards = [];
  }
  loadFrom(msg) {
    if (!msg) throw new Error("loadFrom(msg): interactiveMessage needed");
    if (!msg.interactiveMessage) throw new Error("loadFrom(msg): interactiveMessage not found");
    const { interactiveMessage, ...extraPayload } = msg;
    const iM = interactiveMessage;
    const carousel = iM.carouselMessage || {};
    this._body = iM.body?.text || "";
    this._footer = iM.footer?.text || "";
    this._contextInfo = iM.contextInfo || {};
    this._extraPayload = extraPayload;
    this._cards = Array.isArray(carousel.cards)
      ? carousel.cards.map((card) => ({
          ...card,
          header: {
            ...(card.header || {}),
            hasMediaAttachment: !!card.header?.hasMediaAttachment,
            ...(card.header?.imageMessage ? { imageMessage: card.header.imageMessage } : {}),
            ...(card.header?.videoMessage ? { videoMessage: card.header.videoMessage } : {})
          },
          body: { text: card.body?.text || "" },
          footer: { text: card.footer?.text || "" },
          nativeFlowMessage: {
            ...(card.nativeFlowMessage || {}),
            buttons: Array.isArray(card.nativeFlowMessage?.buttons)
              ? card.nativeFlowMessage.buttons.map((button) => ({
                  ...button,
                  buttonParamsJson:
                    typeof button.buttonParamsJson === "string"
                      ? button.buttonParamsJson
                      : JSON.stringify(button.buttonParamsJson || {})
                }))
              : [],
            messageParamsJson:
              typeof card.nativeFlowMessage?.messageParamsJson === "string"
                ? card.nativeFlowMessage.messageParamsJson
                : JSON.stringify(card.nativeFlowMessage?.messageParamsJson || {})
          }
        }))
      : [];
    return this;
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
      throw new Error(
        `Carousel supports at most ${Carousel.MAX_CARDS} cards (got ${this._cards.length + cards.length})`
      );
    }
    this._cards.push(...cards);
    return this;
  }
  clearCards() {
    this._cards = [];
    return this;
  }
  get cardCount() {
    return this._cards.length;
  }
  async makeCard({
    image,
    video,
    gifPlayback = false,
    body = "",
    footer = "",
    title = "",
    subtitle = "",
    buttons = [],
    params
  } = {}) {
    if (!image && !video) throw new Error("makeCard needs an image or video");
    const source = image
      ? { image: Buffer.isBuffer(image) ? image : { url: image } }
      : { video: Buffer.isBuffer(video) ? video : { url: video } };
    let media = await prepareWAMessageMedia(source, { upload: this.#client.waUploadToServer });
    if (gifPlayback && media.videoMessage)
      media = { ...media, videoMessage: { ...media.videoMessage, gifPlayback: true } };
    return {
      header: { hasMediaAttachment: true, title, subtitle, ...media },
      body: { text: body },
      footer: { text: footer },
      nativeFlowMessage: {
        ...(params
          ? { messageParamsJson: typeof params === "string" ? params : JSON.stringify(params) }
          : {}),
        buttons: buttons.map((b) => ({
          name: b.name,
          buttonParamsJson:
            b.buttonParamsJson ??
            (typeof b.params === "string" ? b.params : JSON.stringify(b.params ?? {}))
        }))
      }
    };
  }
  build(jid, { ...options } = {}) {
    return generateWAMessageFromContent(
      jid,
      {
        ...this._extraPayload,
        interactiveMessage: {
          header: {
            hasMediaAttachment: false,
            ...(this._title ? { title: this._title } : {}),
            ...(this._subtitle ? { subtitle: this._subtitle } : {})
          },
          body: { text: this._body },
          footer: { text: this._footer },
          contextInfo: this._contextInfo,
          carouselMessage: {
            ...(this._params && Object.keys(this._params).length
              ? { messageParamsJson: JSON.stringify(this._params) }
              : {}),
            cards: this._cards
          }
        }
      },
      { ...options }
    );
  }
  async send(jid, { ...options } = {}) {
    if (this._cards.length === 0)
      throw new Error("Carousel requires at least one card (use addCard())");
    const msg = this.build(jid, options);
    const bizNode = getBizBinaryNode(msg.message);
    await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
      messageId: msg.key.id,
      additionalNodes: [bizNode],
      ...options
    });
    return msg;
  }
}
export { Carousel };
