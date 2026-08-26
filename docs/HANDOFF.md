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

## Where things stand — 23 August

Two days of work, all live on Railway.

**22 August** built the operations surface: the Operations screen with a
dispatch board, a partner table and a reservations table; roster-aware dummy
data; one timezone (`America/New_York`) everywhere; partner rate cards priced
by distance band and class of car; an append-only history on every
reservation; a ticket becoming a reservation; and messages to drivers and
partners with offers that really assign.

**23 August** was Claude Code's audit of all of that, and the fixing of it.
Fourteen findings, all closed — see `## What the audit found` below.

**424 backend tests**, of which 146 need Postgres and only run in the Cowork
session. **26 frontend tests**, which are new: `npm test` in `frontend` now
exists and runs `lib/time.ts` and `lib/bookings.ts` from any machine timezone.
Migrations 0008 through 0015.

---

## The list

What is genuinely still open, after the audit work. Everything from the audit
itself is done; the numbering below is what survived.

### Judgement calls, not defects

1. ~~**The vehicle class is regexed out of the model's prose.**~~ **Done, 23
   August.** The class now comes from the passenger and luggage counts —
   `backend/src/booking/vehicles.ts` — with what the customer wrote used only
   as a floor. Six people who write "sedan" get an SUV; one person who asks
   for an SUV still gets one. A party too big for any car returns nothing at
   all rather than the largest thing we run, so it reaches a person instead of
   looking settled. `questions.ts` now reads its sedan-3/3 and SUV-6/6 numbers
   from the same table, so the capacities Adam quotes to a customer cannot
   drift from the ones that pick the car. "An SUV or a van" still resolves to
   the van, deliberately: it is a car they named, and the direction that would
   have hurt — resolving it smaller than the party — is what the counts now
   prevent. [audit 12]

2. ~~**Trips carry no coordinates.**~~ **Done, 23 August.** The geocode was
   always being run and its `geometry.location` thrown away; `VerifiedAddress`
   now keeps it, the draft's stored facts carry it, and
   `createReservationFromTicket` writes it onto the trip — but only when the
   address in the form is still the one that was geocoded, so a corrected
   address stores no point rather than a wrong one. `ops/pricing.ts` joins that
   to the rate cards, and the trip editor shows the price under the Partner
   box as soon as one is chosen, with a sentence instead of a blank whenever
   it cannot be worked out. Seeded trips get their coordinates from
   `backfill-trip-coords.ts`; a `seed-ops --reset` would have priced them too
   but would have deleted the real reservations along the way.

### Housekeeping

3. **Rotate the Google Maps API key.** It appeared in a screenshot. Deferred
   three times now, and item 2 has happened — the geocode it authorises is
   what every partner quote is measured from, so this is the last item here
   that only Amar can do.

4. ~~**Two headings nobody could read.**~~ **Done, 23 August.** `Hrs` is now
   **Booked hours** and `Called` is **Call order**.

5. ~~**Ticket #60**, the Railway newsletter.~~ **Closed by hand, 23 August**,
   as Unresolved · Closed. Triage only runs on brand-new tickets, so nothing
   was going to reach it on its own.

6. ~~**The bulk-signal task.**~~ **Done, 23 August.** `isAutoReply` was six
   header checks collapsed into a boolean; the checks now name themselves in
   `mail/bulk-signals.ts`, the names are stored on the message (migration
   0014) and the Auto-reply badge in the timeline explains itself on hover.
   Same verdict as before on every input — the boolean is now
   `bulkSignals(...).length > 0`. An empty list on a bulk-flagged ticket is
   the interesting case and is exactly what ticket #60 would have recorded.

### Yours to decide

- **Railway: 9 days or $4.31**, whichever goes first. Hobby is about $5/month.
  The only item with a deadline attached, and it is closer than it was.
- The two parked decisions below: the trip-duration model, and how dispatch
  communication should work.
- **Which end of the trip a rate band measures from.** `quoteTripForAffiliate`
  measures from the partner's base to the PICKUP, on the reasoning that a band
  is about how far they must send a car to start the job. That is plainly
  right for an overflow partner taking a local job — Metro Overflow quotes 4
  miles on a Manhattan pickup. It reads oddly for a trip whose whole point is
  the far end: Pacific Coast Livery, based in Los Angeles, prices a New York
  pickup at 2,447 miles and their "Long haul" band answers with a real number.
  Whether a distant partner should be measured to the drop-off instead is a
  business rule, not a coding decision, so it has been left alone rather than
  guessed at.

