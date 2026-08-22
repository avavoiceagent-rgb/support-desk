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

## Task

Written 21 August. The operational tables landed this morning: `vehicles`,
`drivers`, `driver_shifts`, `affiliates`, `trips`, `invoices`,
`invoice_lines`, seeded with `npm run seed:ops -- --reset`. Availability and
affiliate matching already exist in `backend/src/ops/availability.ts` with
tests beside them — read those first, the house style for this area is set
there.

**Build the lookup half: `backend/src/ops/lookup.ts`.**

When a customer writes "can we move T-10432 to 10am" or "invoice 10432 charges
twice", the desk has to find the thing they are talking about. That is a
query, not a judgement, and it belongs in code before any of it goes near a
draft.

1. `findTripByReference(reference)` — tolerant of how people actually type
   references: `T-10432`, `t10432`, `10432`, with stray spaces. Return the trip
   with the driver's name and phone, the vehicle label, and the affiliate's
   company where one is assigned — a reply needs those, and a second round trip
   to fetch them invites someone to skip it.
2. `findInvoiceByReference(reference)` — same tolerance (`INV-10432`, `10432`),
   returning the invoice with its line items and the trip it bills.
3. `findTripsForEmail(email, { withinDays, upcoming })` — a customer's history
   or their forward bookings, most recent first, capped at 20. Match the email
   case-insensitively; people capitalise inconsistently.

Rules that matter here:

- **Cancelled trips must still be findable.** A customer asking "why was I
  charged for a trip I cancelled" needs exactly that record.
- **Never recompute money.** `chargeCents` in `seed-ops.ts` owns the hourly
  arithmetic. Lookups read `amount_cents` and format it; a second
  implementation of the same sum is how two parts of a system start disagreeing
  about what a customer owes.
- **Do not touch `tickets` or `messages`**, and do not wire any of this into
  drafting yet. That is the next task, and doing both at once makes a bad
  change hard to unpick.
- Return `null` for "no such trip" rather than throwing. A customer quoting a
  reference that does not exist is a normal Tuesday, not an error.

Tests, in `src/ops/__tests__/lookup.test.ts`: the reference spellings above all
find the same trip; a wrong reference returns null; email matching ignores
case; ordering is right; a cancelled trip is still returned; an invoice comes
back with its lines attached.

Run the tests and the typecheck, then commit and push as usual. Seventeen
database tests will fail with ECONNREFUSED on your machine as always — but note
that this task's own tests need Postgres, so you cannot verify them there. Say
so in your reply rather than reporting them as passing, and the Cowork session
will run them against a real database before anything is trusted.

## Reply

Written 22 August by Claude Code. Built as asked, with two deliberate
departures set out below.

**What landed**

- `backend/src/ops/lookup.ts` — `findTripByReference`, `findInvoiceByReference`,
  `findTripsForEmail`, plus `findTripById` (an internal helper, so an invoice
  can follow its own `tripId` through the same joined query rather than a
  second, differently-shaped one) and `formatUsd`.
- `backend/src/ops/__tests__/lookup.test.ts` — 25 tests covering everything you
  listed, plus the cap at twenty and the assigned/unassigned split.

Trips come back with the driver's name and phone, the vehicle label and class,
and the affiliate's company, phone and email, all in one query with three left
joins. Nothing filters on status anywhere, so a cancelled trip is found by
reference and stays in the history — there is a test for each. Money is read
and formatted, never summed: the invoice test asserts the *stored* `subtotal`,
`total` and line amounts, and nowhere adds anything up. `formatUsd` is new — the
repo had no money formatter — and it divides by 100 to print, nothing else.

**What I could not verify, and you need to run**

Twenty of the twenty-five tests need Postgres, and this machine has none. They
fail with ECONNREFUSED, exactly as you predicted. I am not reporting them as
passing. What I can tell you is narrower: `npx tsc --noEmit` is clean, and
across the whole suite there are **zero assertion failures** — every one of the
53 failures is the connection refusing, not a test disagreeing with the code.
That rules out typos and shape mistakes. It does not rule out a wrong query.
Please run this file against the real database before anything trusts it.

**Resolved, 22 August.** The Cowork session ran it: all 20 pass, 201 across the
suite, typecheck clean, and it exercised the functions against seeded data as
well — every reference spelling resolves, a bad reference returns null, email
matching ignores case, and trips come back with driver and vehicle attached.
Railway applied migration 0007 and the seven tables exist and are empty. The
caveat above stands only as a record of what was and was not known at the time.

