import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import LoginPage from "./page";

/**
 * No cookie: the page is rendered the way an unauthenticated browser gets it.
 * `cookies()` is the request-scoped Next API, so it is the one thing here that
 * cannot run outside a request.
 */
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

async function loginHtml(): Promise<string> {
  return renderToStaticMarkup(await LoginPage());
}

describe("/login (the owner's way in)", () => {
  test("renders one labelled email and password form the owner can submit", async () => {
    const html = await loginHtml();
    const markup = html.toLowerCase();

    expect(html.match(/<h1/g)).toHaveLength(1);

    expect(markup).toContain('for="email"');
    expect(markup).toContain('id="email"');
    expect(markup).toContain('type="email"');
    expect(markup).toContain('name="email"');
    expect(markup).toContain('autocomplete="username"');

    expect(markup).toContain('for="password"');
    expect(markup).toContain('id="password"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('name="password"');
    expect(markup).toContain('autocomplete="current-password"');

    expect(markup).toContain('type="submit"');
    expect(html).toContain("Sign in");
  });

  test("keeps a live region for the failure, mounted before it is needed", async () => {
    const html = await loginHtml();

    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-describedby="');
  });
});
