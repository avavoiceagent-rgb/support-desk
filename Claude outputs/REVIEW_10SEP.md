# Review — the SantaCruz work, and everything still pending

Written 10 September, reviewing code written the same day. Read as somebody
looking for what is wrong with it rather than checking it looks finished.

**Verified** means I ran it or read the schema and query together. **Read**
means I traced the code but did not execute that path.

---

## Part 1 — What exists

Five new tables, additive; the desk's own reservations, dispatch board and rate
cards are untouched. An import that turns any set of columns into our bookings
via a mapping edited on screen. A refusal path that keeps bad rows whole and
explains them. A staff API behind a login with admin on every write, and one
key-guarded read-only endpoint for SantaCruz. 751 backend tests, 69 frontend,
both typechecks clean. Exercised end to end on the live desk: 3 rows in, 4
refused, with the four reasons reading correctly.

That is the part that works. Below is what does not.

---

## Part 2 — What is wrong with it

### 0. "JFK" was geocoded to Oklahoma City, and the wrong address was sent to the customer — verified on ticket #79

Found by accident while running a test email today. This is the most serious
thing in this document and it is not in the SantaCruz work — it is in the
live drafting path.

**The customer wrote:** "Please book a car for 20 October. Pickup from The
Ritz-Carlton, 50 Central Park South, New York, **going to JFK**. My flight is
BA178 departing at 8:30 PM, international." The ticket's own subject line is
"Car to JFK on 20 October".

**Adam resolved "JFK" to "John F. Kennedy, Oklahoma City, OK 73117"** — about
1,300 miles from every other fact in the email.

Then four things followed from it, none of which questioned it:

1. **The wrong address went to the customer.** The draft was reviewed and
   **sent**, stating "Drop-off: John F. Kennedy, Oklahoma City, OK 73117" as
   fact. The customer replied "Yes this works."
2. **A 1,341-minute drive time was treated as ordinary.** The reply says the
   drive takes "around 1341 minutes in current traffic" — twenty-two hours —
   and reasons about it in the same sentence as a fifteen-minute traffic
   margin.
3. **The pickup was set a day before the flight.** Working back three hours
   from an 8:30 PM Tuesday departure plus a 22-hour drive gives **Monday 19
   October, 6:50 PM**. That is what is on the booking now.
4. **The trip was classified EXTERNAL and farmed out to a partner**, because
   the drop-off state came back as OK rather than NY.

**And it reached further than one ticket.** This is the booking that produced
"a real ticket asked for Oklahoma City and there was nobody to ask at all",
which is why `extend-roster` now adds partners until every US state is
covered. That work was solving a problem that did not exist.

**The proof it is the geocode and not the customer** is sitting one row above
it on the same screen. T-10315: same sender, same pickup, one day later,
drop-off "John F. Kennedy International Airport (JFK)". Two nearly identical
bookings, resolved two different ways.

**Why it is not covered by the existing rule.** "Never invent a fact" has been
read as "do not let the model make something up". Here nothing was made up —
a lookup was performed correctly and returned nonsense, and nothing compared
its answer to anything else known about the booking. At least three signals
contradicted it: a 22-hour drive on a local airport transfer, a drop-off state
1,300 miles from the pickup, and a named international flight departing JFK.
Any one of them could have stopped it.

Worth noting the draft *did* flag uncertainty — on the pickup, saying Google
was not certain about 50 Central Park South. It said nothing about the
drop-off, which is the one that was wrong.

**Not fixed, and I have changed nothing.** Suggested shape: a sanity check
between the geocode and the rest of the booking — a drive time beyond some
plausible bound, or a drop-off state that is neither the pickup's nor
adjacent, should refuse and ask rather than proceed. Consistent with how the
SantaCruz import treats a value it cannot trust.

### 1. Seven of the eighteen mappable fields are displayed nowhere — verified

