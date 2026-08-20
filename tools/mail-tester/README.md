# Test mail sender

Sends scripted emails to the support desk inbox so Adam's behaviour can be
checked across the situations that actually happen, instead of one hand-typed
email at a time.

This folder is not part of the app. Railway only builds `backend/` and
`frontend/`, so nothing here is ever deployed.

## One-time setup

1. **Generate a Gmail app password** for the sending account
   (amarpant30@gmail.com). Google requires 2-Step Verification on the account
   first, then app passwords live at <https://myaccount.google.com/apppasswords>.
   It is a 16-character code, not your Gmail password, and you can revoke it
   there whenever you like.

2. **Create the .env file.** Copy `.env.example` to `.env` in this folder and
   paste the app password in. `.env` is gitignored and must never be committed —
   if it ever appears in GitHub Desktop as a change, do not commit it; tell
   Claude instead.

3. **Install the one dependency**, from inside this folder:

       npm install

## Using it

    node send.mjs list          # what scenarios exist and what each proves
    node send.mjs new-internal  # send one
    node send.mjs all           # send all nine, 45 seconds apart
    node send.mjs all --delay 20

Each send prints what to look for when the ticket appears. Those checks are
for a person to read — nothing is asserted automatically, because what is being
judged is the English Adam wrote, not a number.

Then open the desk and wait a minute or two for the poll:
<https://support-desk-production-90e4.up.railway.app/tickets>

## The scenarios

| id | proves |
|---|---|
| `new-internal` | the everyday case: pickup time, vehicle, and no pointless questions |
| `new-external` | a trip leaving NY/NJ is flagged for a partner and promises nothing |
| `arrival` | an arrival asks for the flight number so the driver can track it |
| `for-someone-else` | booker and passenger kept apart; asks for the passenger's mobile |
| `vague` | with almost no detail, Adam asks rather than invents |
| `too-late` | a pickup that would miss the flight raises an internal warning |
| `change` | a change request is sub-labelled correctly and gets no draft |
| `accounting` | an invoice query lands in Accounting |
| `newsletter` | bulk mail auto-closes and never touches the SLA |

## A caution

These send real email from a real account. Nine at a time is fine; running
`all` in a loop is not — Gmail will rate-limit the account, and every send
creates a real ticket that someone then has to close.
