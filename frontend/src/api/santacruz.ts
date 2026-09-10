// The SantaCruz screens' half of the API.
//
// Kept apart from `ops.ts` on purpose: nothing here reads or writes the desk's
// own reservations, and keeping the two clients separate makes it obvious that
// the existing Operations screens are untouched by any of this.

import { api } from "./client";

export interface TargetField {
  name: string;
  kind: "text" | "integer" | "decimal" | "timestamp" | "money";
  required: boolean;
  describe: string;
}

export interface FieldMapping {
  sourceColumn: string;
  targetField: string;
}

export interface SantaCruzConnection {
  baseUrl: string | null;
  sourceTimeZone: string;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastCheckResult: string | null;
  /** Whether a key is set in Railway. Never the key itself. */
  outboundKeySet: boolean;
  inboundKeySet: boolean;
  inboundUrl: string;
  mappedFieldCount: number;
  missingRequired: string[];
  bookingCount: number;
  readyForFileImport: boolean;
}

export interface SantaCruzBooking {
  id: string;
  externalId: string;
  reference: string | null;
  passengerName: string | null;
  passengerPhone: string | null;
  bookerName: string | null;
  bookerEmail: string | null;
  pickupAddress: string | null;
  dropoffAddress: string | null;
  pickupAt: string | null;
  bookedHours: number | null;
  vehicleClass: string | null;
  passengerCount: number | null;
  luggageCount: number | null;
  flightNumber: string | null;
  status: string | null;
  driverName: string | null;
  priceCents: number | null;
  notes: string | null;
  raw: Record<string, unknown>;
  ticketId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ImportRun {
  id: string;
  source: "FILE" | "API";
  label: string | null;
  startedAt: string;
  finishedAt: string | null;
  rowsSeen: number;
  rowsImported: number;
  rowsRejected: number;
  error: string | null;
  actorName: string | null;
}

export interface Rejection {
  id: string;
  rowNumber: number;
  externalId: string | null;
  reasons: string[];
  raw: Record<string, unknown>;
}

export interface ImportOutcome {
  importId: string;
  rowsSeen: number;
  rowsImported: number;
  rowsRejected: number;
  unmappedColumns: string[];
}

export const santacruzApi = {
  fields: () => api.get<{ fields: TargetField[] }>("/santacruz/fields").then((r) => r.fields),
  connection: () =>
    api.get<{ connection: SantaCruzConnection }>("/santacruz/connection").then((r) => r.connection),
  saveConnection: (patch: { baseUrl?: string | null; sourceTimeZone?: string; enabled?: boolean }) =>
    api
      .patch<{ connection: SantaCruzConnection }>("/santacruz/connection", patch)
      .then((r) => r.connection),
  mapping: () => api.get<{ mapping: FieldMapping[] }>("/santacruz/mapping").then((r) => r.mapping),
  saveMapping: (mapping: FieldMapping[]) =>
    api.put<{ mapping: FieldMapping[] }>("/santacruz/mapping", { mapping }).then((r) => r.mapping),
  runImport: (rows: Record<string, unknown>[], label?: string) =>
    api.post<{ outcome: ImportOutcome }>("/santacruz/import", { rows, label }).then((r) => r.outcome),
  imports: () => api.get<{ imports: ImportRun[] }>("/santacruz/imports").then((r) => r.imports),
  rejections: (importId: string) =>
    api
      .get<{ rejections: Rejection[] }>(`/santacruz/imports/${importId}/rejections`)
      .then((r) => r.rejections),
  bookings: () =>
    api.get<{ bookings: SantaCruzBooking[] }>("/santacruz/bookings").then((r) => r.bookings),
};

/**
 * Work out what is separating the columns.
 *
 * A `.csv` opened in Excel and copied out again arrives TAB separated, which
 * is how most people will get an export onto the clipboard. Reading that as
 * commas gives one enormous column named after every heading at once, and an
 * error about the file that says nothing about the real problem. European
 * Excel uses semicolons for the same reason.
 *
 * Decided on the header line alone, and on the count rather than the presence:
 * a heading row that genuinely contains a comma inside a quoted name should
 * not outvote nine tabs.
 */
function delimiterOf(headerLine: string): string {
  const outsideQuotes = headerLine.replace(/"[^"]*"/g, "");
  const counts: [string, number][] = [
    ["\t", (outsideQuotes.match(/\t/g) ?? []).length],
    [",", (outsideQuotes.match(/,/g) ?? []).length],
    [";", (outsideQuotes.match(/;/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  // Nothing found at all: treat it as commas so the message a person gets is
  // about their file rather than about a delimiter nobody chose.
  return counts[0][1] === 0 ? "," : counts[0][0];
}

/**
 * Read a pasted export into rows, without inventing anything.
 *
 * Quoted fields and embedded commas are handled because a pickup address has
 * commas in it and getting that wrong would shift every column along by one —
 * silently, and only on the rows with addresses. A row whose column count does
 * not match the header is NOT padded or trimmed; it is handed back as an error,
 * because a short row is a sign the file is not what we think it is.
 */
export function parseCsv(text: string): { rows: Record<string, string>[]; problems: string[] } {
  const problems: string[] = [];
  const cleaned = text.replace(/\r\n?/g, "\n").trim();
  if (cleaned === "") return { rows: [], problems: ["That file had nothing in it."] };

  const delimiter = delimiterOf(cleaned.split("\n")[0]);
  const lines = splitRows(cleaned, delimiter);
  if (lines.length === 0) return { rows: [], problems: ["That file had nothing in it."] };

  const header = lines[0];
  if (header.length === 1) {
    problems.push(
      "Only one column was found in the first row, so the columns are probably separated by something this cannot read. Copying from Notepad rather than a spreadsheet usually fixes it."
    );
  }
  if (header.some((h) => h.trim() === "")) {
    problems.push("One of the columns in the first row has no name.");
  }

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i];
    if (cells.length === 1 && cells[0].trim() === "") continue;
    if (cells.length !== header.length) {
      problems.push(
        `Row ${i + 1} has ${cells.length} values but the first row names ${header.length} columns, so it was left out.`
      );
      continue;
    }
    const row: Record<string, string> = {};
    header.forEach((name, j) => {
      row[name.trim()] = cells[j];
    });
    rows.push(row);
  }
  return { rows, problems };
}

/** Split the text into rows of cells, respecting quotes and newlines inside them. */
function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n") {
      cells.push(cell);
      rows.push(cells);
      cells = [];
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  rows.push(cells);
  return rows;
}