`fields.ts` offers eighteen. `SantaCruzTab.tsx` renders eleven. These are
mappable, import correctly, are stored correctly, and appear on no screen:

    externalId  passengerPhone  bookerName  bookerEmail
    bookedHours  flightNumber  notes

Somebody who maps `BAG_CNT` sees bags appear and reasonably concludes the
mapping works. Somebody who maps their flight number column sees nothing
happen and concludes it does not. Nothing tells them the difference.

`bookerEmail` is the worst of the seven: it is the field most likely to carry
the link between a SantaCruz booking and an email ticket, and there is
currently no way to confirm it imported at all.

### 2. The tab shows the first 100 bookings and calls it the total — verified

`santacruzApi.bookings()` passes no limit; the route defaults to 100. The card
header then reads "SantaCruz bookings · 100", which reads as a count of what
exists. There is no paging, no "showing 100 of 400", no indication whatever.

On the seven-row test this is invisible. On a real nightly file it means the
screen is confidently wrong, which is the failure mode this project keeps
being bitten by.

### 3. The endpoint SantaCruz calls can answer about the wrong booking — verified

`santacruz_bookings.reference` is indexed but **not unique**, and
`bookingForSantaCruz` matches `externalId = key OR reference = key` with
`limit(1)` and no ordering.

So: two bookings sharing a reference, or one booking whose reference equals
another's external id, and the answer is whichever row Postgres happens to
return — and it may differ between two identical calls. This is the same class
as the "orders by timestamp with no id tiebreak" finding already open on the
24 August list, in a new place.

### 4. An import that fails halfway reports that nothing came in — verified

The run row is written first, bookings are inserted one at a time, and the
counts are written at the end. If anything throws midway — a connection drop,
a value the schema refuses — some bookings are in the database, `finishedAt`
stays null, and `rowsImported` stays 0. The screen says nothing was imported
while some of it was.

The whole run should be one transaction, or the counts should be written as it
goes. Neither is true today.

### 5. Rows are inserted one at a time — verified

Up to 5,000 rows means up to 5,000 round trips, inside one HTTP request, with
the failure mode above. Should be batched.

### 6. The "enabled" switch does nothing — verified

It is stored, validated, and refused when no key is set. Nothing reads it. A
control that looks live and is inert is exactly what this project flags in
other people's code.

### 7. "Last checked" is always empty — verified

`lastCheckedAt` and `lastCheckResult` exist as columns, cross the API, and are
typed on the frontend. Nothing ever writes them. Two dead fields carried
through three layers.

### 8. Stale warnings, and a raw error — read

`setParseProblems` is never cleared, so warnings from one paste survive into
the next — including into a successful one. And pasting malformed JSON puts a
raw JavaScript `SyntaxError` in front of the user rather than a sentence.

### 9. Smaller

- A repeated column name in the header row silently overwrites the earlier one.
  It should be refused, like a duplicated mapping is.
- The time zone list is five hardcoded entries. Fine for NY/NJ; wrong the day
  SantaCruz is configured elsewhere.
- `applyMapping` suppresses a duplicate "came through empty" reason by testing
  whether any existing reason *contains the field name as a substring*. No
  current pair of field names collides, but the next one added could, and the
  symptom would be a silently missing reason.


### 10. The `on-file` mail-tester scenario is stale — verified

It quotes T-10005 and INV-10032 and expects both to match. Neither exists:
this database's references run T-10310 to T-10320. Every reference in the
email therefore lands in the "matches nothing on file" line, which is
factually correct but means the scenario cannot demonstrate what it exists to
demonstrate. Anyone running it concludes the reference matching is broken.

It should read real references out of the database when it sends, rather than
hard-coding numbers from an older seed.

### 11. The unmatched-reference line uses singular grammar for a list — verified

"Quoted T-10005, T-99999, INV-10032, which **matches** nothing on file —
worth checking whether **it** is a typo or another company's reference."

Three references, singular verb and pronoun. Staff-facing copy in a project
that is careful about wording elsewhere.

### What holds up

