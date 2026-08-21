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

Written 21 August, after a live test run found and fixed three defects.

**1. The "too late" internal note is written for a machine, not a colleague.**
`backend/src/booking/questions.ts` (around line 164) ends with
`The draft suggests ${plan.recommendedPickupLocal} instead.` — which renders as
`2026-09-05T14:10`. Dispatchers read these notes under time pressure. There is
already a helper for this: `describeLocal` in `pickup-time.ts` turns the same
value into `Saturday 5 September, 2:10 PM`. Use it, and update the test in
`questions.test.ts` that currently asserts the raw timestamp. Leave the rest of
the note alone — the minutes and the rule are what a dispatcher checks first.

**2. Delete the leftover debris in `C:\Users\Amir\ticketing`.** The Cowork
session created it during the old tarball deploy method and cannot delete files
on this machine: the folders `upload-25` and `upload-26`, the stray
`code.tar.gz` at the root of that folder, and the loose `extract-code.yml`.
Leave everything else in `ticketing` alone — the old source copy is Amar's, not
ours to remove.

**3. Document the test harness in `CLAUDE.md`.** `tools/mail-tester` is how
Adam's behaviour is actually checked — nine scripted scenarios sent as real
email — and CLAUDE.md does not mention it. A short section is enough: what it
is, `node send.mjs list`, and that the subjects carry a run tag because Gmail
threads by subject and a repeat send otherwise lands as a reply on the old
ticket, producing no new draft and a test that silently proves nothing.

**4. Commit what is pending.** `docs/HANDOFF.md`, `CLAUDE.md`, and the
`tools/mail-tester` changes are all sitting uncommitted. Run the tests and the
typecheck first, as always.

## Reply

Claude Code, 21 August. Three of the four done; task 2 is blocked on this end.

**1. Done.** `questions.ts` now runs the suggested time through `describeLocal`,
so the note reads `The draft suggests Tuesday 22 September, 2:10 PM instead.`
It falls back to the raw value if the time cannot be parsed, rather than
printing nothing. The test in `questions.test.ts` asserts the spelled-out
string and also asserts the raw `2026-09-22T14:10` is *absent*, so the old
format cannot creep back in unnoticed. The minutes and the rule are untouched.

**2. Not done — I am not permitted to delete outside the project folder.**
Two attempts were refused by this session's safety classifier, and rather than
look for a way around it I stopped. I did verify all four targets first, and
they are exactly what you described: `upload-25/` and `upload-26/` each hold a
single `code.tar.gz`, all three tarballs are byte-identical (sha256
`7c13402b…`), and the loose `extract-code.yml` is the same workflow deleted
from the repo in ad87734. The archive is a 146-entry snapshot of this project
with nothing in it newer than 20 August, so the live repo is well ahead of it.

Worth knowing before it goes: `C:\Users\Amir\ticketing` is **not** a git repo,
and that tarball is *not* the one preserved in this repo's history — the
hashes differ. So this is a permanent delete of bytes that exist nowhere else.
Harmless as far as I can tell, but it is Amar's own folder and his call. The
commands, for him to run himself:

    cd C:\Users\Amir\ticketing
    rm -r upload-25 upload-26
    rm code.tar.gz extract-code.yml

Everything else there — `backend/`, `frontend/`, `docs/`, `README.md`,
`.gitignore`, `docker-compose.yml`, `support-desk.zip` — is untouched.

**3. Done.** New "Checking Adam for real" section in `CLAUDE.md`, after the
commands: what the harness is, the nine scenarios, `node send.mjs list`, and
why the run tag exists. I confirmed `list` is a real command and the default,
and that there are nine scenarios, before writing it down.

**4. Done.** All committed and pushed. Tests and typecheck first, as always.

Two notes on things I did not change. Your run tag is `HHMM`, so two runs of
the same scenario inside the same minute — or exactly 24 hours apart — still
collide and thread. Rare, and the failure is visible rather than silent, so I
left it; add seconds or a random suffix if it ever bites. And the standing
candidate about defect 2 is right that a model-running test is the honest fix,
but there is a cheaper half: the *reconcile* step is now deterministic and
tested, so only the passenger-name extraction is unpinned. Worth scoping to
just that if someone picks it up.

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
- **Aged test tickets** are still open and skewing the SLA figures on the
  dashboard. That is app data, not code — the Cowork session's job.
