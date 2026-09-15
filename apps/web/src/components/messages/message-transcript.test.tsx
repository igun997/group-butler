import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { MessageTranscript } from "./message-transcript";

const messages = [
  {
    waMessageId: "wamid-1",
    instanceId: "inst_1",
    groupJid: "120363040000000001@g.us",
    senderJid: "628990000001@s.whatsapp.net",
    pushName: "Nadia",
    fromMe: false,
    timestamp: "2026-09-15T02:00:00.000Z",
    kind: "text",
    text: "Deploy is green",
    media: { status: "none", declaredType: null, r2Key: null, mime: null, fileName: null, reason: null },
  },
  {
    waMessageId: "wamid-2",
    instanceId: "inst_1",
    groupJid: "120363040000000001@g.us",
    senderJid: "628990000002@s.whatsapp.net",
    pushName: "",
    fromMe: true,
    timestamp: "2026-09-15T02:01:00.000Z",
    kind: "document",
    text: "",
    media: { status: "unparsed", declaredType: "document", r2Key: "org_default/inst_1/wamid-2", mime: "application/pdf", fileName: "deploy.pdf", reason: "unsupported_type" },
  },
];

describe("message transcript", () => {
  test("renders chronological bubbles with identity, direction, body, and honest attachment status", () => {
    const html = renderToStaticMarkup(<MessageTranscript messages={messages} />);

    expect(html.indexOf("Deploy is green")).toBeLessThan(html.indexOf("deploy.pdf"));
    expect(html).toContain("Nadia");
    expect(html).toContain("628990000002@s.whatsapp.net");
    expect(html).toContain("Received");
    expect(html).toContain("Sent");
    expect(html).toContain("Attachment could not be read: unsupported type");
    expect(html).toContain("Open media");
  });

  test("explains why the transcript has no rows", () => {
    const html = renderToStaticMarkup(<MessageTranscript messages={[]} filtered />);

    expect(html).toMatch(/No messages match these filters/i);
  });
});
