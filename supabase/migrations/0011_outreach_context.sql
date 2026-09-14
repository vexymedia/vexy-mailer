-- =====================================================================
-- vexy-mailer :: kontext, který caller potřebuje před hovorem
-- =====================================================================
-- Caller volá na studený follow-up. Než vytočí číslo, musí vědět, co
-- prospekt už dostal - typicky personalizovaný Loom. Dosud to v systému
-- nebylo nikde a caller si to musel pamatovat nebo hledat jinde.
--
-- Loom patří ke kontaktu, ne k firmě: video se natáčí konkrétnímu
-- člověku a jiný člověk ve stejné firmě ho neviděl.
--
-- Čistě aditivní, idempotentní, beze změny významu stávajících sloupců.
-- =====================================================================

alter table contacts add column if not exists loom_url text;
alter table contacts add column if not exists loom_title text;
alter table contacts add column if not exists loom_sent_at timestamptz;
-- Jedna až dvě věty, o čem video je. Caller na ně navazuje první větou
-- hovoru, takže musí být čitelné, ne vygenerované.
alter table contacts add column if not exists loom_note text;

-- Vlastní úvodní věta pro tenhle kontakt. Má přednost před šablonou
-- z kampaně: u firmy, kde víme něco konkrétního, je obecný scénář horší
-- než nic.
alter table contacts add column if not exists call_opener text;

-- Rychlé dohledání hovorů podle člověka a času. Reporting nad /tym a
-- denním postupem jinak čte celou tabulku.
create index if not exists calls_caller_started_idx on calls (caller_id, started_at desc);
create index if not exists calls_started_idx on calls (started_at desc) where provider_call_sid is not null;
