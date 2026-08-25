import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import {
  affiliates,
  affiliateZones,
  dispatchMessages,
  driverShifts,
  drivers,
  invoiceLines,
  invoices,
  tripEvents,
  trips,
  users,
  vehicles,
} from "../../db/schema";
import {
  awardQuote,
  describeQuoteRequest,
  quotesForTrip,
  recordQuote,
  requestQuotes,
  respondToOffer,
  sendOffer,
} from "../dispatch";
import { selectTrips, toTripRecord } from "../lookup";

const NOW = new Date("2026-09-24T13:00:00.000Z");
const DESK = { userId: null, name: "Amar Pant" };

afterAll(async () => {
  await pool.end();
});

async function reset() {
  await db.delete(dispatchMessages);
  await db.delete(affiliateZones);
  await db.delete(tripEvents);
  await db.delete(invoiceLines);
  await db.delete(invoices);
  await db.delete(trips);
  await db.delete(driverShifts);
  await db.delete(drivers);
  await db.delete(affiliates);
  await db.delete(vehicles);
  await db.delete(users);
}
beforeEach(reset);

async function makePartner(company: string, active = true) {
  const [a] = await db
    .insert(affiliates)
    .values({
      company,
      phone: "+1 215 555 0100",
      email: `${company.replace(/\W/g, "").toLowerCase()}@partner.example`,
      active,
    })
    .returning();
  return a;
}

/** Philadelphia — out of NY/NJ, which is why it needs a partner at all. */
async function makeExternalTrip(over: Partial<typeof trips.$inferInsert> = {}) {
  const [t] = await db
    .insert(trips)
    .values({
      reference: "T-10432",
      passengerName: "Ana Costa",
      pickupAddress: "230 Park Ave, New York, NY 10169",
      dropoffAddress: "1 Liberty Pl, Philadelphia, PA 19103",
      pickupAt: NOW,
      bookedHours: 4,
      vehicleClass: "SEDAN",
      passengerCount: 2,
      luggageCount: 2,
      ...over,
    })
    .returning();
  return t;
}

const record = async (id: string) =>
  toTripRecord((await selectTrips().where(eq(trips.id, id)).limit(1))[0]);

describe("asking partners what they charge", () => {
  it("sends the reservation and no price at all", async () => {
    const trip = await makeExternalTrip();
    const text = describeQuoteRequest(await record(trip.id));

    expect(text).toContain("1 Liberty Pl, Philadelphia");
    expect(text).toContain("reply with your price");
    // We do not know what this costs yet. That is the whole point.
    expect(text).not.toMatch(/\$\d/);
  });

  it("asks several at once", async () => {
    const trip = await makeExternalTrip();
    const [a, b, c] = await Promise.all([
      makePartner("Liberty Bell Executive"),
      makePartner("Keystone Cars"),
      makePartner("Delaware Valley Livery"),
    ]);

    const out = await requestQuotes({
      tripId: trip.id,
      affiliateIds: [a.id, b.id, c.id],
      actor: DESK,
    });

    expect(out.sent).toHaveLength(3);
    expect(out.refused).toEqual([]);
    expect((await quotesForTrip(trip.id)).map((q) => q.company).sort()).toEqual([
      "Delaware Valley Livery",
      "Keystone Cars",
      "Liberty Bell Executive",
    ]);
  });

  it("still reaches the others when one partner has been deactivated", async () => {
    // The panel was drawn before somebody retired them. Losing the whole
    // request over it would cost the desk a round trip on a same-day job.
    const trip = await makeExternalTrip();
    const live = await makePartner("Liberty Bell Executive");
    const gone = await makePartner("Keystone Cars", false);

    const out = await requestQuotes({
      tripId: trip.id,
      affiliateIds: [live.id, gone.id],
      actor: DESK,
    });

    expect(out.sent).toHaveLength(1);
    expect(out.refused[0].reason).toContain("deactivated");
  });

  it("will not ask about a cancelled job", async () => {
    const trip = await makeExternalTrip({ status: "CANCELLED" });
    const a = await makePartner("Liberty Bell Executive");
    await expect(
      requestQuotes({ tripId: trip.id, affiliateIds: [a.id], actor: DESK })
    ).rejects.toThrow(/cancelled/i);
  });
});

describe("a partner's price coming back", () => {
  async function asked() {
    const trip = await makeExternalTrip();
    const partner = await makePartner("Liberty Bell Executive");
    const { sent } = await requestQuotes({
      tripId: trip.id,
      affiliateIds: [partner.id],
      actor: DESK,
    });
    return { trip, partner, request: sent[0] };
  }

  it("records the money and works out what the customer pays", async () => {
    const { trip, request } = await asked();
    await recordQuote({ requestId: request.id, amountCents: 21_000, actor: DESK });

    const [quote] = await quotesForTrip(trip.id);
    expect(quote.amountCents).toBe(21_000);
    // 25% on top, the figure Amar set.
    expect(quote.customerCents).toBe(26_250);
    expect(quote.awarded).toBe(false);
  });

  it("refuses a quote with no price", async () => {
    // This number becomes what a customer is charged. "About two hundred" is
    // a conversation, and sendText already exists for those.
    const { request } = await asked();
    await expect(
      recordQuote({ requestId: request.id, amountCents: 0, actor: DESK })
    ).rejects.toThrow(/needs a price/i);
  });

  it("takes one price per request and no more", async () => {
    const { request } = await asked();
    await recordQuote({ requestId: request.id, amountCents: 21_000, actor: DESK });
    await expect(
      recordQuote({ requestId: request.id, amountCents: 19_000, actor: DESK })
    ).rejects.toThrow(/already quoted/i);
  });

  it("says who typed it, because no real partner is on the other end yet", async () => {
    const { request } = await asked();
    const quote = await recordQuote({ requestId: request.id, amountCents: 21_000, actor: DESK });
    expect(quote.direction).toBe("IN");
    expect(quote.actedByName).toBe("Amar Pant");
  });
});

