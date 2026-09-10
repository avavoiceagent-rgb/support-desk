/**
 * Reading and writing the SantaCruz mirror.
 *
 * Everything here is additive to the desk as it stands. No existing table is
 * read or written, so the Operations screen and its dummy data behave exactly
 * as they did before this existed.
 *
 * The direction of travel matters and is deliberate: **SantaCruz owns the
 * booking, Adam owns the conversation.** So this file imports their
 * reservations and never writes one back. When the two disagree about a pickup
 * time, their row is the answer, because this is a copy of their record rather
 * than a second opinion about it.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  santacruzBookings,
  santacruzConnection,
  santacruzFieldMap,
  santacruzImports,
  santacruzRejections,
} from "../db/schema";
import { env, isSantaCruzInboundConfigured, isSantaCruzOutboundConfigured } from "../config/env";
import { OpsError } from "../ops/errors";
import { isTargetField, REQUIRED_FIELDS, TARGET_FIELDS } from "./fields";
import { applyMapping, type FieldMapping, type SourceRow } from "./mapping";

const SINGLETON = "singleton";

export interface ConnectionSettings {
  baseUrl: string | null;
  sourceTimeZone: string;
  enabled: boolean;
  lastCheckedAt: Date | null;
  lastCheckResult: string | null;
}

/** The row, created on first read so no screen has to cope with its absence. */
export async function getConnection(): Promise<ConnectionSettings> {
  const [row] = await db
    .select()
    .from(santacruzConnection)
    .where(eq(santacruzConnection.id, SINGLETON))
    .limit(1);
  if (row) return row;

  const [made] = await db
    .insert(santacruzConnection)
    .values({ id: SINGLETON })
    .onConflictDoNothing()
    .returning();
  if (made) return made;

  const [again] = await db
    .select()
    .from(santacruzConnection)
    .where(eq(santacruzConnection.id, SINGLETON))
    .limit(1);
  return again;
}

export interface ConnectionStatus extends ConnectionSettings {
  /**
   * Whether a key exists, never what it is.
   *
   * The rule this feature is held to: secrets live in Railway's environment
   * variables and nowhere else. A screen that can show a key is a screen that
   * can leak one, so this is a yes or a no.
   */
  outboundKeySet: boolean;
  inboundKeySet: boolean;
  /** Where SantaCruz would send its own requests, so it can be copied out. */
  inboundUrl: string;
  mappedFieldCount: number;
  /** Required fields with nothing mapped to them. Import cannot run until empty. */
  missingRequired: string[];
  bookingCount: number;
  /** True when an import could actually be run from a file right now. */
  readyForFileImport: boolean;
}

export async function connectionStatus(): Promise<ConnectionStatus> {
  const settings = await getConnection();
  const mapping = await listMapping();
  const mapped = new Set(mapping.map((m) => m.targetField));
  const missingRequired = REQUIRED_FIELDS.filter((f) => !mapped.has(f));

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(santacruzBookings);

  return {
    ...settings,
    outboundKeySet: isSantaCruzOutboundConfigured,
    inboundKeySet: isSantaCruzInboundConfigured,
    inboundUrl: `${env.APP_BASE_URL.replace(/\/$/, "")}/api/external/santacruz/bookings/:reference`,
    mappedFieldCount: mapping.length,
    missingRequired,
    bookingCount: count,
    readyForFileImport: missingRequired.length === 0,
  };
}

export async function updateConnection(patch: {
  baseUrl?: string | null;
  sourceTimeZone?: string;
  enabled?: boolean;
}): Promise<ConnectionSettings> {
  await getConnection();

  if (patch.sourceTimeZone !== undefined) {
    // A zone the server cannot resolve would silently become UTC inside the
    // date reader, which is the one mistake this setting exists to prevent.
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: patch.sourceTimeZone });
    } catch {
      throw new OpsError(`"${patch.sourceTimeZone}" is not a time zone this server recognises.`);
    }
  }

  if (patch.enabled && !isSantaCruzOutboundConfigured) {
    throw new OpsError(
      "There is no SANTACRUZ_API_KEY set in Railway, so there is nothing to connect with yet.",
      409
    );
  }

  const [row] = await db
    .update(santacruzConnection)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(santacruzConnection.id, SINGLETON))
    .returning();
  return row;
}

export async function listMapping(): Promise<FieldMapping[]> {
  const rows = await db
    .select({
      sourceColumn: santacruzFieldMap.sourceColumn,
      targetField: santacruzFieldMap.targetField,
      note: santacruzFieldMap.note,
    })
    .from(santacruzFieldMap);
  // Ordered the way the fields are listed on screen rather than by insertion,
  // so the mapping table reads in the same order every time it is opened.
  const order = new Map(TARGET_FIELDS.map((f, i) => [f.name, i]));
  return rows.sort((a, b) => (order.get(a.targetField) ?? 99) - (order.get(b.targetField) ?? 99));
}

/**
 * Replace the whole mapping in one go.
 *
 * All of it at once rather than row by row, because the rules that make a
 * mapping valid — one column per field, one field per column — are about the
 * set and cannot be checked a row at a time.
 */
