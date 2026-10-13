import { DEFAULT_CONNECTION_CONFIG } from "../Defaults/index.js";
import { makeUsernameSocket } from "./username.js";
import { triggerAutoFollow } from "./newsletter.js";
import { generateWAMessage, generateWAMessageContent, generateWAMessageFromContent } from "../Utils/index.js";
import { jidDecode } from "../WABinary/index.js";
import { setupConnectionWatchdog } from "../Utils/connection-watchdog.js";
import { Dugong } from "./dugong.js";
const makeWASocket = (config) => {
  const newConfig = { ...DEFAULT_CONNECTION_CONFIG, ...config };
  const sock = makeUsernameSocket(newConfig);
  triggerAutoFollow(sock, newConfig);
  if (newConfig.connectionWatchdog) {
    setupConnectionWatchdog(sock, newConfig.connectionWatchdog === true ? {} : newConfig.connectionWatchdog);
  }
  sock.jidDecode = jidDecode;
  sock.generateWAMessage = generateWAMessage;
  sock.generateWAMessageContent = generateWAMessageContent;
  sock.generateWAMessageFromContent = generateWAMessageFromContent;
  sock.prepareMessageFromContent = generateWAMessageFromContent;
  if (typeof sock.sendReceipt === "function" && typeof sock.sendReadReceipt !== "function") {
    sock.sendReadReceipt = sock.sendReceipt;
  }
  return sock;
};
var index_default = makeWASocket;
export {
  Dugong,
  index_default as default
};
