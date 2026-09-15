import { FailureNotice } from "@/components/shell/failure-notice";
import { DependencyBadge } from "@/components/shell/status-badge";
import type { Dashboard } from "@/lib/dashboard";

/**
 * The two dependencies every reading above depends on, shown together so one
 * glance says whether the screen is telling the truth. When one is down the strip
 * says what it means for the readings, because a badge alone leaves the operator
 * to work out which numbers stopped moving.
 */
export function DependencyStrip({ workerOk, mongoOk, healthError }: Pick<Dashboard, "workerOk" | "mongoOk" | "healthError">) {
  if (healthError) return <FailureNotice>{healthError}</FailureNotice>;

  const mongoDown = mongoOk === false;
  const workerDown = workerOk === false;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border px-4 py-3">
      <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <li className="flex items-center gap-2">
          <span>MongoDB</span>
          <DependencyBadge ok={mongoOk === true} okLabel="Reachable" failedLabel="Unreachable" />
        </li>
        <li className="flex items-center gap-2">
          <span>Worker</span>
          <DependencyBadge ok={workerOk === true} okLabel="Reachable" failedLabel="Unreachable" />
        </li>
      </ul>
      {mongoDown || workerDown ? (
        <p className={mongoDown ? "text-xs text-destructive" : "text-xs text-warning"}>
          {mongoDown
            ? "MongoDB is not answering, so the stored readings below are the ones that were already on the page."
            : "The worker is not answering, so capture has stopped and today's numbers are the last ones it stored."}
        </p>
      ) : null}
    </div>
  );
}
