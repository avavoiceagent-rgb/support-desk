# Connecting Gmail — Google Cloud setup

Before the app can read and reply to email from your Gmail inbox, Google requires you to
register the app in a free "Google Cloud" project and get two secret values (a Client ID
and Client Secret). This is a one-time setup, takes about 10 minutes, and you don't need
any technical background — just follow the steps below in order.

**Do this with the Google account whose inbox you want to turn into a support inbox**
(e.g. support@yourcompany.com, or your own Gmail while testing).

## 1. Create a Google Cloud project

1. Go to https://console.cloud.google.com/ and sign in.
2. Click the project dropdown at the top of the page → **New Project**.
3. Name it something like "Support Ticketing" → **Create**.
4. Make sure the new project is selected in the dropdown at the top.

## 2. Enable the Gmail API

1. In the search bar at the top, type **Gmail API** and open it.
2. Click **Enable**.

## 3. Configure the OAuth consent screen

1. In the left sidebar, go to **APIs & Services → OAuth consent screen**.
2. Choose **External** (unless you have a Google Workspace organization and want
   **Internal**) → **Create**.
3. Fill in the required fields (app name, your email as support email and developer
   contact). You can leave optional fields blank.
4. On the **Scopes** step, click **Add or remove scopes** and add:
   - `.../auth/gmail.modify`
   - `.../auth/gmail.send`
5. On the **Test users** step, add the Gmail address you'll connect (this lets you use it
   immediately, before finishing step 5 below).
6. Save through to the summary page.

### ⚠️ Important: move publishing status to "In production"

By default, new apps sit in **Testing** status. In that status, Google expires the app's
access after 7 days — meaning replies would silently stop working a week after you set
this up, with no obvious error message.

1. Still on the **OAuth consent screen** page, find **Publishing status**.
2. Click **Publish App** to move it to **In production**.

This does **not** require Google's app-verification review (that's only required to
remove the "unverified app" warning screen during login, or if you exceed 100 users —
neither applies to a small internal support inbox). You'll just click through one extra
"Google hasn't verified this app → Advanced → Go to (app name)" confirmation the first
time you connect, which is expected and safe since it's your own app.

## 4. Create OAuth credentials

1. Go to **APIs & Services → Credentials**.
2. Click **Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Name it anything (e.g. "Support Desk App").
5. Under **Authorized redirect URIs**, click **Add URI** and enter:
   - While testing locally: `http://localhost:4000/api/email-accounts/gmail/callback`
   - Once deployed: `https://<your-app-url>/api/email-accounts/gmail/callback`
     (you can add both at once, or come back and add the second one after deploying)
6. Click **Create**. A popup shows your **Client ID** and **Client Secret** — copy both.

## 5. Add the credentials to the app

Open `backend/.env` (created from `.env.example`) and fill in:

```
GOOGLE_CLIENT_ID=<the Client ID from step 4>
GOOGLE_CLIENT_SECRET=<the Client Secret from step 4>
GOOGLE_REDIRECT_URI=http://localhost:4000/api/email-accounts/gmail/callback
```

(When you deploy, you'll set these same three variables on Railway instead, using the
deployed URL for `GOOGLE_REDIRECT_URI` — see `docs/DEPLOY_RAILWAY.md`.)

Restart the app, go to **Settings** in the web app, and click **Connect Gmail**. Sign in
with the Gmail account, approve access (click through the "unverified app" screen —
Advanced → Go to (app name) — this is expected, see the note in step 3), and you're done.
New email to that inbox will start appearing as tickets within about a minute.
