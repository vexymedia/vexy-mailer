-- =====================================================================
-- vexy-mailer :: multi-mailbox campaigns + unified inbox
-- =====================================================================
-- Two features, one migration, because they share the sender model.
--
-- Design decisions worth stating up front:
--
--   * A campaign's sender pool becomes a join table. campaigns.mailbox_id is
--     kept (nullable, no longer read by the engine) so no existing row loses
--     information and the change is reversible.
--
--   * Quota is accounted on email_sends.mailbox_id - the mailbox that actually
--     sent - not derived through the campaign, because a send's sender is now
--     independent of the campaign.
--
--   * Manual replies deliberately do NOT live in email_sends. That table is
--     the campaign send ledger and the thing daily quota counts; mixing human
--     replies into it would let an inbox conversation eat the cold-email cap.
--
--   * Each mailbox carries its own timezone, so "sent today" has one
--     unambiguous meaning per mailbox even when campaigns using it disagree.
-- =====================================================================

-- ---------------------------------------------------------------------
-- mailboxes: per-mailbox global sending policy
-- ---------------------------------------------------------------------
alter table mailboxes
  -- The global cap across every campaign. Deliberately conservative for a
  -- cold-outreach mailbox; the UI makes it editable.
  add column if not exists daily_limit integer not null default 40,
  -- The day boundary for that cap. Per mailbox rather than per campaign so a
  -- mailbox shared by campaigns in different zones still has one "today".
  add column if not exists timezone text not null default 'Europe/Prague',
  -- Lets an operator retire a mailbox without deleting it or breaking the
  -- threads already pinned to it.
  add column if not exists enabled boolean not null default true,
  add column if not exists last_send_at timestamptz;

alter table mailboxes drop constraint if exists mailboxes_daily_limit_check;
alter table mailboxes add constraint mailboxes_daily_limit_check
  check (daily_limit between 1 and 2000);

-- ---------------------------------------------------------------------
-- campaign_mailboxes: the sender pool
-- ---------------------------------------------------------------------
create table if not exists campaign_mailboxes (
  campaign_id uuid not null references campaigns(id) on delete cascade,
  mailbox_id  uuid not null references mailboxes(id) on delete restrict,
  created_at  timestamptz not null default now(),
  primary key (campaign_id, mailbox_id)
);

create index if not exists campaign_mailboxes_mailbox_idx on campaign_mailboxes (mailbox_id);

-- Backfill: every existing campaign keeps its current sender, now as the sole
-- member of its pool. Existing campaigns behave exactly as before.
insert into campaign_mailboxes (campaign_id, mailbox_id)
select id, mailbox_id from campaigns where mailbox_id is not null
on conflict do nothing;

-- Deprecated once the pool exists. Kept, and made nullable, so the migration
-- destroys nothing and can be reversed.
alter table campaigns alter column mailbox_id drop not null;
comment on column campaigns.mailbox_id is
  'DEPRECATED: superseded by campaign_mailboxes. Retained for history; not read by the sending engine.';

-- ---------------------------------------------------------------------
-- email_sends: which mailbox actually sent this
-- ---------------------------------------------------------------------
alter table email_sends
  add column if not exists mailbox_id uuid references mailboxes(id) on delete set null;

-- Backfill from the campaign's original single sender: historically true.
update email_sends es
   set mailbox_id = cp.mailbox_id
  from campaigns cp
 where cp.id = es.campaign_id and es.mailbox_id is null and cp.mailbox_id is not null;

-- The daily-quota lookup: mailbox + the day it was sent.
create index if not exists email_sends_mailbox_day_idx
  on email_sends (mailbox_id, sent_at)
  where status in ('sent', 'unknown', 'skipped');

-- ---------------------------------------------------------------------
-- campaign_contacts: sticky sender
-- ---------------------------------------------------------------------
-- Once a prospect has heard from one address, every later message in that
-- thread comes from the same address. Reassigning mid-sequence would look like
-- two different people chasing the same lead.
alter table campaign_contacts
  add column if not exists sender_mailbox_id uuid references mailboxes(id) on delete restrict;

-- Backfill: anyone who already received something is pinned to the campaign's
-- original sender, which is provably the mailbox that sent it.
update campaign_contacts cc
   set sender_mailbox_id = cp.mailbox_id
  from campaigns cp
 where cp.id = cc.campaign_id
   and cc.sender_mailbox_id is null
   and cp.mailbox_id is not null
   and exists (select 1 from email_sends es where es.campaign_contact_id = cc.id);

create index if not exists campaign_contacts_sender_idx on campaign_contacts (sender_mailbox_id);

