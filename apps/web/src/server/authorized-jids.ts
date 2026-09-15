const WHATSAPP_JID_SUFFIX = "@s.whatsapp.net";

/**
 * The country an operator omits when they type their own number in national
 * form (`0899…`). `DEFAULT_COUNTRY_CODE` overrides it; an unusable value falls
 * back here rather than rejecting every national-format entry.
 */
const FALLBACK_COUNTRY_CODE = "62";

function countryCode(): string {
  const configured = (process.env.DEFAULT_COUNTRY_CODE ?? "").replaceAll(/[^0-9]/g, "");
  return /^[1-9][0-9]{0,3}$/.test(configured) ? configured : FALLBACK_COUNTRY_CODE;
}

/**
 * Converts a phone number or any WhatsApp device JID to the one JID the reply
 * gate compares.
 *
 * An operator writes their own number the way their phone shows it — national
 * form, `0899…` — while WhatsApp JIDs are always international, so the national
 * form is expanded with the deployment's country code. A leading `00` is the
 * other way people write international, so it is stripped and the rest is left
 * alone. Only E.164-sized digit strings survive; anything else is not a phone.
 */
export function normalizeAuthorizedJid(value: string): string | null {
  const trimmed = value.trim();
  const local = trimmed.split("@", 1)[0]?.split(/[.:]/, 1)[0] ?? "";
  let digits = local.replaceAll(/[^0-9]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = countryCode() + digits.replace(/^0+/, "");
  return /^[1-9][0-9]{6,14}$/.test(digits) ? `${digits}${WHATSAPP_JID_SUFFIX}` : null;
}

/** Reads legacy organization data defensively, while returning the canonical reply-gate JIDs. */
export function authorizedJidsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const canonical = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const jid = normalizeAuthorizedJid(candidate);
    if (jid !== null) canonical.add(jid);
  }
  return [...canonical].sort();
}

/** Avoids exposing a phone number in operator UI where identity is not needed. */
export function displayAuthorizedJid(jid: string): string {
  const phone = jid.slice(0, -WHATSAPP_JID_SUFFIX.length);
  return phone.length <= 4 ? "••••" : `${phone.slice(0, 2)}••••${phone.slice(-4)}`;
}
