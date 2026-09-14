import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CreateInstanceFields } from "./create-instance-fields";

/**
 * The create form's fields, rendered to a string. What matters is what the
 * operator can fill in and what the request will carry, not how the fields are
 * assembled: the phone number is a `code`-mode fact, and a field-level failure
 * has to land on the field it belongs to.
 */
describe("create instance fields", () => {
  test("QR mode asks for a label and offers both pairing modes", () => {
    const html = renderToStaticMarkup(<CreateInstanceFields mode="qr" />);

    expect(html).toContain("Label");
    expect(html).toContain('name="label"');
    expect(html).toContain("Scan a QR code");
    expect(html).toContain("Use a phone number");
  });

  test("QR mode carries no phone number, because the route would reject it", () => {
    const html = renderToStaticMarkup(<CreateInstanceFields mode="qr" />);

    expect(html).not.toContain('name="phoneNumber"');
  });

  test("code mode asks for the phone number the code is sent to", () => {
    const html = renderToStaticMarkup(<CreateInstanceFields mode="code" />);

    expect(html).toContain('name="phoneNumber"');
    expect(html).toContain("International format");
  });

  test("a failure lands on the field it belongs to", () => {
    const html = renderToStaticMarkup(
      <CreateInstanceFields mode="qr" errors={{ label: "That label is already in use." }} />,
    );

    expect(html).toContain("That label is already in use.");
  });

  test("while the request is in flight the submit cannot be pressed twice", () => {
    const html = renderToStaticMarkup(<CreateInstanceFields mode="qr" pending />);

    expect(html).toContain("Starting pairing");
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
