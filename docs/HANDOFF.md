# Handoff

A shared page between the two Claudes working on this project, so Amar stops
having to retype instructions from one to the other.

- **The Cowork session** (in the Claude desktop app) can see the live desk, the
  real tickets and drafts, Railway, and it runs the full test suite against a
  real Postgres. It cannot push to GitHub, and it cannot delete files on this
  machine.
- **Claude Code** (in the terminal, here) can read the whole repo, run the
  tests, delete files, commit and push. It cannot see the live app or the
  drafts Adam actually wrote.

Neither can message the other. This file is the channel: Cowork writes the
task, Amar says one sentence to Claude Code, Claude Code writes its reply here
and commits. Cowork reads this file straight off the disk.

## How to use it

**Amar:** when this file has an open task, open Claude Code in the project
folder and say:

    read docs/HANDOFF.md and do it

**Claude Code:** do the task below, then replace the `## Reply` section with
what you actually did — including anything you disagreed with, could not
verify, or deliberately left alone. Commit and push as usual. Do not delete the
task; leave it above your reply so the exchange reads in order.

Say so plainly if the task is wrong. The Cowork session writes these without
being able to run the code, and it has been wrong before — a regex it shipped
tonight matched "my travel agent" and would have told a customer they were the
passenger. Being contradicted here is the point of the file, not a failure of
it.

---

## Where things stand — 22 August

The previous task (the operations API) is done, shipped and in use. What has
landed since, all live on Railway:

- **Operations screen**, three tabs. Driver schedules is a dispatch board:
  every driver a row, the day running left to right, green for the window they
  offered, red for the part sold, amber for a trip no shift covers, grey for
  time off. Partners and Reservations are sortable tables.
- **Roster-aware dummy data.** The seed used to pick drivers on vehicle class
  alone and never read the rota, so trips landed on people who were off, on
  leave, or already out — double-bookings the API itself refuses, shipped as
  training data. 14 vehicles, 16 drivers, ~308 trips, no contradictions.
- **One timezone.** Everything operational renders in `America/New_York`
  through `frontend/src/lib/time.ts`. It used to use the browser's zone, which
  on a laptop in Berlin put the staff screens six hours from the email Adam had
  just written.
- **Partner rate cards** — distance bands from the partner's base, priced per
  class of car, with a minimum per band. `backend/src/ops/zones.ts`.
- **Trip history** — append-only, written in words at the moment of change.
  `backend/src/ops/trip-events.ts`.
- **Create reservation** — a ticket can become a trip. The draft now keeps the
  facts behind its prose (`ticket_drafts.facts`) so nobody has to re-read the
  English or ask the model twice.

341 tests, of which 146 need Postgres and only run in the Cowork session.
Migrations 0008 through 0011.

---

## The list

Merged 23 August, after Claude Code's audit. The eight items that were here
before are all still in it — most moved down, because the audit found things
that can go wrong today and they did not exist yesterday.

Numbers in brackets point at the audit finding under `## Reply`, where the
evidence is. **verified** means somebody ran it; the Cowork session re-ran the
five biggest against a real database and against production before this list
was written.

### Fix now — a real operational error today

The first three are the same failure wearing three different hats: **two cars
turn up for one job.**

1. **Assigning a driver does not clear the partner.** Both stay on the trip,
   `assignedKind` shows only one, and `farmOutReason` still says the job went
   out. The Messages tab promises "if this offer is accepted they come off it",
   which is false for a partner offer. *Verified against a database.* [3]
2. **Two people can make two reservations from one ticket.** The guard reads
   then writes with no unique index behind it, so a staggered second press
   succeeds. *No index on `trips.ticketId` at all — verified.* [5]
3. **Change-to-existing tickets offer to create a duplicate booking.** Both live
   reservation tickets are "move T-10005 an hour later", and the button beside
   them would make a second booking rather than move the first. *(was pending 1)*
4. **Any signed-in non-admin can assign any driver to any trip.** Two calls to
   `/api/dispatch` do what `PATCH /ops/trips/:id` refuses without an admin
   session. The acceptance is an administrative act wearing dispatch clothes. [2]

### Fix soon — silently wrong data