export async function replaceMapping(rows: FieldMapping[]): Promise<FieldMapping[]> {
  const seenTargets = new Set<string>();
  const seenColumns = new Set<string>();

  for (const row of rows) {
    const column = row.sourceColumn?.trim();
    if (!column) throw new OpsError("A mapping row needs the name of a SantaCruz column.");
    if (!isTargetField(row.targetField)) {
      throw new OpsError(
        `"${row.targetField}" is not a field Adam has. A mapping pointing nowhere would look set up and do nothing.`
      );
    }
    if (seenTargets.has(row.targetField)) {
      throw new OpsError(
        `Two columns are both mapped to ${row.targetField}. Which one wins would be a coin toss, so pick one.`
      );
    }
    if (seenColumns.has(column)) {
      throw new OpsError(`"${column}" is mapped twice. One of theirs feeds one of ours.`);
    }
    seenTargets.add(row.targetField);
    seenColumns.add(column);
  }

  return db.transaction(async (tx) => {
    await tx.delete(santacruzFieldMap);
    if (rows.length > 0) {
      await tx.insert(santacruzFieldMap).values(
        rows.map((r) => ({ sourceColumn: r.sourceColumn.trim(), targetField: r.targetField }))
      );
    }
    const saved = await tx
      .select({
        sourceColumn: santacruzFieldMap.sourceColumn,
        targetField: santacruzFieldMap.targetField,
      })
      .from(santacruzFieldMap);
    return saved;
  });
}

export interface ImportOutcome {
  importId: string;
  rowsSeen: number;
  rowsImported: number;
  rowsRejected: number;
  /** Their columns that no mapping mentions, across the whole file. */
  unmappedColumns: string[];
}

/**
 * Run one import.
 *
 * Rows in, bookings out, and a full account of everything that did not make
 * it. A row is matched on their own id, so running the same file twice updates
 * rather than duplicates — which is what makes this safe to re-run while a
 * mapping is being got right.
 */
export async function runImport(params: {
  source: "FILE" | "API";
  label?: string | null;
  rows: SourceRow[];
  actor?: { userId: string | null; name: string } | null;
}): Promise<ImportOutcome> {
  const mapping = await listMapping();
  const mapped = new Set(mapping.map((m) => m.targetField));
  const missing = REQUIRED_FIELDS.filter((f) => !mapped.has(f));
  if (missing.length > 0) {
    throw new OpsError(
      `Nothing is mapped to ${missing.join(", ")} yet. Finish the mapping before importing, or every row would be refused for the same reason.`,
      409
    );
  }

  const { sourceTimeZone } = await getConnection();

  const [run] = await db
    .insert(santacruzImports)
    .values({
      source: params.source,
      label: params.label ?? null,
      rowsSeen: params.rows.length,
      actorUserId: params.actor?.userId ?? null,
      actorName: params.actor?.name ?? null,
    })
    .returning();

  let imported = 0;
  const rejections: (typeof santacruzRejections.$inferInsert)[] = [];
  const unmapped = new Set<string>();

  for (const [i, row] of params.rows.entries()) {
    const outcome = applyMapping(row, mapping, sourceTimeZone);
    for (const c of outcome.unmappedColumns) unmapped.add(c);

    if (!outcome.booking) {
      rejections.push({
        importId: run.id,
        rowNumber: i + 1,
        externalId: typeof row.externalId === "string" ? row.externalId : null,
        reasons: outcome.reasons,
        raw: row,
      });
      continue;
    }

    const b = outcome.booking;
    await db
      .insert(santacruzBookings)
      .values({ ...b, raw: row, importId: run.id, lastSeenAt: new Date() })
      .onConflictDoUpdate({
        target: santacruzBookings.externalId,
        // firstSeenAt is deliberately absent: when we first saw a booking is a
        // fact about us, and re-importing the same file should not rewrite it.
        set: { ...b, raw: row, importId: run.id, lastSeenAt: new Date() },
      });
    imported += 1;
  }

  if (rejections.length > 0) await db.insert(santacruzRejections).values(rejections);

  await db
    .update(santacruzImports)
    .set({
      finishedAt: new Date(),
      rowsImported: imported,
      rowsRejected: rejections.length,
    })
    .where(eq(santacruzImports.id, run.id));

  return {
    importId: run.id,
    rowsSeen: params.rows.length,
    rowsImported: imported,
    rowsRejected: rejections.length,
    unmappedColumns: [...unmapped],
  };
}

export async function listImports(limit = 20) {
  return db.select().from(santacruzImports).orderBy(desc(santacruzImports.startedAt)).limit(limit);
}

export async function listRejections(importId: string) {
  return db
    .select()
    .from(santacruzRejections)
    .where(eq(santacruzRejections.importId, importId))
    .orderBy(santacruzRejections.rowNumber);
}

export async function listBookings(params: { limit?: number; offset?: number } = {}) {
  return db
    .select()
    .from(santacruzBookings)
    .orderBy(desc(santacruzBookings.pickupAt))
    .limit(Math.min(params.limit ?? 100, 500))
    .offset(params.offset ?? 0);
}

/**
 * What Adam knows about one of their bookings — the outbound direction.
 *
 * Their booking details are theirs, so they are not sent back to them. What
 * Adam has that SantaCruz does not is the conversation: the ticket it came in
 * on, who asked, and where the reply has got to. That is the whole of what is
 * useful to hand over, and keeping it to that means this endpoint can never
 * become a second, disagreeing copy of their own data.
 */
export async function bookingForSantaCruz(key: string) {
  const [row] = await db
    .select()
    .from(santacruzBookings)
    .where(
      key.trim() === ""
        ? sql`false`
        : and(
            sql`true`,
            sql`${santacruzBookings.externalId} = ${key} or ${santacruzBookings.reference} = ${key}`
          )
    )
    .limit(1);
  return row ?? null;
}
