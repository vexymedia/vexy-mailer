-- =====================================================================
-- vexy-mailer :: initial schema
-- =====================================================================
-- Design notes that matter:
--   * Every email address column is stored lower-cased and enforced with a
--     CHECK, so a plain UNIQUE index is a real case-insensitive uniqueness
--     guarantee without depending on the citext extension.
--   * email_sends has UNIQUE (campaign_contact_id, step_id). That single
--     constraint is what makes a duplicate send impossible, even if two
--     workers run concurrently or one dies mid-flight.
--   * campaign_contacts has a BEFORE INSERT trigger that rejects any contact
--     present in suppression_list, so "do not contact" cannot be bypassed by
--     a code path that forgot to check.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- app_settings : single-row table holding the global kill switch
-- ---------------------------------------------------------------------
create table if not exists app_settings (
  id              boolean primary key default true,
  test_mode       boolean not null default true,
  test_email      text,
  -- Defaults to 'simulate': a fresh install is both safe AND immediately
  -- usable. 'redirect' would be equally safe but needs an address before it
  -- can do anything, which reads as the app being broken.
  test_behavior   text not null default 'simulate'
                    check (test_behavior in ('redirect', 'simulate')),
  updated_at      timestamptz not null default now(),
  constraint app_settings_singleton check (id)
);

