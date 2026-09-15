import { describe, expect, test } from "vitest";
import { dashboardRead, type DashboardSources } from "./dashboard";
import type { Loaded, TokenTrend, UsageDay } from "@/server/console";
import type { HealthReport } from "@/server/health";
import type { InstanceRow } from "@/server/repos/instances";

const SUPPORT: InstanceRow = {
  id: "6a1f9c",
  label: "Support bot",
  status: "connected",
  groupSync: { groupsObserved: 4, groupsLeft: 0, lastSyncAt: "2026-09-14T06:20:20.620Z", lastError: null },
};
const SALES: InstanceRow = {
  id: "8c2d5f",
  label: "Sales bot",
  status: "logged_out",
  groupSync: { groupsObserved: 0, groupsLeft: 0, lastSyncAt: null, lastError: null },
};

const idle = (instanceId: string, label: string) => ({
  instanceId,
  label,
  recorded: false,
  counters: { messagesIn: 0, mediaStored: 0, mediaUnparsed: 0, sendsOk: 0, sendsFailed: 0, receipts: 0 },
  tokens: { calls: 0, inputTokens: null, outputTokens: null, totalTokens: null },
});

const USAGE: UsageDay = {
  day: "2026-09-14",
  maxTokensPerDay: 200_000,
  recorded: true,
  instances: [
    { ...idle("6a1f9c", "Support bot"), recorded: true, counters: { messagesIn: 1_204, mediaStored: 3, mediaUnparsed: 1, sendsOk: 2, sendsFailed: 0, receipts: 9 } },
    idle("8c2d5f", "Sales bot"),
    { ...idle("gone01", "Retired bot"), recorded: true, counters: { messagesIn: 96, mediaStored: 0, mediaUnparsed: 0, sendsOk: 0, sendsFailed: 0, receipts: 0 } },
  ],
};

const DAYS = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"];

const TOKENS: TokenTrend = {
  days: DAYS,
  instances: [
    {
      instanceId: "6a1f9c",
      label: "Support bot",
      days: DAYS.map((day) => ({ day, calls: 0, inputTokens: null, outputTokens: null, totalTokens: null })),
    },
  ],
};

const HEALTH: HealthReport = { ok: true, mongo: "ok", worker: { reachable: true, ok: true } };

const sources = (overrides: Partial<DashboardSources> = {}): DashboardSources => ({
  instances: { ok: true, data: [SUPPORT, SALES] },
  usage: { ok: true, data: USAGE },
  health: { ok: true, data: HEALTH },
  tokens: { ok: true, data: TOKENS },
  ...overrides,
});

const ok = <T,>(data: T): Loaded<T> => ({ ok: true, data });

/**
 * The dashboard is a reading of four independent dependencies, so its contract is
 * what it says while each one is missing: a failed instance read must not turn the
 * day's totals into zeros, and a failed usage read must not hide how many bots run.
 */
