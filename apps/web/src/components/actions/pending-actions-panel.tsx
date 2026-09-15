"use client";

import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ShieldUserIcon } from "@hugeicons/core-free-icons";
import { FailureNotice } from "@/components/shell/failure-notice";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";

/**
 * The approval queue for destructive group maintenance.
 *
 * Everything the assistant wants to change — a rename, the announcement setting,
 * removing participants, revoking a message — is staged here with what it would
 * do, and nothing reaches WhatsApp until the owner approves it. Approving
 * performs the action and this panel reports the real outcome: the row leaves
 * the queue only once the worker answered, and a refusal is shown with its own
 * reason rather than disappearing as if it had worked. A rejected action is
 * never performed at all.
 *
 * The queue reads itself on mount, so the surface needs no page-level loader and
 * can be dropped onto any console page. The list is a plain function of its
 * props: the fetch and the decision requests live in the wrapper below, so the
 * row rendering can be rendered and read on its own.
 */

/** One staged action as `GET /api/actions` writes it, stamps already ISO strings. */
export interface PendingActionItem {
  id: string;
  shortId: string;
  instanceId: string;
  groupJid: string;
  action: string;
  summary: string;
  requestedAt: string;
  state: string;
}

export type PendingDecision = "approve" | "reject";

/** The fields a response has to carry before a row is rendered from it. */
const ACTION_FIELDS = [
  "id",
  "shortId",
  "instanceId",
  "groupJid",
  "action",
  "summary",
  "requestedAt",
  "state",
] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long an action has been waiting, in the largest unit that has fully
 * elapsed: an operator deciding on a rename wants "4m", not a timestamp to
 * subtract. A stamp that is not a time — or is in the future, where a negative
 * age would read as an answer — is an absent age rather than a wrong one.
 */
export function pendingActionAge(requestedAt: string, nowMs: number): string {
  const elapsed = nowMs - Date.parse(requestedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "an unknown length of time";
  if (elapsed < MINUTE_MS) return "less than a minute";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  return `${Math.floor(elapsed / DAY_MS)}d`;
}

/** The queue as the route wrote it, or `null` when the answer is not one. */
function readActions(body: unknown): PendingActionItem[] | null {
  if (typeof body !== "object" || body === null || !("actions" in body)) return null;
  const { actions } = body;
  if (!Array.isArray(actions)) return null;
  if (!actions.every(isPendingActionItem)) return null;
  return actions;
}

function isPendingActionItem(value: unknown): value is PendingActionItem {
  if (typeof value !== "object" || value === null) return false;
  return ACTION_FIELDS.every((field) => typeof Reflect.get(value, field) === "string");
}

/** The phrase a refusal was written with, when the route sent one. */
function readErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  return typeof body.error === "string" && body.error.length > 0 ? body.error : null;
}

/**
 * What the route reports the action became. A rejection, an execution and a
 * failure all answer with the row, so this is how the panel tells "done" from
 * "refused" instead of assuming an approval implies success.
 */
export function readSettledAction(body: unknown): { state: string; summary: string } | null {
  if (typeof body !== "object" || body === null || !("action" in body)) return null;
  const action = body.action;
  if (typeof action !== "object" || action === null) return null;
  if (!("state" in action) || typeof action.state !== "string") return null;
  const summary = "summary" in action && typeof action.summary === "string" ? action.summary : "";
  return { state: action.state, summary };
}