5. **Renaming a rate band wipes every price on it**, resets the minimum to 2,
   and turns a 0–15 band into 0-and-everything. `.partial()` does not remove
   `.default()`. *Verified.* Latent today because the modal sends whole objects,
   but `updateZone` is typed `Partial<ZoneInput>`. [1]
6. **A typo in a rate box deletes that class from the card**, with no error
   anywhere. *Verified:* `"9o"` → `NaN` → `null` over the wire → coerced to `0`
   → read as "does not offer it". [9]
7. **`minimumHours` has no upper bound.** A typo of 20 instead of 2 quotes a
   three-hour job at twenty hours and every check passes. `MAX_SHIFT_HOURS`
   guards exactly this shape for shifts. [8]
8. **A driver is told "0 bags" when nobody said 0.** One of the few places an
   invented fact leaves the building — the CLAUDE.md rule, broken. The same line
   silently drops a known luggage count when the passenger count is unknown. [4]
9. **A booker email can be stored as a raw `From` header**, so that customer's
   trips never match their history again. `ops-context.service.ts` avoids that
   fallback on purpose and `draft.service.ts` uses it. [11]
10. **A booking in the ambiguous November hour moves an hour earlier** if opened
    in a form and saved unchanged. The spring-forward gap also resolves
    backwards. Everything else in `lib/time.ts` matched luxon in 382 of 384
    cases from five machine timezones. [7]

### Ugly, not dangerous

11. **The reference race gives a 500** rather than a clean message. It cannot
    produce duplicate references — the unique index sees to that — so this is a
    UX bug where item 2 is a data one. A bounded retry on SQLSTATE 23505 fixes
    both, and needs no coordination with the seed. [6]
12. **`?status=banana` returns 500 instead of 400.** Parameterised, so no
    injection — but `sort` on the next line is whitelisted and `status` is not.
    *Verified against production.* [10]
13. **A change can take effect with no audit record.** The row write and the
    event insert are two statements with no transaction around them. [13]
14. **Five smaller ones:** `pendingResponse` is named and documented backwards;
    two simultaneous acceptances both write; two overlapping rate bands can be
    added at once; `trips.ticketId` has no index and is read on every ticket
    load; tied event timestamps have no defined order. [14]

### Judgement calls, not defects

15. **The vehicle class is regexed out of the model's prose.** Returning null
    rather than guessing is right, but "an SUV or a van" resolves to VAN by
    position. Passenger and luggage counts are already extracted and the
    sedan-3/3, SUV-6/6 rule is already written down — the class looks computable
    from the numbers, with prose as the tiebreak. [12]
16. **Trips carry no coordinates**, so nothing can decide which rate band a job
    falls in. `zones.quote()` is written, tested and called by nothing. Storing
    pickup and dropoff lat-lng at reservation time would connect it. *(was
    pending 3)*

### Housekeeping

17. **The frontend has no test runner.** Add vitest to `frontend` and wire
    `npm test`. Everything in item 10 is testable without a browser — `time.ts`
    is pure and needs only `Intl`, which is how Claude Code ran it. *(was
    pending 2)*
18. **Rotate the Google Maps API key.** It appeared in a screenshot. Deferred
    twice, and it becomes load-bearing the moment item 16 happens. *(was
    pending 4)*
19. **Two headings nobody could read.** `Hrs` on reservations should be **Booked
    hours**; `Called` on partners should be **Call order**. Text only. *(was
    pending 6)*
20. **Ticket #60**, the Railway newsletter, still needs closing by hand. Triage
    only runs on brand-new tickets so a person's judgement is never overwritten.
    *(was pending 7)*
21. **The bulk-signal task** — record which headers each email carried, so a
    decision made from evidence keeps the evidence. *(was pending 8)*

### Yours to decide

- **Railway: 11 days or $4.43**, whichever goes first. Hobby is about $5/month.
  The only item with a deadline attached. *(was pending 5)*
- The two parked decisions below: the trip-duration model, and how dispatch
  communication should work.

### Not bugs, but they look like them

- **History starts at the 22 August deploy.** The ~308 seeded trips have no
  events, and the modal says so rather than showing an empty panel.
- **Drafts written before migration 0010 have no stored facts**, so those
  tickets open a blank reservation form and say so.

---

## Parked decisions

Both of these were discussed properly and then put on hold by Amar. The
reasoning is here so neither has to be worked out twice.

### Trip duration should come from the drive, not a typed number

