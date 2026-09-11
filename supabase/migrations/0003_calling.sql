-- =====================================================================
-- vexy-mailer :: cold calling
-- =====================================================================
-- One campaign is e-mail AND calling. Calling is therefore additive
-- columns on the rows that already exist, not a parallel data model.
--
-- Design decisions that matter, because getting these wrong would put the
-- e-mail engine at risk:
--
--   * campaign_contacts.status stays the E-MAIL lifecycle, exclusively.
--     Calling gets its own call_status. Nothing in the calling code ever
--     writes status, current_step, next_send_at, sender_mailbox_id or
--     thread_message_id, so the dispatcher's candidate query, its claim
--     transaction and the duplicate-send guarantee are untouched.
--
--   * next_call_at is a separate column from next_send_at for the same
--     reason: the pacing cursor and the calling queue must never be able
--     to move each other.
--
--   * call_activities is append-only, one row per dialling attempt. The
--     aggregate columns on campaign_contacts (call_attempts, last_call_at,
--     ...) are a cache of it for the queue query; the activity table is the
--     source of truth for every KPI and for the contact timeline.
--
--   * "connected" is stored on the activity rather than derived from the
--     outcome at read time. Campaign economics are billed on connected
--     calls, so that number must not silently change if the outcome list
--     is ever edited.
-- =====================================================================

-- ---------------------------------------------------------------------
-- callers : who does the dialling
-- ---------------------------------------------------------------------
-- A first-class entity rather than a name typed onto each prospect, because
-- calling capacity will be assembled from several external operators: one
-- caller works across campaigns, one campaign is worked by several callers.
--
-- Deliberately four columns. Skills, languages, availability, cost model and
-- performance metrics all belong on this row when they are needed, and can be
-- added without touching anything that references it - which is the entire
-- reason the reference is an id and not a string.
create table if not exists callers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  -- Retire a caller without losing the history of what they dialled.
  active     boolean not null default true,
  email      text,
  phone      text,
  created_at timestamptz not null default now()
);

create index if not exists callers_active_idx on callers (active, name);

-- ---------------------------------------------------------------------
-- contacts: the phone number
-- ---------------------------------------------------------------------
alter table contacts add column if not exists phone text;

-- ---------------------------------------------------------------------
-- campaigns: calling configuration, script and economics
-- ---------------------------------------------------------------------
alter table campaigns
  add column if not exists calling_enabled boolean not null default false,
  -- The company default. Per campaign, because a 300-contact client pilot
  -- and our own acquisition list do not deserve the same persistence.
  add column if not exists max_call_attempts integer not null default 4,

  -- Call script. Four plain text fields, shown as a side panel to the
  -- caller. Deliberately not a template engine: the caller reads it.
  add column if not exists script_opening text,
  add column if not exists script_value text,
  add column if not exists script_objections text,
  add column if not exists script_closing text,

  -- What makes a meeting worth invoicing. Plain text on purpose: the caller
  -- reads it and ticks one box. A rules engine would be a week of work to
  -- replace one sentence and a judgement call.
  add column if not exists qualification_criteria text,

  -- Economics. Amounts are in the operator's own currency (CZK); the app
  -- never converts, so there is one number and no exchange-rate surprise.
  --
  -- double precision, not numeric, on purpose: postgres.js hands numeric back
  -- as a string, which would quietly turn every `select *` into a type lie for
  -- the pages that already read campaigns that way. These are campaign-level
  -- rates and totals for a profitability view, not a ledger, so a float is
  -- exact enough - and every figure is rounded to halers before display.
  add column if not exists revenue_model text not null default 'deal_values',
  add column if not exists revenue_amount double precision not null default 0,
  add column if not exists caller_cost_model text not null default 'none',
  add column if not exists caller_cost_amount double precision not null default 0,
  add column if not exists caller_hours double precision not null default 0,
  add column if not exists additional_costs double precision not null default 0;

alter table campaigns drop constraint if exists campaigns_max_call_attempts_check;
alter table campaigns add constraint campaigns_max_call_attempts_check
  check (max_call_attempts between 1 and 20);

alter table campaigns drop constraint if exists campaigns_revenue_model_check;
alter table campaigns add constraint campaigns_revenue_model_check
  check (revenue_model in ('deal_values', 'fixed', 'per_meeting_booked',
                           'per_qualified_meeting', 'per_meeting_held', 'per_client'));

