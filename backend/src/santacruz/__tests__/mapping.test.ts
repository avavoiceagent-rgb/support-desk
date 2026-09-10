import { describe, it, expect } from "vitest";
import { applyMapping, type FieldMapping } from "../mapping";

const ZONE = "America/New_York";

/** A mapping that covers everything, so each test can break one thing. */
const FULL: FieldMapping[] = [
  { sourceColumn: "RES_ID", targetField: "externalId" },
  { sourceColumn: "RES_NO", targetField: "reference" },
  { sourceColumn: "PU_DATETIME", targetField: "pickupAt" },
  { sourceColumn: "PU_ADDR", targetField: "pickupAddress" },
  { sourceColumn: "DO_ADDR", targetField: "dropoffAddress" },
  { sourceColumn: "PAX_NAME", targetField: "passengerName" },
  { sourceColumn: "PAX_CNT", targetField: "passengerCount" },
  { sourceColumn: "BAG_CNT", targetField: "luggageCount" },
  { sourceColumn: "TOTAL", targetField: "priceCents" },
];

const ROW = {
  RES_ID: "SC-90001",
  RES_NO: "10432",
  PU_DATETIME: "2026-03-14 15:30",
  PU_ADDR: "245 Park Ave, New York, NY 10167",
  DO_ADDR: "JFK Terminal 4",
  PAX_NAME: "Priya Raman",
  PAX_CNT: "3",
  BAG_CNT: "2",
  TOTAL: "$1,234.56",
};

describe("a row that maps cleanly", () => {
  it("reads every field", () => {
    const { booking, reasons } = applyMapping(ROW, FULL, ZONE);
    expect(reasons).toEqual([]);
    expect(booking).not.toBeNull();
    expect(booking!.externalId).toBe("SC-90001");
    expect(booking!.reference).toBe("10432");
    expect(booking!.passengerCount).toBe(3);
    expect(booking!.luggageCount).toBe(2);
    // 15:30 in New York in March is EDT, four hours behind UTC.
    expect(booking!.pickupAt!.toISOString()).toBe("2026-03-14T19:30:00.000Z");
  });

  it("reads money as whole cents", () => {
    const { booking } = applyMapping(ROW, FULL, ZONE);
    expect(booking!.priceCents).toBe(123456);
  });

  it("names their columns that nothing is mapped to", () => {
    const { unmappedColumns } = applyMapping({ ...ROW, WEIRD_COL: "x", ANOTHER: 1 }, FULL, ZONE);
    expect(unmappedColumns).toEqual(["WEIRD_COL", "ANOTHER"]);
  });
});

describe("what it refuses rather than guesses", () => {
  it("does not turn a missing bag count into nought", () => {
    // The rule that reaches a driver: "3 passengers, 0 bags" when nobody said
    // 0 is an invented fact, and this is the same fact one system earlier.
    const { booking, reasons } = applyMapping({ ...ROW, BAG_CNT: "" }, FULL, ZONE);
    expect(reasons).toEqual([]);
    expect(booking!.luggageCount).toBeNull();
    expect(booking!.luggageCount).not.toBe(0);
  });

  it("refuses a row whose required column is absent", () => {
    const row = { ...ROW } as Record<string, unknown>;
    delete row.RES_ID;
    const { booking, reasons } = applyMapping(row, FULL, ZONE);
    expect(booking).toBeNull();
    expect(reasons.join(" ")).toContain("RES_ID");
  });

  it("refuses a required column that is present but empty", () => {
    const { booking, reasons } = applyMapping({ ...ROW, PU_ADDR: "   " }, FULL, ZONE);
    expect(booking).toBeNull();
    expect(reasons.join(" ")).toContain("pickupAddress");
  });

  it("refuses a pickup time it cannot read", () => {
    const { booking, reasons } = applyMapping({ ...ROW, PU_DATETIME: "next Tuesday-ish" }, FULL, ZONE);
    expect(booking).toBeNull();
    expect(reasons.join(" ")).toContain("not a date and time we can read");
  });

  it("refuses a price that is not an amount", () => {
    const { booking, reasons } = applyMapping({ ...ROW, TOTAL: "about two hundred" }, FULL, ZONE);
    expect(booking).toBeNull();
    expect(reasons.join(" ")).toContain("not an amount we can bill");
  });

  it("refuses a passenger count that is not a whole number", () => {
    const { booking, reasons } = applyMapping({ ...ROW, PAX_CNT: "2.5" }, FULL, ZONE);
    expect(booking).toBeNull();
    expect(reasons.join(" ")).toContain("whole number");
  });

  it("refuses a mapping that points at a field Adam does not have", () => {
    const bent = [...FULL, { sourceColumn: "MYSTERY", targetField: "wibble" }];
    const { booking, reasons } = applyMapping({ ...ROW, MYSTERY: "x" }, bent, ZONE);
    expect(booking).toBeNull();
    expect(reasons.join(" ")).toContain("not a field Adam has");
  });

  it("refuses when nothing at all is mapped to a required field", () => {
    const short = FULL.filter((m) => m.targetField !== "externalId");
    const { booking, reasons } = applyMapping(ROW, short, ZONE);
    expect(booking).toBeNull();
    expect(reasons.join(" ")).toContain("externalId");
  });

  it("collects every reason at once, not just the first", () => {
    const row = { ...ROW, PU_DATETIME: "rubbish", TOTAL: "rubbish", PAX_CNT: "rubbish" };
    const { reasons } = applyMapping(row, FULL, ZONE);
    expect(reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe("time zones, which is where a mirror quietly goes wrong", () => {
  it("honours a zone their data carries itself", () => {
    const { booking } = applyMapping({ ...ROW, PU_DATETIME: "2026-03-14T15:30:00Z" }, FULL, ZONE);
    expect(booking!.pickupAt!.toISOString()).toBe("2026-03-14T15:30:00.000Z");
  });

  it("reads a bare wall clock in the zone the connection names", () => {
    const ny = applyMapping(ROW, FULL, "America/New_York").booking!;
    const la = applyMapping(ROW, FULL, "America/Los_Angeles").booking!;
    expect(ny.pickupAt!.toISOString()).toBe("2026-03-14T19:30:00.000Z");
    expect(la.pickupAt!.toISOString()).toBe("2026-03-14T22:30:00.000Z");
  });

  it("refuses a wall clock that does not exist because the clocks went forward", () => {
    // 02:30 on 8 March 2026 never happens in New York.
    const { booking, reasons } = applyMapping({ ...ROW, PU_DATETIME: "2026-03-08 02:30" }, FULL, ZONE);
    expect(booking).toBeNull();
    expect(reasons.join(" ")).toContain("clocks moved");
  });

  it("refuses a wall clock that happens twice because the clocks went back", () => {
    // 01:30 on 1 November 2026 comes round twice, and which is meant is not
    // in the data. An hour out on an airport pickup misses the flight.
    const { booking, reasons } = applyMapping({ ...ROW, PU_DATETIME: "2026-11-01 01:30" }, FULL, ZONE);
    expect(booking).toBeNull();
    expect(reasons.join(" ")).toContain("happens twice");
  });

  it("leaves ordinary times either side of a change alone", () => {
    for (const t of ["2026-03-08 01:30", "2026-03-08 03:30", "2026-11-01 00:30", "2026-11-01 02:30"]) {
      const { booking, reasons } = applyMapping({ ...ROW, PU_DATETIME: t }, FULL, ZONE);
      expect(reasons, `${t} should be readable`).toEqual([]);
      expect(booking!.pickupAt).toBeInstanceOf(Date);
    }
  });
});