The refusal rules, including both daylight-saving edges, are right and covered
by tests that fail without them. Idempotency on their id is right. Keys never
touching the database or a screen is right. The permission split is right and
its test genuinely fails when a guard is removed. Their rows are kept whole.
None of that needs revisiting.

---

## Part 3 — Pending: SantaCruz

**Blocked on GroundWidgets**

- A live pull. `baseUrl` is stored and read by nothing; import is by paste.
- Webhooks, or a polling cadence if they cannot push.
- Real column names. Everything else is configuration once these arrive.

**Blocked on a decision, not on them**

- **Linking a booking to a ticket.** Nothing connects them. Until it does,
  `ticketId` on the outbound endpoint is always null and the whole outbound
  direction returns almost nothing.
- **Cancellations.** A booking deleted in SantaCruz stays in the mirror looking
  live, for ever. No mechanism exists to learn otherwise.
- **How much of Adam's own work to share outward.** Sending their fields back
  would duplicate; sending *ours* — the assigned driver, the partner quote, the
  confirmation sent — would not, and is probably what is actually wanted.
- **Vehicle class translation.** Their words are stored as written and never
  mapped onto our sedan/SUV/van/sprinter rules.

**Housekeeping**

- Three practice bookings (SC-90001 to SC-90003) sitting in the live database.
- `dist/xfer/santacruz-files.tar.gz` left in the repo folder (git-ignored).

---

## Part 4 — Pending: the rest of the desk

Unchanged since the 26 August review; none of it was touched today.

**Still broken (8)** — the ticket timeline blending several bookings with
nothing saying which is which; the unbounded per-reference queries on the
20-second poll; "beyond the distance they will travel" shown for a job that is
too *near*; a re-accepted job returning with a driver and no car; 14.96 miles
rounding into the dearer band; the case-sensitive coverage check; three
dispatch queries with no id tiebreak; a change notice shipping a stray blank
line. The coordinate backfill still overwrites real geocodes if re-run.

**Partly done (2)** — `createReservationFromTicket` still writes its audit
event outside a transaction; stops are still not read when deciding whether a
trip leaves the service area, and cannot be without a schema change.

**Operational**

- Rotate the Google Maps key. Carried in every handoff since 23 August.
- Ticket #83, open and over two weeks past SLA.
- **T-10314** — drop-off reads "John F. Kennedy, Oklahoma City". If that is a
  mis-geocode of JFK, then the partner-coverage work in August solved a problem
  that did not exist.

**Documentation that contradicts itself**

- `docs/DEPLOY_RAILWAY.md` says the Railway project holds a Postgres service.
  It does not — I checked the dashboard; there is one service per project and
  the database is external. The same file tells the reader to bind
  `DATABASE_URL` to a service that does not exist.
- `CLAUDE.md` describes nine mail-tester scenarios; there are eleven.
- The migration journal fix landed for 0021, but the pattern that caused it —
  hand-written entries dated into the future — will silently skip the next
  generated migration too.
- `tools/mail-tester/send.mjs` reports every send failure as a credentials
  problem. A network fault sends the reader to regenerate a working Gmail app
  password.

---

## Part 5 — The order I would take it in

1. **Finding 0** — the geocode. It is the only item here that has already put
   a wrong statement in front of a customer, and the booking it created is
   still on the board with a pickup a day early.
2. **Findings 1 and 2** — the two that make the new SantaCruz screen quietly
   lie. Small; everything else about that screen is honest.
3. **Findings 3, 4, 5** — correctness and durability of the import, before any
   real volume goes through it.
4. **Send the GroundWidgets questions.** Free, and everything automatic waits
   on the answers.
5. **Decide linking and cancellations** with the development team. Neither
   needs GroundWidgets.
6. **The desk's own eight** — starting with the timeline, which is the only one
   that can mislead a person into a decision.
7. **Findings 6 to 11**, which are tidiness rather than risk.

Finding 0 changes the shape of this list. Everything else here is about work
that has not reached anybody yet; that one already has.