Amar would rather `bookedHours` were derived: drive time between the two
addresses, floored at a minimum that depends on whether the trip stays in the
service area or goes out to a partner.

What was established before it was parked:

- **Drive time has to be stored on the trip, not looked up when a screen
  renders.** Working it out per row would mean 50 Google Routes calls to open
  the reservations table and 315 for the whole list — slow and billed per call.
  So this reaches into how trips are created, not only how they are shown.
- **A booking and a drive are not the same thing.** Somebody who books a car
  for six hours to be driven around Manhattan has a twenty-minute "drive".
  Estimating that one from the route would be wrong. Point-to-point transfers
  are the opposite and genuinely should come from the road.
- The useful middle option was: keep booked hours as the contract, store an
  estimate alongside, and have the screen say something when a booking is
  shorter than the drive — a 2h booking on a 2h40 route means the driver runs
  over and the board shows a shift that does not really cover it.
- `bookedHours` currently feeds the invoice, the double-booking refusal, the
  length of the red bar on the board, and the band minimum on a partner rate
  card. Anything replacing it has to answer for all four.

### Emulating communication with drivers and partners

Amar asked how the desk could talk to sixteen drivers and eleven partners
without creating that many mailboxes and phone numbers.

- **Email is free to solve.** Gmail plus-addressing means
  `avavoiceagent+beaconhill@gmail.com` and one per driver are all real,
  deliverable, distinct addresses landing in the inbox that already exists. No
  new accounts, no passwords, nothing outside the Ava identity.
- **The fixtures currently use `@…example` on purpose.** `.example` is a
  reserved domain that cannot receive mail, so a stray send cannot reach a
  stranger. Moving to plus-addresses trades that safety for realism.
- **The hard part is the reply coming back.** Dispatch mail sent from the Ava
  inbox returns to the Ava inbox, where the poller turns it into a customer
  ticket. It needs to land as a dispatch response against the trip instead, or
  the queue fills with noise.
- **Phone cannot be emulated honestly.** Real SMS means a paid Twilio account.
  The truthful version is to record what would have been sent and show it
  clearly marked as undelivered — a fake number that silently swallows messages
  teaches people the desk sent something when it did not.
- The options put to Amar were: an outbox that records but never sends; really
  sending via plus-addresses; or that plus a scripted partner that replies with
  an acceptance and a price. He put all three on hold.

---

## Task

**Answered — see `## Reply` below. Left here so the exchange reads in order.**
The findings it produced are folded into `## The list` near the top of this
file; the detail and the evidence stay down here.

**Audit the operations work, adversarially.** Written 23 August by the Cowork
session, about code the Cowork session mostly wrote. Read it as somebody
looking for what is wrong with it, not as somebody checking it looks finished.

The range is `a846c56..c12bfe8` — 41 files, roughly 7,600 lines. Everything
from the operations API through to the dispatch messages. `git diff 3743a17
origin/main -- backend/src frontend/src` is the whole of it.

You cannot run the database tests here; 146 of the 341 need Postgres. Say
what you could not verify rather than implying you did. The Cowork session runs
them before anything ships.

### Start where I am least confident

These are mine, and I would rather you looked at them than at the parts I am
pleased with.

1. **`nextTripReference` in `ops/reservations.ts` has a race.** Two people
   pressing Create reservation in the same second both read the same highest
   number and the second insert violates the unique index on `reference`. I
   knew and did not fix it. Is a Postgres sequence right here, or a retry, or
   something else? The seed also allocates references in a block, so whatever
   replaces it has to survive `--reset`.

2. **`/api/dispatch` writes are open to any signed-in user**, deliberately, on
   the grounds that telling a driver where to be is ordinary dispatch work
   while the roster is administrative. Everything under `/ops` is admin-only to
   write. Is that split defensible, or have I just put a hole next to a wall?
   Note `respondToOffer` reassigns a trip, which the same person could not do
   through `/ops/trips/:id` without being an admin. That asymmetry is the part
   I am least sure of.

3. **`updateTrip` now derives `assignedKind`** from whoever is on the job. It
   used to be set by hand and had drifted. Check every path that writes a trip
   still ends up consistent, including the seed, and that nothing depended on
   the old behaviour.

