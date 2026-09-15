-- ---------------------------------------------------------------------
-- 0014: poměr nových a follow-upů, klasifikace příchozí pošty,
--       bounce jako data a suppression, která ví proč.
--
-- Čtyři věci, které v modelu chyběly a bez kterých se platforma nedá
-- používat na 100 e-mailů denně:
--
--   1. Kampaň neměla ŽÁDNÝ pojem "nový kontakt versus follow-up".
--      Dispatcher řadil jen podle next_send_at, takže stačil backlog
--      follow-upů a nové kontakty se přestaly oslovovat úplně.
--   2. Příchozí pošta neměla druh. Bounce, automatická odpověď i
--      "jsem na dovolené" se zpracovaly jako lidská odpověď, čímž
--      natrvalo zastavily sekvenci a zaplnily sales inbox.
--   3. Bounce se nikde neuložil. 5.1.1 (neexistující adresa) a
--      554 reputation block vypadaly v datech úplně stejně.
--   4. suppression_list měla jen volný text `reason`. Nešlo odlišit
--      explicitní odhlášení (nikdy nevracet) od technické chyby
--      (bezpečně vrátit) - a tím pádem ani nic bezpečně obnovit.
--
-- Nic se nemaže a nic se nepřepisuje: všechny sloupce jsou přírůstkové
-- s výchozí hodnotou, která odpovídá dosavadnímu chování.
-- ---------------------------------------------------------------------

-- 1 ------------------------------------------------- poměr nových a follow-upů
--
-- Jedno číslo, ne dvě. Dvě nezávislá procenta by uživatele pustila
-- nastavit 70 + 40 a tvrdý strop by pak dával smysl jen náhodou.
alter table campaigns add column if not exists new_ratio integer not null default 70;
alter table campaigns drop constraint if exists campaigns_new_ratio_check;
alter table campaigns add constraint campaigns_new_ratio_check
  check (new_ratio between 0 and 100);

-- Do kterého poolu se send počítal. Zapisuje se v okamžiku claimu podle
-- toho, jestli kontakt už někdy něco dostal - ne dopočítává se zpětně,
-- protože zpětně už to nejde spolehlivě zjistit.
alter table email_sends add column if not exists pool text;
alter table email_sends drop constraint if exists email_sends_pool_check;
alter table email_sends add constraint email_sends_pool_check
  check (pool is null or pool in ('new', 'follow_up'));

create index if not exists email_sends_pool_today_idx
  on email_sends (campaign_id, pool, sent_at);

-- 2 -------------------------------------------------- druh příchozí zprávy
--
-- Výchozí 'human' schválně: historické zprávy jsme jako lidské odpovědi
-- už zpracovali a tvrdit o nich zpětně něco jiného by přepsalo historii.
-- Nové zprávy klasifikuje `src/lib/inbound.ts`.
alter table messages add column if not exists message_class text not null default 'human';
alter table messages drop constraint if exists messages_class_check;
alter table messages add constraint messages_class_check
  check (message_class in ('human', 'ooo', 'bounce', 'auto', 'unsubscribe'));

create index if not exists messages_class_idx on messages (conversation_id, message_class);

-- 3 ----------------------------------------------------------------- bounce
--
-- Bounce je vlastnost ODESLANÉHO e-mailu, ne samostatná entita. Drží se
-- proto u email_sends, kde už je campaign, kontakt, schránka i krok.
alter table email_sends add column if not exists bounce_type text;
alter table email_sends add column if not exists bounce_code text;
alter table email_sends add column if not exists bounce_detail text;
alter table email_sends add column if not exists bounced_at timestamptz;

alter table email_sends drop constraint if exists email_sends_bounce_type_check;
alter table email_sends add constraint email_sends_bounce_type_check
  check (bounce_type is null or bounce_type in (
    'HARD_INVALID', 'SOFT_TEMPORARY', 'MAILBOX_FULL', 'RATE_LIMIT',
    'REPUTATION_BLOCK', 'POLICY_BLOCK', 'SPAM_REJECTION', 'NETWORK_ERROR', 'UNKNOWN'
  ));

create index if not exists email_sends_bounce_idx
  on email_sends (bounce_type, bounced_at) where bounce_type is not null;

-- 4 ------------------------------------------------- suppression, která ví proč
--
-- reason_code je uzavřený číselník. Volný text `reason` zůstává - je v něm
-- historie a přepsat ji by znamenalo tvrdit, že víme víc, než víme.
alter table suppression_list add column if not exists reason_code text not null default 'legacy';
alter table suppression_list add column if not exists source text;
alter table suppression_list add column if not exists restorable boolean;

alter table suppression_list drop constraint if exists suppression_reason_code_check;
alter table suppression_list add constraint suppression_reason_code_check
  check (reason_code in (
    'unsubscribe', 'spam_complaint', 'manual_dnc', 'hard_invalid',
    'not_interested', 'bounce_technical', 'import', 'legacy'
  ));

-- Backfill z volného textu. Mapuje se jen to, co je jednoznačné; cokoli
-- jiného zůstane 'legacy' a půjde do "Ke kontrole". Hádat u odhlášení
-- by znamenalo riskovat, že se odhlášený kontakt vrátí do oběhu.
update suppression_list set reason_code = 'unsubscribe'
 where reason_code = 'legacy'
   and (reason ilike '%unsubscrib%' or reason ilike '%odhlas%' or reason ilike '%odhláš%');
update suppression_list set reason_code = 'spam_complaint'
 where reason_code = 'legacy' and (reason ilike '%spam%' or reason ilike '%complaint%');
update suppression_list set reason_code = 'manual_dnc'
 where reason_code = 'legacy' and reason in ('manual', 'dnc', 'do_not_contact');
update suppression_list set reason_code = 'import'
 where reason_code = 'legacy' and reason ilike '%import%';

create index if not exists suppression_reason_code_idx on suppression_list (reason_code);

-- 5 -------------------------------------------- vyloučení firmy pro klienta
--
-- „Firma je už klientem ASN Plus" nesmí tu firmu schovat celé VEXY
-- databázi. companies.status = 'excluded' zůstává tím, čím je: globální
-- blok. Tohle je ta druhá, užší věc, která dosud neexistovala vůbec.
create table if not exists client_company_exclusions (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  reason      text,
  created_at  timestamptz not null default now(),
  unique (client_id, company_id)
);

create index if not exists client_company_exclusions_company_idx
  on client_company_exclusions (company_id);
