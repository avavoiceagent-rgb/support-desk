// Every operational time in one timezone: the one the cars are driving in.
//
// This screen and the emails Adam sends have to agree. The backend composes
// replies in America/New_York — "your car will be there at 2:10 PM" means New
// York, always — while the browser was formatting the same instant in whatever
// zone the laptop happens to be set to. On a machine in Berlin that is a
// six-hour lie sitting next to the email that contradicts it, and it also made
// a day the wrong twenty-four hours: asking for Saturday fetched 6pm Friday to
// 6pm Saturday, so the evening's work quietly vanished off the board.
//
// So: nothing here reads the browser's zone. Times are shown in New York and
// labelled, and a "day" starts at midnight in New York.

export const OPERATING_TIME_ZONE = "America/New_York";

/** Shown next to times so a reader outside New York is never guessing. */
export const OPERATING_ZONE_LABEL = "ET";

/**
 * How far the operating zone's clock is from UTC at a given instant.
 *
 * Read off Intl rather than hard-coded, because the answer changes twice a
 * year and a fixed -5 or -4 is wrong for half of it.
 */
function offsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: OPERATING_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const p: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") p[part.type] = part.value;

  // `hour` comes back as "24" at midnight under hour12:false, hence the % 24.
  const asIfUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second)
  );
  return asIfUtc - instant.getTime();
}

/**
 * A wall-clock reading in New York, as the instant it actually refers to.
 *
 * Twice: the first offset is taken from a guess that can sit on the wrong side
 * of a clock change, and on those two days a single pass lands an hour out.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0
): Date {
  // Milliseconds are held back and added at the end: the offset is read off a
  // formatter that only goes down to seconds, so a guess carrying 999ms comes
  // back a second out.
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let ts = guess - offsetMs(new Date(guess));
  ts = guess - offsetMs(new Date(ts));
  return new Date(ts + ms);
}

/** The calendar parts of an instant, as New York sees them. */
function zoneParts(value: Date | string) {
  const d = typeof value === "string" ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: OPERATING_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const p: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") p[part.type] = part.value;
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: String(Number(p.hour) % 24).padStart(2, "0"),
    minute: p.minute,
  };
}

const zoned = (extra: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions => ({
  timeZone: OPERATING_TIME_ZONE,
  ...extra,
});

/** "Sat 22 Aug, 7:15 PM" */
export function when(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(
    "en-GB",
    zoned({ weekday: "short", day: "numeric", month: "short" })
  );
  return `${date}, ${atTime(iso)}`;
}

/** "22 Aug 2026" */
export function onDate(iso: string): string {
  return new Date(iso).toLocaleDateString(
    "en-GB",
    zoned({ day: "numeric", month: "short", year: "numeric" })
  );
}

/** "7:15 PM" */
export function atTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(
    "en-US",
    zoned({ hour: "numeric", minute: "2-digit", hour12: true })
  );
}

/** "Sat 22 Aug, 5:00 PM – 4:00 AM", collapsing the date when it does not change. */
export function span(startIso: string, endIso: string): string {
  const sameDay = toDateInput(startIso) === toDateInput(endIso);
  return sameDay ? `${when(startIso)} – ${atTime(endIso)}` : `${when(startIso)} – ${when(endIso)}`;
}

/** "21 Aug" — compact, for marking a shift that began the day before. */
export function dayMonth(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", zoned({ day: "numeric", month: "short" }));
}

/** "Saturday, 22 August 2026" — the heading over a day's board. */
export function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString(
    "en-GB",
    zoned({ weekday: "long", day: "numeric", month: "long", year: "numeric" })
  );
}

/** yyyy-mm-dd for a date input — the New York calendar date of this instant. */
export function toDateInput(value: Date | string): string {
  const p = zoneParts(value);
  return `${p.year}-${p.month}-${p.day}`;
}

/** yyyy-mm-ddThh:mm for a datetime-local input, reading New York's clock. */
export function toDateTimeInput(value: Date | string): string {
  const p = zoneParts(value);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/**
 * What a datetime-local input gives back, read as New York time.
 *
 * An admin typing "5:00 PM" means five in the afternoon for the driver, not
 * five wherever the admin is sitting.
 */
export function fromDateTimeInput(value: string): string {
  const [date, time = "00:00"] = value.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return zonedToUtc(y, m, d, h, min).toISOString();
}

/** Midnight in New York on this date, as an instant. */
export function dayStartMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return zonedToUtc(y, m, d, 0, 0, 0, 0).getTime();
}

export function startOfDayIso(date: string): string {
  return new Date(dayStartMs(date)).toISOString();
}

export function endOfDayIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return zonedToUtc(y, m, d, 23, 59, 59, 999).toISOString();
}

/**
 * The date this many days on, by the calendar rather than by adding 24 hours.
 *
 * The day a clock change falls on is 23 or 25 hours long, and stepping by
 * milliseconds through it lands on the same date twice or skips one.
 */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return toDateInput(zonedToUtc(y, m, d + days, 12, 0));
}

/** Today's date in New York, which is what "Today" on the board should mean. */
export function todayInZone(): string {
  return toDateInput(new Date());
}
