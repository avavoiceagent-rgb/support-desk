# Deploying so your team can use it

Right now the app only runs on whoever's machine started it. "Hosting" just means
putting it somewhere on the internet that stays on all the time, so your team can open
it from a browser whenever they want — like any other web app.

We'll use **Railway** (railway.app), which is built for exactly this: no server
management, no GitHub required, just a couple of commands. It has a free trial and then
costs roughly $5–20/month for a team this size (small app + small database).

You'll need [Node.js](https://nodejs.org) installed on your own computer to run these
commands (or ask whoever is doing this step to run them from this project folder).

## 1. Install the Railway command-line tool

```
npm install -g @railway/cli
```

## 2. Sign in

```
railway login
```

This opens a browser tab to sign in / create a free Railway account. (If you're doing
this from a remote machine with no browser, use `railway login --browserless` instead —
it prints a link and a short code to enter from any device.)

## 3. Create the project

From inside this project's folder:

```
railway init --name support-desk
```

## 4. Add a database

```
railway add --database postgres
```

This provisions a managed Postgres database inside your Railway project — you don't
need to install or manage Postgres yourself.

## 5. Deploy

```
railway up
```

This uploads the code and starts building/deploying it. Follow the prompt to link it to
a new service in the project. It'll take a couple of minutes the first time.

## 6. Set the environment variables

Open your project in the Railway dashboard (`railway open`), click on the app service →
**Variables**, and add these (see `backend/.env.example` for what each one means):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Click "New Variable" → "Add Reference" → choose the Postgres service's `DATABASE_URL`. This links the app to the database Railway just created. |
| `NODE_ENV` | `production` |
| `APP_BASE_URL` | The URL Railway gives your service (shown at the top of the service page, looks like `https://support-desk-production-xxxx.up.railway.app`) |
| `JWT_SECRET` | A long random string — generate one locally with `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | A random key — generate one locally with `openssl rand -base64 32`. **Write this down somewhere safe** — if it's lost, every connected mailbox has to be reconnected. |
| `GOOGLE_CLIENT_ID` | From `docs/GOOGLE_OAUTH_SETUP.md` |
| `GOOGLE_CLIENT_SECRET` | From `docs/GOOGLE_OAUTH_SETUP.md` |
| `GOOGLE_REDIRECT_URI` | `<your APP_BASE_URL>/api/email-accounts/gmail/callback` |

Saving variables triggers a redeploy automatically.

## 7. Add the production redirect URI to Google

Go back to Google Cloud Console → **APIs & Services → Credentials** → your OAuth client
→ **Authorized redirect URIs** → add the same `GOOGLE_REDIRECT_URI` value from the table
above (in addition to the localhost one you may already have for local testing).

## 8. You're live

Open the Railway URL, create your admin account, and go to **Settings → Connect Gmail**.
Share the URL with your team so they can log in (an admin adds their accounts from
**Settings → Team members**).

## Updating later

Whenever the code changes, redeploy with:

```
railway up
```
