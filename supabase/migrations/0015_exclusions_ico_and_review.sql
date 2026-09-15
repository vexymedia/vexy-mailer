-- ---------------------------------------------------------------------
-- 0015: IČO, autor vyloučení a odpovědi ke kontrole.
--
-- Tři přírůstkové sloupce a jeden index. 0014 se nepřepisuje - mohla už
-- být někde aplikovaná.
--
--   1. companies.ico
--      Klientský vylučovací seznam přichází jako seznam IČ. Název firmy
--      je nespolehlivý identifikátor ("Acme s.r.o." versus "ACME sro"),
--      IČO je jednoznačné.
--
--   2. client_company_exclusions.created_by
--      Kdo firmu vyloučil. Bez toho se po půl roce nedá zjistit, jestli
--      za tím stálo rozhodnutí, nebo omyl při importu.
--
--   3. replies.needs_review
--      Odpověď, která přišla na naše vlákno, ale od NĚKOHO JINÉHO než
--      od prospekta. Vzniká přeposláním: kolega odpoví na přeposlaný
--      e-mail a jeho zpráva nese naše Message-ID v References. Dřív se
--      z toho stalo "prospekt odpověděl" a jeho sekvence se zastavila
--      kvůli cizí zprávě.
-- ---------------------------------------------------------------------

alter table companies add column if not exists ico text;

-- Normalizované IČO je jen číslice. Prázdný řetězec nemá být hodnota.
alter table companies drop constraint if exists companies_ico_check;
alter table companies add constraint companies_ico_check
  check (ico is null or ico ~ '^[0-9]{1,12}$');

-- Unikátní jen tam, kde je vyplněné: historická data ho nemají.
create unique index if not exists companies_ico_key on companies (ico) where ico is not null;

alter table client_company_exclusions
  add column if not exists created_by uuid references users(id) on delete set null;

alter table replies add column if not exists needs_review boolean not null default false;

create index if not exists replies_needs_review_idx
  on replies (needs_review, received_at desc) where needs_review;
