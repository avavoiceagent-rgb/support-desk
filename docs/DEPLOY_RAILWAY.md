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
