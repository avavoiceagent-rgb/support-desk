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

Written 21 August, after the lookup half landed and was verified against a real
database.

**Surface what the desk already knows about a ticket — to staff, not to
customers.**

`backend/src/ops/lookup.ts` can now find a trip or an invoice from the way a
customer writes its reference. Nothing calls it. The obvious next move is to
let Adam write about trips in a draft, and that is the wrong first step: a
drafted sentence about somebody's booking is a customer-facing claim, and we
would be making it before anyone has seen whether the lookups pick the right
record from a real email. So this task stops one step short of that, on
purpose.

Build a read-only endpoint that answers: *what do we already have on file
about this ticket?*

**1. Pull references out of the email text.** A new pure function — put it in
`backend/src/ops/references.ts` — that reads a subject and body and returns any
trip and invoice references it finds. People write them as `T-10432`,
`t10432`, `#10432`, `booking 10432`, `INV-10432`, `invoice 10432`, sometimes
several in one email. Return them de-duplicated, in the order they appear.

Two traps worth testing: a bare five-digit number with no word near it is NOT a
reference (it could be a postcode, a phone fragment, a flight number), and
`invoice 10432` and `INV-10432` in the same email are one invoice, not two.

**2. Add `GET /api/tickets/:id/ops-context`.** It reads the ticket's first
inbound message, extracts references, looks them up, and also returns that
sender's recent and upcoming trips via `findTripsForEmail`. Compute it on
request — do not store it. A stored copy would be wrong the moment a trip moved,
and we have already been bitten once this week by data that outlived its truth.

Return the trips and invoices found, plus a short machine-readable reason for
each: quoted directly in the email, or matched by the sender's address. Whoever
reads this needs to know the difference between "they named this booking" and
"this is the last thing they booked".

**3. Nothing customer-facing.** No changes to `draft.service.ts`, the composer,
or any prompt. This endpoint feeds a panel for staff that the Cowork session
will build, because it can see the running app and you cannot.

**4. Tests.** The reference-extraction function is pure, so test it hard — every
spelling above, the negative cases, duplicates across spellings, and an email
containing no references at all. The endpoint needs at least: a ticket whose
email quotes a real trip, one quoting a reference that does not exist (must
return an empty list, not an error), and one from a sender with history but no
reference quoted.

Note the endpoint tests need Postgres, which your machine does not have. Say so
plainly in your reply as you did last time rather than reporting them as
passing, and the Cowork session will run them.

## Reply

Written 22 August by Claude Code. Built as asked. Nothing customer-facing moved.

**What landed**

- `backend/src/ops/references.ts` — `extractReferences(subject, body)`, pure,
  returning canonical trip and invoice references de-duplicated in the order
  they appear. It reuses `normaliseReference` from `lookup.ts` for the canonical
  form, so there is still only one definition of what `T-10432` means.
- `backend/src/services/ops-context.service.ts` — `getOpsContext(ticketId)`.
- `GET /api/tickets/:id/ops-context` in `tickets.routes.ts`, registered above
  the bare `/:id` so the path is not swallowed as an id. 404 for an unknown
  ticket; otherwise `{ context }`.
- `backend/src/ops/__tests__/references.test.ts` (13 tests) and
  `backend/src/services/__tests__/ops-context.service.test.ts` (11 tests).

Computed per request, stored nowhere. `draft.service.ts`, the composer and the
prompts are untouched — `git show --stat` will confirm that in one line.

Each record carries a reason. I used three rather than two: `QUOTED_IN_EMAIL`,
`SENDER_UPCOMING`, `SENDER_RECENT`. You asked for the difference between "they
named this booking" and "this is the last thing they booked", and the second of
those splits again — the trip they have coming on Thursday and the one they took
in March are both "matched by sender" but a person reading the panel treats them
completely differently. Quoted always wins a tie, so a trip that is both named
in the email and their latest booking appears once, as quoted.

Extraction is 14 tests now, not 13, and the suite is 226. All still pass here
without a database.

**Two additions beyond the brief**

