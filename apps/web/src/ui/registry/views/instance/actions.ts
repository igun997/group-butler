import type { ActionCtx, ActionDescriptor } from "../../types";
import { INSTANCES_ALL } from "../instances/model";
import { deleteInstance, INSTANCE_SNAPSHOT, requestPairingCode } from "./model";

/**
 * The instance workspace's own actions (docs/ui-decision.md §2.1, §2.2 invariant
 * 3, §4.6 R-A8).
 *
 * An action is an operation, not a notification: it does the work and answers
 * with what the server now holds, and `useAction` is what reports the outcome.
 * The destructive one is gated by a confirmation plan rather than by a flag its
 * caller sets, because a caller that can set a boundary can skip it (§4.6 R-A8):
 * the plan names the target and states the consequence, and the shell's dialog
 * holds the pending state and the failure.
 */

/**
 * `Request a pairing code` (draft §6.5 `POST /instances/{id}/pairing-code`). It
 * is offered only by a `code`-mode instance while it is pairing, and the worker
 * refuses it in any other state with `invalid_state` — which is why the control
 * is not rendered anywhere else (R-L8).
 */
export interface RequestPairingCodeAction extends ActionDescriptor {
  run(ctx: ActionCtx): Promise<{ ok: true }>;
}

export const requestPairingCodeAction: RequestPairingCodeAction = {
  id: "request-pairing-code",
  label: "Request a pairing code",
  resource: { id: INSTANCE_SNAPSHOT },
  run: async (ctx) => {
    await requestPairingCode(ctx.scope);
    return { ok: true };
  },
};

/**
 * `Log out and delete` (draft §6.5 `DELETE /instances/{id}`). It is the one
 * action that unlinks a device, so it is the one action here that asks first:
 * the confirmation names the instance's own address and states what is lost and
 * what is kept. Nothing is optimistic — the row is gone when the worker says the
 * session was ended and the device deleted, and the workspace then leaves the
 * address rather than rendering a screen about an instance that no longer
 * exists.
 */
export interface DeleteInstanceAction extends ActionDescriptor {
  run(ctx: ActionCtx): Promise<{ ok: true }>;
}

export const deleteInstanceAction: DeleteInstanceAction = {
  id: "delete-instance",
  label: "Log out and delete",
  resource: { id: INSTANCES_ALL },
  confirm: {
    title: "Log out and delete this instance?",
    body:
      "The WhatsApp session is logged out, the linked device is deleted, and the instance is removed from this dashboard. Its stored groups and messages stay readable, and a removed instance cannot be paired again: creating a new one is how you re-pair.",
    confirmLabel: "Log out and delete",
  },
  run: async (ctx) => {
    await deleteInstance(ctx.scope);
    return { ok: true };
  },
};
