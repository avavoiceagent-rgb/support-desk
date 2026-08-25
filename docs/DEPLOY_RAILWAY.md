# Deploying so your team can use it

The app is hosted on **Railway** (railway.app). "Hosting" just means it lives
somewhere on the internet that stays on all the time, so your team can open it from a
browser whenever they want — like any other web app. It costs roughly $5–20/month for a
team this size (small app + small database).

## How deploying works

There is nothing to install and no commands to run. Releasing a change is three steps:

1. The change is made in your local copy of the project at `C:\Users\Amir\support-desk`.
2. You open **GitHub Desktop**, look over what changed, write a short note describing
   it, and click **Commit to main**.
3. You click **Push origin**.

That's it. Pushing to `main` is the deploy. Railway notices the new code within a few
seconds, builds it, and puts the new version live automatically — usually a couple of
minutes from pushing to being live. You can watch it happen in the Railway dashboard
under the service's **Deployments** tab.

If a build fails, Railway keeps the previous working version running, so the app your
team is using never goes down mid-build.

## Running a one-off command on the live database

Occasionally something has to be run against the real database once — topping up
the driver rota, for instance. The live `DATABASE_URL` lives in Railway and stays
there, so this is your step and nobody else's.

In the Railway dashboard, open the app service and click the **Console** tab. It
opens at the root of the project, and it runs the built app, not the source. Two
things follow from that:

- Use `node backend/dist/...`, not `npm run something`. The `npm run` shortcuts
  live in `backend/package.json` while the console starts a directory above it,
  and they rely on a tool called `tsx` that the production image does not carry.
- Run it after the deploy has finished, so the file you are calling is the one
  you just pushed.

### Topping up the driver rota

    node backend/dist/db/extend-roster.js --days 365

Drivers are only bookable on days they are rostered, and the rota does not
stretch on for ever. When it runs out, every booking past the end of it finds no
driver and offers itself to a partner instead — which on the screen looks exactly
like being short of drivers, and is not. Running this pushes the rota out by
however many days you ask for, from today.

It only ever adds. It does not change or delete a booking, an invoice, a ticket
or a message, it leaves days that are already rostered exactly as they are
(including anybody's booked leave), and running it twice does nothing the second
time. So if you are not sure whether you have run it, run it — it will tell you
it added nothing.

It prints what it did:

    Roster extended: {
      vehiclesAdded: 8,
      driversAdded: 15,
      affiliatesAdded: 16,
      rateBandsAdded: 64,
      shiftsAdded: 7931,
      rosteredThrough: 'Wednesday 25 August 2027'
    }

`rosteredThrough` is the date to remember. Run it again before then.

---

Everything below is one-time setup. It has already been done — it's written down here
in case it ever has to be redone or checked.

## The Railway project

The Railway project holds two things: the **app service**, which is connected to this
project's GitHub repository and watches the `main` branch, and a **Postgres database**,
which is managed by Railway so nobody has to install or run Postgres themselves.

## Environment variables

Open the project in the Railway dashboard, click on the app service → **Variables** (see
`backend/.env.example` for what each one means):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Click "New Variable" → "Add Reference" → choose the Postgres service's `DATABASE_URL`. This links the app to the database. |
| `NODE_ENV` | `production` |
| `APP_BASE_URL` | The URL Railway gives your service (shown at the top of the service page, looks like `https://support-desk-production-xxxx.up.railway.app`) |
| `JWT_SECRET` | A long random string — generate one locally with `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | A random key — generate one locally with `openssl rand -base64 32`. **Write this down somewhere safe** — if it's lost, every connected mailbox has to be reconnected. |
| `GOOGLE_CLIENT_ID` | From `docs/GOOGLE_OAUTH_SETUP.md` |
| `GOOGLE_CLIENT_SECRET` | From `docs/GOOGLE_OAUTH_SETUP.md` |
| `GOOGLE_REDIRECT_URI` | `<your APP_BASE_URL>/api/email-accounts/gmail/callback` |

Saving variables triggers a redeploy automatically.

## The production redirect URI in Google

Google Cloud Console → **APIs & Services → Credentials** → your OAuth client →
**Authorized redirect URIs** → add the same `GOOGLE_REDIRECT_URI` value from the table
above (in addition to the localhost one you may already have for local testing).

## Going live

Open the Railway URL, create your admin account, and go to **Settings → Connect Gmail**.
Share the URL with your team so they can log in (an admin adds their accounts from
**Settings → Team members**).
