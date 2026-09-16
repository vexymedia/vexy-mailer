-- Pozastavení sekvence na dobu ručního posouzení odpovědi.
--
-- Když na naše vlákno odpoví někdo, u koho nejde bezpečně určit, jestli je
-- to prospekt (jiná doména, Gmail, přeposlání, podvržené hlavičky), nesmí
-- se stát ani jedna ze dvou věcí:
--
--   * označit prospekta za toho, kdo odpověděl - utnuli bychom ho kvůli
--     cizí zprávě,
--   * poslat mu mezitím další automatický krok - kdyby to byl on z jiné
--     adresy, přišel by mu cold e-mail hodinu poté, co nám odpověděl.
--
-- Sekvence se proto pozastaví a čeká na rozhodnutí člověka. Původní termín
-- se uschová sem, aby se po zamítnutí dal vrátit přesně takový, jaký byl,
-- a ne přepočítaný na "hned teď" - jinak by se po delší pauze vyrojilo
-- všechno naráz.
--
-- Null znamená, že nic nečeká.
alter table campaign_contacts add column if not exists paused_next_send_at timestamptz;

comment on column campaign_contacts.paused_next_send_at is
  'Původní next_send_at uschovaný na dobu, kdy kontakt čeká na posouzení odpovědi od nejisté adresy. Null = nic nečeká.';