describe("awarding the job", () => {
  async function quoted(cents = 21_000) {
    const trip = await makeExternalTrip();
    const partner = await makePartner("Liberty Bell Executive");
    const { sent } = await requestQuotes({
      tripId: trip.id,
      affiliateIds: [partner.id],
      actor: DESK,
    });
    const quote = await recordQuote({ requestId: sent[0].id, amountCents: cents, actor: DESK });
    return { trip, partner, quote };
  }

  it("offers them the job at the price they gave, and writes both sides onto it", async () => {
    const { trip, quote } = await quoted();
    const { offer, trip: after } = await awardQuote({ quoteId: quote.id, actor: DESK });

    expect(offer.kind).toBe("OFFER");
    expect(offer.body).toContain("$210.00");
    expect(after.partnerQuoteCents).toBe(21_000);
    expect(after.customerPriceCents).toBe(26_250);
    // Awarding is not assigning. A price given on Tuesday is not a promise the
    // car is still free on Thursday.
    expect(after.affiliateId).toBeNull();
    expect((await quotesForTrip(trip.id))[0].awarded).toBe(true);
  });

  it("only assigns the partner once they accept", async () => {
    const { trip, partner, quote } = await quoted();
    const { offer } = await awardQuote({ quoteId: quote.id, actor: DESK });

    await respondToOffer({ offerId: offer.id, accept: true, actor: DESK });

    const after = await record(trip.id);
    expect(after.affiliateId).toBe(partner.id);
    expect(after.assignedKind).toBe("AFFILIATE");
    // The money survives the assignment.
    expect(after.customerPriceCents).toBe(26_250);
  });

  it("leaves the price alone when the partner declines", async () => {
    const { trip, quote } = await quoted();
    const { offer } = await awardQuote({ quoteId: quote.id, actor: DESK });
    await respondToOffer({ offerId: offer.id, accept: false, actor: DESK });

    const after = await record(trip.id);
    expect(after.affiliateId).toBeNull();
    // Still what we agreed with them. If the desk goes elsewhere, awarding
    // the next quote overwrites it.
    expect(after.partnerQuoteCents).toBe(21_000);
  });

  it("will not award a job another partner is already holding", async () => {
    const { quote } = await quoted();
    const other = await makePartner("Keystone Cars");
    const [q] = await quotesForTrip(quote.tripId!);
    await db.update(trips).set({ affiliateId: other.id }).where(eq(trips.id, quote.tripId!));

    await expect(awardQuote({ quoteId: q.quoteId!, actor: DESK })).rejects.toThrow(
      /already with Keystone Cars/i
    );
  });

  it("refuses to award something that is not a quote", async () => {
    const { trip } = await quoted();
    const [request] = await db
      .select()
      .from(dispatchMessages)
      .where(eq(dispatchMessages.tripId, trip.id));
    await expect(awardQuote({ quoteId: request.id, actor: DESK })).rejects.toThrow(/not a quote/i);
  });
});

describe("a partner we have already spoken to about this job", () => {
  // T-10315. Metro Overflow Group had been sent two offers before anybody
  // asked them for a price. The board read "has this partner an offer on this
  // trip" as "has this quote been awarded", so the moment they quoted $300 it
  // decided the quote was already taken: no button to accept it, the other
  // partners told the job was gone, and the customer confirmed at the older
  // price because the award that writes $300 onto the trip never ran.
  async function alreadyOffered() {
    const trip = await makeExternalTrip();
    const partner = await makePartner("Metro Overflow Group");
    await sendOffer({
      contact: { kind: "AFFILIATE", id: partner.id },
      tripId: trip.id,
      actor: DESK,
    });
    const { sent } = await requestQuotes({
      tripId: trip.id,
      affiliateIds: [partner.id],
      actor: DESK,
    });
    const quote = await recordQuote({ requestId: sent[0].id, amountCents: 30_000, actor: DESK });
    return { trip, partner, quote };
  }

  it("does not call a quote awarded because an older offer exists", async () => {
    const { trip } = await alreadyOffered();

    const [q] = await quotesForTrip(trip.id);
    expect(q.amountCents).toBe(30_000);
    expect(q.customerCents).toBe(37_500);
    expect(q.awarded).toBe(false);
  });

  it("marks it awarded only once the award actually runs", async () => {
    const { trip, quote } = await alreadyOffered();

    await awardQuote({ quoteId: quote.id, actor: DESK });

    const [q] = await quotesForTrip(trip.id);
    expect(q.awarded).toBe(true);
    // And the money the customer is quoted follows the quote we took, not
    // whatever the trip happened to be carrying before.
    const after = await record(trip.id);
    expect(after.partnerQuoteCents).toBe(30_000);
    expect(after.customerPriceCents).toBe(37_500);
  });

  it("points the offer at the quote it is honouring", async () => {
    const { quote } = await alreadyOffered();
    const { offer } = await awardQuote({ quoteId: quote.id, actor: DESK });
    expect(offer.respondsToId).toBe(quote.id);
  });
});
