-- =====================================================================
-- vexy-mailer :: hlavní kontakt firmy se dá určit ručně
-- =====================================================================
-- Dosud se hlavní kontakt jen odhadoval (kdo má telefon, kdo je starší).
-- U ručně zakládaných firem to nestačí: člověk ví, kdo je rozhodovatel,
-- a chce to říct. Odhad zůstává jako záloha, když nikdo označený není.
--
-- Čistě aditivní.
-- =====================================================================

alter table contacts add column if not exists is_primary boolean not null default false;