Five tests *do* run here, on purpose. I scoped the database cleanup to the three
describes that need it instead of a file-level `beforeEach`, which lets the
reference-parsing and formatting tests execute on a machine with no Postgres.
They pass. That is the part of this file that makes a judgement rather than a
query — the rest is joins — so it is the part I most wanted actually exercised
rather than merely typechecked, given what happened with the passenger-name
regex.

One correction to your note while I am here: it is **33** database tests that
fail on this machine, not 17. `availability.test.ts` added 13 since that number
was written, and `ingest`/`classification` account for the rest. With this
change it is 53. The suite is 201 tests, 148 passing.

**Where I did not do what you asked**

*Ordering of forward bookings.* You said "most recent first" for
`findTripsForEmail` as a blanket rule. I made history newest-first as you asked,
but forward bookings **soonest-first**, and I think the blanket version is a bug.
The list is capped at twenty. A customer with more than twenty trips on the books
who asks about their next pickup would, under newest-first, get the twenty
furthest-away bookings and lose the one happening tomorrow — the single trip most
likely to be the one they are writing about. If you disagree, it is one word in
`orderBy`, but I would want to hear the case before changing it back.

**Settled, 22 August.** The Cowork session agrees: soonest-first is right, for
the reason given. The task's blanket wording was the error. Left as built.

(I also corrected the stale "17" in the standing candidates below to 53, since
leaving a known-wrong number in a shared page is worse than editing your list.)

**Two judgement calls worth knowing about**

*A prefix belonging to the other kind is rejected, not ignored.* `INV-10432`
handed to `findTripByReference` returns null rather than trip 10432, and
`T-10432` handed to `findInvoiceByReference` does the same. Both numbers exist
in the seed and mean different things, so being tolerant in that direction would
manufacture confident wrong answers. Bare `10432` still finds either, as
specified.

*A bare number is taken at face value.* `+1 917 555 0142` normalises to
`T-19175550142`. I left it that way rather than adding length or range rules:
this function canonicalises something already believed to be a reference, it
does not decide which numbers in an email are one. Nothing is claimed until the
row is found, and that row never will be. The test says so explicitly so the
next person does not "fix" it by guessing. **The real risk lives one layer up**
— whatever eventually picks references out of email prose is where a phone
number could become a wrong lookup, and that is the next task's problem, not
solved here.

`withinDays` bounds the window in whichever direction you are looking: days back
for history, days forward for `upcoming`. `now` is injectable so the tests do not
depend on the clock.

`tickets` and `messages` are untouched, and none of this is wired into drafting.

---

## Standing candidates

Not tasks yet — the things we know are unfinished, so whoever picks one up
knows the background:

- **Defect 2 is half closed.** On 21 August a live test confirmed the draft now
  names "Ms Ana Costa" as the passenger and asks for her mobile number — so it
  works. But that rests on a sentence in a prompt with no test behind it, and it
  was verified once, by hand. Pinning it down needs a test that actually runs
  the model, and the API key lives only in Railway, so neither machine can run
  one today. Worth solving properly rather than faking.
- **The database tests can't run on this machine.** 53 of them need Postgres on
  localhost:5432 (it was 17 when this was written; `availability` and now
  `lookup` have been added since). `docker compose up -d` in the repo root would start exactly
  the right one, if Docker were installed. Until then the Cowork session runs
  them before anything ships.
- **The dummy data is local only, and the live tables are empty.** As of
  22 August migration 0007 has run on Railway, so `trips`, `invoices` and the
  rest exist in production with nothing in them. `npm run seed:ops -- --reset`
  has only ever been run against the Cowork session's database, and nothing on
  the deploy path calls it. Seeding production stays a deliberate separate step
  and still needs a decision about whether fabricated trips should sit in the
  live system at all. Note the consequence for the next task: a lookup wired
  into drafting will find nothing in production until that decision is made.
- **The bulk-signal task** (recording which headers each email carried) is
  still open and was written up before this one; it is the smaller job.
- **Ticket #60** (the Railway newsletter) stays open until somebody closes it
  by hand. Triage only ever runs on brand-new tickets, so that a person's
  judgement is never overwritten later; the fix protects the next newsletter,
  not this one.
- **The run tag now includes seconds**, closing the `HHMM` collision noted in
  the reply above.
