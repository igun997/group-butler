import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DependencyStrip } from "./dependency-strip";
import type { Dashboard } from "@/lib/dashboard";

const read = (overrides: Partial<Pick<Dashboard, "workerOk" | "mongoOk" | "healthError">> = {}): Parameters<typeof DependencyStrip>[0] => ({
  workerOk: true,
  mongoOk: true,
  healthError: null,
  ...overrides,
});

/**
 * Both dependencies in one line, because every reading above depends on them. A
 * badge alone leaves the operator to work out which numbers stopped moving, so a
 * degraded dependency says what it costs.
 */
describe("dependency strip", () => {
  test("both reachable is a quiet line with no alarm", () => {
    const html = renderToStaticMarkup(<DependencyStrip {...read()} />);

    expect(html).toContain("MongoDB");
    expect(html).toContain("Worker");
    expect((html.match(/Reachable/gu) ?? []).length).toBe(2);
    expect(html).not.toContain("not answering");
  });

  test("a worker that stopped says capture has stopped", () => {
    const html = renderToStaticMarkup(<DependencyStrip {...read({ workerOk: false })} />);

    expect(html).toContain("Unreachable");
    expect(html).toContain("capture has stopped");
  });

  test("mongoDB that stopped names the readings it took with it", () => {
    const html = renderToStaticMarkup(<DependencyStrip {...read({ mongoOk: false })} />);

    expect(html).toContain("Unreachable");
    expect(html).toContain("MongoDB is not answering");
  });

  test("a probe that could not run is said rather than shown as healthy", () => {
    const html = renderToStaticMarkup(
      <DependencyStrip {...read({ workerOk: null, mongoOk: null, healthError: "The dependency probe did not finish." })} />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("The dependency probe did not finish.");
    expect(html).not.toContain("Reachable");
  });
});