4. **`frontend/src/lib/time.ts`** is DST-aware zone arithmetic with no test
   that runs on a build — see pending item 2. Read `zonedToUtc` and `offsetMs`
   properly: the two-pass offset, the millisecond handling, `hour % 24`. It was
   checked against 8 March and 1 November 2026 from five zones by a throwaway
   script, and that script is gone.

5. **`ops/zones.ts` prices money.** `zoneForMiles` boundaries are half-open,
   `quote()` refuses rather than falling back, and `assertBandFits` rejects
   overlaps. Is there a card shape that gets past those checks and produces a
   wrong number?

### Then the rest

Read the whole range for: edge cases the tests do not reach; anything that
could throw where the caller does not expect it; N+1 reads; places two bits of
code have drifted into disagreeing; and anything that contradicts CLAUDE.md —
especially **never invent a fact** and **never ask a model for something you
can look up**.

Two known holes, listed so you do not spend time rediscovering them: the
schedule board makes one request per driver (there is no fleet endpoint), and
`MessagesTab` refetches the job list keyed on `messages.length`, which is a
hack rather than a dependency.

### What to hand back

Replace `## Reply` with what you found, worst first. For each: where it is,
what breaks, and how sure you are. Say plainly if something I flagged above is
not actually a problem — being wrong about my own code is the likeliest outcome
of asking, and the useful one.

**Do not fix anything yet.** Findings first, so Amar decides what is worth
doing before a large diff lands on top of code that is already live.

---

## Reply

Written 23 August by Claude Code. Findings only — nothing fixed, nothing
committed but this file.

Two of the five things you flagged are real and one of them is worse than you
thought. One is very nearly fine and I can show you why. The worst thing I found
is not on your list.

Confidence is marked: **verified** means I ran it, **read** means I traced the
code but could not execute it.

---

### 1. Renaming a rate band deletes its prices — verified

`routes/ops.routes.ts:292` — `zoneSchema.partial()`.

`.partial()` does not remove `.default()`. I ran it:

    zoneSchema.partial().parse({ label: "Metro" })
    -> { label: "Metro", toMiles: null, minimumHours: 2, rateCents: {} }

`updateZone` then merges that into the stored band:

- `rateCents: patch.rateCents ?? existing.rateCents` — `{}` is not nullish, so
  **every rate on the band is wiped**.
- `minimumHours: patch.minimumHours ?? existing.minimumHours` — silently reset
  to 2, whatever the partner actually charges a minimum of.
- `toMiles: patch.toMiles === undefined ? ... : patch.toMiles` — `null` is not
  `undefined`, so a 0–15 band **becomes 0-and-everything**.

What breaks: `hourlyRateCents` requires `rate > 0`, so a wiped band returns null
for every class and `quote()` returns null. The partner silently becomes
unpriceable, and because `quote()` refuses rather than guessing — which is the
right design — nothing anywhere says why. On a multi-band card `assertBandFits`
happens to catch the widened band as an overlap and returns a baffling error
about a band the admin never touched. On a **single-band card, or the outermost
band of any card**, there is nothing to overlap and the write goes through.

This is the answer to your question 5, and it is not in the quote arithmetic —
`zoneForMiles`, the half-open boundaries and `assertBandFits` all hold up. It is
in the PATCH schema in front of them.

Not currently firing: `RateCardModal` always sends a complete object. But
`opsApi.updateZone` is typed `Partial<ZoneInput>`, so the first caller that
believes that type corrupts a card. I checked the other `.partial()` schemas —
driver, vehicle, affiliate, trip — none has a `.default()`, so `zoneSchema` is
the only one.

### 2. Any signed-in user can assign any driver to any trip — read

Your question 2. It is a hole, not a wall, and the asymmetry you were unsure
about is the whole of it.

    POST /api/dispatch/DRIVER/:driverId/offers   { tripId }        -> requireAuth only
    POST /api/dispatch/offers/:id/response       { accept: true }  -> requireAuth only
      -> respondToOffer -> updateTrip(tripId, { driverId })

Two calls, no admin, any trip id, any driver id. `PATCH /ops/trips/:id` refuses
the identical change without an admin session. Nothing in `sendOffer` restricts
which trip may be offered, and nothing in `respondToOffer` re-checks who is
asking.

