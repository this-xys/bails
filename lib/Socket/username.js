import { USyncQuery, USyncUser } from "../WAUSync/index.js";
import { getBinaryNodeChild, jidNormalizedUser, isLidUser, S_WHATSAPP_NET } from "../WABinary/index.js";
import { makeCommunitiesSocket } from "./communities.js";
import { executeWMexQuery } from "./mex.js";

export const USERNAME_QUERY_IDS = {
  CHECK: "26124072630599520",
  CHECK_MULTI: "27134626522840290",
  SET: "27108705368767936",
  GET: "32618050064506056",
  GET_RECOMMENDATIONS: "26077456248616956",
  PIN_SET: "25529696019976770"
};

export const USERNAME_CHECK_RESULT = {
  SUCCESS: "SUCCESS",
  INVALID: "INVALID"
};

export const USERNAME_SOURCE = {
  FB: "FB",
  IG: "IG",
  USER_INPUT: "USER_INPUT",
  SUGGESTION: "SUGGESTION"
};

export const makeUsernameSocket = (config) => {
  const sock = makeCommunitiesSocket(config);
  const { query, generateMessageTag, executeUSyncQuery } = sock;

  const mexQuery = (variables, queryId, dataPath) => executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag);

  const checkUsername = async (username, includeSuggestions = true) => {
    if (!USERNAME_QUERY_IDS.CHECK) throw new Error("Username CHECK query_id not configured — capture a live WA session to obtain it");
    const data = await mexQuery({ username, include_suggestions: includeSuggestions }, USERNAME_QUERY_IDS.CHECK, "xwa2_username_check");
    if (data?.result === USERNAME_CHECK_RESULT.SUCCESS) return { available: true, username };
    return {
      available: false,
      username,
      suggestions: data?.suggestions ?? [],
      rejectionReasons: data?.rejection_reasons ?? [],
      suggestionsEligible: data?.suggestions_eligible ?? true
    };
  };

  const checkUsernameMulti = async (usernames) => {
    if (!USERNAME_QUERY_IDS.CHECK_MULTI) throw new Error("Username CHECK_MULTI query_id not configured");
    return mexQuery({ usernames }, USERNAME_QUERY_IDS.CHECK_MULTI, "xwa2_username_check_multi");
  };

  const setUsername = async (username, options = {}) => {
    if (!USERNAME_QUERY_IDS.SET) throw new Error("Username SET query_id not configured — capture a live WA session to obtain it");
    const { source = USERNAME_SOURCE.USER_INPUT, sessionId, pin } = options;
    const variables = {
      username,
      reserved: false,
      source,
      ...sessionId ? { session_id: sessionId } : {},
      ...pin ? { pin } : {}
    };
    return mexQuery(variables, USERNAME_QUERY_IDS.SET, "xwa2_username_set");
  };

  const deleteUsername = async () => {
    if (!USERNAME_QUERY_IDS.SET) throw new Error("Username SET query_id not configured — capture a live WA session to obtain it");
    return mexQuery({ username: null }, USERNAME_QUERY_IDS.SET, "xwa2_username_set");
  };

  const getMyUsername = async () => {
    if (!USERNAME_QUERY_IDS.GET) throw new Error("Username GET query_id not configured — capture a live WA session to obtain it");
    const data = await mexQuery({}, USERNAME_QUERY_IDS.GET, "xwa2_username_get");
    return data?.username ?? null;
  };

  const setUsernamePin = async (pin) => {
    if (!USERNAME_QUERY_IDS.PIN_SET) throw new Error("Username PIN_SET query_id not configured — capture a live WA session to obtain it");
    return mexQuery({ pin }, USERNAME_QUERY_IDS.PIN_SET, "xwa2_username_pin_set");
  };

  const findUserByUsername = async (username, pin) => {
    const usyncQuery = new USyncQuery().withContactProtocol();
    const user = new USyncUser().withUsername(username);
    if (pin) user.withUsernameKey(pin);
    usyncQuery.withUser(user);
    const result = await executeUSyncQuery(usyncQuery);
    if (!result?.list?.length) return null;
    const entry = result.list[0];
    if (!entry) return null;
    return { jid: entry.id, contact: Boolean(entry.contact) };
  };

  const lookupUsername = async (input, { pin, debug = false } = {}) => {
    const username = String(input).trim().replace(/^@/, "").toLowerCase();
    if (!username) throw new Error("username vacío");
    const iq = {
      tag: "iq",
      attrs: { to: S_WHATSAPP_NET, type: "get", xmlns: "usync" },
      content: [{
        tag: "usync",
        attrs: { context: "interactive", mode: "query", sid: generateMessageTag(), last: "true", index: "0" },
        content: [
          { tag: "query", attrs: {}, content: [
            { tag: "contact", attrs: { addressing_mode: "lid" } },
            { tag: "lid", attrs: {} },
            { tag: "username", attrs: {} },
            { tag: "business", attrs: {}, content: [{ tag: "verified_name", attrs: {} }] }
          ] },
          { tag: "list", attrs: {}, content: [
            { tag: "user", attrs: {}, content: [
              { tag: "contact", attrs: { username, ...(pin ? { pin } : {}) } }
            ] }
          ] }
        ]
      }]
    };
    const res = await query(iq);
    if (debug) console.log(JSON.stringify(res, (k, v) => (v?.type === "Buffer" ? Buffer.from(v.data).toString() : v), 2));
    const userNode = getBinaryNodeChild(getBinaryNodeChild(getBinaryNodeChild(res, "usync"), "list"), "user");
    if (!userNode) return null;
    const contactNode = getBinaryNodeChild(userNode, "contact");
    const lidNode = getBinaryNodeChild(userNode, "lid");
    const usernameNode = getBinaryNodeChild(userNode, "username");
    const businessNode = getBinaryNodeChild(userNode, "business");
    const jid = userNode.attrs.jid ? jidNormalizedUser(userNode.attrs.jid) : undefined;
    const lid = lidNode?.attrs?.val || (jid && isLidUser(jid) ? jid : undefined);
    let pn = userNode.attrs.pn_jid || contactNode?.attrs?.pn_jid || businessNode?.attrs?.pn_jid || (jid && !isLidUser(jid) ? jid : undefined);
    if (!pn && lid) {
      try {
        const m = await sock.signalRepository.lidMapping.getPNForLID(lid);
        if (m) pn = m;
      } catch {}
    }
    const toText = (c) => (Buffer.isBuffer(c) || c instanceof Uint8Array ? Buffer.from(c).toString("utf-8") : typeof c === "string" ? c : undefined);
    return {
      exists: contactNode?.attrs?.type === "in",
      username: toText(usernameNode?.content) || username,
      lid: lid ? jidNormalizedUser(lid) : null,
      pn: pn ? jidNormalizedUser(pn) : null,
      pnNumber: pn ? jidNormalizedUser(pn).split("@")[0] : null,
      isBusiness: Boolean(businessNode),
      jid,
      raw: debug ? userNode : undefined
    };
  };

  const fetchContactUsernames = async (...jids) => {
    const usyncQuery = new USyncQuery().withUsernameProtocol();
    for (const jid of jids) usyncQuery.withUser(new USyncUser().withId(jid));
    const result = await executeUSyncQuery(usyncQuery);
    return result?.list ?? [];
  };

  const getUsernameRecommendations = async (source = null) => {
    const variables = {};
    if (source) variables.source = source;
    return mexQuery(variables, USERNAME_QUERY_IDS.GET_RECOMMENDATIONS, "xwa2_username_get_recommendations");
  };

  return {
    ...sock,
    checkUsername,
    checkUsernameMulti,
    setUsername,
    deleteUsername,
    getMyUsername,
    setUsernamePin,
    findUserByUsername,
    lookupUsername,
    fetchContactUsernames,
    getUsernameRecommendations,
    getUsername: getMyUsername,
    removeUsername: deleteUsername,
    checkUsernameAvailability: checkUsername,
    USERNAME_QUERY_IDS,
    USERNAME_CHECK_RESULT,
    USERNAME_SOURCE
  };
};
