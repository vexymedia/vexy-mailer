# vexy-mailer

A deliberately small cold-email tool for one person: import a CSV, write a
short sequence, and let a worker send it inside a window you choose, stopping
the moment somebody replies.

It is not a SaaS and has no accounts, billing, teams, AI personalisation,
warm-up or inbox rotation. Everything it does is in service of one guarantee.

## The guarantee

**A given contact never receives the same sequence step twice.** Not when two
cron ticks overlap, not when a serverless function is killed mid-send, not when
SMTP times out at the worst possible moment.

Four layers enforce it, in order of authority:

1. **`UNIQUE (campaign_contact_id, step_id)` on `email_sends`.** One row per
   contact per step, forever. The database is the authority, not the code.
2. **The claim is committed before SMTP is touched.** A worker that dies during
   delivery leaves behind a committed `sending` row that blocks every later
   attempt.
3. **An abandoned claim becomes `unknown`, never `failed`.** If we cannot tell
   whether a message left, we never retry it. It is surfaced for you to judge.
4. **Only provably-undelivered errors are retried.** A rejection carrying an
   SMTP response code means the server refused it, so a retry is safe. A socket
   that dies at or after `DATA` is unclassifiable, and therefore final.

The trade is deliberate: a missed email is cheap and recoverable, a prospect
receiving the same email twice is not. Every ambiguous case resolves towards
not sending.

## What it does

- **Mailboxes** — your own SMTP for sending and IMAP for reply detection, with
  a *Test connection* button. Passwords are encrypted with AES-256-GCM and are
  never sent back to the browser.
- **Contacts** — CSV import (`first_name, last_name, company, email, website`)
  with de-duplication by email. Comma, semicolon and tab files all work.
- **Campaigns** — a sender mailbox, a contact list, a daily limit, and a
  sending window with days, hours and an IANA timezone.
- **Sequences** — any number of steps, each with a delay in days measured from
  the previous send, and `{{first_name}}`-style variables with optional
  fallbacks.
- **Sending engine** — one email per campaign per tick, paced across the
  window with randomised gaps, so nothing arrives in a burst.
- **Reply detection** — IMAP polling matches replies by `In-Reply-To` first and
  sender address second, then drops the contact from the sequence immediately.
- **Test mode** — a global switch, on by default, that either redirects every
  email to your own address or simulates sending entirely.
- **Do not contact** — a global suppression list enforced by a database
  trigger, so a suppressed address cannot enter a campaign by any route.

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind CSS v4 · PostgreSQL via
Supabase · nodemailer · imapflow · Vercel.

