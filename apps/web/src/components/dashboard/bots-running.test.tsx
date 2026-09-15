import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { BotsRunning } from "./bots-running";
import type { InstanceRow } from "@/server/repos/instances";
import type { Dashboard } from "@/lib/dashboard";

const CONNECTED: InstanceRow = { id: "6a1f9c", label: "Support bot", status: "connected", groupSync: { groupsObserved: 4, groupsLeft: 0, lastSyncAt: null, lastError: null } };
const LOGGED_OUT: InstanceRow = { ...CONNECTED, id: "8c2d5f", label: "Sales bot", status: "logged_out" };

const read = (overrides: Partial<Pick<Dashboard, "bots" | "stalled" | "botsError">>) => ({
  bots: { capturing: 1, total: 2 },
  stalled: [LOGGED_OUT],
  botsError: null,
  ...overrides,
});

/**
 * The first question the screen answers is how much of the fleet is capturing, and
 * a count alone does not say which account stopped, so the stalled bots are named
 * under it with the same status word the rest of the console uses.
 */
describe("bots running", () => {
  test("counts capturing accounts against the fleet and names the ones that stopped", () => {
    const html = renderToStaticMarkup(<BotsRunning {...read({})} />);

    expect(html).toContain("1");
    expect(html).toContain("of 2 linked accounts are capturing");
    expect(html).toContain("1 not capturing");
    expect(html).toContain("Sales bot");
    expect(html).toContain("Logged out");
    expect(html).toContain('href="/instances/8c2d5f"');
  });

  test("every account capturing is stated once, with no empty list under it", () => {
    const html = renderToStaticMarkup(
      <BotsRunning {...read({ bots: { capturing: 2, total: 2 }, stalled: [] })} />,
    );

    expect(html).toContain("All capturing");
    expect(html).toContain("Every linked account is capturing.");
    expect(html).not.toContain("<ul");
  });

  test("nothing capturing is a failure state, not a quiet one", () => {
    const html = renderToStaticMarkup(
      <BotsRunning {...read({ bots: { capturing: 0, total: 2 }, stalled: [CONNECTED, LOGGED_OUT] })} />,
    );

    expect(html).toContain("None capturing");
    expect(html).toContain("Support bot");
  });

  test("no linked account asks for the one thing that creates one", () => {
    const html = renderToStaticMarkup(<BotsRunning {...read({ bots: { capturing: 0, total: 0 }, stalled: [] })} />);

    expect(html).toContain("No bot is linked yet");
    expect(html).toContain('href="/instances/new"');
  });

  test("a refused instance read says why instead of showing a zero fleet", () => {
    const html = renderToStaticMarkup(
      <BotsRunning {...read({ bots: null, stalled: null, botsError: "MongoDB did not answer, so the stored instances could not be read." })} />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("MongoDB did not answer, so the stored instances could not be read.");
    expect(html).not.toContain("linked accounts are capturing");
  });
});