-- Ships with test mode ON. A fresh install cannot send to a real prospect
-- until someone deliberately turns it off.
insert into app_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- mailboxes
-- ---------------------------------------------------------------------
create table if not exists mailboxes (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  from_name             text not null,
  from_email            text not null check (from_email = lower(from_email)),

  smtp_host             text not null,
  smtp_port             integer not null check (smtp_port between 1 and 65535),
  smtp_username         text not null,
  smtp_password_enc     text not null,
  smtp_secure           boolean not null default true,

  imap_host             text,
  imap_port             integer check (imap_port between 1 and 65535),
  imap_username         text,
  imap_password_enc     text,
  imap_secure           boolean not null default true,

  -- IMAP cursor. uidvalidity guards against the server renumbering UIDs.
  imap_last_uid         bigint,
  imap_uidvalidity      bigint,
  imap_last_checked_at  timestamptz,
  imap_last_error       text,

  last_test_ok          boolean,
  last_test_at          timestamptz,
  last_test_error       text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------
create table if not exists contacts (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique check (email = lower(email) and email like '%@%'),
  first_name  text,
  last_name   text,
  company     text,
  website     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- suppression_list : global do-not-contact
-- ---------------------------------------------------------------------
create table if not exists suppression_list (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique check (email = lower(email)),
  reason      text not null default 'manual',
  note        text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------
create table if not exists campaigns (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  mailbox_id         uuid not null references mailboxes(id) on delete restrict,

  -- A campaign is ALWAYS created as draft; nothing auto-starts.
  status             text not null default 'draft'
                       check (status in ('draft', 'active', 'paused', 'completed')),

  daily_limit        integer not null default 50 check (daily_limit between 1 and 2000),

  -- ISO weekday numbers: 1 = Monday .. 7 = Sunday
  send_days          smallint[] not null default '{1,2,3,4,5}',
  -- Minutes from local midnight, e.g. 08:00 -> 480, 16:00 -> 960
  send_start_minute  integer not null default 480  check (send_start_minute between 0 and 1439),
  send_end_minute    integer not null default 960  check (send_end_minute between 1 and 1440),
  timezone           text not null default 'Europe/Prague',

  -- Pacing cursor: the earliest instant this campaign may send again.
  next_slot_at       timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  started_at         timestamptz,
  completed_at       timestamptz,

  constraint campaigns_window_valid check (send_end_minute > send_start_minute),
  constraint campaigns_days_valid check (
    array_length(send_days, 1) between 1 and 7
    and send_days <@ '{1,2,3,4,5,6,7}'::smallint[]
  )
);

-- ---------------------------------------------------------------------
-- sequence_steps
-- ---------------------------------------------------------------------
create table if not exists sequence_steps (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references campaigns(id) on delete cascade,
  step_number  integer not null check (step_number >= 1),
  -- Days to wait after the PREVIOUS step was sent. Step 1 must be 0.
  delay_days   integer not null default 0 check (delay_days between 0 and 365),
  subject      text not null,
  body         text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (campaign_id, step_number)
);

create index if not exists sequence_steps_campaign_idx
  on sequence_steps (campaign_id, step_number);

-- ---------------------------------------------------------------------
-- campaign_contacts : one contact's journey through one campaign
-- ---------------------------------------------------------------------
create table if not exists campaign_contacts (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  contact_id    uuid not null references contacts(id) on delete cascade,

  status        text not null default 'pending'
                  check (status in ('pending', 'scheduled', 'sent', 'replied',
                                    'completed', 'failed', 'unsubscribed')),

  -- The step_number that will be sent NEXT.
  current_step  integer not null default 1,
  next_send_at  timestamptz,

  last_sent_at  timestamptz,
  replied_at    timestamptz,
  completed_at  timestamptz,
  last_error    text,

  -- Message-ID of step 1, used to thread every follow-up onto one conversation.
  thread_message_id text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (campaign_id, contact_id)
);

create index if not exists campaign_contacts_due_idx
  on campaign_contacts (campaign_id, status, next_send_at);
create index if not exists campaign_contacts_contact_idx
  on campaign_contacts (contact_id);

-- Hard guarantee for "do not contact": a suppressed address can never be
-- inserted into a campaign, regardless of which code path tries.
create or replace function reject_suppressed_contact() returns trigger
language plpgsql as $$
declare
  v_email text;
begin
  select email into v_email from contacts where id = new.contact_id;
  if exists (select 1 from suppression_list s where s.email = v_email) then
    raise exception 'contact % is on the suppression list', v_email
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists campaign_contacts_suppression_guard on campaign_contacts;
create trigger campaign_contacts_suppression_guard
  before insert on campaign_contacts
  for each row execute function reject_suppressed_contact();

-- ---------------------------------------------------------------------
-- email_sends : THE anti-duplicate ledger
-- ---------------------------------------------------------------------
-- Lifecycle:
--   sending  -> row claimed and COMMITTED before SMTP is touched
--   sent     -> SMTP accepted the message
--   failed   -> provably not delivered; may be retried in place
--   unknown  -> we cannot tell whether it went out; NEVER retried
--   skipped  -> suppressed at send time (test-mode simulate, etc.)
create table if not exists email_sends (
  id                   uuid primary key default gen_random_uuid(),
  campaign_id          uuid not null references campaigns(id) on delete cascade,
  campaign_contact_id  uuid not null references campaign_contacts(id) on delete cascade,
  step_id              uuid not null references sequence_steps(id) on delete cascade,
  step_number          integer not null,

  status               text not null default 'sending'
                         check (status in ('sending', 'sent', 'failed', 'unknown', 'skipped')),

  to_email             text not null,          -- actual recipient (may be the test address)
  intended_email       text not null,          -- who it was really for
  subject              text not null,
  body                 text not null,

  message_id           text,                   -- Message-ID header we emitted
  attempt_count        integer not null default 1,
  error                text,
  next_retry_at        timestamptz,

  claimed_at           timestamptz not null default now(),
  sent_at              timestamptz,
  created_at           timestamptz not null default now(),

  -- ****  This is the guarantee. One row per contact per step. Ever.  ****
  unique (campaign_contact_id, step_id)
);

create index if not exists email_sends_campaign_sent_idx
  on email_sends (campaign_id, sent_at) where status = 'sent';
create index if not exists email_sends_message_id_idx
  on email_sends (message_id) where message_id is not null;
create index if not exists email_sends_stuck_idx
  on email_sends (claimed_at) where status = 'sending';

-- ---------------------------------------------------------------------
-- replies
-- ---------------------------------------------------------------------
create table if not exists replies (
  id                  uuid primary key default gen_random_uuid(),
  mailbox_id          uuid not null references mailboxes(id) on delete cascade,
  contact_id          uuid references contacts(id) on delete set null,
  campaign_contact_id uuid references campaign_contacts(id) on delete set null,
  matched_send_id     uuid references email_sends(id) on delete set null,

  from_email          text not null,
  subject             text,
  snippet             text,
  imap_message_id     text not null,
  in_reply_to         text,
  imap_uid            bigint,
  received_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),

  -- Same physical message must never be recorded twice.
  unique (mailbox_id, imap_message_id)
);

create index if not exists replies_contact_idx on replies (contact_id);

-- ---------------------------------------------------------------------
-- activity_logs
-- ---------------------------------------------------------------------
create table if not exists activity_logs (
  id                  bigserial primary key,
  created_at          timestamptz not null default now(),
  level               text not null default 'info' check (level in ('info', 'warn', 'error')),
  action              text not null,
  detail              text,
  campaign_id         uuid references campaigns(id) on delete cascade,
  contact_id          uuid references contacts(id) on delete set null,
  campaign_contact_id uuid references campaign_contacts(id) on delete set null
);

create index if not exists activity_logs_created_idx on activity_logs (created_at desc);
create index if not exists activity_logs_campaign_idx on activity_logs (campaign_id, created_at desc);

-- ---------------------------------------------------------------------
-- worker_locks : lease-based mutual exclusion for the cron worker
-- ---------------------------------------------------------------------
-- Session-level pg_advisory_lock is unusable behind Supabase's transaction
-- pooler (connections are not sticky across statements), and a serverless
-- worker cannot hold a transaction open across an SMTP round trip. A lease
-- row solves both: it is acquired with a single atomic UPDATE and expires on
-- its own if the worker dies mid-tick.
create table if not exists worker_locks (
  name          text primary key,
  locked_until  timestamptz not null default now() - interval '1 second',
  holder        text,
  acquired_at   timestamptz
);

insert into worker_locks (name) values ('dispatch'), ('replies')
  on conflict (name) do nothing;