describe("dashboardRead", () => {
  test("counts capturing bots, the day's messages and each bot's share", () => {
    const dashboard = dashboardRead(sources());

    expect(dashboard.bots).toEqual({ capturing: 1, total: 2 });
    expect(dashboard.stalled?.map((row) => row.label)).toEqual(["Sales bot"]);
    expect(dashboard.day).toBe("2026-09-14");
    expect(dashboard.messagesIn).toBe(1_300);
    expect(dashboard.activity).toEqual([
      { instanceId: "6a1f9c", label: "Support bot", messagesIn: 1_204 },
      { instanceId: "gone01", label: "Retired bot", messagesIn: 96 },
      { instanceId: "8c2d5f", label: "Sales bot", messagesIn: 0 },
    ]);
    expect(dashboard.workerOk).toBe(true);
    expect(dashboard.mongoOk).toBe(true);
    expect(dashboard.healthError).toBeNull();
  });

  test("a bot that recorded today stays on the chart after it is unlinked", () => {
    const dashboard = dashboardRead(sources({ instances: ok([SUPPORT]) }));

    expect(dashboard.bots).toEqual({ capturing: 1, total: 1 });
    expect(dashboard.activity.map((bot) => bot.instanceId)).toContain("gone01");
  });

  test("equal counts are ordered by label so the chart does not reshuffle", () => {
    const tied: UsageDay = {
      ...USAGE,
      instances: [idle("b", "Beta"), idle("a", "Alpha")].map((row) => ({ ...row, recorded: true, counters: { ...row.counters, messagesIn: 5 } })),
    };

    const dashboard = dashboardRead(sources({ usage: ok(tied) }));

    expect(dashboard.activity.map((bot) => bot.label)).toEqual(["Alpha", "Beta"]);
  });

  test("a failed instance read leaves the day's messages readable", () => {
    const dashboard = dashboardRead(sources({ instances: { ok: false, error: "MongoDB did not answer." } }));

    expect(dashboard.bots).toBeNull();
    expect(dashboard.stalled).toBeNull();
    expect(dashboard.botsError).toBe("MongoDB did not answer.");
    expect(dashboard.messagesError).toBeNull();
    expect(dashboard.messagesIn).toBe(1_300);
    expect(dashboard.activity).toHaveLength(3);
  });

  test("a failed usage read leaves the bot count readable, and no zero where a number is unknown", () => {
    const dashboard = dashboardRead(
      sources({ usage: { ok: false, error: "MongoDB did not answer, so today's usage could not be read." } }),
    );

    expect(dashboard.bots).toEqual({ capturing: 1, total: 2 });
    expect(dashboard.messagesIn).toBeNull();
    expect(dashboard.messagesError).toBe("MongoDB did not answer, so today's usage could not be read.");
    expect(dashboard.botsError).toBeNull();
    expect(dashboard.day).toBeNull();
    expect(dashboard.activity).toEqual([]);
  });

  test("an unreadable dependency probe is unknown, not healthy", () => {
    const dashboard = dashboardRead(sources({ health: { ok: false, error: "The dependency probe did not finish." } }));

    expect(dashboard.workerOk).toBeNull();
    expect(dashboard.mongoOk).toBeNull();
    expect(dashboard.healthError).toBe("The dependency probe did not finish.");
    expect(dashboard.messagesIn).toBe(1_300);
  });

  test("a day with nothing recorded still lists the bots, so silence is visible", () => {
    const quiet: UsageDay = {
      ...USAGE,
      recorded: false,
      instances: USAGE.instances.map((instance) => ({
        ...instance,
        recorded: false,
        counters: { ...instance.counters, messagesIn: 0 },
      })),
    };

    const dashboard = dashboardRead(sources({ usage: ok(quiet) }));

    expect(dashboard.messagesIn).toBe(0);
    expect(dashboard.activity).toHaveLength(3);
    expect(dashboard.activity.every((bot) => bot.messagesIn === 0)).toBe(true);
  });

  test("a worker that reports itself unhealthy is not read as healthy", () => {
    const dashboard = dashboardRead(
      sources({ health: ok({ ...HEALTH, ok: false, worker: { reachable: false, ok: false, error: "the worker did not answer" } }) }),
    );

    expect(dashboard.workerOk).toBe(false);
    expect(dashboard.mongoOk).toBe(true);
  });

  test("counts a bot's calls and the days its provider reported, ignoring quiet days", () => {
    const trend: TokenTrend = {
      days: DAYS,
      instances: [
        {
          instanceId: "6a1f9c",
          label: "Support bot",
          days: [
            // Quiet days are a factual zero and must not count as reported.
            { day: DAYS[0]!, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            { day: DAYS[1]!, calls: 2, inputTokens: 40, outputTokens: 400, totalTokens: 440 },
            { day: DAYS[2]!, calls: 1, inputTokens: null, outputTokens: null, totalTokens: null },
            { day: DAYS[3]!, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            { day: DAYS[4]!, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            { day: DAYS[5]!, calls: 3, inputTokens: 7, outputTokens: null, totalTokens: null },
            { day: DAYS[6]!, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          ],
        },
      ],
    };

    const dashboard = dashboardRead(sources({ tokens: ok(trend) }));
    const support = dashboard.tokens?.[0];

    expect(support?.calls).toBe(6);
    expect(support?.reportedDays).toBe(2);
    expect(support?.days[0]).toEqual({ day: DAYS[0], calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(support?.days[2]).toEqual({ day: DAYS[2], calls: 1, inputTokens: null, outputTokens: null, totalTokens: null });
  });

  test("a bot that never called has nothing reported, not a week of zeroes counted as reports", () => {
    const quiet: TokenTrend = {
      days: DAYS,
      instances: [
        {
          instanceId: "8c2d5f",
          label: "Sales bot",
          days: DAYS.map((day) => ({ day, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })),
        },
      ],
    };

    const dashboard = dashboardRead(sources({ tokens: ok(quiet) }));
    const sales = dashboard.tokens?.[0];

    expect(sales?.calls).toBe(0);
    expect(sales?.reportedDays).toBe(0);
    expect(dashboard.tokenMax).toBe(0);
  });

  test("a failed token read is its own absence, not a flat line", () => {
    const dashboard = dashboardRead(sources({ tokens: { ok: false, error: "MongoDB did not answer, so the token history could not be read." } }));

    expect(dashboard.tokens).toBeNull();
    expect(dashboard.tokensError).toBe("MongoDB did not answer, so the token history could not be read.");
    expect(dashboard.messagesIn).toBe(1_300);
  });
});
