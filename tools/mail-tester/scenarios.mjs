// The scenarios worth testing, and what each one is meant to prove.
//
// Every scenario here exists because some rule in the app can only be checked
// by a real email arriving through Gmail: the triage queue, the sub-label, the
// questions Adam asks, the warnings he keeps to himself. `check` is the list a
// person reads afterwards to decide whether the system got it right — it is
// not asserted automatically, because the judgement is about English, not
// values.
//
// Dates are computed at send time so a scenario never quietly becomes a
// request for a date in the past.

/** A weekday date in the future, written the way a customer would write it. */
function futureDate(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/New_York",
  }).format(d);
  return parts; // e.g. "Wednesday 30 September"
}

const NEAR = futureDate(9);
const MID = futureDate(12);
const FAR = futureDate(16);

export const scenarios = [
  {
    id: "new-internal",
    title: "New reservation, inside the service area",
    subject: `Car to JFK on ${NEAR.split(" ").slice(1).join(" ")}`,
    body: `Hi,

I need a car on ${NEAR}. Pickup from 245 Park Avenue, Manhattan, then on to JFK Terminal 4.
Flight to Paris at 7pm.
Two of us, two suitcases.

Regards,
Daniel Weiss
+1 917 555 0134`,
    check: [
      "Queue: Reservation / New reservation / INTERNAL",
      'Confirms "Passenger and booker: Daniel Weiss, travelling with 1 other"',
      'Does NOT ask "are you travelling yourself" — the email said "two of us"',
      "Suggests a pickup time roughly 3h before 7pm plus the drive (international rule)",
      "Recommends a Sedan (2 passengers, 2 bags)",
      "Still asks for the flight number",
    ],
  },
  {
    id: "new-external",
    title: "New reservation, outside the service area",
    subject: "Airport transfer — JFK to Philadelphia",
    body: `Hello,

Do you cover a run from JFK Terminal 4 to the Sheraton Philadelphia Downtown on ${MID}? Flight lands 14:20.
Three passengers, four bags.

Many thanks,
Priya Raman
+1 646 555 0188`,
    check: [
      "Queue: Reservation / New reservation / EXTERNAL (crosses into PA)",
      'Internal note warns the trip must be "covered by a partner"',
      "The draft does NOT promise a vehicle",
      "Recommends an SUV (3 passengers, 4 bags)",
      "Asks for the flight number so the driver can track the landing",
    ],
  },
  {
    id: "arrival",
    title: "Airport pickup — arrival, no flight number given",
    subject: "Pickup from Newark next week",
    body: `Hi there,

Could you collect me at Newark airport terminal B on ${NEAR} at around 4pm and take me to 245 Park Avenue, Manhattan?
Just me, one small case.

Best,
Tomás Oliveira`,
    check: [
      "Queue: Reservation / New reservation / INTERNAL",
      '"collect me" and "just me" should mean it does NOT ask who is travelling',
      "Asks for the flight number so the driver can track the landing",
      "Asks for a contact number — the email gives none",
      "Recommends a Sedan",
    ],
  },
  {
    id: "for-someone-else",
    title: "Booking on behalf of a client",
    subject: "Car needed for our client",
    body: `Good afternoon,

I am arranging a car for our client, Ms Ana Costa, on ${MID}. Pickup 10:30am from the Trump Building, 40 Wall Street, drop-off at LaGuardia.
She has two bags.

Kind regards,
Helen Brooks
Executive Assistant
+1 212 555 0177`,
    check: [
      "Confirms Booker: Helen Brooks AND Passenger: Ana Costa separately",
      'Does NOT assume Helen travels — "for our client" is the negative guard',
      "Asks for a mobile number for the passenger, not just the booker",
      "Asks whether the flight is domestic or international, and for the flight time",
    ],
  },
  {
    id: "vague",
    title: "Barely any detail — the test of not inventing",
    subject: "Car on Friday",
    body: `Hi, I need a car on Friday morning. Can you help?

Thanks,
Marcus`,
    check: [
      "Asks for pickup address, drop-off address, and a time",
      "Asks how many passengers and bags, quoting sedan/SUV capacities",
      "Asks for a contact number",
      "Invents NOTHING — no addresses, no times, no vehicle stated as fact",
    ],
  },
  {
    id: "too-late",
    title: "Requested pickup is too late for the flight",
    subject: `International flight ${FAR.split(" ").slice(1).join(" ")}`,
    body: `Hello,

Flight to London departs 6pm on ${FAR} from JFK Terminal 4. I'd like the pickup at 3pm please, from 245 Park Avenue, Manhattan.
Two of us, three bags.

Regards,
Daniel Weiss
+1 917 555 0134`,
    check: [
      "INTERNAL NOTE (amber, not sent) says the requested pickup is too late for the 180-minute rule",
      "The note names the shortfall in minutes and suggests an earlier pickup",
      "The customer-facing draft suggests the earlier time politely, without scolding",
    ],
  },
  {
    id: "change",
    title: "Change to an existing booking",
    subject: "Change to tomorrow's pickup",
    body: `Hi,

Could we move tomorrow morning's 9am pickup to 10am instead? Same addresses, same passenger.

Thanks,
Daniel Weiss`,
    check: [
      "Queue: Reservation, sub-label CHANGE TO EXISTING (not New reservation)",
      "No drafted reply — Adam only drafts for new reservations",
    ],
    /**
     * The same request, naming a booking that really exists.
     *
     * The version above is deliberately vague, which tests the triage and
     * nothing else. Quoting a live reference also exercises the lookup and
     * the "On file for this sender" panel, and it is what a real customer
     * writes once they have been given a number.
     *
     *     node send.mjs change --ref T-10308
     *
     * The time is left as "an hour later" rather than a clock time on
     * purpose: this file does not know when the booking is, and inventing a
     * time would produce a test email that contradicts the booking it names.
     */
    withRef: (ref) => ({
      subject: `Change to booking ${ref}`,
      body: `Hi,

Could we move ${ref} an hour later than planned? Same pickup and drop-off.

Also a colleague is now joining me, so that is three of us with three suitcases.

Thanks,
Daniel Weiss
+1 917 555 0134`,
      check: [
        "Queue: Reservation, sub-label CHANGE TO EXISTING (not New reservation)",
        "No drafted reply — Adam only drafts for new reservations",
        `"On file for this sender" lists ${ref}, tagged "Named in this email"`,
        "The booking itself is NOT moved — a person makes the change in Operations",
        "After editing it there, the History column on that row names who changed what",
      ],
    }),
  },
  {
    id: "accounting",
    title: "An invoice question",
    subject: "Query on invoice 10432",
    body: `Hello,

Invoice 10432 appears to charge twice for the same journey on the 4th. Could someone check it?

Thanks,
Helen Brooks
Accounts Payable`,
    check: [
      "Queue: Accounting",
      "No reservation sub-labels",
      "No drafted reply",
    ],
  },
  {
    id: "on-file",
    title: "Quotes a booking and an invoice we already have",
    subject: "Change to booking T-10005",
    body: `Hi,

Could we move booking T-10005 an hour later than planned?

Separately, invoice 10032 looks like it charges twice for the same journey — could someone check it?

One more: what happened with T-99999? I can't find it in my records.

Regards,
Daniel Weiss
+1 917 555 0134`,
    check: [
      'The "On file for this sender" panel appears above the conversation',
      'T-10005 and INV-10032 are listed, both tagged "Named in this email"',
      "The invoice shows its line and, if it is one of the disputed ones, the dispute note",
      "T-99999 appears in the amber line as quoted but matching nothing",
      "Nothing from the panel appears in any drafted reply — it is staff-only",
      "Requires the operational tables to be seeded first, or the panel stays hidden",
    ],
  },
  {
    id: "newsletter",
    title: "Bulk marketing mail",
    subject: "🚗 Your September fleet newsletter is here!",
    body: `See what's new this month — special rates, new vehicles, and more.

Unsubscribe at any time: https://example.com/unsubscribe`,
    headers: {
      "List-Unsubscribe": "<https://example.com/unsubscribe>",
      Precedence: "bulk",
    },
    check: [
      "Lands in Automated, NOT in Active",
      "Auto-closed on arrival, so it never counts against the SLA",
      "No drafted reply",
    ],
  },
];

export function findScenario(id) {
  return scenarios.find((s) => s.id === id) ?? null;
}
