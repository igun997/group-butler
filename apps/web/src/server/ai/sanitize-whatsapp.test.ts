import { describe, expect, test } from "vitest";
import { normalizeUntrustedText, sanitizeWhatsAppOutput, sourceLinksOf } from "./sanitize-whatsapp";

describe("sanitizeWhatsAppOutput", () => {
  test("removes controls and bidi overrides while preserving line breaks", () => {
    expect(sanitizeWhatsAppOutput(" hello\u0000\n\u202Espoof ")).toEqual({ ok: true, text: "hello\nspoof" });
  });

  test("removes zero-width formatting, the soft hyphen and the BOM", () => {
    expect(sanitizeWhatsAppOutput("a\u200Bb\u00ADc\u061Cd\uFEFFe")).toEqual({ ok: true, text: "abcde" });
  });

  test("removes a lone surrogate but keeps an astral character whole", () => {
    expect(sanitizeWhatsAppOutput("a\uD800b\u{1F600}c")).toEqual({ ok: true, text: "ab😀c" });
  });

  test("collapses runs of blank lines to two and trims the ends", () => {
    expect(sanitizeWhatsAppOutput("\n\nfirst\n\n\n\n\nsecond   \n\n")).toEqual({ ok: true, text: "first\n\nsecond" });
  });

  test("caps the answer at 3,500 Unicode scalar values", () => {
    const result = sanitizeWhatsAppOutput("x".repeat(4_000));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an accepted answer");
    expect(result.text).toHaveLength(3_500);
  });

  test("counts the cap in scalars, so an astral answer is not cut mid-pair", () => {
    const result = sanitizeWhatsAppOutput("😀".repeat(4_000));

    if (!result.ok) throw new Error("expected an accepted answer");
    expect([...result.text]).toHaveLength(3_500);
    expect(result.text).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  test("preserves ordinary WhatsApp markup characters as plain text", () => {
    expect(sanitizeWhatsAppOutput(" *bold* _italic_ ~strike~ ```mono``` ")).toEqual({
      ok: true,
      text: "*bold* _italic_ ~strike~ ```mono```",
    });
  });

  test("keeps an allowed scheme", () => {
    const text = "see https://example.com/a?b=1 or mailto:owner@example.com or tel:+628123";

    expect(sanitizeWhatsAppOutput(text, new Set(["https://example.com/a?b=1"]))).toEqual({ ok: true, text });
  });

  test("rejects an unapproved WhatsApp link", () => {
    expect(sanitizeWhatsAppOutput("open https://wa.me/62812", new Set())).toEqual({ ok: false, code: "unsafe_link" });
  });

  test("accepts a source-backed WhatsApp link", () => {
    expect(sanitizeWhatsAppOutput("open https://wa.me/62812", new Set(["https://wa.me/62812"]))).toEqual({ ok: true, text: "open https://wa.me/62812" });
  });

  test("rejects a scheme the deployment does not allow", () => {
    for (const text of ["ftp://files.example.com/x", "ssh://host/x", "javascript:alert(1)", "data:text/html,<b>x", "file:/etc/passwd", "about:blank"]) {
      expect(sanitizeWhatsAppOutput(text), text).toEqual({ ok: false, code: "unsafe_link" });
    }
  });

  test("rejects an unsupported scheme written without the // of an absolute URL", () => {
    for (const text of ["ftp:/files/x", "ws:endpoint", "custom-scheme:payload", "blob:https://example.com/x", "telnet:host", "irc://host/x"]) {
      expect(sanitizeWhatsAppOutput(text), text).toEqual({ ok: false, code: "unsafe_link" });
    }
  });

  test("allows only the four schemes the plan names", () => {
    expect(sanitizeWhatsAppOutput("write to mailto:owner@example.com or call tel:+628123")).toEqual({
      ok: true,
      text: "write to mailto:owner@example.com or call tel:+628123",
    });
    expect(sanitizeWhatsAppOutput("read HTTPS://example.com/x")).toEqual({ ok: true, text: "read HTTPS://example.com/x" });
  });

  test("does not mistake a colon inside an accepted URL for a second scheme", () => {
    expect(sanitizeWhatsAppOutput("see https://example.com/a:1")).toEqual({ ok: true, text: "see https://example.com/a:1" });
  });

  test("still names a whole-body tool result as JSON rather than as a scheme", () => {
    expect(sanitizeWhatsAppOutput('{"ok":true,"link":"https://example.com"}')).toEqual({ ok: false, code: "unsafe_json" });
  });

  test("does not mistake prose for a scheme", () => {
    expect(sanitizeWhatsAppOutput("Note: 42 rows\nData: 12 items")).toEqual({ ok: true, text: "Note: 42 rows\nData: 12 items" });
  });

  test("rejects HTML tags and markdown links", () => {
    expect(sanitizeWhatsAppOutput("<b>hi</b>")).toEqual({ ok: false, code: "unsafe_markup" });
    expect(sanitizeWhatsAppOutput("[click](https://example.com)")).toEqual({ ok: false, code: "unsafe_markup" });
    expect(sanitizeWhatsAppOutput("![chart](https://example.com/c.png)")).toEqual({ ok: false, code: "unsafe_markup" });
  });

  test("rejects a tool result escaping into the group", () => {
    expect(sanitizeWhatsAppOutput('{"ok":true,"messageId":"m1","columns":["a"],"rows":[["1"]]}')).toEqual({
      ok: false,
      code: "unsafe_json",
    });
  });

  // The gateway returns a tool call as text often enough that it reached a real
  // owner: two messages of pure control markup, one of them the truncated
  // `<｜DSML｜function_calls`, were delivered to WhatsApp. The fullwidth vertical
  // line is the tell, and the truncated form has no closing bracket, so the test
  // and the code both key on the codepoint rather than on a `<>` pair.
  test("refuses a provider control token, whole or cut off mid-token", () => {
    expect(sanitizeWhatsAppOutput("<\uFF5CDSML\uFF5Cfunction_calls")).toEqual({ ok: false, code: "model_markup" });
    expect(sanitizeWhatsAppOutput("<\uFF5CDSML\uFF5Cinvoke name=\"group_info\">")).toEqual({ ok: false, code: "model_markup" });
    expect(sanitizeWhatsAppOutput("<|im_start|>assistant")).toEqual({ ok: false, code: "model_markup" });
    // The observed leak was preceded by tool narration, which must not be
    // delivered on its own either: the turn it belonged to never finished.
    expect(sanitizeWhatsAppOutput("Only one monitored group: \"Test Grrup\" (typo likely).\n\nCheck group info for latest details.\n\n<\uFF5CDSML\uFF5Cfunction_calls")).toEqual({
      ok: false,
      code: "model_markup",
    });
  });

  // A rejection has to be narrow enough to keep real answers: a table row, a
  // pipe in prose, and a fullwidth line in ordinary text are all text.
  test("keeps ordinary pipes and brackets in a real answer", () => {
    expect(sanitizeWhatsAppOutput("produk | stok\nSemen | 128")).toEqual({ ok: true, text: "produk | stok\nSemen | 128" });
    expect(sanitizeWhatsAppOutput("harga naik 5% < 62000")).toEqual({ ok: true, text: "harga naik 5% < 62000" });
    expect(sanitizeWhatsAppOutput("a < b dan c > d")).toEqual({ ok: true, text: "a < b dan c > d" });
  });

  test("creates no text at all when it refuses, so nothing can be sent", () => {
    const result = sanitizeWhatsAppOutput("javascript:alert(1)");

    expect(result).toEqual({ ok: false, code: "unsafe_link" });
    expect(result).not.toHaveProperty("text");
  });

  test("treats an empty answer, and one made only of controls, as no answer", () => {
    expect(sanitizeWhatsAppOutput("")).toEqual({ ok: false, code: "empty" });
    expect(sanitizeWhatsAppOutput("\u0000\u202E\uFEFF")).toEqual({ ok: false, code: "empty" });
    expect(sanitizeWhatsAppOutput("   \n\n   ")).toEqual({ ok: false, code: "empty" });
  });
});

describe("sourceLinksOf", () => {
  test("collects the absolute URLs that literally occur in the scoped evidence", () => {
    expect([...sourceLinksOf(["see https://wa.me/62812 and http://x.example/a"])]).toEqual([
      "https://wa.me/62812",
      "http://x.example/a",
    ]);
  });

  test("stops at the delimiters a JSON tool result puts around a link", () => {
    // Evidence reaches the gate as tool-result JSON, where a link is followed by
    // a quote: the collected link must be the clean one the model quotes back.
    const json = JSON.stringify({ ok: true, rows: [["bolt", "https://wa.me/62812"]], sha256: "ab" });

    expect([...sourceLinksOf([json])]).toEqual(["https://wa.me/62812"]);
  });

  test("hands the gate a link it will then accept, and leaves others refused", () => {
    const links = sourceLinksOf(["the group shared https://wa.me/62812"]);

    expect(sanitizeWhatsAppOutput("open https://wa.me/62812", links)).toEqual({ ok: true, text: "open https://wa.me/62812" });
    expect(sanitizeWhatsAppOutput("open https://wa.me/62899", links)).toEqual({ ok: false, code: "unsafe_link" });
  });
});

describe("normalizeUntrustedText", () => {
  test("applies NFC and strips what a reader cannot see", () => {
    expect(normalizeUntrustedText("e\u0301\u200B\u0007\ttab")).toBe("é\ttab");
  });
});
