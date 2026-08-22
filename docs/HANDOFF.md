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

331 tests, 20 files. Migrations 0008, 0009, 0010.

---

## Pending

Roughly in the order I would take them.

1. **Change-to-existing tickets do the wrong thing.** Both open reservation
   tickets on the live desk are "can we move T-10005 an hour later". Create
   reservation is offered on them and would make a *second* booking beside the
   one the customer wants moved. The lookup that finds a quoted reference
   already exists (`ops/lookup.ts`); what is missing is the step that ties a
   follow-up email to the trip it is about and offers to change it. This is the
   other half of the Create reservation work and the highest-value thing open.

2. **The frontend has no test runner.** `lib/time.ts` does DST-aware zone
   arithmetic and `ops/zones.ts` prices money, and neither has a test that runs
   on a build. The timezone logic was verified against both DST boundaries from
   five zones — by a script in the Cowork sandbox, which is gone. This is the
   natural Claude Code job: add vitest + jsdom to `frontend`, wire `npm test`,
   and port the checks (NY midnight in August vs January, 8 March and 1 November
   2026 in both directions, a datetime-local round trip, and `zoneForMiles`
   boundaries at exactly 15 and 40 miles).

3. **Trips carry no coordinates**, so nothing can work out which rate band a
   job falls in. `zones.quote()` is written and tested and currently called by
   nothing. Storing pickup/dropoff lat-lng at reservation time would connect it.

4. **The Google Maps API key needs rotating.** It appeared in a screenshot.
   Deferred by Amar twice, and it becomes load-bearing the moment (3) happens.

5. **Railway trial: 11 days or $4.43**, whichever runs out first. Hobby is
   about $5/month. Amar's call, but it has a deadline attached.

6. **Two headings Amar had to ask the meaning of.** `Hrs` on the reservations
   table should read **Booked hours**; `Called` on the partners table should
   read **Call order**. Offered, not yet done — heading text only, no logic.

7. **Ticket #60** (the Railway newsletter) is still open and needs closing by
   hand. Triage only runs on brand-new tickets so a person's judgement is never
   overwritten; the bulk-mail fix protects the next newsletter, not this one.

8. **The bulk-signal task** — recording which headers each email carried, so a
   decision made from evidence keeps the evidence. Open since before this
   session, still the smaller job.

Two things that are not bugs but will look like them:

- **History starts at deploy.** The ~308 seeded trips have no events, and the
  modal says so rather than showing an empty panel.
- **Drafts written before 0010 have no stored facts**, so those tickets open a
  blank reservation form and say so.

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

**None assigned.** Item 2 above (the frontend test runner) is written up as a
Claude Code job and is ready to hand over whenever Amar wants it — say the word
and it moves into this section properly.

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
