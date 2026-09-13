-- =====================================================================
-- vexy-mailer :: rozlišení řečníků v přepisu hovoru
-- =====================================================================
-- Twilio nahrává hovor jako `record-from-answer-dual`, tedy každou větev
-- do vlastního kanálu. Když se každý kanál přepíše zvlášť, víme jistě,
-- kdo co řekl - není to odhad modelu, je to fyzicky oddělený zvuk.
--
-- `transcript` zůstává beze změny jako plochý text (a u starých hovorů
-- je to jediné, co máme). `transcript_segments` je nové a nepovinné.
--
-- Čistě aditivní.
-- =====================================================================

-- Kolik kanálů nahrávka měla. Z toho se pozná, jestli šlo řečníky
-- rozlišit, nebo jestli je přepis starý plochý.
alter table calls add column if not exists recording_channels int;

-- [{ speaker: 'agent' | 'prospect', text, start, end }]
alter table calls add column if not exists transcript_segments jsonb;
