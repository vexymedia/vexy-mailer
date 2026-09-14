-- =====================================================================
-- vexy-mailer :: klienti a přidělení práce callerům
-- =====================================================================
-- Do teď byla kampaň sama o sobě. To stačilo, dokud v systému běžel jeden
-- vlastní outbound. Jakmile vedle sebe existuje ASN Plus a VEXY, musí být
-- v každém okamžiku jednoznačné, čí práce se zpracovává - a externí caller
-- ASN se nesmí dostat k datům VEXY ani naopak.
--
-- Hierarchie zůstává co nejmělčí:
--
--   klient -> kampaň -> kontakty / hovory / konverzace
--
-- Firmy a kontakty zůstávají GLOBÁLNÍ a záměrně se neduplikují. Tatáž
-- firma může být relevantní pro ASN i pro VEXY; co je oddělené, je
-- obchodní stav - ten žije v `campaign_contacts`, tedy pod kampaní.
-- "Nemá zájem" u ASN proto neznamená "nemá zájem o VEXY".
--
-- Přidělení práce je na obchodní identitě (`callers`), ne na přihlášení:
-- reporting i hovory se vážou na ni.
--
-- Čistě aditivní. Stávající kampaně zůstanou bez klienta a jsou tím pádem
-- viditelné jen administrátorovi - historii nikdo neuhaduje.
-- =====================================================================

create table if not exists clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  -- Uzavřený klient se nemaže: odkazuje se na něj historie kampaní.
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists clients_name_key on clients (lower(name));

-- Nullable schválně: historické kampaně nemají jak klienta poznat a hádat
-- ho ze jména by přiřadilo cizí data ke špatnému klientovi.
alter table campaigns add column if not exists client_id uuid references clients(id) on delete restrict;
create index if not exists campaigns_client_idx on campaigns (client_id);

-- Které kampaně smí caller zpracovávat.
--
-- Prázdno = žádná práce. Fail-closed je tu záměr: nový caller nesmí
-- omylem dostat cizí frontu jen proto, že mu nikdo nic nepřidělil.
create table if not exists caller_campaigns (
  caller_id   uuid not null references callers(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (caller_id, campaign_id)
);

create index if not exists caller_campaigns_campaign_idx on caller_campaigns (campaign_id);
