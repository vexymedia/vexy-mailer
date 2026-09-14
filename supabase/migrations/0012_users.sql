-- =====================================================================
-- vexy-mailer :: skuteční uživatelé a role
-- =====================================================================
-- Dosud mělo VEXY jedno sdílené heslo. To stačilo, dokud aplikaci
-- používal jeden člověk. Externí caller ale nesmí dostat přístup
-- k Twilio credentials, heslům schránek ani nastavení - a s jedním
-- heslem to nejde oddělit.
--
-- `callers` se NENAHRAZUJE. Je to obchodní identita, na kterou se
-- odkazují hovory, výsledky a reporting; ta zůstává. Přibývá vedle ní
-- přihlašovací identita a vazba mezi nimi.
--
--   users.caller_id -> callers.id
--
-- Role jsou schválně jen dvě. Obecný systém oprávnění pro hypotetické
-- budoucí role by byl větší než celý zbytek téhle změny a nikdo by ho
-- nepotřeboval.
--
-- Čistě aditivní: žádná stávající tabulka nemění význam.
-- =====================================================================

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),

  -- Přihlašovací jméno. Ukládá se malými písmeny, aby se člověk nemohl
  -- omylem zavést dvakrát.
  email         text not null,
  -- Hash hesla, nikdy heslo samotné. Formát viz lib/password.ts.
  password_hash text not null,
  name          text not null,

  role          text not null check (role in ('admin', 'caller')),

  -- Obchodní identita. Povinná u callera (bez ní by se jeho hovory
  -- neměly komu připsat), zakázaná u admina.
  caller_id     uuid references callers(id) on delete restrict,

  -- Deaktivovaný člověk se nemaže: odkazuje se na něj historie.
  is_active     boolean not null default true,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Jeden e-mail = jeden účet, bez ohledu na velikost písmen.
create unique index if not exists users_email_key on users (lower(email));

-- Caller musí mít obchodní identitu, admin ji mít nesmí. Vynucuje to
-- databáze, ne jen formulář: bez toho by šlo vyrobit callera, jehož
-- hovory nemá kam zapsat.
alter table users drop constraint if exists users_caller_identity_check;
alter table users add constraint users_caller_identity_check
  check ((role = 'caller' and caller_id is not null)
      or (role = 'admin'  and caller_id is null));

-- Jedna obchodní identita patří nejvýš jednomu přihlášení. Dva účty na
-- téhož callera by znamenaly, že se hovory nedají rozdělit mezi lidi.
create unique index if not exists users_caller_id_key on users (caller_id)
  where caller_id is not null;

-- Přihlašování hledá podle e-mailu; ostatní dotazy podle role.
create index if not exists users_role_idx on users (role) where is_active;