### Not bugs, but they look like them

- **History starts at the 22 August deploy.** The seeded trips have no events,
  and the modal says so rather than showing an empty panel.
- **Drafts written before migration 0010 have no stored facts**, so those
  tickets open a blank reservation form and say so.
- **A completed booking can still be edited**, on purpose — that is how a
  billing dispute gets answered — but the screen now says what changing it
  actually does before you do.

---

## The 24 August review — findings, not yet fixed

Two independent reviews of that night's work (dispatch, candidates, the ticket
timeline, trip coordinates), then verified by hand against the running code
before being written down. All of these are defects in work done that night.
Nothing here is fixed yet; the numbering is by seriousness.

**1. A ticket adopts a booking reference that may belong to somebody else.**
`tripsThisTicketIsAbout` resolves every reference in the customer's email with
`findTripByReference`, which matches on the reference alone. Nothing checks
that the booking is the sender's. Our references start at T-10000 — exactly
the five-digit space airline and hotel confirmation numbers occupy — and the
extractor accepts a third party's label: verified live, `Booking reference
10432 — Delta DL2801` yields `T-10432`, and `Your reservation 10005 at
Marriott` yields `T-10005`. The ticket then shows that trip's dispatch
messages in full, and an offer body carries another customer's pickup address,
drop-off, passenger name and flight. The fix is an ownership check —
`bookerEmail` against `requesterEmail`, which `findTripsForEmail` already does
elsewhere — before any private traffic is attached.

**2. Two drivers can both accept the same job, and the first is never told.**
`respondToOffer` checks only that *this* offer has no answer yet. It does not
look at who currently holds the trip. Offer a job to two drivers, both accept:
the second assignment silently overwrites the first, and the first driver's
thread still reads "Yes, I can take that." Two cars at one kerb, which is the
failure the module header says acceptance goes through `updateTrip` to avoid.
The same gap lets a driver accept a job cancelled since the offer went out.

**3. A driver's own reply marks them as told about a change they never saw.**
`lastSpokeTo` filters on trip and contact but not direction, while its comment
says "when we last said anything to this contact". An ACCEPT, a DECLINE or an
inbound text all satisfy it. Concretely: the pickup moves at 09:00, the driver
taps Accept on the offer already on their phone at 09:05, and `toldOfLatest`
goes true — the warning disappears, and the only thing that driver has ever
been shown says the old time. Filtering to `direction = "OUT"` alone will not
do it: accepting writes its own trip event afterwards, so the settled case
would then never look settled. The two questions need separating.

**4. Availability looks for clashes inside a UTC calendar day.**
`findAvailableDrivers` bounds its clash query to the pickup's UTC date, but the
window it is checking runs past midnight UTC for any New York pickup from
about 8pm. A driver with a genuinely overlapping later job reads as free, the
desk offers it, and `updateTrip` only refuses at the moment of acceptance —
that guard deliberately scans two days either side, so the screen and the rule
disagree. `driverStillFits` inherits the same hole, and `tripsThatDay` counts
an 8pm-to-8pm day.

**5. `leavesTheArea` reads only the drop-off, and re-decides a settled rule.**
Its own comment says the in-area answer is read from stored state rather than
decided again — and then it declares its own `HOME_STATES` and applies it to
`dropoffState` alone. A Philadelphia pickup returning to Manhattan is EXTERNAL
to the classifier and ordinary work to this, which offers our own drivers a
95-mile run into Pennsylvania. Stops are ignored on the same basis.

**6. The timeline blends several bookings with nothing saying which is which.**
Once a ticket is about more than one trip, `TicketDispatchEntry` carries no
reference and `BookingChange` prints none. "Job offered — Accepted" from last
month's booking sits above this one's "Reservation created", and reads as
though the new job is covered.

**7. The backfill overwrites real coordinates.** Its header promises it only
fills nulls; the predicate became "coordinate or state missing" while the
write still sets all three columns, so a real Google geocode is replaced by
the seed's rounded constants whenever the state alone is absent. The schema
comment gives reproducibility as the reason to store coordinates at all.

**8. A job nearer than a partner's first band is reported as too far.** With a
card whose lowest band starts at 40 miles, a 12-mile job gets "falls outside
every band — beyond the distance they have said they will travel", which is
the opposite of true. Bands may legitimately start above zero and may have
gaps; `assertBandFits` refuses overlaps but permits both.

**Smaller, same review:** a re-accepted job comes back with a driver and no
car, because decline clears the vehicle and accept never sets one;
`listDispatchForTrip` orders by timestamp with no id tiebreak, the exact
problem `trip-events.ts` documents and solves; `sendChangeNotice` ships a
stray blank line when there is no note; `round(miles)` before the band lookup
can push 14.96 into a dearer band; `coverageNote` compares state codes
case-sensitively while `suggestAffiliates` uppercases both sides.

**Unbounded work per request:** every reference in an email becomes its own
join query, then its own dispatch and events queries, on a 20-second poll. A
forwarded corporate travel digest listing 200 confirmation numbers would issue
~200 joins every 20 seconds per open tab.

---

## What the audit found

All fourteen closed. Kept as a record of what was wrong and what was done,
because the next person to touch this code will want to know why some of it
looks the way it does. The full findings, with the evidence, are under
`## Reply` further down.

