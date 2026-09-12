# vexy-mailer

A deliberately small outreach tool: import a CSV, write a short sequence, and
let a worker send it inside a window you choose, stopping the moment somebody
replies — and, on the same contacts, work a calling queue that ends in a booked,
qualified meeting.

The user interface is in Czech. Everything stored in the database — statuses,
outcomes, models, column names — stays in English, so nothing in the app's logic
depends on a translation.

It is not a SaaS and has no accounts, billing, teams, AI personalisation,
warm-up, inbox rotation or dialler. Everything it does is in service of one
guarantee.

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
- **Contacts** — CSV import (`first_name, last_name, company, email, website,
  phone`) with de-duplication by email. Comma, semicolon and tab files all work.
  A phone number is what makes a contact callable.
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
- **Calling** — the same campaign, worked by phone: a queue, twelve outcomes,
  an attempt limit, callbacks, meetings with a qualification judgement, and the
  economics of the whole thing. See below.

## Calling

One campaign is e-mail **and** phone. Calling adds columns to the rows that
already exist rather than a parallel model, and it never touches the e-mail
side: `campaign_contacts.status` stays the e-mail lifecycle, `call_status` is
the calling one, and no calling code writes `next_send_at`, `current_step` or
the sticky sender.

- **Callers** (`/calleri`) are a first-class record, because calling capacity is
  assembled from several people: one caller works across campaigns, one campaign
  is worked by several callers. A caller is never deleted, only deactivated —
  the call history and the campaign's economics reference them.
- **The queue** is ordered: callbacks that are due now, then prospects already
  started but still under the attempt limit (fewest attempts first), then
  contacts nobody has called. Anyone without a phone number is never offered,
  and the order is fully deterministic - it ends on the row id, because a batch
  added by one `INSERT ... SELECT` shares a timestamp and would otherwise come
  back in whatever order the storage engine felt like.
- **One caller at a time.** A caller says who they are once per shift, and the
  prospect they are handed is leased to them for five minutes - the same
  mechanism the send worker uses for its own lock. Two callers on one campaign
  cannot be given the same person to dial, and a closed tab frees the prospect
  on its own.
- **The workspace** (`/volani/<campaign>`) is two clicks per call: dial the
  `tel:` link, press an outcome. Only a callback and a booked meeting open a
  second step, for the date — and a booked meeting also asks the question the
  service is billed on: does it meet the campaign's qualification criteria.
- **Twelve outcomes.** Four of them never reached a human (`no_answer`, `busy`,
  `gatekeeper`, `wrong_number`); the other eight count as a connected call,
  which is the billable unit. "Connected" is stored on the call, not derived at
  read time, so the number cannot move under an invoice.
- **The attempt limit** (4 by default, per campaign) only ever retires a
  prospect whose outcome left them open. A meeting booked on the fourth attempt
  is a meeting, not a prospect who ran out of attempts. The limit is enforced
  where attempts are written, not only where the queue is read, so a stale tab
  cannot push a "max 4" campaign to five.
- **Do not call** is global. "Nevolat" is a decision about the person, so it
  goes on `call_suppression` and removes them from every campaign's queue.
  Deliberately not the e-mail suppression list: phone and e-mail are separate
  consents, and merging them would let a call outcome stop a campaign's e-mail.
- **The meeting lifecycle** is `scheduled → held / no_show / cancelled`, not a
  boolean. A meeting in the diary and one the prospect never turned up to are
  different things, and only one of them is billable. `meeting_held` is derived
  from that column in the database, so the two can never disagree.
- **The funnel**: contacts → called → connected → meetings booked → qualified →
  held → clients, each rate against the stage above it.
- **Economics**: revenue per campaign, per booked or qualified or held meeting,
  per client, or summed from the deal values won; caller cost fixed, hourly or
  per connected call; plus other costs. From those it computes gross profit and
  margin, cost per connected call / booked / qualified / held meeting, and —
  for VEXY's own acquisition — clients won, CAC, ROAS and revenue per connected
  call.
