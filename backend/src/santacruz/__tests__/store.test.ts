import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import {
  santacruzBookings,
  santacruzConnection,
  santacruzFieldMap,
  santacruzImports,
  santacruzRejections,
} from "../../db/schema";
import {
  connectionStatus,
  getConnection,
  listBookings,
  listMapping,
  listRejections,
  replaceMapping,
  runImport,
  updateConnection,
} from "../store";

const MAP = [
  { sourceColumn: "RES_ID", targetField: "externalId" },
  { sourceColumn: "PU_DATETIME", targetField: "pickupAt" },
  { sourceColumn: "PU_ADDR", targetField: "pickupAddress" },
  { sourceColumn: "PAX_NAME", targetField: "passengerName" },
  { sourceColumn: "BAG_CNT", targetField: "luggageCount" },
];

const row = (over: Record<string, unknown> = {}) => ({
  RES_ID: "SC-1",
  PU_DATETIME: "2026-10-01 09:00",
  PU_ADDR: "245 Park Ave, New York, NY",
  PAX_NAME: "Ana Costa",
  BAG_CNT: "2",
  ...over,
});

beforeEach(async () => {
  await db.delete(santacruzRejections);
  await db.delete(santacruzBookings);
  await db.delete(santacruzImports);
  await db.delete(santacruzFieldMap);
  await db.delete(santacruzConnection);
});

afterAll(async () => {
  await pool.end();
});

describe("the connection, which holds no secrets", () => {
  it("creates itself on first read, switched off", async () => {
    const c = await getConnection();
    expect(c.enabled).toBe(false);
    expect(c.sourceTimeZone).toBe("America/New_York");
  });

  it("reports whether a key exists but never what it is", async () => {
    const status = await connectionStatus();
    expect(status).toHaveProperty("outboundKeySet");
    expect(typeof status.outboundKeySet).toBe("boolean");
    // Nothing on the object may look like a credential.
    expect(JSON.stringify(status)).not.toMatch(/api[_-]?key["\s:]+[A-Za-z0-9]{8}/i);
  });

  it("refuses a time zone the server cannot resolve", async () => {
    await expect(updateConnection({ sourceTimeZone: "Mars/Olympus" })).rejects.toThrow(
      /not a time zone/i
    );
  });

  it("will not be switched on with no key to connect with", async () => {
    await expect(updateConnection({ enabled: true })).rejects.toThrow(/SANTACRUZ_API_KEY/);
  });

  it("says which required fields are still unmapped", async () => {
    const status = await connectionStatus();
    expect(status.missingRequired).toContain("externalId");
    expect(status.readyForFileImport).toBe(false);
  });
});

describe("the mapping", () => {
  it("saves and reads back", async () => {
    await replaceMapping(MAP);
    const saved = await listMapping();
    expect(saved).toHaveLength(MAP.length);
    expect(saved.map((m) => m.targetField)).toContain("pickupAt");
  });

  it("refuses two of their columns feeding one of ours", async () => {
    await expect(
      replaceMapping([...MAP, { sourceColumn: "PICKUP_2", targetField: "pickupAt" }])
    ).rejects.toThrow(/both mapped to pickupAt/);
  });

  it("refuses one of their columns feeding two of ours", async () => {
    await expect(
      replaceMapping([...MAP, { sourceColumn: "RES_ID", targetField: "reference" }])
    ).rejects.toThrow(/mapped twice/);
  });

  it("refuses a field Adam does not have", async () => {
    await expect(
      replaceMapping([{ sourceColumn: "X", targetField: "wibble" }])
    ).rejects.toThrow(/not a field Adam has/);
  });

  it("leaves the old mapping alone when the new one is refused", async () => {
    await replaceMapping(MAP);
    await expect(
      replaceMapping([{ sourceColumn: "X", targetField: "wibble" }])
    ).rejects.toThrow();
    expect(await listMapping()).toHaveLength(MAP.length);
  });
});

describe("importing", () => {
  it("refuses to run at all while a required field is unmapped", async () => {
    await replaceMapping(MAP.filter((m) => m.targetField !== "externalId"));
    await expect(runImport({ source: "FILE", rows: [row()] })).rejects.toThrow(/externalId/);
  });

  it("imports a good row and records the run", async () => {
    await replaceMapping(MAP);
    const out = await runImport({ source: "FILE", label: "sample.csv", rows: [row()] });
    expect(out.rowsImported).toBe(1);
    expect(out.rowsRejected).toBe(0);

    const [booking] = await listBookings();
    expect(booking.externalId).toBe("SC-1");
    expect(booking.passengerName).toBe("Ana Costa");
    expect(booking.luggageCount).toBe(2);
    // 09:00 New York in October is EDT, four hours behind UTC.
    expect(booking.pickupAt!.toISOString()).toBe("2026-10-01T13:00:00.000Z");
  });

  it("keeps their row whole, including columns nothing is mapped to", async () => {
    await replaceMapping(MAP);
    const out = await runImport({ source: "FILE", rows: [row({ THEIR_ODD_COLUMN: "keep me" })] });
    expect(out.unmappedColumns).toContain("THEIR_ODD_COLUMN");
    const [booking] = await listBookings();
    expect((booking.raw as Record<string, unknown>).THEIR_ODD_COLUMN).toBe("keep me");
  });

  it("updates rather than duplicates when the same file is imported twice", async () => {
    await replaceMapping(MAP);
    await runImport({ source: "FILE", rows: [row()] });
    await runImport({ source: "FILE", rows: [row({ PAX_NAME: "Ana Costa-Silva" })] });

    const all = await listBookings();
    expect(all).toHaveLength(1);
    expect(all[0].passengerName).toBe("Ana Costa-Silva");
  });

  it("does not rewrite when we first saw a booking", async () => {
    await replaceMapping(MAP);
    await runImport({ source: "FILE", rows: [row()] });
    const first = (await listBookings())[0].firstSeenAt;
    await new Promise((r) => setTimeout(r, 15));
    await runImport({ source: "FILE", rows: [row({ PAX_NAME: "Changed" })] });
    const again = (await listBookings())[0];
    expect(again.firstSeenAt.getTime()).toBe(first.getTime());
    expect(again.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });

  it("refuses a bad row, keeps it whole, and says why", async () => {
    await replaceMapping(MAP);
    const out = await runImport({
      source: "FILE",
      rows: [row(), row({ RES_ID: "SC-2", PU_DATETIME: "whenever" })],
    });
    expect(out.rowsImported).toBe(1);
    expect(out.rowsRejected).toBe(1);

    const [rejected] = await listRejections(out.importId);
    expect(rejected.rowNumber).toBe(2);
    expect(rejected.reasons.join(" ")).toMatch(/not a date and time/);
    // The row survives being refused, so nothing has to be re-exported.
    expect((rejected.raw as Record<string, unknown>).RES_ID).toBe("SC-2");
  });

  it("lets one bad row through without taking the good ones with it", async () => {
    await replaceMapping(MAP);
    const out = await runImport({
      source: "FILE",
      rows: [row({ RES_ID: "A" }), row({ RES_ID: "B", PU_ADDR: "" }), row({ RES_ID: "C" })],
    });
    expect(out.rowsImported).toBe(2);
    expect(out.rowsRejected).toBe(1);
    expect((await listBookings()).map((b) => b.externalId).sort()).toEqual(["A", "C"]);
  });

  it("never turns an absent bag count into nought, end to end", async () => {
    await replaceMapping(MAP);
    await runImport({ source: "FILE", rows: [row({ BAG_CNT: "" })] });
    const [booking] = await listBookings();
    expect(booking.luggageCount).toBeNull();
  });
});
