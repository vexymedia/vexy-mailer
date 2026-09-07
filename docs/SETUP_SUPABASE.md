# Setting up Supabase

You need one thing from Supabase: a PostgreSQL connection string. The app talks
to the database directly and does not use the Supabase client libraries, Auth,
Storage or Row Level Security.

## 1. Create the project

1. Sign in at [supabase.com](https://supabase.com) and click **New project**.
2. Pick a region close to where the app will run. If you deploy to Vercel in
   Frankfurt, choose `eu-central-1`.
3. Set a database password and **save it somewhere** — Supabase shows it once,
   and it is part of the connection string.
4. Wait for provisioning (a minute or two).

The free tier is comfortably enough. Note that free projects pause after a week
of inactivity; a campaign that runs every day will keep it awake.

## 2. Get the connection string

**Project Settings → Database → Connection string.** There are three, and the
choice matters:

| Mode | Port | Use it? |
| --- | --- | --- |
| Direct connection | 5432 | Local development only |
| **Transaction pooler** | **6543** | **Yes — this is the one for Vercel** |
| Session pooler | 5432 | No |

Take the **Transaction pooler** string. It looks like:

```
postgresql://postgres.abcdefghijklm:YOUR-PASSWORD@aws-0-eu-central-1.pooler.supabase.com:6543/postgres
```

Replace `YOUR-PASSWORD` with the database password from step 1. If it contains
characters like `@`, `:`, `/` or `#`, percent-encode them (`@` → `%40`).

### Why the transaction pooler

Every Vercel serverless invocation is its own process. With direct connections
a burst of traffic exhausts Postgres's connection limit almost immediately. The
pooler multiplexes them onto a small number of real backends.

The trade-off is that PgBouncer's transaction mode cannot support the
extended-protocol prepared statements postgres.js uses by default. The app
detects port 6543 (or a `pooler.supabase.com` host) and turns them off for you —
see `src/lib/db.ts`. You do not need to add `?pgbouncer=true`.

## 3. Run the migration

Put the connection string in `.env.local` as `DATABASE_URL`, then:

```bash
npm run db:migrate
```

You should see:

```
  apply  0001_init.sql ... ok

Applied 1 migration(s).
```

Applied files are recorded in `schema_migrations`, so re-running is a no-op.
Every migration is also written to be idempotent on its own.

### Or apply it by hand

If you would rather not run the script, open **SQL Editor** in the Supabase
dashboard, paste the contents of `supabase/migrations/0001_init.sql`, and run
it. It only needs the `pgcrypto` extension, which Supabase has available.

## 4. Check it worked

**Table Editor** should now list:

`app_settings` · `mailboxes` · `contacts` · `suppression_list` · `campaigns` ·
`sequence_steps` · `campaign_contacts` · `email_sends` · `replies` ·
`activity_logs` · `worker_locks`

To confirm the constraint that matters, run this in the SQL Editor:

```sql
select conname
  from pg_constraint
 where conrelid = 'email_sends'::regclass and contype = 'u';
```

It must return `email_sends_campaign_contact_id_step_id_key`. That single index
is what makes a duplicate send impossible; if it is missing, stop and re-run
the migration.

`app_settings` should hold exactly one row with `test_mode = true`. A fresh
install cannot email a real prospect until you deliberately change that.

## A note on security

There is no Row Level Security and no Supabase Auth, because there is exactly
one user and the app authenticates them itself. The connection string is a
full-access database credential:

- keep it out of git (`.env.local` is already ignored);
- do not expose it to the browser — no `NEXT_PUBLIC_` prefix, ever;
- rotate the database password in Supabase if it leaks.

Mailbox passwords are encrypted with AES-256-GCM before they are stored, so a
database dump alone does not reveal them. That protection is only as good as
`ENCRYPTION_KEY`, which lives in the environment, not the database — keep them
apart.

## Backups

Supabase takes daily backups on paid plans. On the free tier, `email_sends` is
the table worth protecting: it is the record of who has already been contacted,
and losing it is what leads to sending the same email twice.

```bash
pg_dump "$DATABASE_URL" -t email_sends -t campaign_contacts -t contacts > backup.sql
```

## Using a local PostgreSQL instead

Nothing here requires Supabase. Any PostgreSQL 14+ works:

```bash
createdb vexy_mailer
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/vexy_mailer?sslmode=disable" npm run db:migrate
```

`sslmode=disable` matters for a local server; without it the client tries TLS
and fails.