-- ---------------------------------------------------------------------
-- conversations: one thread per (mailbox, contact)
-- ---------------------------------------------------------------------
-- Keyed on the pair rather than on the campaign, because the prospect
-- experiences one conversation with one person regardless of how many
-- campaigns we happen to have them in.
create table if not exists conversations (
  id                  uuid primary key default gen_random_uuid(),
  mailbox_id          uuid not null references mailboxes(id) on delete cascade,
  contact_id          uuid not null references contacts(id) on delete cascade,
  campaign_id         uuid references campaigns(id) on delete set null,
  campaign_contact_id uuid references campaign_contacts(id) on delete set null,

  subject             text,
  last_message_at     timestamptz not null default now(),
  last_inbound_at     timestamptz,
  unread_count        integer not null default 0,

  -- Hand-set by the operator. No automatic classification yet.
  classification      text not null default 'unclassified'
                        check (classification in ('unclassified', 'positive', 'not_interested',
                                                  'later', 'wrong_person', 'ooo',
                                                  'unsubscribe', 'other')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (mailbox_id, contact_id)
);

create index if not exists conversations_recent_idx on conversations (last_message_at desc);
create index if not exists conversations_campaign_idx on conversations (campaign_id);
create index if not exists conversations_unread_idx on conversations (unread_count) where unread_count > 0;

-- ---------------------------------------------------------------------
-- messages: the thread itself, both directions
-- ---------------------------------------------------------------------
create table if not exists messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,

  direction        text not null check (direction in ('outbound', 'inbound')),
  -- How this message came to exist. Manual replies are separated from campaign
  -- sends so statistics - and the daily cap - can tell them apart.
  kind             text not null default 'campaign'
                     check (kind in ('campaign', 'manual_reply', 'incoming')),

  from_email       text not null,
  to_email         text not null,
  subject          text,
  body_text        text,
  -- Stored for completeness but never rendered: the UI shows body_text only,
  -- so untrusted remote HTML cannot reach a browser.
  body_html        text,

  -- RFC 5322 threading. `references` is a reserved word, hence the prefix.
  message_id         text,
  in_reply_to        text,
  message_references text,

  email_send_id    uuid references email_sends(id) on delete set null,
  reply_id         uuid references replies(id) on delete set null,

  occurred_at      timestamptz not null default now(),
  is_read          boolean not null default true,
  created_at       timestamptz not null default now()
);

-- One row per physical message. Partial, because a legacy backfilled row may
-- have no Message-ID at all and several such rows must still coexist.
create unique index if not exists messages_conversation_message_id_key
  on messages (conversation_id, message_id) where message_id is not null;

create index if not exists messages_conversation_idx on messages (conversation_id, occurred_at);
create index if not exists messages_message_id_idx on messages (message_id) where message_id is not null;

-- ---------------------------------------------------------------------
-- Backfill the inbox from history, so it is not empty on first open
-- ---------------------------------------------------------------------
-- Conversations implied by replies we already detected.
insert into conversations (mailbox_id, contact_id, campaign_id, campaign_contact_id,
                           subject, last_message_at, last_inbound_at)
select distinct on (r.mailbox_id, r.contact_id)
       r.mailbox_id, r.contact_id, cc.campaign_id, r.campaign_contact_id,
       r.subject, r.received_at, r.received_at
  from replies r
  left join campaign_contacts cc on cc.id = r.campaign_contact_id
 where r.contact_id is not null
 order by r.mailbox_id, r.contact_id, r.received_at desc
on conflict (mailbox_id, contact_id) do nothing;

-- Outbound campaign emails that belong to one of those conversations.
insert into messages (conversation_id, direction, kind, from_email, to_email, subject,
                      body_text, message_id, email_send_id, occurred_at, is_read)
select cv.id, 'outbound', 'campaign', mb.from_email, es.intended_email, es.subject,
       es.body, es.message_id, es.id, coalesce(es.sent_at, es.claimed_at), true
  from email_sends es
  join campaign_contacts cc on cc.id = es.campaign_contact_id
  join conversations cv on cv.contact_id = cc.contact_id
  join mailboxes mb on mb.id = cv.mailbox_id
 where es.status in ('sent', 'unknown');

-- And the inbound replies themselves.
insert into messages (conversation_id, direction, kind, from_email, to_email, subject,
                      message_id, in_reply_to, reply_id, occurred_at, is_read)
select cv.id, 'inbound', 'incoming', r.from_email, mb.from_email, r.subject,
       r.imap_message_id, r.in_reply_to, r.id, r.received_at, true
  from replies r
  join conversations cv on cv.mailbox_id = r.mailbox_id and cv.contact_id = r.contact_id
  join mailboxes mb on mb.id = r.mailbox_id
 where r.contact_id is not null
on conflict do nothing;
