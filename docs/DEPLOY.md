# Deploying

The app is a standard Next.js project. Vercel is the path of least resistance,
but anything that runs Node 20+ works.

## Deploy to Vercel

### 1. Import the repository

Push to GitHub, then **Add New → Project** on Vercel and import it. The
framework preset, build command and output directory are all detected — leave
them alone.

### 2. Set the environment variables

**Project Settings → Environment Variables.** Add these for **Production**
(and Preview, if you use it):

| Name | Value |
| --- | --- |
| `DATABASE_URL` | Supabase **Transaction pooler**, port **6543** — runtime |
| `MIGRATION_DATABASE_URL` | Supabase **Session pooler**, port **5432** — migrations only |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `APP_URL` | `https://your-app.vercel.app` |

**The two database URLs are not interchangeable.** Both come from
*Project Settings → Database → Connection string* in Supabase and differ only
by port:

- **`DATABASE_URL` must be the transaction pooler (6543).** It is what the
  running app uses. A session-pooler URL here holds a connection for the whole
  session, and a handful of concurrent function instances exhaust the 15-client
  ceiling: `EMAXCONNSESSION — max clients reached in session mode`. The app
  keeps `max: 1` and `prepare: false` to match what a transaction pooler allows.
- **`MIGRATION_DATABASE_URL` must be the session pooler (5432),** or a direct
  connection. `npm run release` serialises concurrent deployments with
  `pg_advisory_lock()`, which is a *session*-scoped lock: under transaction
  pooling the connection returns to the pool after each commit and the lock
  protects nothing. `release` refuses to run against a `:6543` URL rather than
  migrate without a working lock.

Migrations run once per deployment, so the session pooler's ceiling is not a
problem for them.

Two more deserve care:

- **`ENCRYPTION_KEY` can never change** without invalidating every stored
  mailbox password. Keep a copy somewhere safe.
- **`CRON_SECRET` is special-cased by Vercel.** When a variable has exactly
  this name, Vercel Cron sends it as `Authorization: Bearer <value>`
  automatically. Do not rename it.

Set `APP_URL` explicitly rather than relying on inference. A preview deployment
would otherwise mint unsubscribe links pointing at itself, which stop working
when that preview is torn down.

### 3. Set the build command

**Project Settings → Build & Development Settings → Build Command**, override
with:

```
npm run vercel-build
```

That is `npm run release && next build`. Migrations become part of the
deployment — a controlled release step, not something that fires on an HTTP
request.

What `release` does, and what it refuses to do:

- applies pending migrations in order, **each one in a transaction together
  with its `schema_migrations` row**, so a failure rolls back whole and never
  leaves a half-applied schema recorded as done;
- stops the build on the first failure — a broken migration means no deploy,
  not a deploy against a schema the app does not understand;
- **skips entirely on preview and development deployments**, which share
  environment variables with production. Without that guard every pull request
  would migrate your live database;
- skips (without failing) when `DATABASE_URL` is absent, so a local
  `npm run build` still works;
- after migrating, verifies the columns the app actually reads are present —
  a recorded migration is not proof it ran to the end.

It never drops, resets or "repairs" anything. Only the migrations in the
repository, only forwards.

No manual step, and nothing to paste into the Supabase SQL Editor.

### 4. Deploy

Push, or click **Deploy**. When it is live, open the URL and sign in.

Then open **Nastavení → Stav systému**. It shows database, migrations, SMTP,
IMAP, Twilio and the public URL, each judged on its own, and says what to do
about anything missing. It distinguishes *configured* from *verified* — Twilio
credentials existing is not the same as a call going through.

For automated monitoring:

- `GET /api/health` — is the process alive? Does not touch the database, so a
  database outage will not make your host restart-loop the app.
- `GET /api/health?ready=1` — is it fit to serve? `503` with the names of the
  missing migrations when not.

Neither returns a connection string, credentials or any secret value.

### Deploying from somewhere other than Vercel

One command, with the production `DATABASE_URL` in the environment:

```bash
npm run release
```

`npm run release:check` does the same checks but changes nothing.

### 5. Confirm the worker is running

`vercel.json` already declares the cron:

```json
{ "crons": [{ "path": "/api/cron/tick", "schedule": "* * * * *" }] }
```

Check **Project → Cron Jobs** in the dashboard. It should list one job running
every minute, with recent successful invocations.