alter table campaigns drop constraint if exists campaigns_caller_cost_model_check;
alter table campaigns add constraint campaigns_caller_cost_model_check
  check (caller_cost_model in ('none', 'fixed', 'hourly', 'per_connected_call'));

-- ---------------------------------------------------------------------
-- campaign_contacts: the calling half of one prospect's journey
-- ---------------------------------------------------------------------
alter table campaign_contacts
  -- The calling lifecycle. Separate from `status`, which is e-mail only.
  --   new           never dialled
  --   in_progress   dialled, still worth dialling again
  --   callback      the prospect asked to be called at next_call_at
  --   meeting_booked a meeting is in the diary
  --   won           became a client
  --   lost          not interested / no budget / wrong number
  --   do_not_call   asked us not to phone again
  --   max_attempts  ran out of attempts without ever connecting
  add column if not exists call_status text not null default 'new',
  add column if not exists assigned_caller_id uuid references callers(id) on delete set null,
  add column if not exists call_attempts integer not null default 0,
  add column if not exists last_call_at timestamptz,
  -- Next action: when a callback or a re-dial is due. Never next_send_at.
  add column if not exists next_call_at timestamptz,
  add column if not exists last_call_outcome text,
  add column if not exists call_note text,
  add column if not exists meeting_booked boolean not null default false,
  add column if not exists meeting_at timestamptz,
  -- NULL = not judged yet. Only a qualified meeting is billable, so the
  -- unjudged state must be distinguishable from "judged, not qualified".
  add column if not exists meeting_qualified boolean,
  add column if not exists meeting_held boolean not null default false,
  add column if not exists deal_value double precision;

alter table campaign_contacts drop constraint if exists campaign_contacts_call_status_check;
alter table campaign_contacts add constraint campaign_contacts_call_status_check
  check (call_status in ('new', 'in_progress', 'callback', 'meeting_booked',
                         'won', 'lost', 'do_not_call', 'max_attempts'));

-- The calling queue reads exactly this: one campaign, by state, by due time.
create index if not exists campaign_contacts_call_queue_idx
  on campaign_contacts (campaign_id, call_status, next_call_at, call_attempts);

-- ---------------------------------------------------------------------
-- call_activities: one row per dialling attempt, append only
-- ---------------------------------------------------------------------
create table if not exists call_activities (
  id                  uuid primary key default gen_random_uuid(),
  campaign_id         uuid not null references campaigns(id) on delete cascade,
  campaign_contact_id uuid not null references campaign_contacts(id) on delete cascade,
  contact_id          uuid not null references contacts(id) on delete cascade,

  -- Who made this call. Nullable so a caller row can be deleted without
  -- destroying the campaign's history or its economics.
  caller_id           uuid references callers(id) on delete set null,
  outcome             text not null,
  -- Did a human on the other end actually talk to us? The billable unit.
  connected           boolean not null default false,
  note                text,

  -- Which attempt this was, so the timeline reads without recomputing.
  attempt_number      integer not null check (attempt_number >= 1),

  called_at           timestamptz not null default now(),
  -- Whatever the outcome scheduled: a callback time or a meeting time.
  next_action_at      timestamptz,
  meeting_at          timestamptz,
  meeting_qualified   boolean,
  deal_value          double precision,

  created_at          timestamptz not null default now()
);

alter table call_activities drop constraint if exists call_activities_outcome_check;
alter table call_activities add constraint call_activities_outcome_check
  check (outcome in ('no_answer', 'busy', 'wrong_number', 'gatekeeper',
                     'callback', 'not_interested', 'no_budget', 'not_decision_maker',
                     'send_info', 'meeting_booked', 'won', 'do_not_call'));

create index if not exists call_activities_campaign_idx
  on call_activities (campaign_id, called_at desc);
create index if not exists call_activities_contact_idx
  on call_activities (campaign_contact_id, called_at desc);
-- Economics counts connected calls per campaign; make that a cheap scan.
create index if not exists call_activities_connected_idx
  on call_activities (campaign_id) where connected;
create index if not exists call_activities_caller_idx
  on call_activities (caller_id, called_at desc);
