-- =====================================================================
-- vexy-mailer :: firmy jako hlavní objekt + týdenní plán
-- =====================================================================
-- Dosud byla firma jen text ve `contacts.company`. Produkt je ale
-- company-first: prioritu, důvod, odpovědnou osobu a další krok je třeba
-- držet na firmě, ne na jednotlivém e-mailu.
--
-- Čistě aditivní. Nic se nemaže ani nepřepisuje:
--   * contacts.company zůstává beze změny jako zdroj pravdy pro import
--     a jako fallback, company_id je odvozený odkaz navíc,
--   * e-mailový engine ani calling se těchto tabulek nedotýkají,
--   * suppression_list a call_suppression zůstávají jedinými místy,
--     která reálně blokují odesílání a volání.
-- =====================================================================

-- ---------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------
create table if not exists companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  website    text,

  -- "Proč ji řešíme" - kontext, podle kterého byla firma vybrána. Volný
  -- text schválně: v téhle fázi ho píše člověk, ne scoring engine.
  reason     text,

  priority   text not null default 'normal',
  -- Stav firmy v procesu. Záměrně krátký seznam: VEXY končí u předání
  -- obchodní konverzace, dál si klient vede vlastní CRM.
  status     text not null default 'new',

  -- Odpovědná osoba. Odkaz na tým, ne volný text.
  owner_id   uuid references callers(id) on delete set null,
  note       text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table companies drop constraint if exists companies_priority_check;
alter table companies add constraint companies_priority_check
  check (priority in ('high', 'normal', 'low'));

alter table companies drop constraint if exists companies_status_check;
alter table companies add constraint companies_status_check
  check (status in ('new', 'ready', 'in_progress', 'interested',
                    'meeting', 'won', 'lost', 'excluded'));

-- Jedna firma jednou, bez ohledu na velikost písmen v importu.
create unique index if not exists companies_name_key on companies (lower(btrim(name)));
create index if not exists companies_owner_idx on companies (owner_id);
create index if not exists companies_status_idx on companies (status, priority);

-- ---------------------------------------------------------------------
-- contacts -> companies
-- ---------------------------------------------------------------------
alter table contacts add column if not exists company_id uuid references companies(id) on delete set null;
create index if not exists contacts_company_idx on contacts (company_id);

-- Backfill z textu, který už v datech je. distinct on (lower(btrim(...)))
-- proto, že "Acme" a "acme" jsou jedna firma a unikátní index je jen jeden.
insert into companies (name)
select distinct on (lower(btrim(c.company))) btrim(c.company)
  from contacts c
 where c.company is not null and btrim(c.company) <> ''
 order by lower(btrim(c.company))
on conflict do nothing;

update contacts c
   set company_id = co.id
  from companies co
 where c.company_id is null
   and c.company is not null
   and lower(btrim(co.name)) = lower(btrim(c.company));

-- ---------------------------------------------------------------------
-- Firma vzniká z kontaktu, vždy
-- ---------------------------------------------------------------------
-- Backfill výše řeší jen data, která tu byla v okamžiku migrace. Kontakt
-- naimportovaný zítra by zůstal bez firmy a v seznamu firem by chyběl.
-- Stejný přístup jako u suppression guardu: invariant hlídá databáze, ne
-- jedna funkce v aplikaci, takže platí bez ohledu na to, kudy zápis přišel.
create or replace function link_contact_company() returns trigger
language plpgsql as $$
declare
  v_name text := nullif(btrim(new.company), '');
  v_id   uuid;
begin
  if v_name is null then
    return new;
  end if;

  select id into v_id from companies where lower(btrim(name)) = lower(v_name);
  if v_id is null then
    insert into companies (name) values (v_name)
    on conflict do nothing
    returning id into v_id;

    -- Souběžný import mohl firmu založit mezitím.
    if v_id is null then
      select id into v_id from companies where lower(btrim(name)) = lower(v_name);
    end if;
  end if;

  new.company_id := v_id;
  return new;
end;
$$;

drop trigger if exists contacts_company_link on contacts;
create trigger contacts_company_link
  before insert or update of company on contacts
  for each row execute function link_contact_company();

-- ---------------------------------------------------------------------
-- work_blocks : týdenní plán obchodní kapacity
-- ---------------------------------------------------------------------
-- Plánujeme bloky práce, ne jednotlivé hovory. Proto datum + rozsah +
-- člověk + typ aktivity, a nic víc. Není to kalendář schůzek a nemá to
-- ambici nahradit Google Calendar.
create table if not exists work_blocks (
  id            uuid primary key default gen_random_uuid(),
  block_date    date not null,
  -- Minuty od půlnoci, stejná konvence jako odesílací okno kampaní.
  start_minute  integer not null check (start_minute between 0 and 1439),
  end_minute    integer not null check (end_minute between 1 and 1440),

  caller_id     uuid references callers(id) on delete set null,
  activity_type text not null default 'calling',
  note          text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint work_blocks_range_valid check (end_minute > start_minute)
);

alter table work_blocks drop constraint if exists work_blocks_activity_type_check;
alter table work_blocks add constraint work_blocks_activity_type_check
  check (activity_type in ('calling', 'follow_up', 'email', 'research', 'other'));

create index if not exists work_blocks_date_idx on work_blocks (block_date, start_minute);
create index if not exists work_blocks_caller_idx on work_blocks (caller_id, block_date);
