-- =====================================================================
-- vexy-mailer :: calling hardening
-- =====================================================================
-- Everything here closes a hole found by reading 0003 back against what a
-- real pilot does, not by adding features. Each block says which.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Do-not-call, across every campaign
-- ---------------------------------------------------------------------
-- 0003 recorded "nevolat" as a call_status on one campaign_contacts row,
-- so the same person was still dialled from the next campaign they were
-- imported into. Somebody who asks not to be phoned means it for good.
--
-- Deliberately NOT suppression_list. That table is the e-mail channel and
-- is enforced by a trigger on campaign_contacts; phone and e-mail are
-- separate consents, and merging them would let a call outcome silently
-- stop a campaign's e-mail - exactly the coupling 0003 set out to avoid.
create table if not exists call_suppression (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid not null unique references contacts(id) on delete cascade,
  reason     text not null default 'do_not_call',
  note       text,
  created_at timestamptz not null default now()
);

create index if not exists call_suppression_contact_idx on call_suppression (contact_id);

-- Anyone already retired as do_not_call under 0003 belongs on the list.
insert into call_suppression (contact_id, reason)
select distinct contact_id, 'do_not_call'
  from campaign_contacts where call_status = 'do_not_call'
on conflict (contact_id) do nothing;

-- ---------------------------------------------------------------------
-- 2. One caller at a time on one prospect
-- ---------------------------------------------------------------------
-- Two callers working the same campaign both read the same head of the
-- queue and both dial the same person. A lease is the same mechanism the
-- send engine already uses for its worker: acquired atomically, expires on
-- its own if the caller closes the tab.
alter table campaign_contacts
  add column if not exists call_locked_until timestamptz,
  add column if not exists call_locked_by uuid references callers(id) on delete set null;

create index if not exists campaign_contacts_call_lock_idx
  on campaign_contacts (call_locked_until) where call_locked_until is not null;

-- ---------------------------------------------------------------------
-- 3. Meeting lifecycle: "not yet" is not "did not happen"
-- ---------------------------------------------------------------------
-- meeting_held was a boolean, so a meeting in the future and one the
-- prospect never turned up to were the same value. A pilot billed on held
-- meetings cannot tell those apart, and a no-show is the number that says
-- whether the meetings are real.
alter table campaign_contacts
  add column if not exists meeting_outcome text not null default 'scheduled';

alter table campaign_contacts drop constraint if exists campaign_contacts_meeting_outcome_check;
alter table campaign_contacts add constraint campaign_contacts_meeting_outcome_check
  check (meeting_outcome in ('scheduled', 'held', 'no_show', 'cancelled'));

update campaign_contacts set meeting_outcome = 'held'
 where meeting_held and meeting_outcome = 'scheduled';

-- meeting_held stays, as the single thing economics and the UI read, but it
-- is now DERIVED. Two independently writable columns meaning the same thing
-- is the data-integrity bug, not the fix for it.
alter table campaign_contacts drop column if exists meeting_held;
alter table campaign_contacts
  add column if not exists meeting_held boolean
    generated always as (meeting_outcome = 'held') stored;

-- ---------------------------------------------------------------------
-- 4. Invariants the application must not be able to break
-- ---------------------------------------------------------------------
-- Every one of these was reachable by calling the query layer directly.
alter table campaign_contacts drop constraint if exists campaign_contacts_callback_needs_time;
alter table campaign_contacts add constraint campaign_contacts_callback_needs_time
  -- No prospect may sit in 'callback' without a time to call back at:
  -- that is an active contact with no next action.
  check (call_status <> 'callback' or next_call_at is not null);

alter table campaign_contacts drop constraint if exists campaign_contacts_meeting_needs_time;
alter table campaign_contacts add constraint campaign_contacts_meeting_needs_time
  check (not meeting_booked or meeting_at is not null);

alter table campaign_contacts drop constraint if exists campaign_contacts_qualification_needs_meeting;
alter table campaign_contacts add constraint campaign_contacts_qualification_needs_meeting
  -- Only a booked meeting can be judged against the criteria.
  check (meeting_qualified is null or meeting_booked);

alter table campaign_contacts drop constraint if exists campaign_contacts_meeting_outcome_needs_meeting;
alter table campaign_contacts add constraint campaign_contacts_meeting_outcome_needs_meeting
  check (meeting_outcome = 'scheduled' or meeting_booked);

alter table campaign_contacts drop constraint if exists campaign_contacts_attempts_nonneg;
alter table campaign_contacts add constraint campaign_contacts_attempts_nonneg
  check (call_attempts >= 0);

-- ---------------------------------------------------------------------
-- 5. A deterministic queue needs a unique tiebreak
-- ---------------------------------------------------------------------
-- The 0003 ordering ended at created_at. addContactsToCampaign inserts a
-- whole list with one INSERT ... SELECT, so every row in it carries the
-- same timestamp and their relative order was undefined - two reads of the
-- same queue could hand out different prospects. The id settles it; this
-- index is the order the query now asks for.
create index if not exists campaign_contacts_call_queue_order_idx
  on campaign_contacts (campaign_id, call_status, call_attempts, next_call_at, created_at, id);
