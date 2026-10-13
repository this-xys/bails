import { randomBytes } from "node:crypto";
import { generateWAMessageContent, generateWAMessageFromContent } from "./messages.js";
import { unixTimestampSeconds } from "./generics.js";
import { S_WHATSAPP_NET } from "../WABinary/index.js";
const toBuffer = async stream => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  stream.destroy?.();
  return Buffer.concat(chunks);
};

const generateWideProfilePicture = async img => {
  const { Jimp, JimpMime } = await import("jimp");
  const jimp = await Jimp.read(img);
  const width = jimp.bitmap.width;
  const height = jimp.bitmap.height;
  const ratio = width > height ? width / 720 : width / 324;
  const targetWidth = Math.round(width / ratio);
  const targetHeight = Math.round(height / ratio);
  const buffer = await jimp.resize({
    w: targetWidth,
    h: targetHeight
  }).getBuffer(JimpMime.jpeg, {
    quality: 100
  });
  return {
    img: buffer
  };
};

export const generateProfilePictureFull = generateWideProfilePicture;

export const changeprofileFull = generateWideProfilePicture;

const generateSquareProfilePicture = async buffer => {
  const { Jimp, JimpMime } = await import("jimp");
  const jimp = await Jimp.read(buffer);
  const img = await jimp.clone().scaleToFit({
    w: 720,
    h: 720
  }).getBuffer(JimpMime.jpeg);
  const preview = await jimp.clone().normalize().getBuffer(JimpMime.jpeg);
  return {
    img: img,
    preview: preview
  };
};

export const generateProfilePictureFP = generateSquareProfilePicture;

export const generatePP = generateSquareProfilePicture;

export const generateProfilePicturee = async mediaUpload => {
  let bufferOrFilePath;
  if (Buffer.isBuffer(mediaUpload)) {
    bufferOrFilePath = mediaUpload;
  } else if ("url" in mediaUpload) {
    bufferOrFilePath = mediaUpload.url.toString();
  } else {
    bufferOrFilePath = await toBuffer(mediaUpload.stream);
  }
  const { Jimp, JimpMime } = await import("jimp");
  const jimp = await Jimp.read(bufferOrFilePath);
  const {width: width, height: height} = jimp.bitmap;
  const resized = width > height ? jimp.resize({
    w: 720,
    h: Math.round(height / width * 720)
  }) : jimp.resize({
    w: Math.round(width / height * 720),
    h: 720
  });
  const img = await resized.getBuffer(JimpMime.jpeg, {
    quality: 100
  });
  return {
    img: img
  };
};

export const updateProfilePictureFull = async (jid, content, sock) => {
    const { query } = sock;
    const { img } = await generateProfilePictureFP(content);
    const media = await query({
        tag: 'iq',
        attrs: {
            target: jid,
            to: S_WHATSAPP_NET,
            type: 'set',
            xmlns: 'w:profile:picture'
        },
        content: [
            {
                tag: 'picture',
                attrs: { type: 'image' },
                content: img
            }
        ]
    });
    return media;
};

export const updateProfilePictureFull2 = async (jid, content, sock) => {
    const { query } = sock;
    const { preview } = await generatePP(content);
    const media = await query({
        tag: 'iq',
        attrs: {
            target: jid,
            to: S_WHATSAPP_NET,
            type: 'set',
            xmlns: 'w:profile:picture'
        },
        content: [
            {
                tag: 'picture',
                attrs: { type: 'image' },
                content: preview
            }
        ]
    });
    return media;
};

export const groupStatus = async (jid, content, sock) => {
    const { backgroundColor, ...rest } = content;
    const inside = await generateWAMessageContent(rest, {
        upload: sock.waUploadToServer,
        backgroundColor
    });
    const messageSecret = randomBytes(32);
    const userJid = sock.authState?.creds?.me?.id;
    const userJidLid = sock.authState?.creds?.me?.lid;
    const m = generateWAMessageFromContent(jid, {
        messageContextInfo: { messageSecret },
        groupStatusMessageV2: {
            message: {
                ...inside,
                messageContextInfo: { messageSecret }
            }
        }
    }, { userJid, userJidLid });
    await sock.relayMessage(jid, m.message, { messageId: m.key.id });
    return m;
};

export const groupStatusV2 = async (jids, content, sock) => {
    const { backgroundColor, ...rest } = content;
    const inside = await generateWAMessageContent(rest, {
        upload: sock.waUploadToServer,
        backgroundColor
    });
    const messageSecret = randomBytes(32);
    const userJid = sock.authState?.creds?.me?.id;
    const userJidLid = sock.authState?.creds?.me?.lid;
    const results = [];
    for (const id of jids) {
        const m = generateWAMessageFromContent(id, {
            messageContextInfo: { messageSecret },
            groupStatusMessageV2: {
                message: {
                    ...inside,
                    messageContextInfo: { messageSecret }
                }
            }
        }, { userJid, userJidLid });
        await sock.relayMessage(id, m.message, { messageId: m.key.id });
        results.push(m);
    }
    return results;
};

export const groupSetMemberLabel = async (jid, memberLabel, sock) => {
    const result = await sock.relayMessage(jid, {
        protocolMessage: {
            type: 30,
            memberLabel: {
                label: memberLabel.slice(0, 30),
                labelTimestamp: unixTimestampSeconds() || Date.now()
            }
        }
    }, {
        additionalNodes: [
            {
                tag: 'meta',
                attrs: {
                    tag_reason: 'user_update',
                    appdata: 'member_tag'
                },
                content: undefined
            }
        ]
    });
    return result;
};

export const groupLabel = async (jid, text, sock) => {
    try {
        void sock.relayMessage(jid, {
            protocolMessage: {
                type: 30,
                memberLabel: {
                    label: text.slice(0, 30),
                    labelTimestamp: unixTimestampSeconds() || Date.now()
                }
            }
        }, {
            additionalNodes: [
                {
                    tag: 'meta',
                    attrs: {
                        tag_reason: 'user_update',
                        appdata: 'member_tag'
                    },
                    content: undefined
                }
            ]
        });
    }
    catch {
    }
};
