import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PendingActionsList, pendingActionAge, readSettledAction, type PendingActionItem } from "./pending-actions-panel";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");

/**
 * A held control, in the markup React actually renders. It is matched as an
 * attribute rather than the word: every button also carries `disabled:` utility
 * classes, which would count as a held button if the word alone were enough.
 */
const DISABLED_CONTROL = /(?:^|\s)disabled=""/g;

const rename: PendingActionItem = {
  id: "a1",
  shortId: "K7M2QP",
  instanceId: "inst_1",
  groupJid: "120363043123456789@g.us",
  action: "group_rename",
  summary: "Rename the group to Ops Team.",
  requestedAt: "2026-09-15T11:56:00.000Z",
  state: "pending",
};

const announcement: PendingActionItem = {
  ...rename,
  id: "a2",
  shortId: "B4X9TN",
  action: "group_set_announce",
  summary: "Only admins may post in this group.",
  requestedAt: "2026-09-15T09:00:00.000Z",
};

function list(
  overrides: {
    actions?: readonly PendingActionItem[];
    deciding?: { id: string; decision: "approve" | "reject" };
    failure?: { id: string; message: string };
  } = {},
) {
  return renderToStaticMarkup(
    <PendingActionsList
      actions={overrides.actions ?? [rename, announcement]}
      now={NOW}
      deciding={overrides.deciding ?? null}
      failure={overrides.failure ?? null}
      onDecide={() => {}}
    />,
  );
}

/**
 * The approval queue: every destructive group change is staged here, so the
 * operator decides on a sentence, the group it affects and how long it has been
 * waiting — not on a model's word.
 */
describe("pending actions panel", () => {
  test("each action is one row with its summary, short id, group and age", () => {
    const html = list();

    expect(html).toContain("Rename the group to Ops Team.");
    expect(html).toContain("K7M2QP");
    expect(html).toContain("120363043123456789@g.us");
    expect(html).toContain("waiting 4m");

    expect(html).toContain("Only admins may post in this group.");
    expect(html).toContain("B4X9TN");
    expect(html).toContain("waiting 3h");
  });

  test("every row can be approved or rejected", () => {
    const html = list();

    expect(html.match(/Approve/g)).toHaveLength(2);
    expect(html.match(/Reject/g)).toHaveLength(2);
    expect(html).not.toMatch(DISABLED_CONTROL);
  });

  test("nothing waiting says so, and says what would appear here", () => {
    const html = list({ actions: [] });

    expect(html).toMatch(/nothing is waiting for a decision/i);
    expect(html).not.toContain("Approve");
  });

  test("a decision in flight is said on the row it belongs to, and cannot be sent twice", () => {
    const html = list({ deciding: { id: "a1", decision: "approve" } });

    // One row is busy, so one row's two controls are disabled.
    expect(html.match(DISABLED_CONTROL)).toHaveLength(2);
    expect(html).toContain("Approving");
    expect(html).toContain('aria-label="Loading"');
    // The other action is still decidable, so a slow request blocks one row.
    expect(html).toContain("B4X9TN");
  });

  test("a failed decision stays on its row, with the reason the server gave", () => {
    const html = list({ failure: { id: "a2", message: "the action was already decided" } });

    expect(html).toMatch(/role="alert"/);
    expect(html).toContain("the action was already decided");
    expect(html).not.toContain("Approving");
  });

  test("an age is the largest unit that has actually elapsed", () => {
    expect(pendingActionAge("2026-09-15T11:59:30.000Z", NOW)).toBe("less than a minute");
    expect(pendingActionAge("2026-09-15T11:56:00.000Z", NOW)).toBe("4m");
    expect(pendingActionAge("2026-09-15T09:00:00.000Z", NOW)).toBe("3h");
    expect(pendingActionAge("2026-09-13T12:00:00.000Z", NOW)).toBe("2d");
    // An unreadable stamp is not a wrong age: it is an absent one.
    expect(pendingActionAge("not a date", NOW)).toBe("an unknown length of time");
  });
});

/**
 * Approving performs the action, so the panel has to read what actually became
 * of it: an approval is not the same answer as a success, and a refused change
 * answers with a failure status that must not be reported as "done".
 */
describe("reading a settled action", () => {
  test("an executed answer names the action that was carried out", () => {
    expect(readSettledAction({ action: { state: "executed", summary: "Rename the group to Ops Team." } })).toEqual({
      state: "executed",
      summary: "Rename the group to Ops Team.",
    });
  });

  test("a failed answer is read as a failure, whatever status carried it", () => {
    expect(readSettledAction({ error: "the group refused", code: "not_admin", action: { state: "failed", summary: "Remove 2 participants." } })).toEqual({
      state: "failed",
      summary: "Remove 2 participants.",
    });
  });

  test("anything that is not a reported action is null rather than a guess", () => {
    for (const body of [null, undefined, "text", {}, { action: null }, { action: {} }, { action: { summary: "no state" } }, { action: { state: 7 } }]) {
      expect(readSettledAction(body)).toBeNull();
    }
  });

  test("a state without a summary is still a state", () => {
    expect(readSettledAction({ action: { state: "rejected" } })).toEqual({ state: "rejected", summary: "" });
  });
});
