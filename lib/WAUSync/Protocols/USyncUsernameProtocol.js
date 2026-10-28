import { assertNodeErrorFree, getBinaryNodeChild } from "../../WABinary/index.js";
class USyncUsernameProtocol {
  constructor() {
    this.name = "username";
  }
  getQueryElement() {
    return { tag: "username", attrs: {} };
  }
  getUserElement(user) {
    void user;
    return null;
  }
  parser(node) {
    if (node.tag !== "username") {
      return null;
    }
    if (getBinaryNodeChild(node, "error")) {
      return null;
    }
    assertNodeErrorFree(node);
    const content = node.content;
    if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
      const text = Buffer.from(content).toString("utf-8");
      return text || null;
    }
    if (typeof content === "string") {
      return content || null;
    }
    if (node.attrs?.val) {
      return node.attrs.val;
    }
    if (node.attrs?.username) {
      return node.attrs.username;
    }
    return null;
  }
}
export {
  USyncUsernameProtocol
};
