-- ---------------------------------------------------------------------
-- 0016: pauza sekvence u odpovědi, která čeká na posouzení.
--
-- Odpověď, která podle threading headers patří do našeho vlákna, ale
-- přišla od někoho jiného než od prospekta (přeposlání, Gmail, jiná
-- firemní doména), se od 0015 neoznačí jako odpověď prospekta. Sekvence
-- ale nesmí ani bez omezení pokračovat: pokud to JE prospekt z jiné
-- adresy, poslali bychom mu další cold e-mail hodinu poté, co odpověděl.
--
-- Kroky se proto pozastaví a jejich původní termín se uschová sem. Až
-- člověk zprávu posoudí:
--   * relevantní  → kontakt je "replied", sekvence končí, termín se zahodí
--   * nesouvisí   → termín se vrátí přesně takový, jaký byl
--
-- Jeden sloupec schválně: nový stavový automat by tady byl větší než
-- všechno, co řeší.
-- ---------------------------------------------------------------------

alter table campaign_contacts add column if not exists paused_next_send_at timestamptz;

comment on column campaign_contacts.paused_next_send_at is
  'Původní next_send_at uschovaný na dobu, kdy kontakt čeká na posouzení odpovědi od jiné adresy. Null = nic nečeká.';