| # | Finding | What was done |
|---|---|---|
| 1 | Renaming a rate band wiped every price on it | Fields declared once with no defaults; the patch schema cannot carry them |
| 2 | Any signed-in user could assign any driver to any trip | Changing a trip needs an admin, whichever screen it is done from |
| 3 | A trip could hold a driver and a partner at once | Whichever side is assigned clears the other, with what belonged to it |
| 4 | Drivers told "0 bags" when nobody said 0 | Both counts listed independently, with "not stated" where it is not |
| 5 | Two people could make two reservations from one ticket | Partial unique index on `trips.ticketId` |
| 6 | The reference race returned a 500 | Bounded retry on the unique violation |
| 7 | Two DST edges in `lib/time.ts` | Gap steps forward; untouched fields are not reinterpreted |
| 8 | `minimumHours` had no ceiling | Capped at 12 — half a day, not the 24 shifts use |
| 9 | A typo in a rate box deleted a class | Rates are not coerced; the modal names the offending box |
| 10 | `?status=banana` returned a 500 | Whitelisted, like `sort` on the line below it |
| 11 | A raw `From` header could be stored as a booker email | Parsed, and null when it cannot be |
| 12 | Vehicle class regexed out of model prose | **Open** — item 1 above |
| 13 | A change could take effect with no audit record | The change and its record are one transaction |
| 14 | Five smaller ones | All closed: `answerTo` renamed, double-accept indexed, card edits locked, `ticketId` indexed, event ties broken on id |

Two things worth carrying forward from doing the work:

- **Three separate bugs produced the same real-world failure** — two cars for
  one job. That only became visible once the audit and the old list sat in the
  same document.
- **A test that passes before the fix proves nothing.** Every fix above was
  checked against the previous commit. Where that could not be made to fail —
  the rate-card race, because local Postgres is too fast to open the window —
  the test says so in a comment rather than implying more.

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

**Answered, and everything it found has since been fixed.** Left here so the
exchange reads in order. The outcomes are summarised under `## What the audit
found` near the top; the evidence stays down here.

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

## Where things stand — 25 August

Live on Railway, deployed and verified: commit *"Guard quoted references and
stale offers; add roster top-up tool"*. `extend-roster` has been run against
production — 8 vehicles, 15 drivers, 16 partners, 64 rate bands, 7,965 shifts,
rostered through **25 August 2027**.

653 backend tests pass. Both typechecks clean. Frontend builds.

### What shipped

**A quoted reference now has to belong to the sender.** Our references start at
T-10000 and INV-10000, which is exactly the five-digit space airline and hotel
confirmation numbers occupy, and `extractReferences` takes a third party's
label at face value: "Booking reference 10432 — Delta DL2801" resolved to
T-10432. A customer forwarding their own airline confirmation was enough to
attach a stranger's booking to their ticket — passenger name, both addresses,
the flight, and the whole dispatch thread underneath. Confirmed against the
live desk, not reasoned about.

`bookedBy` and `theirBooking` in `ops/lookup.ts` are the guard; `billedTo` is
the same for invoices. Both `tripsThisTicketIsAbout` and `getOpsContext` run
quoted references through it, and a booking that is not theirs is reported as
a reference we could not find rather than silently dropped.

