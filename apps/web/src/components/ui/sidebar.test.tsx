import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SidebarInset, SidebarProvider } from "./sidebar";

/**
 * The console's one landmark. `SidebarInset` is a generated shadcn primitive and
 * was a `<main>` until this slice, which nested it around the shell's own
 * `<main id="content">` and gave assistive technology two answers to "where is
 * the main content". Re-syncing the primitive must not put it back.
 */
describe("console landmarks", () => {
  test("the inset wraps the page's single main landmark", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarInset>
          <main id="content">page</main>
        </SidebarInset>
      </SidebarProvider>,
    );

    expect(html.match(/<main/gu)).toHaveLength(1);
    expect(html).toContain('id="content"');
    expect(html).toContain("sidebar-inset");
  });
});
