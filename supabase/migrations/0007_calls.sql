-- =====================================================================
-- vexy-mailer :: hovory z prohlížeče (Twilio Voice / WebRTC)
-- =====================================================================
-- `call_activities` je záznam POKUSU: co caller zjistil a co se má stát
-- dál. Je to doména, na které stojí kadence, a nesmí být závislá na tom,
-- jestli hovor vznikl přes Twilio, z mobilu, nebo ho někdo zapsal ručně.
--
-- `calls` je vedle toho technický záznam TELEFONÁTU: co provider udělal,
-- jak dlouho to trvalo, jestli je nahrávka, přepis a analýza. Jeden
-- `call_activities` může mít `calls` (volal se přes VEXY) i nemusí
-- (zápis z mobilu) - a naopak nedovolaný hovor má `calls` bez výsledku.
--
-- Čistě aditivní: žádná stávající tabulka nemění význam.
-- =====================================================================

create table if not exists calls (
  id uuid primary key default gen_random_uuid(),

  -- Komu se volalo. contact_id je povinné, zbytek je kontext, který se
  -- může časem odpojit (kampaň skončí, firma se sloučí).
  contact_id          uuid not null references contacts(id) on delete cascade,
  campaign_contact_id uuid references campaign_contacts(id) on delete set null,
  company_id          uuid references companies(id) on delete set null,
  caller_id           uuid references callers(id) on delete set null,

  -- Výsledek hovoru, jakmile ho caller zapíše. Outcome zůstává v
  -- call_activities - tady je jen odkaz, aby šlo spárovat nahrávku
  -- s tím, co z hovoru vzešlo.
  call_activity_id    uuid references call_activities(id) on delete set null,

  provider          text not null default 'twilio',
  provider_call_sid text,
  direction         text not null default 'outbound',

  -- Stav telefonátu podle providera, ne obchodní výsledek.
  status text not null default 'queued',

  -- Snímek čísla v okamžiku vytáčení. Kontakt si číslo může změnit;
  -- záznam hovoru musí zůstat pravdivý.
  destination text not null,
  from_number text,

  started_at  timestamptz not null default now(),
  answered_at timestamptz,
  ended_at    timestamptz,
  duration_seconds int,

  -- Nahrávka nevzniká v okamžiku zavěšení. Do té doby je 'pending';
  -- 'disabled' znamená, že se nahrávat nemělo.
  recording_status           text not null default 'pending',
  recording_sid              text,
  recording_url              text,
  recording_duration_seconds int,
  recording_error            text,

  transcript_status   text not null default 'pending',
  transcript          text,
  transcript_language text,
  transcript_provider text,
  transcript_error    text,

  analysis_status   text not null default 'pending',
  analysis          jsonb,
  analysis_provider text,
  analysis_error    text,
  -- Co z analýzy vyšlo jako pravděpodobný výsledek. Návrh, ne rozhodnutí:
  -- zapsat ho musí člověk, aby bylo vždy poznat, co tvrdí AI a co člověk.
  suggested_outcome text,

  error_code    text,
  error_message text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Jeden hovor u providera = jeden řádek. Webhooky chodí opakovaně a mimo
-- pořadí, takže se na tohle spoléhá dohledání i ochrana proti duplicitě.
create unique index if not exists calls_provider_sid_key
  on calls (provider, provider_call_sid) where provider_call_sid is not null;

create index if not exists calls_contact_idx on calls (contact_id, started_at desc);
create index if not exists calls_company_idx on calls (company_id, started_at desc);
create index if not exists calls_caller_idx on calls (caller_id, started_at desc);

-- Fronta zpracování: co čeká na přepis nebo na analýzu. Částečný index,
-- protože hotových hovorů bude drtivá většina.
create index if not exists calls_pipeline_idx on calls (created_at)
  where transcript_status in ('pending', 'failed') or analysis_status in ('pending', 'failed');

alter table calls drop constraint if exists calls_status_check;
alter table calls add constraint calls_status_check
  check (status in ('queued', 'ringing', 'in_progress', 'completed',
                    'busy', 'no_answer', 'failed', 'canceled'));

alter table calls drop constraint if exists calls_direction_check;
alter table calls add constraint calls_direction_check
  check (direction in ('outbound', 'inbound'));

alter table calls drop constraint if exists calls_recording_status_check;
alter table calls add constraint calls_recording_status_check
  check (recording_status in ('pending', 'available', 'failed', 'disabled'));

alter table calls drop constraint if exists calls_transcript_status_check;
alter table calls add constraint calls_transcript_status_check
  check (transcript_status in ('pending', 'processing', 'done', 'failed', 'skipped'));

alter table calls drop constraint if exists calls_analysis_status_check;
alter table calls add constraint calls_analysis_status_check
  check (analysis_status in ('pending', 'processing', 'done', 'failed', 'skipped'));

-- ---------------------------------------------------------------------
-- Nahrávání jde vypnout
-- ---------------------------------------------------------------------
-- Když je vypnuté, hovor funguje dál - jen z něj nevznikne nahrávka,
-- a tedy ani přepis a analýza.
alter table app_settings add column if not exists call_recording_enabled boolean not null default true;