`unresolvedReferences` — references the customer quoted that match nothing on
file. You specified that an unknown reference returns an empty list rather than
an error, and it does. But dropping it silently loses the most interesting case
on that panel: somebody quoting `T-99999` is mistyping, or talking about another
company, and a person should see that they quoted *something*. It is a separate
field, so it costs nothing to ignore.

`quotedReferences` is returned too, so the panel can show what was matched on
without re-deriving it.

**What I could not verify — now resolved**

The 11 endpoint tests need Postgres and this machine has none, so I did not
report them as passing. **The Cowork session has since run them: 225 tests pass
against a real Postgres, typecheck clean.**

The 13 extraction tests need no database and **do pass here**, which is the point
of keeping that function pure — it is the part that guesses.

One bug I did catch by reading rather than running, worth knowing because it
would have looked like a code fault when you ran it: my first draft of the
service test pinned fixtures to a fixed date in September. `getOpsContext` calls
`findTripsForEmail` without a `now`, so it asks the real system clock whether a
trip is past or upcoming — every "recent" fixture would have been in the future
and every `SENDER_RECENT` assertion would have failed. The fixtures are now
relative to the real clock, in whole days so there is no boundary to race.

**Where I would push back**

*`#10432` was not safely a trip reference — **settled, and now removed**.* You
listed it among the trip spellings and I first implemented it with a four-digit
floor, which kept today's ticket numbers out but was a collision scheduled for
the day ticket numbers reach four digits. Amar agreed the fault was in the spec
and asked for the form to be dropped outright rather than floored, which is the
better call: a floor with an expiry date is worse than no rule.

A bare `#10432` now extracts nothing, at any length. `booking #10432`,
`invoice #10432` and `trip no. #10432` still work — the word carries the
meaning and the hash is only punctuation between it and the digits. There are
two tests: one asserting the bare form finds nothing (`#60`, `#1234`, `#10432`,
"please cancel #10432"), and one asserting the worded forms still do, so
dropping the first cannot silently break the second. The reason is written into
the file header as well, because this is the kind of thing that gets helpfully
added back.

*A number is never a reference without a word next to it.* That is the rule the
whole file rests on, and it is why "postcode 10118", "flight DL2801", "917 555
0142" and a bare "10432" all extract nothing. There are tests for each. The cost
is that a customer who writes only "please cancel 10432" gets nothing found —
correctly, in my view, because guessing there is how the passenger-name regex
went wrong.

**Housekeeping**

The standing candidates lost two corrections I made on 22 August when this file
was rewritten: the Postgres count went back to "17" (it is 64 now — it changes
every time an ops test file is added, so it may be worth not quoting a number at
all), and the note about the live tables now existing but being empty was
dropped, though the newer "Seeding production is Amar's step alone" entry covers
the same ground better than mine did. I have left both alone this time rather
than re-editing your list under you.

The HTTP layer itself is not directly tested: there is no supertest in this repo
and every existing route is covered through its service, so I followed that.
The route is three lines and a 404.

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
- **The database tests can't run on this machine.** 17 of them need Postgres on
  localhost:5432. `docker compose up -d` in the repo root would start exactly
  the right one, if Docker were installed. Until then the Cowork session runs
  them before anything ships.
- **Seeding production is Amar's step alone.** The `DATABASE_URL` for the live
  database lives in Railway and stays there; neither Claude has it, which is
  deliberate. He runs `node backend/dist/db/seed-ops.js --reset` in Railway's
  Console tab when he wants the tables filled.
- **The dummy data is local only.** `npm run seed:ops -- --reset` has been run
  against the Cowork session's database, not Railway's. Seeding production is a
  deliberate separate step, and needs a decision about whether fabricated trips
  should sit in the live system at all.
- **The bulk-signal task** (recording which headers each email carried) is
  still open and was written up before this one; it is the smaller job.
- **Ticket #60** (the Railway newsletter) stays open until somebody closes it
  by hand. Triage only ever runs on brand-new tickets, so that a person's
  judgement is never overwritten later; the fix protects the next newsletter,
  not this one.
- **The run tag now includes seconds**, closing the `HHMM` collision noted in
  the reply above.
