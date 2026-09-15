import { afterEach, describe, expect, test, vi } from "vitest";
import { displayTimeZone, toZonedIso } from "./display-time";

/**
 * The clock times are written in. Stored instants stay UTC; what the owner is
 * shown is their own zone, because a recap that says 08:20 for a message their
 * phone showed at 15:20 is one they have to translate before they can use it.
 */
describe("the clock the owner reads", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("uses the configured zone, and the deployment's own default when unset", () => {
    vi.stubEnv("DISPLAY_TIMEZONE", "Europe/Berlin");
    expect(displayTimeZone()).toBe("Europe/Berlin");

    vi.stubEnv("DISPLAY_TIMEZONE", "");
    expect(displayTimeZone()).toBe("Asia/Jakarta");

    // Blank or spaced values are the same as unset.
    vi.stubEnv("DISPLAY_TIMEZONE", "   ");
    expect(displayTimeZone()).toBe("Asia/Jakarta");
  });

  // The value becomes a formatter, and an unknown zone makes `Intl` throw — which
  // would take out every message that carries a time.
  test("falls back rather than throwing on a zone it cannot use", () => {
    vi.stubEnv("DISPLAY_TIMEZONE", "Mars/Olympus_Mons");
    expect(displayTimeZone()).toBe("Asia/Jakarta");

    vi.stubEnv("DISPLAY_TIMEZONE", "Asia/Jakarta");
    expect(toZonedIso(new Date("2026-09-15T08:20:00Z"))).toBe("2026-09-15T15:20:00+07:00");
  });

  test("writes one instant as the reader's clock and offset", () => {
    vi.stubEnv("DISPLAY_TIMEZONE", "Asia/Jakarta");
    // 01:20 UTC is 08:20 the same morning in Jakarta.
    expect(toZonedIso(new Date("2026-09-16T01:20:00Z"))).toBe("2026-09-16T08:20:00+07:00");
    // The offset is read for that instant: Berlin is +02:00 in summer, +01:00 in winter.
    expect(toZonedIso(new Date("2026-07-01T12:00:00Z"), "Europe/Berlin")).toBe("2026-07-01T14:00:00+02:00");
    expect(toZonedIso(new Date("2026-12-01T12:00:00Z"), "Europe/Berlin")).toBe("2026-12-01T13:00:00+01:00");
    // Midnight is 00:00, never 24:00, because the clock is read as h23.
    expect(toZonedIso(new Date("2026-09-15T17:00:00Z"), "Asia/Jakarta")).toBe("2026-09-16T00:00:00+07:00");
    expect(toZonedIso(new Date("2026-09-15T12:00:00Z"), "UTC")).toBe("2026-09-15T12:00:00+00:00");
  });
});