`theirBooking` allows a second proof — the ticket the trip was created from was
raised by the sender — because a booking typed into the Reservations screen
often has no `bookerEmail` at all, and refusing those hid a customer's own trip
from their own follow-up. That case is the one existing test that failed when
the guard first went in, and it was the test that was right.

**`respondToOffer` refuses a yes that has been overtaken.** Three contacts are
asked, the second says yes and is assigned, the third says yes an hour later —
nothing in the offer sitting in their inbox knows. It ran straight through
`updateTrip` and took the job off whoever held it, with both threads reading as
accepted. Now refused, across both kinds, so a partner cannot take a job a
driver holds either. Same for a cancelled booking. Declining still works in
both cases, so a thread can always be closed.

**`findAvailableDrivers` bounds the clash search by the window, not the UTC
calendar date.** Two separate bugs in one line. An evening booking runs past
midnight, so a clash early the next morning fell outside the old bounds and the
driver came back marked free. And `tripsThatDay` — the figure the list sorts on
— was sliced at midnight UTC, which in New York is 8pm the evening before, so a
9pm booking counted against a day the driver would not recognise. Now
`LONGEST_BOOKING_HOURS` back from the window start, and the day is
`OPERATING_TIME_ZONE`.

**`pendingOfferCounts` counts unanswered quote requests too.** It filtered
`kind = "OFFER"`, which is the whole of a driver's side of the conversation but
only the back half of a partner's — a partner is sent a QUOTE_REQUEST first and
an OFFER only once the money is agreed. So every partner sitting on an
unanswered rate request showed no badge while drivers showed theirs. Amar spotted
it from the screen.

**New: `backend/src/db/extend-roster.ts`, `npm run roster:extend`.**

This one is worth reading before touching the fleet fixtures. The reported
symptom was "we keep running short of drivers"; the cause was not the number of
drivers. `seed-ops` rosters `now-30d` to `now+14d`, so shifts ended 5 September
and every test booking past that fell off the rota and farmed out. Adding
drivers would have changed nothing. Verified live before writing anything.

`extend-roster` is purely additive — it never deletes, is safe to run again, and
touches no trip, invoice, ticket or message. `seed-ops --reset` remains
unusable on a database in use because it deletes every trip.

It also fixes two real fixture faults:

- The seed handed cars out one driver each, so every van and sprinter had
  exactly one driver — on the road about a third of the week. Both sprinter
  drivers happened to draw morning starts, so every sprinter was off the road
  by 5pm and a 9pm booking for fourteen people found nobody, every day.
- Thirteen states and DC were covered by partners. A real ticket asked for
  Oklahoma City and there was nobody to ask at all. Now every state is covered,
  several by two so a rate request has somebody to lose.

Start hours and rest days are **computed**, not picked — `spreadShifts`, a
greedy leximin over the week's 168 hours. Two things learned the hard way and
written into the comments: an eleven-hour shift is only usable for about seven
hours of work once you allow for getting there and finishing, and comparing
candidates on the single worst hour alone is degenerate when full cover is
impossible (every candidate ties at zero, and everybody gets handed midnight).
The test checks the result by asking `findAvailableDrivers`, not by trusting the
arithmetic. Past the seeded fortnight, every hour of every day of the week has a
car of every class free.

`patternsFor` reads each existing driver's pattern off their own shifts so the
rota continues rather than restarting. Note the trap: the seed drifts each start
by ±1 hour, so the **commonest** hour in a driver's history is a coin toss
between three — `usualStartHour` takes a circular mean instead. Driver insertion
order cannot be relied on either; the seed inserts them in one statement, so they
share a `createdAt` and come back in whatever order the database likes. That is
why the hour is read from the shifts and not from a position in a list.

### Open

- ~~Check `docs/DEPLOY_RAILWAY.md` is committed.~~ **Done** — it went in with
  the deploy commit (`7cb4e8e`), verified on Amar's disk.
- **Booker name comes from the wrong place.** Priya Raman's booking came through
  as "Amar Pant" — the sender's Gmail display name is not being read.
- **Nobody tells the partners who lost.** Garden State Chauffeur is still
  holding a quote request for a job Metro won. There is no "tell the others"
  action anywhere.
- **A confirmation email can be sent before any partner has accepted.** Nothing
  gates it on the trip actually being covered.