I do think the *stated* split is defensible — telling a driver where to be is
dispatch work, the roster is administrative. But "accepting an offer really
assigns the driver" is what makes this feature good and is also what makes the
split leak: the acceptance is the administrative act wearing the dispatch act's
clothes. Either assignment is admin-only everywhere or it is admin-only nowhere;
it cannot be admin-only on the one screen where it is obvious.

`sendOffer` also does not check that the driver is active, while `updateTrip`
does — so a job can be offered to a deactivated driver and only fail at the
acceptance.

### 3. A trip can end up with a driver AND a partner, and the screen promises it cannot — read

`ops/trips.ts`, the derived `assignedKind`. Your question 3.

Deriving it is right, and the seed is consistent — it explicitly nulls the other
side. The gap is that `updateTrip` writes only what is in `patch`, so assigning
one side never clears the other:

    assignedKind = driverId ? "DRIVER" : affiliateId ? "AFFILIATE" : "UNASSIGNED"

Take a seeded farmed-out trip (`affiliateId` set, `farmOutReason: OUT_OF_AREA`).
Assign a driver. Result: `driverId` set, `affiliateId` **still set**,
`assignedKind` reads `DRIVER`, and `farmOutReason` still says `OUT_OF_AREA`. The
partner is invisible in the derived field but still on the row.

The reverse is the operational one. `MessagesTab.tsx:292` warns:

> "Somebody is already on that job. If this offer is accepted they come off it."

For a driver-to-driver offer that is true. For an offer to a **partner** it is
false — `respondToOffer` passes `{ affiliateId }` and leaves `driverId` alone.
The partner accepts, our driver is still assigned, `assignedKind` still reads
DRIVER, and two vehicles are booked for one pickup. The warning also only tests
`.driverId`, so offering a job that is already farmed out shows no warning at
all.

Nothing depended on the old hand-set behaviour that I could find: the seed sets
it consistently, and `createReservationFromTicket` writes `UNASSIGNED` with
nobody on the job.

### 4. `describeOffer` tells drivers "0 bags" when nobody said 0 — read

`ops/dispatch.ts`, in the message a driver actually reads:

    if (trip.passengerCount != null)
      lines.push(`${trip.passengerCount} passengers, ${trip.luggageCount ?? 0} bags`);

`luggageCount` is nullable and unknown is the ordinary case. A driver told
"3 passengers, 0 bags" brings a sedan and finds a boot's worth of luggage. This
is the CLAUDE.md rule — never invent a fact — and it is one of the few places in
this system where an invented fact leaves the building.

The same line loses real information the other way: if `passengerCount` is null
but `luggageCount` is 4, the whole line is skipped and nobody is told about the
four bags.

### 5. Two people can create two reservations from one ticket — read

`ops/reservations.ts`. This is a worse version of the race you flagged, and you
did not flag it.

`createReservationFromTicket` guards with `reservationForTicket(ticketId)`, and
the comment says "the second press must not quietly commit a second car". But it
is a check-then-act with **no unique constraint behind it** — `trips.ticketId`
has no unique index, and no index at all.

The exactly-simultaneous case is saved by accident, via the reference collision:
both get the same `T-` number and one insert dies. The *staggered* case is not.
B reads "no reservation yet"; A inserts; B then computes a fresh reference off
the new maximum and inserts successfully. Two trips, one ticket, two cars.

The reference race fails safe. This one fails open, which is why it sits above
your item 1.

### 6. The reference race — real, and the least of the three — read

Your question 1, confirmed: two calls read the same `max()` and the second
insert violates the unique index. The user-visible result is a 500, because the
Postgres error is not an `OpsError` and falls through to the generic handler.

The good news is that the unique index means it cannot produce duplicate
references — only an ugly failure. So this is a UX bug, not a data-integrity
one, which is the opposite of finding 5.

On your "sequence or retry": a sequence is tidier but does not survive `--reset`
on its own, because the seed inserts literal `T-10000...` references without
advancing it, so the first real booking after a seed collides. That is fixable
with a `setval` at the end of seeding, but it means the seed and the allocator
have to stay in step forever. A bounded retry on SQLSTATE 23505 around the
insert needs no coordination with the seed and turns the 500 into a success. I
would take the retry — and it also closes finding 5, if the retry wraps an
insert that a new unique index on `ticketId` is protecting.

