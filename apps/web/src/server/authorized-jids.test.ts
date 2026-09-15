import { afterEach, describe, expect, test } from "vitest";
import { authorizedJidsOf, displayAuthorizedJid, normalizeAuthorizedJid } from "./authorized-jids";

const previous = process.env.DEFAULT_COUNTRY_CODE;

afterEach(() => {
  if (previous === undefined) delete process.env.DEFAULT_COUNTRY_CODE;
  else process.env.DEFAULT_COUNTRY_CODE = previous;
});

describe("normalizeAuthorizedJid", () => {
  test("accepts a national number, which is how a local operator writes their own phone", () => {
    expect(normalizeAuthorizedJid("08996926184")).toBe("628996926184@s.whatsapp.net");
  });

  test("keeps an already-international number as written", () => {
    expect(normalizeAuthorizedJid("628996926184")).toBe("628996926184@s.whatsapp.net");
    expect(normalizeAuthorizedJid("+62 899-6926-184")).toBe("628996926184@s.whatsapp.net");
  });

  test("treats the international 00 prefix as already international", () => {
    expect(normalizeAuthorizedJid("00628996926184")).toBe("628996926184@s.whatsapp.net");
  });

  test("reduces a full WhatsApp JID or device JID to the same canonical value", () => {
    expect(normalizeAuthorizedJid("628996926184@s.whatsapp.net")).toBe("628996926184@s.whatsapp.net");
    expect(normalizeAuthorizedJid("628996926184:12@s.whatsapp.net")).toBe("628996926184@s.whatsapp.net");
  });

  test("honours the deployment country code for the national form", () => {
    process.env.DEFAULT_COUNTRY_CODE = "44";
    expect(normalizeAuthorizedJid("08996926184")).toBe("448996926184@s.whatsapp.net");
  });

  test("ignores an unusable country code and falls back to the deployment default", () => {
    process.env.DEFAULT_COUNTRY_CODE = "not-a-code";
    expect(normalizeAuthorizedJid("08996926184")).toBe("628996926184@s.whatsapp.net");
  });

  test("rejects values that cannot be a phone number", () => {
    for (const value of ["", "0", "abc", "12", "0899", "62 899 626 184 99 88 77 66 55", "@s.whatsapp.net"]) {
      expect(normalizeAuthorizedJid(value)).toBeNull();
    }
  });
});

describe("authorizedJidsOf", () => {
  test("canonicalizes legacy stored entries and drops duplicates", () => {
    expect(authorizedJidsOf(["08996926184", "628996926184@s.whatsapp.net", "not a phone"])).toEqual([
      "628996926184@s.whatsapp.net",
    ]);
  });

  test("is empty for anything that is not a string array", () => {
    expect(authorizedJidsOf(undefined)).toEqual([]);
    expect(authorizedJidsOf("62899626184")).toEqual([]);
  });
});

describe("displayAuthorizedJid", () => {
  test("masks the middle so the operator can tell entries apart without printing the number", () => {
    expect(displayAuthorizedJid("628996926184@s.whatsapp.net")).toBe("62••••6184");
  });
});
