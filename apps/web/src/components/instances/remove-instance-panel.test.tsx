import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { RemoveInstancePanel } from "./remove-instance-panel";

/**
 * Removal is the one irreversible action in the console, so it is two steps in
 * place, never a single button and never a modal. The second step is where the
 * consequences are named, because that is the step the operator has to read.
 */
describe("remove instance panel", () => {
  test("nothing irreversible is offered until it is asked for", () => {
    const html = renderToStaticMarkup(<RemoveInstancePanel label="Support bot" onStart={() => {}} />);

    expect(html).toContain("Remove instance");
    expect(html).not.toContain("Cancel");
    expect(html).not.toContain("audit log");
  });

  test("the second step names what it unlinks and what it keeps", () => {
    const html = renderToStaticMarkup(
      <RemoveInstancePanel label="Support bot" confirming onStart={() => {}} onCancel={() => {}} onConfirm={() => {}} />,
    );

    expect(html).toContain("Support bot");
    expect(html).toMatch(/unlink/i);
    expect(html).toMatch(/audit log/i);
    expect(html).toContain("Cancel");
    expect(html).toMatch(/Remove and unlink/);
  });

  test("the second step can be abandoned", () => {
    const html = renderToStaticMarkup(
      <RemoveInstancePanel label="Support bot" confirming onStart={() => {}} onCancel={() => {}} onConfirm={() => {}} />,
    );

    expect(html).toContain("Cancel");
  });

  test("a refused removal says why, and the operator stays on the page", () => {
    const html = renderToStaticMarkup(
      <RemoveInstancePanel
        label="Support bot"
        confirming
        error="the worker could not delete the device"
        onStart={() => {}}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(html).toContain("the worker could not delete the device");
    expect(html).toContain("Cancel");
  });

  test("while it is running the confirm cannot be pressed twice", () => {
    const html = renderToStaticMarkup(
      <RemoveInstancePanel label="Support bot" confirming pending onStart={() => {}} onCancel={() => {}} onConfirm={() => {}} />,
    );

    expect(html).toContain("Removing");
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