> **Per-minute cron needs a Vercel Pro plan.** On Hobby, cron jobs run at most
> once a day, which is useless here. Either upgrade, or use an external
> scheduler — see below.

Verify it by hand:

```bash
curl -X POST "https://your-app.vercel.app/api/cron/tick" \
  -H "Authorization: Bearer $CRON_SECRET"
```

You should get JSON back with `"ok": true`. Without the header it must return
`401`; if it does not, `CRON_SECRET` is not set.

There is also a **Run worker now** button on the dashboard.

## Driving the worker from somewhere else

The endpoint is a plain authenticated HTTP call. Anything that can make one
every minute will do, and calling it more often than necessary is harmless —
every operation is idempotent.

### cron-job.org (free)

1. Create a job at <https://console.cron-job.org>.
2. URL: `https://your-app.vercel.app/api/cron/tick`
3. Schedule: every minute.
4. Under *Advanced*, add the header `Authorization: Bearer <CRON_SECRET>`.

If headers are awkward, the secret is also accepted as a query parameter:
`…/api/cron/tick?secret=<CRON_SECRET>`. Prefer the header — query strings turn
up in logs.

### GitHub Actions

```yaml
name: worker
on:
  schedule:
    - cron: "*/5 * * * *"
  workflow_dispatch:
jobs:
  tick:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sS -X POST "${{ secrets.APP_URL }}/api/cron/tick" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" --fail
```

GitHub's scheduler has a five-minute floor and is best-effort under load. With
a five-minute tick a campaign sends at most 12 emails an hour, which is fine
for a 50/day limit.

### A machine you control

```bash
* * * * * curl -sS -X POST https://your-app.vercel.app/api/cron/tick -H "Authorization: Bearer SECRET" > /dev/null
```

## What one tick does

1. Takes the `dispatch` lease, so two overlapping ticks never both send.
2. Converts abandoned claims to `unknown` (never retried).
3. For each active campaign: checks the window, the pacing cursor and the daily
   limit, then sends at most **one** email.
4. Polls IMAP for mailboxes whose last check is older than
   `REPLY_POLL_INTERVAL_MS`.

The route sets `maxDuration = 60`. If a tick ever exceeds it the function is
killed, the lease expires on its own, and any claim left behind becomes
`unknown` rather than being retried.

## Self-hosting

```bash
npm ci
npm run build
npm start          # listens on :3000
```

Put it behind a reverse proxy with TLS, keep the environment variables in the
service definition, and add the cron line above. A `systemd` unit and an nginx
`proxy_pass` are all that is needed — there is nothing Vercel-specific in the
application code beyond `vercel.json`.

## Operating it

**Logs.** Vercel → Deployments → *Runtime Logs*, filtered to
`/api/cron/tick`. Application-level events are in the app's own Activity page,
which is usually the more useful of the two.

**Watch for.** Failed sends on the dashboard; a *Needs review* count above zero
(sends whose outcome is unknown); `IMAP error` entries in the activity log; a
mailbox whose last inbox check is hours old.

**Rotating a user's password** invalidates nothing — sessions are signed with
`SESSION_SECRET`. Rotate that instead to sign everyone out, but note that it
also invalidates every unsubscribe link already sitting in someone's inbox.

**Upgrading: migrate first, deploy second.** In that order, always.

```bash
git pull
npm ci
DATABASE_URL="postgresql://…:5432/postgres" npm run db:migrate   # 1. schema
# only once that prints "Applied N migration(s)":
git push origin main                                             # 2. code
```

The deploy does **not** run migrations — nothing in the build or the runtime
touches the schema. If the code ships first, every request that needs the new
schema fails until you catch up, and that window is entirely avoidable.

The reverse order is safe because migrations are additive: they add tables and
columns, and never change the meaning of an existing one. This is verified,
not assumed — the previous release's full test suite is run against the newest
schema before each schema change ships. Old code simply does not see the new
columns.

A migration applied twice is a no-op: `scripts/migrate.mjs` keeps a
`schema_migrations` table and skips what is already in it. It prints `skip` for
those and `apply` only for what it actually runs, so read the output — an
unexpected `apply` on an old migration means the tracker does not match reality
and you should stop.

Check what production actually has before migrating:

```sql
select name, applied_at from schema_migrations order by name;
```

**Use the direct connection (port 5432), not the transaction pooler (6543),
for migrations.** DDL in PgBouncer's transaction mode is asking for trouble.