- **`leavesTheArea` decides out-of-area from the drop-off alone**
  (`ops/candidates.ts` ~line 99), and its own comment says it reads the stored
  decision when the code directly below re-derives it from a local
  `HOME_STATES` list. Both halves are wrong, and the second is the dangerous
  one: a **Philadelphia pickup returning to Manhattan** has `dropoffState: "NY"`
  and reads as ordinary local work, so `candidatesForTrip` offers one of our own
  drivers a 95-mile run into Pennsylvania and back. `trips.pickupState` exists
  and is simply never consulted. There is also no stored INTERNAL/EXTERNAL flag
  on a trip for the comment to be describing, so the comment is doubly untrue.
  Found by the Cowork session on 25 August; confirmed by reading the file.
- **`lastSpokeTo` has no direction filter** (`ops/dispatch.ts` ~line 424). It
  returns the newest dispatch row for the contact whatever its direction, so a
  driver tapping Accept on the offer already sitting on their phone marks them
  as *told* about a change they never saw — and `toldOfLatest` on the
  Reservations screen then reads green. It should count outbound only.
- **Rotate the Google Maps API key.** Amar only.
- **Railway credit.** $4.17 / 7 days as of this afternoon, for the whole
  project. When it runs out the desk stops.
- Findings 3, 5, 6, 7, 8 from the 24 August review, and the "Smaller, same
  review" list above, are all still open.

### Corrections to what is written above in this file

- `pendingResponse` was renamed and its race closed some time ago; item 14's
  first two bullets are stale. The accept-twice race is now handled by
  `insertAnswer` translating the `dispatch_one_answer_per_offer` unique
  violation into a 409, so the check-then-act is backed by a constraint.

---

## Task — 25 August: a guessed booker name is stated as fact

**The symptom Amar saw.** A test booking whose email was signed "Priya Raman"
came through the desk as **Amar Pant** — Amar's own mailbox display name, since
the mail-tester sends every scenario from his Gmail.

**What I could and could not establish.** I read the path; I could not run the
extractor, because the Anthropic key lives in Railway and neither of us has it.
So treat the diagnosis below as traced, not proven, and correct me if the code
says otherwise.

The name reaches the customer down two separate paths in `draft.service.ts`, and
only one of them is a problem:

    // ~line 226 — the greeting
    customerName: booking.bookerName ?? ticket.requesterName ?? nameFromAddress(first.fromAddress)

    // ~line 271 — stored on the draft, and carried onto the trip
    bookerName: booking.bookerName ?? ticket.requesterName ?? null

The greeting is defensible: addressing a reply to the mailbox it came from is
what anybody would do, and being wrong there is a mild awkwardness.

The second is not. `facts.bookerName` becomes the reservation's Booked-by field
and is printed in the confirmation email by `booking/confirmation.ts`, so a name
guessed from an email header leaves the building as a statement of fact. That is
the rule in CLAUDE.md — *never invent a fact for a customer* — and the codebase
already agrees with itself about this everywhere else:

- `reviewBooking` in `booking/questions.ts` confirms `Booker: X` **only** from
  `booking.bookerName`, the extracted one. It never touches the envelope. So the
  questions layer treats the mailbox name as not-a-fact while the facts snapshot
  treats it as one, and they are describing the same booking.
- `bookerEmail` two lines below has exactly the right instinct written into its
  comment: *"Null when it cannot be parsed: not knowing is recoverable, a wrong
  key is not."*

**What I think should change**, though you are closer to the code than I am:

`facts.bookerName` should carry only a name somebody actually established —
`booking.bookerName`, or null. If the envelope name is worth having, it belongs
somewhere that marks it as unconfirmed, so Adam asks *"am I right that you're
booking this on behalf of Ms Costa?"* rather than asserting it. What it must not
do is arrive at the customer inside a confirmation as though they had said it.

**The second half, which is the more interesting one.** The comment above line
226 says the sign-off beats the mailbox display name, and the `??` chain does
exactly that — *provided extraction returns something*. The observed result
means `booking.bookerName` came back null for an email signed "Priya Raman", and
`extract.ts` has a prompt that explicitly says the sign-off wins. Work out why.
Read the prompt and the schema around lines 96 and 118 and say what you find,
even if the answer is "the prompt is fine and this needs a live run to catch".
Do not paper over it by making the fallback smarter — that would hide the
failure rather than fix it.

