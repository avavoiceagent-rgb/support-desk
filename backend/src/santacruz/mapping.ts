/**
 * Turning one SantaCruz row into one of our bookings.
 *
 * Pure: no database, no network, no clock beyond the zone it is handed. That
 * is what lets the whole of this be tested against a file long before a
 * connection to SantaCruz exists.
 *
 * The rule the rest of this feature hangs off: **a value that cannot be read
 * is refused, never approximated.** A pickup time we could not parse is not
 * midnight, an absent bag count is not nought, and "about two hundred" is not
 * $200. Every refusal carries a sentence a person can act on, and the row is
 * kept whole so nothing is lost by refusing it.
 */

import { DateTime } from "luxon";
import { targetField, TARGET_FIELDS, type FieldKind } from "./fields";

export interface FieldMapping {
  /** Whatever SantaCruz calls the column. */
  sourceColumn: string;
  /** One of TARGET_FIELDS. */
  targetField: string;
}

export type SourceRow = Record<string, unknown>;

export interface MappedBooking {
  externalId: string;
  reference: string | null;
  pickupAt: Date | null;
  pickupAddress: string | null;
  dropoffAddress: string | null;
  passengerName: string | null;
  passengerPhone: string | null;
  bookerName: string | null;
  bookerEmail: string | null;
  bookedHours: number | null;
  vehicleClass: string | null;
  passengerCount: number | null;
  luggageCount: number | null;
  flightNumber: string | null;
  status: string | null;
  driverName: string | null;
  priceCents: number | null;
  notes: string | null;
}

export type ReadResult =
  | { ok: true; value: string | number | Date | null }
  | { ok: false; reason: string };

/** Blank in their data means "they did not say", which is not the same as a value. */
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * A timestamp, read in the zone the connection screen names.
 *
 * Three cases, and only one of them is a guess we are willing to make:
 *
 * - The string carries its own offset or a Z. Honoured as written; their
 *   answer beats our setting.
 * - No offset. Read as wall-clock time in `zone`, which is why that setting
 *   exists and why it is not allowed to default silently in the UI.
 * - The wall-clock time does not exist, or exists twice, because the clocks
 *   moved that morning. Refused. It is one or two bookings a year, the
 *   rejection names them, and a booking an hour out is worse than a booking
 *   somebody has to look at.
 */
function readTimestamp(raw: unknown, zone: string): ReadResult {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime())
      ? { ok: false, reason: "the date value was not a real date" }
      : { ok: true, value: raw };
  }
  if (typeof raw === "number") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime())
      ? { ok: false, reason: `${raw} is not a time we can read` }
      : { ok: true, value: d };
  }
  if (typeof raw !== "string") return { ok: false, reason: "the pickup time was not text or a date" };

  const text = raw.trim();

  // Their answer beats our setting: a string carrying its own offset or a Z is
  // unambiguous and needs none of the work below.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const own = DateTime.fromISO(text, { setZone: true });
    return own.isValid
      ? { ok: true, value: own.toUTC().toJSDate() }
      : { ok: false, reason: `"${text}" is not a date and time we can read.` };
  }

  // Parsed as UTC so the fields come back exactly as written rather than being
  // resolved against a zone before we have had a chance to look at them.
  const FORMATS = ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "M/d/yyyy H:mm", "M/d/yyyy H:mm:ss"];
  let literal = DateTime.fromISO(text, { zone: "utc" });
  for (const fmt of FORMATS) {
    if (literal.isValid) break;
    literal = DateTime.fromFormat(text, fmt, { zone: "utc" });
  }
  if (!literal.isValid) {
    return {
      ok: false,
      reason: `"${text}" is not a date and time we can read. Expected something like 2026-03-14 15:30.`,
    };
  }

  const { year, month, day, hour, minute } = literal;
  const wallMs = Date.UTC(year, month - 1, day, hour, minute);

  // The two offsets in force either side of any change that week. Where they
  // agree there is no transition to worry about and the first candidate wins.
  const offsets = [
    DateTime.fromMillis(wallMs - 36 * 3_600_000, { zone }).offset,
    DateTime.fromMillis(wallMs + 36 * 3_600_000, { zone }).offset,
  ];

  // A candidate is real only if turning it back into wall-clock time in this
  // zone gives the clock reading we started from. That is the whole test:
  // a time in the spring gap satisfies neither offset, and a time in the
  // autumn overlap satisfies both.
  const real = [...new Set(offsets)]
    .map((off) => wallMs - off * 60_000)
    .filter((ms) => {
      const back = DateTime.fromMillis(ms, { zone });
      return (
        back.year === year &&
        back.month === month &&
        back.day === day &&
        back.hour === hour &&
        back.minute === minute
      );
    });

  if (real.length === 0) {
    return {
      ok: false,
      reason: `"${text}" does not exist in ${zone} — the clocks moved that morning. Confirm the real time with SantaCruz.`,
    };
  }
  if (new Set(real).size > 1) {
    return {
      ok: false,
      reason: `"${text}" happens twice in ${zone} on the day the clocks go back, so which one is meant is not in the data.`,
    };
  }

  return { ok: true, value: new Date(real[0]) };
}

