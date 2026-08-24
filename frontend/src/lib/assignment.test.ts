import { describe, it, expect } from "vitest";
import { handoverNote, withDriver, withPartner, type Assignment } from "./assignment";

const both: Assignment = { driverId: "d1", vehicleId: "v1", affiliateId: "a1" };
const inHouse: Assignment = { driverId: "d1", vehicleId: "v1", affiliateId: "" };
const farmedOut: Assignment = { driverId: "", vehicleId: "", affiliateId: "a1" };
const nobody: Assignment = { driverId: "", vehicleId: "", affiliateId: "" };

describe("withPartner", () => {
  it("takes the job off our driver and our car", () => {
    // The backend does exactly this to the record. The form used to send both
    // and get refused at the last moment instead.
    expect(withPartner(inHouse, "a2")).toEqual({ driverId: "", vehicleId: "", affiliateId: "a2" });
  });

  it("leaves the car free rather than out on a job it is not doing", () => {
    // A vehicle left attached still reads as busy on the schedule board.
    expect(withPartner(inHouse, "a2").vehicleId).toBe("");
  });

  it("clearing the partner does not touch anything else", () => {
    expect(withPartner(farmedOut, "")).toEqual(nobody);
    expect(withPartner(inHouse, "")).toEqual(inHouse);
  });
});

describe("withDriver", () => {
  it("brings the job back in-house", () => {
    expect(withDriver(farmedOut, "d2")).toEqual({ driverId: "d2", vehicleId: "", affiliateId: "" });
  });

  it("keeps the car that was already chosen", () => {
    // Changing driver is not a reason to unpick the car; they may well be
    // taking the same one.
    expect(withDriver(inHouse, "d2").vehicleId).toBe("v1");
  });

  it("unassigning is not the same as handing over", () => {
    // "Unassigned" means nobody has it yet, not that the partner lost it.
    expect(withDriver(farmedOut, "")).toEqual(farmedOut);
  });

  it("still fixes a record that somehow has both", () => {
    expect(withDriver(both, "d2").affiliateId).toBe("");
    expect(withPartner(both, "a2").driverId).toBe("");
  });
});

describe("handoverNote", () => {
  it("says who currently has it", () => {
    expect(handoverNote(inHouse, { driver: "Hector Alvarez" })).toContain("Hector Alvarez");
    expect(handoverNote(farmedOut, { partner: "Metro Overflow Group" })).toContain(
      "Metro Overflow Group"
    );
  });

  it("says nothing when nobody has it", () => {
    expect(handoverNote(nobody, {})).toBeNull();
  });

  it("says nothing rather than naming somebody we cannot name", () => {
    // A deleted driver, or a list that has not loaded. "With undefined" is
    // worse than silence.
    expect(handoverNote(inHouse, {})).toBeNull();
  });
});
