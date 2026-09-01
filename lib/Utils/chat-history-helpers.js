import { generateForwardMessageContent, prepareWAMessageMedia } from "./messages.js";

export const getLastMessageInChat = (store, jid) => {
  const list = store.messages?.[jid];
  const arr = list?.array;
  if (!arr || arr.length === 0) return undefined;
  return arr[arr.length - 1];
};

export const getOldestMessageInChat = (store, jid) => {
  const list = store.messages?.[jid];
  const arr = list?.array;
  if (!arr || arr.length === 0) return undefined;
  return arr[0];
};

export const copyNForward = async (sock, jid, message, forceForward = false) => {
  const content = generateForwardMessageContent(message, forceForward);
  return sock.sendMessage(jid, content);
};

export const uploadMediaToWhatsApp = async (sock, message, opts) => prepareWAMessageMedia(message, {
  upload: sock.waUploadToServer,
  logger: opts?.logger,
  mediaTypeOverride: opts?.mediaTypeOverride
});