- **Not built**: no dialler, no VoIP, no recording or transcription, no shift
  planning, availability, skill matching or payroll, no automatic assignment of
  callers. The `callers` table is shaped so those can be added later without
  touching anything that references it.

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
4. **[docs/INBOX_DELETION_SEMANTICS.md](docs/INBOX_DELETION_SEMANTICS.md)** — what
   deleting a reply, a campaign or a contact does to the Inbox, and how to
   remove a stale conversation safely.
5. **[docs/PRE_FLIGHT.md](docs/PRE_FLIGHT.md)** — the checklist to work through
   before your first real campaign, e-mail and calling. Do not skip this one.

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

**Unsubscribing.** The link we mail out is signed with an HMAC of the contact
id, so it needs no session and cannot be forged. Opening it (`GET`, or a `HEAD`
from a link checker) renders a confirmation page and changes nothing; the
address is removed only by the `POST` behind that page's button, or by a mail
client's RFC 8058 one-click `POST` to the same URL.

That split is not ceremony. A server-rendered page that suppresses while it
renders is triggered by everything that follows a URL in an email without being
the recipient - Safe Links and its equivalents, spam filters scoring the mail,
link checkers, preview prefetches - so prospects unsubscribe themselves by
receiving the mail. GET and HEAD are safe methods because crawlers assume it.

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

## Calling statuses

Separate from the e-mail statuses above, on the same row, and never mixed.

| `call_status` | Meaning |
| --- | --- |
| `new` | Never dialled |
| `in_progress` | Dialled, still worth dialling again |
| `callback` | They asked to be called back at `next_call_at` |
| `meeting_booked` | A meeting is in the diary |
| `won` | Became a client |
| `lost` | Not interested, no budget, or an unusable number |
| `do_not_call` | Asked us not to phone again (this does **not** stop e-mails) |
| `max_attempts` | Ran out of attempts without ever deciding anything |

Invariants enforced by the database, not by the application: a prospect in
`callback` must have a `next_call_at` (no active contact without a next
action), a booked meeting must have a date, only a booked meeting can carry a
qualification judgement or a meeting outcome, and attempts cannot go negative.

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

`npm test` runs 313 tests. Most are ordinary unit tests, but the interesting
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
  dispatcher is prodded;
- a GET or HEAD on an unsubscribe link - a link scanner, a spam filter, a
  client prefetching a preview - never suppresses anybody, and only a POST
  does.

### Verifying a deployment in a browser

```bash
node tests/e2e/fake-smtp.mjs &          # a local SMTP server on port 2525
npm run build && npm start &
SMTP_PORT=2525 SESSION_SECRET=... DATABASE_URL=... npm run test:e2e
```

75 checks driving the real UI: sign-in, mailbox setup and connection test, CSV
import, sequence editing, campaign start, a worker tick, suppression, the
unsubscribe link under every HTTP method, the calling workspace through to a
booked, qualified meeting and on to a no-show, and the cron endpoint's
authorisation. It writes to whichever database the server points at, so aim it
at a scratch database.

`SESSION_SECRET` and `DATABASE_URL` must match what the server is running with.
The unsubscribe checks mint a real signed link for a real contact and drive it
over HTTP, which is the only place the GET/HEAD safety rule can be proved
against actual routing rather than against the handler in isolation.

## Project layout

```
src/
  app/(app)/        authenticated pages (dashboard, campaigns, contacts, …)
  app/api/cron/     the worker endpoint
  app/u/            public unsubscribe: GET confirms, POST acts
  app/volani/       the caller's workspace
  app/kontakt/      one prospect's timeline, calls and e-mails together
  lib/engine/       dispatch.ts (sending) and replies.ts (IMAP)
  lib/queries/      data access, grouped by subject
  lib/actions/      server actions used by the forms
  lib/schedule.ts   windows, timezones, pacing
  lib/calling.ts    call outcomes, queue order and economics (pure, no DB)
supabase/migrations/
tests/              unit, integration and browser suites
```

## Deliberate limitations

No AI personalisation, no warm-up, no email verification, no CRM, no multi-user
accounts, no billing, no teams, no inbox rotation, no dialler or call recording,
no analytics beyond the counters on the dashboard. Each of those is a reason for something to go wrong
with a mailbox you depend on.
