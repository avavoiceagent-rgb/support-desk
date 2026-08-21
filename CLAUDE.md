# Support Desk — working notes for Claude

An email-to-ticket helpdesk for a New York / New Jersey ground-transportation
company. Mail arrives at a Gmail inbox, becomes a ticket, gets sorted
automatically, and for new reservations an AI agent called **Adam** drafts a
reply for a human to review. Nothing is ever sent to a customer without a
person pressing Send.

Amar owns this and is not a programmer. Explain changes in plain language and
say what will visibly happen, not how the code is shaped.

## Rules that are not negotiable

- **Secrets live only in Railway environment variables.** Never print, echo,
  log or ask for a secret value. `ENCRYPTION_KEY` in particular: losing it
  forces a full Gmail reconnect.
- **All third-party accounts belong to the Ava identity** (avavoiceagent@gmail.com,
  GitHub `avavoiceagent-rgb`). Never create accounts, type passwords, or accept
  OAuth consent screens — hand those to Amar.
- **Never invent a fact for a customer.** If the email did not say it, Adam
  asks instead of assuming. A guessed name or time reaches a real customer as a
  statement of fact.
- **Never ask a model for something you can look up.** Postcodes come from
  Google Geocoding, drive times from the Routes API, internal-vs-external from
  state codes, all timing arithmetic from TypeScript. Models are for reading
  prose and writing prose.
- Notes and replies are attributed to the logged-in author. Do not reintroduce
  attribution by assignee.

## Stack

Node + TypeScript + Express, **Drizzle ORM** (not Prisma), React + Vite +
Tailwind v4, Postgres (Neon), one Railway service. Migrations live in
`backend/drizzle/` and run on `npm start`; `meta/_journal.json` decides order,
and **editing an already-applied migration does nothing** — add a new one.

Models: `claude-haiku-4-5` for triage and extraction, `claude-sonnet-5` for
composing replies and rate lookups.

## Where things are

    backend/src/mail/          Gmail provider, polling, ingest, threading
    backend/src/ai/classifier  Queue + reservation-type triage
    backend/src/booking/
      extract.ts               Reads booking facts out of an email (Haiku)
      maps.ts                  Geocoding + Routes wrappers; never throws
      pickup-time.ts           Airport lead times, stops, DST-safe (pure TS)
      questions.ts             The business rules: what to confirm vs ask
      rates.ts                 Web-search market rates, heavily validated
      compose.ts               Turns the above into an email (Sonnet)
    backend/src/services/draft.service.ts   Orchestrates the draft
    frontend/src/components/DraftCard.tsx   The suggested reply in the timeline

Business rules worth knowing: domestic flights need 2h at the airport,
international 3h, plus 15 minutes for any stop with no stated duration; pickup
is rounded down to 5 minutes. A sedan takes 3 passengers and 3 bags, an SUV 6
and 6. Trips staying inside NY/NJ are INTERNAL; anything crossing out is
EXTERNAL and gets farmed out to a partner, so the draft must not promise a car.

## Commands

    cd backend && npm test            # vitest (no --reporter=basic, it's v4)
    cd backend && npx tsc --noEmit    # Railway builds tests too, so this must pass
    cd frontend && npm run build

Always run the backend tests and the typecheck before committing.

## Checking Adam for real

The unit tests cover the rules; `tools/mail-tester` covers the behaviour. It
sends nine scripted scenarios to the desk inbox as real email — an internal
booking, one crossing out of state, an arrival, one booked for somebody else, a
vague one-liner, a pickup that is too late, a change to an existing booking, an
invoice and a newsletter — and prints what a person should look for in each
resulting ticket. Nothing is asserted automatically.

    cd tools/mail-tester
    node send.mjs list      # what the scenarios are
    node send.mjs vague     # send one
    node send.mjs all       # send all nine, 45 seconds apart

Every subject carries a run tag like `[0117]`. Gmail threads by subject and
sender, so without it a second send of the same scenario arrives as a reply on
the existing ticket: no new ticket, no new draft, and a re-test that quietly
proves nothing. It needs its own `.env` (see that folder's README); the
credentials are a Gmail app password and never belong in the repo.

## Deploying

This repo is the deploy pipeline: pushing to `main` makes Railway build and
release. Amar reviews changes in GitHub Desktop and pushes. There are no GitHub
Actions here — the old `code.tar.gz` unpack workflow and the archive itself were
deleted in ad87734, so nothing runs on a push except Railway's own build. If CI
ever comes back, note that a GitHub Actions token is not allowed to modify
workflow files, so changes there must be made by a person.
`docs/DEPLOY_RAILWAY.md` is the plain-language version of all this for Amar.

## Working with the other Claude

Amar also works on this project through a Cowork session in the Claude desktop
app. That session can see the live desk, the real tickets and the drafts Adam
wrote, watch Railway, and run the full test suite against a real Postgres — but
it cannot push to GitHub or delete files here. This session can do all of those
and none of the former.

The two cannot message each other. `docs/HANDOFF.md` is the channel: a task is
written there, Amar says "read docs/HANDOFF.md and do it", and the reply goes
back into the same file and gets committed. Read that file before starting such
a task, and say plainly in the reply if the task itself is wrong — the other
session writes them without being able to run anything.

## Style

Comments explain *why*, especially where a rule came from a real customer email
or a real bug. Keep them; they are how Amar follows what happened. Prefer
putting business rules in typed code with tests over putting them in a prompt.