**Before you start:** check whether the greeting should change at all. I have
argued it should not. If you disagree, say so instead of changing it.

**Notes.** The DB tests do not run on your machine — that is the environment,
not you; check the failures are refused connections rather than assertions.
`npx tsc --noEmit` must pass. Amar's working copy often carries uncommitted
files from this session, so read `git status` before committing and ask him
about anything you did not write.

## Reply — 25 August

Claude Code did this one and its diagnosis beat the task's. The task said
extraction must have missed the sign-off. It had not: `toPlainText` collapses
**every** run of whitespace, newlines included, which breaks two things at
once. A sign-off stops looking like a sign-off, and `stripQuotedReply` splits
on newlines — so flattened text is a single line with nothing to strip, and the
extractor was handed our own quoted draft, greeting and guessed name included,
as though the customer had written it. New `mail/body-text.ts` keeps the lines;
both fact-reading call sites use it; `facts.bookerName` no longer falls back to
the mailbox name. It left the greeting's fallback alone, as the task argued.

It crashed while printing, after the edits landed. The Cowork session ran the
suite it cannot run, and wrote the tests it did not get to.

---

## Where things stand — 26 August, small hours

Everything below is deployed and was checked on the live desk, not reasoned
about. 708 tests, typecheck clean, frontend builds.

### The booker name, finished

The body-text fix was necessary and **not sufficient**, which only showed up
because Amar replied to a real ticket after deploying. The quote is stripped
correctly now — but the reply was "my number is 9978615599" and nothing else.
The extractor is told to fall back to the mailbox display name when a message
carries no sign-off, which is right for a first email and wrong for every reply
after it, so it named the mailbox owner and `mergeFacts` wrote Amar Pant over
Priya Raman again.

`bookerNameFromReply` in `booking/facts.ts`: **a re-read may fill a booker name
in; it may not replace one.** Only `bookerName` needs it — `passengerName` is
never derived from the envelope, so it was never exposed. Confirmed live: the
note now lists the phone number and says nothing about the booker.

### Four wrong facts, found by reading ticket #86

- **`Terminal 4 Departures` on an arrival.** Google's place for "JFK Terminal
  4" is the departures hall — the comment on `expandKnownPlace` claiming it
  "already resolves correctly" is true only for departures. The terminal is
  kept (it is where the driver goes) and the contradicting door dropped, rather
  than swapping in an "Arrivals" nobody has looked up and cannot point a car at.
- **"(domestic)" on an email that never said so.** On a departure the flight
  kind decides the pickup; on an arrival it decides nothing.
- **"waiting for you"** four lines above asking whether the reader was
  travelling. `BookingReview` now carries `knowsWhoTravels` as a typed answer.
- An internal note reading "the market range is As a rough guide, published
  market rates…" — `describeRate` returns a sentence, dropped where a phrase
  belonged. `rateRange` is the figure alone.

### The two findings the last session confirmed — both fixed

- **`leavesTheArea`** read the drop-off alone against a *private copy* of the
  state list, under a comment claiming it read a stored decision that does not
  exist. The rule now lives once as `serviceAreaFromStates` and
  `resolveServiceArea` is a way of spelling it. The halves are deliberately
  asymmetrical: **outside needs one leg** (a foot in Pennsylvania settles it),
  **inside needs all of them** (an address nobody could place could be
  anywhere). That also fixed a smaller thing on the draft side — one verified
  leg in another state used to come back "not enough to say" when it plainly
  was.
- **`lastSpokeTo`** counted messages in either direction, so a driver tapping
  Accept on the offer already on their phone marked them as told about a change
  they never saw. Outbound only now.

  **That alone over-corrected**, and the existing tests caught it: accepting
  writes "Driver: Unassigned → Marco Rinaldi" into the trip's history, so every
  freshly accepted booking read as out of date on the strength of the
  acceptance itself. An event whose every change is about *who is on the job*
  is skipped; anything travelling alongside one still counts. `WHO_HAS_IT` in
  `ops/candidates.ts`.

### Two more the live test turned up

