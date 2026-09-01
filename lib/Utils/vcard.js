export const escapeVCard = s => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

export const unescapeVCard = s => s.replace(/\\(.)/g, (_, ch) => ch === "n" ? "\n" : ch);

export const formatPhone = p => p.replace(/[^\d+]/g, "");

export const generateVCard = c => {
  const lines = [ "BEGIN:VCARD", "VERSION:3.0", `FN:${escapeVCard(c.fullName)}` ];
  const parts = c.fullName.split(" ");
  if (parts.length >= 2) {
    const last = parts[parts.length - 1] || "";
    const first = parts.slice(0, -1).join(" ");
    lines.push(`N:${escapeVCard(last)};${escapeVCard(first)};;;`);
  } else {
    lines.push(`N:${escapeVCard(c.fullName)};;;;`);
  }
  if (c.organization) lines.push(`ORG:${escapeVCard(c.organization)}`);
  if (c.title) lines.push(`TITLE:${escapeVCard(c.title)}`);
  for (const p of c.phones ?? []) {
    const t = p.type || "CELL";
    const n = formatPhone(p.number);
    lines.push(p.label ? `TEL;type=${t};type=VOICE;X-ABLabel=${escapeVCard(p.label)}:${n}` : `TEL;type=${t};type=VOICE:${n}`);
  }
  for (const e of c.emails ?? []) lines.push(`EMAIL;type=${e.type || "OTHER"}:${e.email}`);
  for (const u of c.urls ?? []) lines.push(`URL;type=${u.type || "OTHER"}:${u.url}`);
  for (const a of c.addresses ?? []) {
    const t = a.type || "OTHER";
    const parts = [ "", "", a.street || "", a.city || "", a.state || "", a.postalCode || "", a.country || "" ].map(v => escapeVCard(v));
    lines.push(`ADR;type=${t}:${parts.join(";")}`);
  }
  if (c.birthday) lines.push(`BDAY:${c.birthday}`);
  if (c.note) lines.push(`NOTE:${escapeVCard(c.note)}`);
  lines.push("END:VCARD");
  return lines.join("\r\n");
};

export const generateVCards = contacts => contacts.map(generateVCard).join("\r\n");

export const parseVCard = vcard => {
  const contact = {};
  for (const line of vcard.split(/\r?\n/)) {
    const [key, ...vp] = line.split(":");
    if (!key) continue;
    const value = vp.join(":");
    if (key.startsWith("FN")) contact.fullName = unescapeVCard(value); else if (key.startsWith("ORG")) contact.organization = unescapeVCard(value); else if (key.startsWith("TITLE")) contact.title = unescapeVCard(value); else if (key.startsWith("TEL")) {
      contact.phones = contact.phones || [];
      const tm = key.match(/type=(\w+)/i);
      contact.phones.push({
        number: value,
        type: tm?.[1]?.toUpperCase() || "CELL"
      });
    } else if (key.startsWith("EMAIL")) {
      contact.emails = contact.emails || [];
      const tm = key.match(/type=(\w+)/i);
      contact.emails.push({
        email: value,
        type: tm?.[1]?.toUpperCase() || "OTHER"
      });
    } else if (key.startsWith("BDAY")) contact.birthday = value; else if (key.startsWith("NOTE")) contact.note = unescapeVCard(value);
  }
  return contact;
};

export const createContactCard = contact => ({
  contacts: {
    displayName: contact.displayName || contact.fullName,
    contacts: [ {
      vcard: generateVCard(contact)
    } ]
  }
});

export const createContactCards = contacts => ({
  contacts: {
    displayName: contacts.length === 1 ? contacts[0]?.displayName || contacts[0]?.fullName || "" : `${contacts.length} Contacts`,
    contacts: contacts.map(c => ({
      vcard: generateVCard(c)
    }))
  }
});

export const quickContact = (name, phone, options) => ({
  fullName: name,
  phones: [ {
    number: phone,
    type: "CELL"
  } ],
  organization: options?.organization,
  emails: options?.email ? [ {
    email: options.email,
    type: "WORK"
  } ] : undefined
});