# Support Desk — email-to-ticket system

Turns email sent to a shared inbox into tickets your team can view, assign, reply to,
leave internal notes on, and track through Open / In Progress / Closed. Starts with
Gmail; the mail integration is written behind a provider interface so Outlook/Microsoft
365 support can be added later without touching the rest of the app.

## How it's built

One app, two parts, one deploy:

- **`backend/`** — Node.js/TypeScript/Express API, Postgres database (via Drizzle ORM),
  a background poller that checks the connected mailbox every minute and turns new email
  into tickets, and (in production) serves the built frontend too.
- **`frontend/`** — React/Vite/Tailwind single-page app: login, ticket list with
  filters, ticket detail (conversation + reply + internal notes + assign/status),
  settings (connect Gmail, manage team members).

The reasoning behind the trickier decisions (email threading, idempotent ingestion,
token encryption, avoiding duplicate/looping tickets) is documented inline as comments
in `backend/src/mail/`.

## Local development

Requirements: Node.js 20+, and a Postgres database (either install Postgres locally, or
run one via Docker — see `docker-compose.yml`).

```bash
# 1. Backend
cd backend
cp .env.example .env
# edit .env: set DATABASE_URL to your local Postgres, generate JWT_SECRET and
# ENCRYPTION_KEY (commands are in the .env.example comments)
npm install
npm run db:migrate
npm run dev            # http://localhost:4000

# 2. Frontend (separate terminal)
cd frontend
npm install
npm run dev             # http://localhost:5173, proxies /api to :4000
```

Open http://localhost:5173, you'll land on a one-time "create your admin account"
screen. From there you can log in and use the app immediately — tickets just won't
appear until a mailbox is connected (see below) or you run the demo seed:

```bash
cd backend
npm run seed   # adds 2 sample tickets so you can try the UI without a real mailbox
```

## Connecting Gmail

Walk through `docs/GOOGLE_OAUTH_SETUP.md` once (about 10 minutes, no technical
background needed) to get the two credential values Google requires, then go to
**Settings → Connect Gmail** in the app.

## Putting it online for your team

The app isn't reachable by anyone but you until it's deployed somewhere. Walk through
`docs/DEPLOY_RAILWAY.md` — it's a handful of copy-pasteable commands, no server
management or GitHub required.

## Adding Outlook/Microsoft 365 later

The mail integration is written behind `backend/src/mail/provider.interface.ts`. Adding
Outlook means implementing that same interface against the Microsoft Graph API in a new
`backend/src/mail/outlook/` folder and registering it in `backend/src/mail/registry.ts`
— the ticket data model, ingestion pipeline, threading, and UI don't need to change.

## Tests

```bash
cd backend
npm test   # ingestion/threading logic — dedupe, thread grouping, reopen-on-reply, etc.
```