function readInteger(raw: unknown, label: string): ReadResult {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { ok: false, reason: `"${String(raw)}" is not a number for ${label}` };
  if (!Number.isInteger(n)) return { ok: false, reason: `${label} came through as ${n}, which is not a whole number` };
  if (n < 0) return { ok: false, reason: `${label} came through as ${n}` };
  return { ok: true, value: n };
}

function readDecimal(raw: unknown, label: string): ReadResult {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { ok: false, reason: `"${String(raw)}" is not a number for ${label}` };
  if (n < 0) return { ok: false, reason: `${label} came through as ${n}` };
  return { ok: true, value: n };
}

/**
 * Money, in whole cents.
 *
 * Mirrors the frontend's `parseMoney` deliberately: a price becomes an invoice,
 * so anything that is not unambiguously an amount is refused rather than
 * rounded into something plausible.
 */
function readMoney(raw: unknown, label: string): ReadResult {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return { ok: false, reason: `${label} came through as ${raw}` };
    return { ok: true, value: Math.round(raw * 100) };
  }
  const cleaned = String(raw).trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return { ok: false, reason: `"${String(raw)}" is not an amount we can bill for ${label}` };
  }
  return { ok: true, value: Math.round(Number(cleaned) * 100) };
}

export function readValue(raw: unknown, kind: FieldKind, label: string, zone: string): ReadResult {
  switch (kind) {
    case "timestamp":
      return readTimestamp(raw, zone);
    case "integer":
      return readInteger(raw, label);
    case "decimal":
      return readDecimal(raw, label);
    case "money":
      return readMoney(raw, label);
    case "text": {
      const text = String(raw).trim();
      return { ok: true, value: text === "" ? null : text };
    }
  }
}

export interface MappingOutcome {
  booking: MappedBooking | null;
  reasons: string[];
  /** Columns in their row that no mapping mentions. Not an error; worth seeing. */
  unmappedColumns: string[];
}

/**
 * Apply the mapping to one row.
 *
 * Every reason is collected rather than returning on the first, so a person
 * fixing a mapping sees everything wrong with it in one pass instead of
 * discovering the next fault on the next import.
 */
export function applyMapping(row: SourceRow, mappings: FieldMapping[], zone: string): MappingOutcome {
  const reasons: string[] = [];
  const out: Record<string, unknown> = {};
  const usedColumns = new Set<string>();

  for (const field of TARGET_FIELDS) out[field.name] = null;

  for (const map of mappings) {
    const field = targetField(map.targetField);
    if (!field) {
      reasons.push(`the mapping points "${map.sourceColumn}" at "${map.targetField}", which is not a field Adam has`);
      continue;
    }

    const present = Object.prototype.hasOwnProperty.call(row, map.sourceColumn);
    usedColumns.add(map.sourceColumn);

    if (!present) {
      if (field.required) {
        reasons.push(`the column "${map.sourceColumn}" that feeds ${field.name} was not in this row`);
      }
      continue;
    }

    const raw = row[map.sourceColumn];
    if (isBlank(raw)) {
      if (field.required) reasons.push(`${field.name} is required and "${map.sourceColumn}" was empty`);
      continue;
    }

    const read = readValue(raw, field.kind, field.name, zone);
    if (!read.ok) {
      reasons.push(`${field.name}: ${read.reason}`);
      continue;
    }
    out[field.name] = read.value;
  }

  for (const field of TARGET_FIELDS) {
    if (!field.required) continue;
    const mapped = mappings.some((m) => m.targetField === field.name);
    if (!mapped) reasons.push(`nothing is mapped to ${field.name}, which every booking needs`);
    else if (out[field.name] === null && !reasons.some((r) => r.startsWith(`${field.name}`) || r.includes(field.name))) {
      reasons.push(`${field.name} came through empty`);
    }
  }

  const unmappedColumns = Object.keys(row).filter((c) => !usedColumns.has(c));

  if (reasons.length > 0) return { booking: null, reasons, unmappedColumns };
  return { booking: out as unknown as MappedBooking, reasons: [], unmappedColumns };
}
