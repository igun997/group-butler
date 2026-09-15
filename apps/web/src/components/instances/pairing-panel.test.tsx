import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PairingPanel } from "./pairing-panel";

const connected = {
  kind: "connected",
  identity: {
    phoneNumber: "628990000001",
    botJid: "628990000001@s.whatsapp.net",
    botLid: "1234567890@lid",
    connectedAt: "2026-09-14T09:05:00.000Z",
    lastSeenAt: "2026-09-14T09:20:00.000Z",
  },
} as const;

/**
 * The pairing panel, rendered for each stage the worker can put an instance in.
 * The payload is the worker's: the panel shows what it was handed, stops when
 * the flow stops, and never leaves a QR on screen for an instance that is no
 * longer pairing.
 */
describe("pairing panel", () => {
  test("a scan stage shows the image the worker produced", () => {
    const html = renderToStaticMarkup(<PairingPanel stage={{ kind: "scan", qr: "data:image/png;base64,AAAA" }} />);

    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain("Scan this with WhatsApp");
    expect(html).toContain("Linked devices");
  });

  test("a code stage shows the code as text and no image", () => {
    const html = renderToStaticMarkup(<PairingPanel stage={{ kind: "code", code: "ABCD-1234" }} />);

    expect(html).toContain("ABCD-1234");
    expect(html).not.toContain("<img");
  });

  test("waiting is a wait, not a failure", () => {
    const html = renderToStaticMarkup(<PairingPanel stage={{ kind: "waiting" }} />);

    expect(html).toMatch(/has not produced/i);
    expect(html).not.toContain("<img");
  });

  test("connected shows the identity the worker reported", () => {
    const html = renderToStaticMarkup(<PairingPanel stage={connected} />);

    expect(html).toContain("628990000001");
    expect(html).toContain("628990000001@s.whatsapp.net");
    expect(html).toContain("1234567890@lid");
    expect(html).toContain("2026-09-14 09:05 UTC");
    expect(html).toContain("2026-09-14 09:20 UTC");
    expect(html).not.toContain("<img");
  });

  test("a stopped stage carries the reason and leaves no payload behind", () => {
    const html = renderToStaticMarkup(
      <PairingPanel stage={{ kind: "stopped", tone: "failure", reason: "This device was unlinked from the phone." }} />,
    );

    expect(html).toContain("This device was unlinked from the phone.");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("ABCD-1234");
  });

  test("checking and the code action are real controls, shown only when the caller offers them", () => {
    const bare = renderToStaticMarkup(<PairingPanel stage={{ kind: "waiting" }} />);
    expect(bare).not.toContain("Check now");

    const withActions = renderToStaticMarkup(
      <PairingPanel stage={{ kind: "waiting" }} polling onCheckNow={() => {}} checking={false} />,
    );
    expect(withActions).toContain("Check now");
    expect(withActions).toContain("Checking every 2 seconds");

    const idle = renderToStaticMarkup(
      <PairingPanel stage={{ kind: "stopped", tone: "idle", reason: "This account is not linked right now." }} onRequestCode={() => {}} />,
    );
    expect(idle).toContain("Send a pairing code");
  });

  test("re-pairing is offered on a stopped stage, in either tone, and nowhere else", () => {
    const failure = renderToStaticMarkup(
      <PairingPanel
        stage={{ kind: "stopped", tone: "failure", reason: "This device was unlinked from the phone." }}
        onPairAgain={() => {}}
        onCheckNow={() => {}}
      />,
    );
    expect(failure).toContain("Pair again");

    const idle = renderToStaticMarkup(
      <PairingPanel
        stage={{ kind: "stopped", tone: "idle", reason: "This account is not linked right now." }}
        onPairAgain={() => {}}
      />,
    );
    expect(idle).toContain("Pair again");

    // A stopped stage with no caller-supplied action leaves only the reason.
    const bare = renderToStaticMarkup(
      <PairingPanel stage={{ kind: "stopped", tone: "idle", reason: "This account is not linked right now." }} />,
    );
    expect(bare).not.toContain("Pair again");

    const linked = renderToStaticMarkup(<PairingPanel stage={connected} onPairAgain={() => {}} />);
    expect(linked).not.toContain("Pair again");
  });

  test("checking disables the control so a second request cannot overlap", () => {
    const html = renderToStaticMarkup(<PairingPanel stage={{ kind: "waiting" }} polling onCheckNow={() => {}} checking />);

    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
