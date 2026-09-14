import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SchedulerSection } from "./scheduler-section";
import type { LoopReport } from "@/lib/operations";

const LOOP: LoopReport = {
  name: "group-sync",
  intervalMs: 1_800_000,
  lastRunAt: "2026-09-14T09:12:03Z",
  lastError: "",
  runs: 42,
};

/**
 * The loops section is the operator's only read of the worker's timers, so a row
 * has to carry the cadence, the last pass and its outcome without a second click —
 * and a worker that cannot be read has to say so without taking the page with it.
 */
describe("scheduler section", () => {
  test("a loop row carries its interval, last UTC run, run count and outcome", () => {
    const html = renderToStaticMarkup(<SchedulerSection result={{ ok: true, data: [LOOP] }} />);

    expect(html).toContain("group-sync");
    expect(html).toContain("interval 30m");
    expect(html).toContain("last run 2026-09-14 09:12 UTC");
    expect(html).toContain("42");
    expect(html).toContain("runs since start");
    expect(html).toContain("OK");
  });

  test("a single pass is counted in the singular, several in the plural", () => {
    const once = renderToStaticMarkup(<SchedulerSection result={{ ok: true, data: [{ ...LOOP, runs: 1 }] }} />);
    const many = renderToStaticMarkup(<SchedulerSection result={{ ok: true, data: [{ ...LOOP, runs: 0 }] }} />);

    // The count sits in its own mono span, so the sentence is read as text.
    expect(once.replace(/<[^>]+>/gu, "")).toContain("1 run since start");
    expect(once.replace(/<[^>]+>/gu, "")).not.toContain("1 runs since start");
    expect(many.replace(/<[^>]+>/gu, "")).toContain("0 runs since start");
  });

  test("a cadence the worker did not declare is stated in words, never as a dash", () => {
    const html = renderToStaticMarkup(
      <SchedulerSection result={{ ok: true, data: [{ ...LOOP, intervalMs: 0 }] }} />,
    );

    expect(html).toContain("interval not available");
    expect(html).not.toContain("—");
  });

  test("a pass that failed shows the error the loop recorded", () => {
    const html = renderToStaticMarkup(
      <SchedulerSection
        result={{ ok: true, data: [{ ...LOOP, lastError: "GetJoinedGroups timed out" }] }}
      />,
    );

    expect(html).toContain("Failed");
    expect(html).toContain("Last pass failed: GetJoinedGroups timed out");
  });

  test("a loop that has not run yet is not shown as a failure", () => {
    const html = renderToStaticMarkup(
      <SchedulerSection result={{ ok: true, data: [{ ...LOOP, lastRunAt: null, runs: 0 }] }} />,
    );

    expect(html).toContain("last run never");
    expect(html).toContain("Not yet run");
    expect(html).not.toMatch(/failed/i);
  });

  test("a worker that cannot be read fails on its own, with the loader's fixed phrase", () => {
    const html = renderToStaticMarkup(
      <SchedulerSection result={{ ok: false, error: "The worker control plane did not answer." }} />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("The worker control plane did not answer.");
  });

  test("a worker that reports no loop names the cause", () => {
    const html = renderToStaticMarkup(<SchedulerSection result={{ ok: true, data: [] }} />);

    expect(html).toContain("The worker reports no scheduled loop");
    expect(html).toContain("once the worker starts it and records a pass");
  });
});