### 7. `frontend/src/lib/time.ts` — almost entirely correct, two real edges — verified

I could run this one. I copied it into the backend and drove it against luxon as
an oracle across every half-hour of both 2026 clock changes plus a summer and a
winter day, from five machine timezones.

**382 of 384 agreed exactly**, and the results were identical under `TZ=UTC`,
`Europe/Berlin`, `Asia/Kolkata`, `Pacific/Auckland` and `America/Los_Angeles` —
so it genuinely is independent of the browser's zone, which was the point of
writing it. `dayStartMs` is right on both DST days, `shiftDate` steps correctly
across both, and the `hour % 24` handling is right in this V8. The two-pass
offset does what you meant it to do.

The two failures, both real:

- **The spring-forward gap resolves backwards.** `zonedToUtc(2026, 3, 8, 2, 30)`
  returns 06:30Z — 01:30 EST, *before* the requested time. Luxon returns 07:30Z
  (03:30 EDT). A shift typed as 02:30 on 8 March starts two hours from where
  anyone would expect. Narrow: one hour, one day a year, and nothing else in the
  file lands in the gap.
- **Round-tripping an ambiguous time moves it an hour earlier.** This is the one
  I would fix. An instant at `2026-11-01T06:00:00Z` is 01:00 EST, the second
  pass through that hour. `toDateTimeInput` renders "01:00"; reading it back
  through `fromDateTimeInput` gives 05:00Z — 01:00 **EDT**, the first pass. So a
  shift or pickup stored in that hour, opened in an edit form and saved **without
  changing anything**, silently moves an hour earlier. Every other round-trip I
  tried was exact.

Neither is a reason to distrust the file. It needs a test, which is pending item
2 — and everything above is a test that can be written today without a browser,
because the whole file is pure and needs only `Intl`.

### 8. A rate card can still produce a wrong number: `minimumHours` — read

The rest of question 5. `minimumHours` is validated `.int().min(1)` and has **no
upper bound**, in the schema or in `assertBandFits`. A band typed with a minimum
of 20 instead of 2 quotes a three-hour job at twenty hours, and every check
passes. Compare `MAX_SHIFT_HOURS`, which guards exactly this typo shape for
shifts.

Everything else about the pricing held up under attack: half-open bands are
right, two open-ended bands are correctly refused as overlapping, negative and
non-integer rates are rejected at the route, `milesBetween` clamps its domain,
and a gap in the card produces a refusal rather than a wrong number.