The database is reached with [postgres.js](https://github.com/porsager/postgres)
directly rather than `supabase-js`. The sending engine needs
`FOR UPDATE SKIP LOCKED` and real transactions, and the Supabase REST API
cannot express those — without them the duplicate-send guarantee would be
decorative.

## Getting started

You need Node 20+ and a PostgreSQL database (Supabase, or a local one).

```bash
git clone <this repo> && cd vexy-mailer
npm install
cp .env.example .env.local     # then fill it in — see below
npm run db:migrate
npm run dev
```

Open <http://localhost:3000> and sign in with `APP_PASSWORD`.

### Filling in `.env.local`

Generate the three secrets:

```bash
openssl rand -base64 32   # ENCRYPTION_KEY  (must decode to exactly 32 bytes)
openssl rand -hex 32      # SESSION_SECRET
openssl rand -hex 32      # CRON_SECRET
```

`DATABASE_URL` comes from Supabase — see
[docs/SETUP_SUPABASE.md](docs/SETUP_SUPABASE.md). `APP_PASSWORD` is whatever
you want to type at the login screen.

> Changing `ENCRYPTION_KEY` later makes every stored mailbox password
> undecryptable and you will have to re-enter them. Keep a copy.

## Setting it up

1. **[docs/SETUP_SUPABASE.md](docs/SETUP_SUPABASE.md)** — create the project,
   get the right connection string, run the migration.
2. **[docs/SETUP_MAILBOX.md](docs/SETUP_MAILBOX.md)** — SMTP and IMAP settings
   for Google Workspace, Microsoft 365, Forpsi, Seznam and others, plus what to
   do about app passwords.
3. **[docs/DEPLOY.md](docs/DEPLOY.md)** — deploy to Vercel and wire up the
   worker.
4. **[docs/PRE_FLIGHT.md](docs/PRE_FLIGHT.md)** — the checklist to work through
   before your first real campaign. Do not skip this one.

## How sending actually works

A cron calls `POST /api/cron/tick` every minute. Each call:

1. Takes a lease on the `dispatch` lock, so overlapping ticks do not both send.
2. Marks any claim abandoned for longer than `SEND_CLAIM_TIMEOUT_MS` as
   `unknown`, and halts those contacts for review.
3. For each **active** campaign, in order: skips it unless the local time is
   inside the sending window, skips it if the pacing cursor is still in the
   future, skips it if the daily limit is used up. Otherwise it claims one due
   contact, commits, sends, and records the result.
4. Polls IMAP for each mailbox whose last check is older than
   `REPLY_POLL_INTERVAL_MS`.

**One email per campaign per tick.** With a per-minute cron that is a ceiling of
1,440 a day, far above any sane limit, and it makes two sends in the same second
structurally impossible.

**Pacing.** After each send the campaign's `next_slot_at` moves forward by
`window_length / daily_limit`, scaled by a random factor between 0.6 and 1.4.
A 50/day limit over an eight-hour window gives an average gap of about
9m36s, jittered between roughly 6 and 13 minutes.

**Follow-ups.** `delay_days` is measured from when the *previous* step was
actually sent, then pulled into the next open window. A follow-up that would
land on a Saturday goes out on Monday morning instead.

**Threading.** We mint our own `Message-ID` for every send and store it.
Follow-ups carry `In-Reply-To` and `References` pointing at step 1, so the
sequence renders as one conversation and replies come back with a header that
identifies the exact send.

## Contact statuses

| Status | Meaning |
| --- | --- |
| `pending` | In the campaign, which has not been started yet |
| `scheduled` | Waiting for the first email |
| `sent` | At least one step delivered, more to come |
| `completed` | Every step delivered |
| `replied` | They answered — removed from the sequence |
| `failed` | A send failed permanently, or its outcome is unknown |
| `unsubscribed` | On the do-not-contact list |

## Test mode

On by default, and applied globally rather than per campaign — one switch, in
one place, stated on every screen.

- **Simulate** — no SMTP connection at all. Sends are recorded in the activity
  log and the sequence advances exactly as it would live, including pacing and
  the daily limit. This is the default on a fresh install.
- **Redirect** — really sends over SMTP, but every message goes to your address
  with the intended recipient in the subject line. The better rehearsal, since
  it exercises the real mail path. Refuses to send at all if no address is set.

## Commands

```bash
npm run dev         # development server
npm run build       # production build
npm start           # run the production build
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest: unit + integration
npm run check       # typecheck, lint, build and test in one go
npm run db:migrate  # apply supabase/migrations
```

### Tests

`npm test` runs 132 tests. Most are ordinary unit tests, but the interesting
ones need a real database:

```bash
createdb vexy_mailer_test
TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/vexy_mailer_test?sslmode=disable" npm test
```

They drop and rebuild the schema from `supabase/migrations` on every run, so
point them at a scratch database. Among other things they assert that:

- 20 concurrent claims on one contact produce exactly one send row;
- 10 concurrent plus 10 sequential worker ticks put exactly one message on the
  wire of a real in-process SMTP server;
- a connection dropped mid-`DATA` is recorded as `unknown` and never retried;
- a 4xx rejection is retried in place, reusing the same ledger row, and still
  delivers exactly once;
- a contact marked replied receives no further follow-up, however hard the
  dispatcher is prodded.

### Verifying a deployment in a browser

```bash
node tests/e2e/fake-smtp.mjs &          # a local SMTP server on port 2525
npm run build && npm start &
SMTP_PORT=2525 npm run test:e2e
```

35 checks driving the real UI: sign-in, mailbox setup and connection test, CSV
import, sequence editing, campaign start, a worker tick, suppression, and the
cron endpoint's authorisation. It writes to whichever database the server
points at, so aim it at a scratch database.

## Project layout

```
src/
  app/(app)/        authenticated pages (dashboard, campaigns, contacts, …)
  app/api/cron/     the worker endpoint
  app/u/            public one-click unsubscribe
  lib/engine/       dispatch.ts (sending) and replies.ts (IMAP)
  lib/queries/      data access, grouped by subject
  lib/actions/      server actions used by the forms
  lib/schedule.ts   windows, timezones, pacing
supabase/migrations/
tests/              unit, integration and browser suites
```

## Deliberate limitations

No AI personalisation, no warm-up, no email verification, no CRM, no multi-user
accounts, no billing, no teams, no inbox rotation, no analytics beyond the
counters on the dashboard. Each of those is a reason for something to go wrong
with a mailbox you depend on.
