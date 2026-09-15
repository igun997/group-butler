/**
 * The clock the assistant reads times in.
 *
 * Every timestamp the model is shown is an instant, and an instant is only
 * meaningful to a reader in a zone. Stored times are UTC — that is what the
 * database keeps and what the history has always rendered — but a recap that
 * tells the owner a message arrived at 08:20 when their phone said 15:20 is a
 * recap they have to translate before they can use it.
 *
 * The deployment's own default is `Asia/Jakarta`, the same way
 * `authorized-jids.ts` defaults the country to `62`: this project is written for
 * one operator in one country, and a value that has never been set should behave
 * the way that operator expects rather than the way a library would.
 */
const FALLBACK_TIME_ZONE = "Asia/Jakarta";

/**
 * A zone name `Intl` will accept. Values are read from the environment and used
 * to build formatters, where an unknown name throws a `RangeError` — so an
 * operator's typo would take out every reply that renders a time. An unusable
 * value falls back instead, exactly like an unusable country code does.
 */
function usableTimeZone(value: string): boolean {
  if (value === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

let resolved: { configured: string; zone: string } | null = null;

/** The zone times are written in: `DISPLAY_TIMEZONE`, or the deployment's default. */
export function displayTimeZone(): string {
  const configured = (process.env.DISPLAY_TIMEZONE ?? "").trim();
  if (resolved?.configured === configured) return resolved.zone;
  const zone = usableTimeZone(configured) ? configured : FALLBACK_TIME_ZONE;
  resolved = { configured, zone };
  return zone;
}

/**
 * One instant as the reader's own clock and offset, e.g. `2026-09-16T08:20:00+07:00`.
 *
 * An offset is kept rather than a bare wall clock because the model may compare
 * two of these, or subtract one from "now": `2026-09-16T08:20:00` alone is a
 * string it would have to guess about, while the offset makes the instant
 * unambiguous and still reads as the time the owner saw.
 */
export function toZonedIso(date: Date, zone: string = displayTimeZone()): string {
  const clock = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = new Map(clock.formatToParts(date).map((part) => [part.type, part.value]));
  const day = `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
  const time = `${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}`;
  return `${day}T${time}${offsetOf(date, zone)}`;
}

/**
 * The zone's offset at that instant, as `+07:00`. It is read for the given date
 * rather than assumed, because a zone that observes daylight saving is not at one
 * offset all year.
 */
function offsetOf(date: Date, zone: string): string {
  const named = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  // `longOffset` answers `GMT+07:00`, and `GMT` alone for UTC itself.
  return named === undefined || named === "GMT" ? "+00:00" : named.replace(/^GMT/u, "");
}