Smaller, same file: `rate` accepts `0`, and `hourlyRateCents` then reads 0 as
"does not offer it" — so the distinction the schema comment draws ("missing is
different from offering it at nothing") cannot actually be expressed, and typing
0 silently means the opposite of what it looks like.

### 9. A mistyped rate silently deletes a class from the card — verified

`RateCardModal.tsx:67` does `Math.round(Number(typed) * 100)`. Typing anything
non-numeric gives `NaN`, which `JSON.stringify` turns into `null`, and
`z.coerce.number()` turns `null` into **0** — which finding 8 shows is read as
"not offered". I ran that path end to end. So a typo in a rate box removes that
class from the band, with no error anywhere.

`fromMiles` has the same path: garbage becomes 0, quietly moving the band to
start at the base. That one usually trips the overlap check and fails loudly,
which is better luck than design.

### 10. `?status=banana` returns 500 — read. This one is mine.

`routes/ops.routes.ts:96` — `status: z.string().optional()`, unvalidated, into
``sql`${trips.status} = ${search.status}` ``. Postgres rejects the value for the
enum, the error is not an `OpsError`, and it reaches the generic handler as a
500 instead of a 400. It is parameterised, so there is no injection. I wrote
that line in `a846c56`; `sort` immediately below it is correctly whitelisted,
which is what makes the omission obvious in hindsight.

### 11. Two bits of code have drifted on what a booker email is — read

`draft.service.ts`: `bookerEmail: ticket.requesterEmail ?? first.fromAddress`.
`messages.fromAddress` is the **raw From header** and can be
`"Ana Costa <ana@example.com>"`. `ops-context.service.ts` explicitly avoids it
for that reason, in a comment. The fallback flows into the reservation form and
then into `trips.bookerEmail`, and `findTripsForEmail` matches that column with
`lower(...) = ...`, so such a trip never appears in that customer's history
again. `reservationSchema.bookerEmail` is `z.string()` with no `.email()`,
unlike every other email field in the API, so nothing downstream catches it.

### 12. The vehicle class is regexed out of model prose — read

`vehicleClassFromText(review.vehicleSuggestion)` in `draft.service.ts` reads a
sentence the model wrote and pattern-matches a class out of it. Returning null
rather than guessing is right, and the Sprinter-before-van ordering is a good
catch. But the order decides ambiguous cases by position rather than by meaning:
"an SUV or a van" yields VAN, because van is tested first. That value pre-fills
the reservation form.

This is the shape CLAUDE.md warns about twice — a regex over prose, and asking a
model for something derivable. Passenger and luggage counts are already
extracted, and the sedan-3/3, SUV-6/6 rule is already written down as business
logic. The class looks computable from the numbers, with the prose as a tiebreak
rather than as the source.

### 13. A change can take effect with no audit record — read

`updateTrip` and `createReservationFromTicket` both write the row and then call
`recordTripEvent` as a separate statement, with no transaction around the pair.
If the event insert fails, the change stands and the history has a hole. The
file's own header sets the right standard — "an audit trail that can be tidied
afterwards is not evidence of anything" — and that argues for one transaction.

### 14. Smaller things

- `pendingResponse` (`ops/dispatch.ts`) is documented as "an offer that has not
  been answered yet, or null" and does the exact opposite: it returns the answer
  if one exists. The caller is correct; the name and the comment are both
  backwards.
- Accepting an offer is another check-then-act — two simultaneous acceptances
  both pass `pendingResponse` and write two ACCEPT rows.
- `createZone`/`updateZone` have the same race: two overlapping bands added at
  once both pass `assertBandFits`. No constraint behind it.
- `trips.ticketId` has no index at all, and `reservationForTicket` runs on every
  ticket detail load.
- `listTripEvents` orders by `createdAt` alone; two events in the same
  millisecond have no defined order.

---

### What I could not verify

- **146 of the 341 tests need Postgres and did not run.** Not 100-odd — worth
  correcting, since that number is quoted in the task. Every one of the 195 that
  ran passed, and there are **zero assertion failures** across the whole suite:
  all 146 failures are the connection refusing. Backend `tsc --noEmit` is clean.
- **I could not build or typecheck the frontend at all.** `frontend/node_modules`
  is not installed on this machine. Everything above about frontend files comes
  from reading them, with the single exception of `time.ts`, which I ran by
  copying it into the backend where the dependencies exist. Findings 3, 9 and the
  `MessagesTab` warning are read, not run — 9's coercion half I did run, in
  isolation.
- I exercised no endpoint over HTTP. Findings 1, 2 and 10 are traced through the
  code; finding 1 is additionally confirmed by running the schema on its own.
- The two known holes you listed — the per-driver schedule requests and the
  `messages.length` refetch key — I left alone, as agreed.

### On being wrong about your own code

Item 4 is where you were hardest on yourself and least deserved it: `time.ts` is
right in 382 of 384 cases and right from every machine timezone I tried. Both
bugs in it are narrower than the one you were worried about. Item 5 was the right
question asked of the wrong file — the arithmetic is sound; the schema in front
of it is not. Item 1 is real, and the least dangerous of the three races in this
range.

---

## Notes that still apply

- **The database tests can't run on the Claude Code machine.** They need
  Postgres on localhost:5432. `docker compose up -d` in the repo root would
  start exactly the right one, if Docker were installed. Until then the Cowork
  session runs them before anything ships.
- **Seeding production is Amar's step alone.** The live `DATABASE_URL` lives in
  Railway and stays there; neither Claude has it, deliberately. The command is
  `node backend/dist/db/seed-ops.js --reset` in Railway's Console tab — not
  `npm run seed:ops`, which only exists in `backend/package.json` while the
  console opens at the repo root, and which would need `tsx` that the
  production image does not carry.
- **Amar pushes.** The Cowork session writes files onto his disk through the
  desktop bridge and he commits them in GitHub Desktop. It has no push rights
  to the repo and never has.
- **Line endings.** His working copy is CRLF and the repo is LF, which is
  Windows Git doing its job. `git status` from a Linux view shows every file as
  modified; ignore it.
