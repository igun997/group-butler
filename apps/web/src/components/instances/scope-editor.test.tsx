import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ScopeEditor } from "./scope-editor";

const groups = [
  { jid: "120363040000000001@g.us", name: "Ops Team" },
  { jid: "120363040000000002@g.us", name: "Suppliers ID" },
  { jid: "120363040000000003@g.us", name: "Ops Standup" },
];

/**
 * The assistant-scope picker: the operator chooses from the groups this instance
 * actually has, so the route's unknown-group refusal is unreachable by
 * construction, and nothing is saved until the selection differs from what is
 * stored.
 */
describe("scope editor", () => {
  test("every known group is offered, by name and by the jid to copy", () => {
    const html = renderToStaticMarkup(
      <ScopeEditor groups={groups} whitelisted={["120363040000000001@g.us"]} onSave={() => {}} />,
    );

    expect(html).toContain("Ops Team");
    expect(html).toContain("120363040000000002@g.us");
    expect(html).toContain("Ops Standup");
  });

  test("the stored scope is what starts selected", () => {
    const html = renderToStaticMarkup(
      <ScopeEditor groups={groups} whitelisted={["120363040000000001@g.us", "120363040000000003@g.us"]} onSave={() => {}} />,
    );

    expect(html).toContain("2 of 3 groups");
  });

  test("nothing to save until the selection changes", () => {
    const html = renderToStaticMarkup(<ScopeEditor groups={groups} whitelisted={[]} onSave={() => {}} />);

    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain("Save scope");
  });

  test("an instance with no observed groups says why there is nothing to pick", () => {
    const html = renderToStaticMarkup(<ScopeEditor groups={[]} whitelisted={[]} onSave={() => {}} />);

    expect(html).toMatch(/no observed groups/i);
    expect(html).toMatch(/sync/i);
    expect(html).not.toContain("Save scope");
  });

  test("a refused save is shown against the editor", () => {
    const html = renderToStaticMarkup(
      <ScopeEditor
        groups={groups}
        whitelisted={[]}
        error="the whitelist names groups this instance does not have"
        onSave={() => {}}
      />,
    );

    expect(html).toContain("the whitelist names groups this instance does not have");
  });

  test("while a save is in flight the control says so and cannot be pressed twice", () => {
    const html = renderToStaticMarkup(<ScopeEditor groups={groups} whitelisted={[]} saving onSave={() => {}} />);

    expect(html).toContain("Saving");
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  test("the group list scrolls inside a bounded box, and the search stays above it", () => {
    const many = Array.from({ length: 24 }, (_, index) => ({
      jid: `12036304000000${String(index).padStart(4, "0")}@g.us`,
      name: `Group ${index}`,
    }));

    const html = renderToStaticMarkup(<ScopeEditor groups={many} whitelisted={[]} onSave={() => {}} />);

    const searchIndex = html.indexOf('aria-label="Search groups"');
    const listIndex = html.indexOf('data-slot="scope-list"');
    expect(searchIndex).toBeGreaterThan(-1);
    expect(listIndex).toBeGreaterThan(searchIndex);

    // The list is the thing that scrolls, inside a height the panel bounds.
    const container = html.slice(listIndex, html.indexOf(">", listIndex));
    expect(container).toContain("overflow-y-auto");
    expect(container).toMatch(/max-h-\d/);

    // And every group lives inside it, so the count stays honest while scrolling.
    const scrollBox = html.slice(listIndex);
    expect(scrollBox).toContain("120363040000000023@g.us");
    expect(scrollBox).toContain("Group 23");
  });
});
