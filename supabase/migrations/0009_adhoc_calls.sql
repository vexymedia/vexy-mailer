-- =====================================================================
-- vexy-mailer :: výsledek hovoru i mimo kampaň
-- =====================================================================
-- Calling produkt musí umět zapsat výsledek každého skutečného hovoru,
-- i když kontakt není v žádné e-mailové kampani. Dosud to nešlo:
-- call_activities vyžadovaly kampaň.
--
-- Ad-hoc hovor si nese vlastní další krok v `next_action_at` - nemá kde
-- jinde bydlet, protože campaign_contacts pro něj neexistují. Tím se
-- zároveň zaručuje, že se nespustí e-mailová kadence: ta se řídí sloupci
-- v campaign_contacts, kterých se ad-hoc zápis vůbec nedotkne.
--
-- Aditivní a zpětně kompatibilní: uvolnění NOT NULL nerozbije žádný
-- existující řádek ani kód, který kampaň vždycky vyplňuje.
-- =====================================================================

alter table call_activities alter column campaign_id drop not null;
alter table call_activities alter column campaign_contact_id drop not null;

-- Hovory mimo kampaň se dohledávají podle kontaktu, ne podle kampaně.
create index if not exists call_activities_adhoc_idx
  on call_activities (contact_id, called_at desc)
  where campaign_contact_id is null;
