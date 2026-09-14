import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ButtonLink } from "./button-link";

/**
 * A link that looks like a button.
 *
 * base-ui's `Button` claims native button semantics unless told otherwise, so
 * rendering an anchor through it warns and tells assistive technology it is a
 * button. These tests pin the seam that stops a call site from forgetting.
 */
describe("button link", () => {
  afterEach(() => vi.restoreAllMocks());

  test("renders an anchor with the destination, not a button", () => {
    const html = renderToStaticMarkup(<ButtonLink href="/instances/new">Link an account</ButtonLink>);

    expect(html).toMatch(/<a[^>]+href="\/instances\/new"/);
    expect(html).toContain("Link an account");
    expect(html).not.toContain('type="button"');
    expect(html).not.toContain('role="button"');
  });

  test("says nothing about native buttons, because it does not claim to be one", () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    renderToStaticMarkup(<ButtonLink href="/instances">All instances</ButtonLink>);

    expect(logged.filter((entry) => /nativeButton|native <button>|button semantics/i.test(entry))).toEqual([]);
  });

  test("keeps the button's own appearance and the caller's classes", () => {
    const html = renderToStaticMarkup(
      <ButtonLink href="/instances/new" variant="outline" className="max-md:h-11">
        Link an account
      </ButtonLink>,
    );

    expect(html).toContain("max-md:h-11");
    expect(html).toContain("border-border");
  });
});