- **A confirmation went to a customer for a car nobody had agreed to bring.**
  On T-10319: "Your booking is confirmed … Price: $1,000.00", while the panel
  two inches away read "Nobody assigned yet" and "They are not on the job until
  they confirm". Metro had quoted $800 and been *offered* the job.

  `whyNotConfirmable` gates on **who owns the car**, not on assignment
  generally. Inside NY/NJ the fleet is ours, so an unassigned booking still
  promises something we can deliver and blocking the email would stop the desk
  answering for hours. Outside it we have no car at all until a partner
  accepts. It reads `affiliateId` rather than "an offer was sent": an offer is
  a question. 409, which the panel already handles correctly — it shows the
  message on a deliberate press and stays quiet on the automatic one after a
  Create. No frontend change. Both halves confirmed live.

- **`245 Park Avenue, 245 Park Ave, New York, NY 10167, USA`** in that same
  confirmation and in the offer to Metro. That repetition is the example
  `tidyAddress` quotes in its own comment. It was called by the draft and
  nowhere else, so the trip kept Google's original and everything reading the
  trip read the raw one. `asThisDeskSaysIt` is now the one place raw stops
  being raw. Existing bookings keep the string they were created with.

### Still open

- **The 24 August list above is stale in places and nothing says which.** Three
  items were checked against current code tonight and are already fixed, with
  the fixes quoting the findings back in their comments: the dispatch
  permission split (`requireAdmin` is on `/offers/:id/response` and
  `/quotes/:id/award`), a trip holding a driver and a partner at once
  (`updateTrip` refuses both and clears the other side), and `describeOffer`
  saying "0 bags". **Somebody should walk items 4–14 and mark what is done** —
  a session chasing a fixed bug is the cost of leaving it.
- **Nobody tells the partners who lost.** Garden State is still holding a quote
  request for a job Metro won. There is no "tell the others" action anywhere.
- **Rotate the Google Maps API key.** Amar only.
- **Railway credit: $4.16 / 7 days**, for the whole project. When it runs out
  the desk stops. The only item here with a real deadline.

### Worth keeping in mind

Three fixes tonight were **wrong or incomplete on the first attempt**, and in
every case the live desk is what said so — not the tests, which passed
throughout.

The booker name took three deploys. `leavesTheArea` looked like a one-line
change and turned out to be two rules for one question. `lastSpokeTo` needed a
second half nobody predicted. Each was caught by sending a real email through
the desk and reading what came out.

The pattern worth repeating: fix it, deploy it, then *use it as a customer
would* before believing it. A passing suite meant "no regression", never "the
thing works".

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
  production image does not carry. The same applies to the rota top-up:
  `node backend/dist/db/extend-roster.js --days 365`. That one is additive and
  safe to repeat; `seed-ops --reset` is not, and deletes every trip.
  `docs/DEPLOY_RAILWAY.md` now has this written down for Amar in plain language.
- **Amar pushes.** The Cowork session writes files onto his disk through the
  desktop bridge and he commits them in GitHub Desktop. It has no push rights
  to the repo and never has.
- **Do not run git through the desktop bridge.** Every `git status` a Cowork
  session runs against the mounted folder creates `.git/index.lock`, and the
  bridge is not allowed to delete files — so the lock stays, and the next
  thing Amar does in GitHub Desktop fails with *"A lock file already exists in
  the repository"*. Twice on 25 August, by two different sessions, and the
  second one reported it as "I can't reach GitHub from the bridge" without
  realising it had just broken his commit. Clearing it means asking Amar to
  delete a file by hand, at whatever hour it is.

  Read the repo with `ls`, `cat` and `grep`, which are harmless. To know what
  is uncommitted, ask him — or read it out of `git status` in a session that
  has its own clone, never his. If a lock does get left, the file to delete is
  `C:\Users\Amir\support-desk\.git\index.lock` — **not** `index` beside it,
  which is Git's real staging file.
- **Line endings — and do not just "ignore it".** His working copy is CRLF and
  the repo is LF, so `git status` from a Linux view shows a wall of modified
  files that are not modified at all. The advice here used to end at "ignore
  it", and on 25 August that cost us: a session read the wall, declared the
  disk clean, and missed 197 genuinely uncommitted lines in this very file plus
  an untracked `docs/NEXT_SESSION.md`. Dismissing the noise means dismissing
  whatever real work is standing in it.

  Ask a question the noise cannot answer:

        git diff --stat --ignore-all-space HEAD    # real content changes only
        git ls-files --others --exclude-standard   # new files, never noise

  An empty result from both is a clean tree. A wall from plain `git status` is
  not evidence of anything either way.
