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
| `DATABASE_URL` | The Supabase **transaction pooler** string, port 6543 |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `APP_PASSWORD` | The password you will type to sign in |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `APP_URL` | `https://your-app.vercel.app` |

Two of these deserve care:

- **`ENCRYPTION_KEY` can never change** without invalidating every stored
  mailbox password. Keep a copy somewhere safe.
- **`CRON_SECRET` is special-cased by Vercel.** When a variable has exactly
  this name, Vercel Cron sends it as `Authorization: Bearer <value>`
  automatically. Do not rename it.

Set `APP_URL` explicitly rather than relying on inference. A preview deployment
would otherwise mint unsubscribe links pointing at itself, which stop working
when that preview is torn down.

### 3. Run the migration

From your machine, with production `DATABASE_URL` in the environment:

```bash
DATABASE_URL="postgresql://…:6543/postgres" npm run db:migrate
```

Or paste `supabase/migrations/0001_init.sql` into the Supabase SQL Editor.

### 4. Deploy

Push, or click **Deploy**. When it is live, open the URL and sign in.

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

**Rotating `APP_PASSWORD`** invalidates nothing — sessions are signed with
`SESSION_SECRET`. Rotate that instead to sign everyone out, but note that it
also invalidates every unsubscribe link already sitting in someone's inbox.

**Upgrading.** Pull, `npm ci`, `npm run db:migrate`, redeploy. Migrations are
additive and idempotent.
