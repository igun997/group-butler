import type { EmptyAction, EmptyPlan } from "../registry";

/**
 * The five empty reasons, said once (docs/ui-decision.md §4.4 R-E1–R-E5).
 *
 * A resource declares all five copies, and the reason words them: an empty scope
 * offers the action that creates data, an over-filtered one offers clearing, a
 * missing prerequisite points at its editor, a downed service offers a retry,
 * and a scope that cannot answer offers the way back. Those are four different
 * sentences about four different situations, which is the point — a single
 * "No data" makes a wrong filter look like an empty system (R-E2).
 *
 * The copy is built from what the caller knows and nothing else: the subject the
 * operator is looking at, the noun the resource holds, and whatever action each
 * reason actually has. A reason with no way out keeps its action absent and
 * names the prerequisite in its body instead, because a control that is present
 * and disabled is worse than no control at all (R-E5).
 */

export interface EmptyCopyInput {
  /** How the scope is named in a sentence: "this instance", "Ops Team". */
  subject: string;
  /** What the resource holds, plural: "groups", "messages", "sends". */
  noun: string;
  /** The prerequisite whose absence disables the resource, e.g. "a group whitelist". */
  prerequisite?: string;
  /** The way out of each reason. Omitted where the reason has none. */
  create?: EmptyAction;
  clear?: EmptyAction;
  configure?: EmptyAction;
  retry?: EmptyAction;
  leave?: EmptyAction;
}

export function emptyPlan(input: EmptyCopyInput): EmptyPlan {
  const prerequisite = input.prerequisite ?? "the missing prerequisite";
  return {
    "no-data": {
      title: `No ${input.noun} yet`,
      body: `${input.subject} has no ${input.noun} recorded yet.`,
      action: input.create,
    },
    filtered: {
      title: `No ${input.noun} match these filters`,
      body: `${input.subject} has ${input.noun}, but none of them match the current filters.`,
      action: input.clear,
    },
    unconfigured: {
      title: "Not set up yet",
      body: `${input.subject} cannot use ${input.noun} until ${prerequisite} is set up.`,
      action: input.configure,
    },
    unavailable: {
      title: "Unavailable right now",
      body: `A service ${input.subject} depends on is not answering, so ${input.noun} cannot be read at the moment.`,
      action: input.retry,
    },
    "not-permitted": {
      title: "Not available in this scope",
      body: `${input.subject} does not include ${input.noun}, so they cannot be shown here.`,
      action: input.leave,
    },
  };
}
