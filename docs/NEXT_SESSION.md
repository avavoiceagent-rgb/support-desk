# Starting a new session

Two prompts, one for each Claude. Copy the one you need and paste it in.

- **Cowork** (the Claude desktop app) — sees the live desk, the real tickets and
  drafts, Railway, and runs the full test suite against a real Postgres. Cannot
  push.
- **Claude Code** (the terminal) — reads the whole repo, deletes files, commits
  and pushes. Cannot see the live app, and cannot run the database tests.

---

## For a Cowork session

Paste everything below the line. Delete the "What I want to do next" line and
write your own if you have something specific in mind.

---

I'm Amar. I'm not a programmer — explain things in plain language and tell me
what will visibly happen, not how the code is shaped.

We're working on **Support Desk**: a live email-to-ticket helpdesk for my
NY/NJ ground-transportation company. Mail arrives at a Gmail inbox, becomes a
ticket, gets sorted, and an AI agent called Adam drafts a reply for a person to
review. Nothing reaches a customer without me pressing Send. It runs on Railway
with a Neon Postgres database.

The code is on my machine at `C:\Users\Amir\support-desk` and the desktop bridge
is connected, so you can read and write it there.

**Start by reading these two files, in this order:**

1. `C:\Users\Amir\support-desk\CLAUDE.md` — the rules, the stack, and where
   things are. The rules in it are not negotiable.
2. `C:\Users\Amir\support-desk\docs\HANDOFF.md` — read the section
   **"Where things stand — 25 August"** and everything after it. That is the
   most recent state. Earlier sections are history and some of it is stale;
   the 25 August section lists the corrections.

**How we work together:**

- You can't push to GitHub. You write files to my disk through the bridge, I
  review them in GitHub Desktop and push. Pushing to `main` is the deploy —
  Railway builds it automatically in a couple of minutes.
- Always run `cd backend && npm test` and `npx tsc --noEmit`, and
  `cd frontend && npm run build`, before you hand me anything.
- Secrets live only in Railway environment variables. Never print, echo, log or
  ask me for one. `ENCRYPTION_KEY` especially — losing it means reconnecting
  Gmail from scratch.
- All third-party accounts belong to the Ava identity. Never create accounts,
  type passwords, or accept OAuth consent screens — hand those to me.
- Never invent a fact for a customer. If the email didn't say it, Adam asks.
- Never ask a model for something you can look up.
- Look at the live app rather than reasoning about it. Last session the reported
  problem was "we keep running short of drivers"; the actual cause was that the
  rota had run out, and adding drivers would have changed nothing. Checking the
  database took two minutes.
- A test that passes before the fix proves nothing. Check it fails first.

**Two things that need doing regardless of what else we work on:**

- The Railway credit was down to about $4.17 / 7 days. Ask me whether I've
  topped it up. When it runs out the desk stops.
- The Google Maps API key still needs rotating. That one is mine to do.

**What I want to do next:** [say what you want here, or ask me]

---

## For a Claude Code session

Paste everything below the line into Claude Code, in the project folder.

If there is an open task in `docs/HANDOFF.md` you don't need any of this — just
say `read docs/HANDOFF.md and do it`. Use the prompt below when you want Claude
Code caught up without a specific job attached.

---

I'm Amar. I'm not a programmer — explain things in plain language and tell me
what will visibly happen, not how the code is shaped.

**Read these two files before anything else, in this order:**

1. `CLAUDE.md` — the rules, the stack, and where things are. The rules in it are
   not negotiable.
2. `docs/HANDOFF.md` — read the section **"Where things stand — 25 August"** and
   everything after it. That is the current state. Earlier sections are the
   history of this project and some of it is now wrong; the 25 August section
   says which parts.

**Things about this machine that will otherwise waste your time:**

- **The database tests cannot run here.** They need Postgres on localhost:5432
  and there is none. Around 146 of the tests will fail on a refused connection.
  That is the environment, not a regression — check the failures are connection
  errors and not assertions, then say so rather than trying to fix them. The
  Cowork session runs the real suite before anything ships. `npx tsc --noEmit`
  does work here and must pass.
- **The frontend may have no `node_modules`.** If `npm run build` cannot run,
  say that you read the frontend files rather than implying you built them.
- **Line endings.** My working copy is CRLF and the repo is LF. `git status` may
  show files as modified when nothing has changed. Ignore it.

**About pushing.** You can push and the Cowork session cannot, which makes you
the one who has to be careful. I often have uncommitted changes sitting in my
working copy from the other session — check `git status` before you commit, and
tell me what you found rather than sweeping it into your own commit. If there is
work there you did not write, stop and ask me.

**When you finish a task from `docs/HANDOFF.md`:** replace the `## Reply`
section with what you actually did — including anything you disagreed with,
could not verify, or deliberately left alone. Leave the task above it so the
exchange reads in order. Commit and push.

Say so plainly if a task is wrong. Cowork writes them without being able to run
the code and has been wrong before.

**What I want you to do:** [say what you want here, or ask me]