export function PendingActionsList({
  actions,
  now,
  deciding,
  failure,
  onDecide,
}: {
  actions: readonly PendingActionItem[];
  now: number;
  /** The one decision in flight, if any: both of that row's controls are held. */
  deciding: { id: string; decision: PendingDecision } | null;
  failure: { id: string; message: string } | null;
  onDecide: (id: string, decision: PendingDecision) => void;
}) {
  if (actions.length === 0) {
    return (
      <Empty className="border border-dashed border-border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={ShieldUserIcon} strokeWidth={2} />
          </EmptyMedia>
          <EmptyTitle>Nothing is waiting for a decision</EmptyTitle>
          <EmptyDescription>
            A group change the assistant wants to make appears here, with what it would do and to which group.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {actions.map((action) => {
        const busy = deciding?.id === action.id;
        const message = failure?.id === action.id ? failure.message : null;

        return (
          <li key={action.id}>
            <Item variant="outline">
              <ItemContent>
                <ItemTitle className="break-words">{action.summary}</ItemTitle>
                <ItemDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono">{action.shortId}</span>
                  <span aria-hidden>·</span>
                  <span className="break-all font-mono">{action.groupJid}</span>
                  <span aria-hidden>·</span>
                  <span>waiting {pendingActionAge(action.requestedAt, now)}</span>
                </ItemDescription>
                {message !== null ? (
                  <p role="alert" className="text-sm text-destructive">
                    {message}
                  </p>
                ) : null}
              </ItemContent>
              <ItemActions>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => onDecide(action.id, "approve")}
                  className="max-md:h-11"
                >
                  {busy && deciding.decision === "approve" ? <Spinner /> : null}
                  {busy && deciding.decision === "approve" ? "Approving" : "Approve"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => onDecide(action.id, "reject")}
                  className="max-md:h-11"
                >
                  {busy && deciding.decision === "reject" ? <Spinner /> : null}
                  {busy && deciding.decision === "reject" ? "Rejecting" : "Reject"}
                </Button>
              </ItemActions>
            </Item>
          </li>
        );
      })}
    </ul>
  );
}

export function PendingActionsPanel() {
  const [actions, setActions] = useState<readonly PendingActionItem[] | null>(null);
  const [failedToLoad, setFailedToLoad] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ id: string; decision: PendingDecision } | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch("/api/actions", { headers: { accept: "application/json" } });
        const body: unknown = await response.json().catch(() => null);
        if (!live) return;
        const listed = readActions(body);
        if (!response.ok || listed === null) {
          setFailedToLoad(`The queue could not be read (${response.status}).`);
          return;
        }
        setActions(listed);
      } catch {
        if (live) setFailedToLoad("The server did not answer, so nothing is known about the queue.");
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const decide = useCallback(async (id: string, decision: PendingDecision) => {
    setDeciding({ id, decision });
    setFailure(null);
    setNotice(null);

    let response: Response;
    try {
      response = await fetch(`/api/actions/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
    } catch {
      setFailure({ id, message: "The server did not answer. The action is unchanged." });
      setDeciding(null);
      return;
    }

    const body: unknown = await response.json().catch(() => null);
    const settled = readSettledAction(body);

    if (!response.ok) {
      // A failed execution answers with the failure's own status, so a non-2xx
      // here is not necessarily a refused decision: the action may have been
      // approved and then refused by WhatsApp. Say which one happened.
      const reason = readErrorMessage(body);
      if (settled?.state === "failed") {
        setFailure({ id, message: `${settled.summary} — ${reason ?? "the change was not made"}` });
      } else {
        setFailure({ id, message: reason ?? `The decision was refused (${response.status}).` });
      }
      setDeciding(null);
      return;
    }

    // The action is settled, so it is no longer waiting: it leaves the queue.
    setActions((current) => current?.filter((action) => action.id !== id) ?? current);
    setNotice(
      decision === "reject"
        ? "Rejected. Nothing was changed."
        : settled?.state === "executed"
          ? `${settled.summary} — done.`
          : "Approved and carried out.",
    );
    setDeciding(null);
  }, []);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-medium tracking-tight">Waiting for your decision</h2>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          Group changes that cannot be undone are staged here, with what they would do, and are never performed until you
          approve them.
        </p>
      </div>

      {failedToLoad !== null ? (
        <FailureNotice>{failedToLoad}</FailureNotice>
      ) : actions === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking what is waiting for a decision…
        </p>
      ) : (
        <PendingActionsList
          actions={actions}
          now={Date.now()}
          deciding={deciding}
          failure={failure}
          onDecide={decide}
        />
      )}

      {notice !== null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
