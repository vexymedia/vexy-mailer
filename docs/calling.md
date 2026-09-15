# Volání z prohlížeče

VEXY umí vytočit prospekta přímo z prohlížeče: caller sedí u notebooku
s headsetem, klikne na **Zavolat** a prospektovi zazvoní normální telefon.
Z hovoru pak vznikne nahrávka, přepis, AI shrnutí a návrh dalšího kroku.

Tlačítko **Zavolat** je vždycky tlačítko, nikdy odkaz `tel:`. Bez Twilio
proměnných se neschová ani nezmizí: po kliknutí otevře cockpit a vypíše,
které proměnné na serveru chybí. Tichý přechod na systémový telefon tu byl
dřív a byla to past — hovor se nikam nezapsal a nikdo se nedozvěděl, že
telefonie není zapnutá.

---

## 1. Architektura

```
prohlížeč (headset)
  │  @twilio/voice-sdk  ── WebRTC ──┐
  │                                 ▼
  │                          Twilio Voice
  │                                 │  telefonní síť
  ▼                                 ▼
VEXY backend  ◄── webhooky ───  prospekt
  │
  ├─ /api/calling/token      podepsaný přístupový token (jen pro přihlášené)
  ├─ /api/calling/calls      založí hovor, dohledá číslo v databázi
  ├─ /api/calling/voice      TwiML: koho vytočit (ověřený podpis)
  ├─ /api/calling/status     průběh hovoru (ověřený podpis)
  └─ /api/calling/recording  hotová nahrávka (ověřený podpis)

nahrávka ──► /api/cron/tick ──► přepis (OpenAI) ──► analýza ──► CRM
```

Dvě tabulky, dva různé pojmy:

* **`call_activities`** — POKUS o kontakt a jeho výsledek. Na tom stojí
  kadence, počet pokusů i fronta. Vzniká, i když se volalo z mobilu.
* **`calls`** — TELEFONÁT: co udělal provider, jak dlouho trval, nahrávka,
  přepis, analýza. Spojka mezi nimi je `calls.call_activity_id`.

Klíčové bezpečnostní rozhodnutí: **prohlížeč nikdy neposílá telefonní
číslo.** Posílá jen id kontaktu, číslo si server dohledá sám. Jinak by
kdokoli s platnou relací mohl přes váš Twilio účet vytočit cokoli.

Zpracování nahrávek nemá vlastní infrastrukturu — jede na stejném ticku
jako odesílání e-mailů (`/api/cron/tick`, na Vercelu každou minutu).

---

## 2. Nastavení Twilia

1. **Účet a číslo.** Na [twilio.com](https://www.twilio.com/console) si
   založte účet a kupte telefonní číslo s hlasovými službami
   (*Phone Numbers → Buy a number*, zaškrtněte **Voice**). České číslo
   vyžaduje ověření adresy (*Regulatory Bundle*) — počítejte s pár dny.
   Na začátek jde použít i jiné číslo; volanému se zobrazí jako
   `TWILIO_CALLER_ID`.

2. **Account SID a Auth Token.** *Console → Account Info*.
   Auth Token je heslo k celému účtu. Nikdy nepatří do prohlížeče ani do
   repozitáře — VEXY ho používá výhradně k ověření podpisu webhooků a ke
   stažení nahrávky.

3. **API klíč.** *Console → Account → API keys & tokens → Create API key*,
   typ **Standard**. Dostanete `SK…` (SID) a Secret — ten se ukáže jen
   jednou. Tímhle klíčem se podepisuje token pro prohlížeč; kdyby unikl,
   zneplatníte ho bez měnění hesla k účtu.

4. **TwiML App.** *Console → Voice → TwiML → TwiML Apps → Create*.
   * Friendly name: `VEXY`
   * **Voice Request URL**: `https://VASE-DOMENA/api/calling/voice`, metoda
     `POST`
   * Uložte a zkopírujte `AP…` SID.

5. **Ověření čísla (jen trial účet).** Na trialu jde volat pouze na
   ověřená čísla: *Phone Numbers → Verified Caller IDs*.

---

## 3. Proměnné prostředí

```bash
TWILIO_ACCOUNT_SID=AC...        # Console → Account Info
TWILIO_AUTH_TOKEN=...           # Console → Account Info (heslo k účtu!)
TWILIO_API_KEY_SID=SK...        # API keys & tokens
TWILIO_API_KEY_SECRET=...       # ukáže se jen při vytvoření
TWILIO_TWIML_APP_SID=AP...      # Voice → TwiML Apps
TWILIO_CALLER_ID=+420...        # číslo, které uvidí volaný

# Nepovinné: veřejná URL pro podpis webhooků. Když chybí, použije se
# APP_URL, a když ani ta ne, hlavičky od proxy.
TWILIO_WEBHOOK_BASE_URL=https://vexy.example.com

# Přepis a analýza. Bez klíče volání funguje, jen z hovoru nevznikne
# přepis ani shrnutí — hovory počkají ve frontě, nic se neztratí.
OPENAI_API_KEY=sk-...
OPENAI_TRANSCRIBE_MODEL=whisper-1     # nepovinné
OPENAI_ANALYSIS_MODEL=gpt-4o-mini     # nepovinné
OPENAI_BASE_URL=https://api.openai.com/v1   # nepovinné, pro jiného providera
```

Na Vercelu je doplňte v *Settings → Environment Variables* a **udělejte
redeploy** — proměnné se do funkcí zapékají při buildu.

---

## 4. Lokální vývoj

```bash
npm run db:migrate     # potřebuje migrace 0005, 0006 a 0007
npm run dev
```

Bez Twilio proměnných uvidíte v *Nastavení → Volání* stav „není
nastaveno“ a seznam chybějících proměnných. Tlačítko Zavolat zůstane
klikatelné a ten samý seznam ukáže i v cockpitu.

### Bez veřejné URL se odchozí hovor neuskuteční

Tohle je důležité a snadno se to plete. Když kliknete na Zavolat,
prohlížeč jen *požádá* Twilio o spojení; **vytáčí Twilio, a to podle
TwiML, které si samo stáhne z Voice Request URL vaší TwiML App.** Na
`http://localhost:3000` se Twilio nedostane.

Bez tunelu proto funguje:

* vydání přístupového tokenu (`/api/calling/token`),
* načtení Voice SDK a registrace zařízení u Twilia,
* kontrola a povolení mikrofonu v *Nastavení → Volání*,
* založení záznamu hovoru (řádek v `calls` vznikne, číslo se dohledá).

Bez tunelu naopak **nefunguje vůbec nic z vlastního hovoru**:

* Twilio nedokáže stáhnout TwiML, takže **telefon prospektovi nikdy
  nezazvoní** — PSTN větev se ani nezaloží,
* hovor v prohlížeči skončí chybou (Twilio hlásí problém se stažením
  TwiML, typicky `11200`), cockpit ukáže „Nepodařilo se“,
* nedorazí žádné stavové události ani nahrávka, protože není co hlásit.

Založený řádek v `calls` zůstane ve stavu „vytáčím“ a po patnácti
minutách ho úklid v ticku uzavře jako neúspěšný — v historii firmy tedy
nezůstane viset jako věčně zpracovávaný.

Jinými slovy: **bez tunelu se nedá otestovat ani jeden skutečný hovor.**
Dá se otestovat všechno okolo.

### Tunel

```bash
cloudflared tunnel --url http://localhost:3000     # nebo: ngrok http 3000
```

Výslednou `https://…` adresu dejte **na obě místa**:

1. do `TWILIO_WEBHOOK_BASE_URL` v `.env.local` (podpis webhooků se počítá
   proti URL, na kterou Twilio skutečně volá — když nesedí, všechny tři
   webhooky vrátí 403),
2. do **Voice Request URL** v TwiML App: `https://…/api/calling/voice`.

Tunel je nástroj, ne součást aplikace — do `package.json` nepatří.
Adresa se u obou nástrojů při restartu mění, takže ji po každém spuštění
aktualizujte na obou místech.

## 5. Webhooky

| Endpoint | Kdo volá | Co dělá |
| --- | --- | --- |
| `POST /api/calling/voice` | Twilio při `Device.connect()` | vrátí TwiML `<Dial>` s číslem z databáze |
| `POST /api/calling/status` | Twilio v průběhu hovoru | posouvá stav (`ringing` → `in_progress` → `completed`) |
| `POST /api/calling/recording` | Twilio po zpracování nahrávky | uloží odkaz a délku nahrávky |

Podpis ověřuje oficiální `twilio.validateRequest`. Ručně to Twilio dělat
nedoporučuje — co přesně do podpisu vstupuje se časem mění a vlastní
implementace by o tom nevěděla. Bez platného podpisu vrátí endpoint `403`
a nic nezmění. Proto jsou tyhle tři cesty v middlewaru mezi veřejnými:
Twilio se přihlásit neumí, chrání je podpis.

### Dvě větve, jedno SID

Hovor má u Twilia dvě větve a webhooky chodí z každé jinak:

* **rodič** je hovor z prohlížeče. Jeho `CallSid` dorazí do
  `/api/calling/voice` a ukládá se do `calls.provider_call_sid`.
* **potomek** je odchozí PSTN větev, kterou vytvoří `<Dial><Number>`.

Z toho plyne párování, na kterém všechno stojí:

* `statusCallback` je na `<Number>`, takže události nesou `CallSid`
  potomka a `ParentCallSid` rodiče → párujeme na `ParentCallSid`.
* `recordingStatusCallback` je na `<Dial>`, takže události nesou
  `CallSid` **rodiče** → párujeme na `CallSid`.

Kdyby se to zaměnilo, události by se navázaly na hovor, který v databázi
neexistuje, a stav by se nikdy nepohnul. Obojí hlídá test s reálnými
payloady od Twilia.

### Doručení vícekrát a mimo pořadí

Twilio garantuje doručení „alespoň jednou“, ne „právě jednou“, a ne
v pořadí. Zápis je proto idempotentní a stav se nikdy nevrací zpátky:

* ukončený hovor zůstane ukončený, i když po něm dorazí opožděné
  „vyzvání“,
* stejná událost doručená třikrát nechá stejný jeden řádek se stejnými
  hodnotami,
* když se ztratí událost o zvednutí, ale dorazí „completed“ s nenulovou
  délkou, hovor se přesto označí za spojený.

**Časté chyby**

* `403` na všech webhoocích → `TWILIO_WEBHOOK_BASE_URL` neodpovídá URL, na
  kterou Twilio skutečně volá (typicky http/https nebo jiná doména).
* Hovor zůstane „Vytáčím“ → webhooky nedorazily; zkontrolujte tunel nebo
  Voice Request URL v TwiML App. Po patnácti minutách takový hovor úklid
  v ticku uzavře jako neúspěšný.
* Nahrávka se nikdy nezpracuje → chybí `OPENAI_API_KEY`, nebo neběží
  `/api/cron/tick`.

## 6. Testování

```bash
npm test        # unit + integrační, včetně podpisu webhooků a lifecyclu
npm run check   # typecheck, lint, build, testy
```

Testy **nikdy nevolají** skutečné Twilio ani OpenAI: provider je rozhraní
a v testech se nahrazuje. Žádný test nestojí peníze.

Pokryté je mimo jiné: token dostane jen přihlášená relace, klientem
podstrčené číslo se ignoruje, nepodepsaný webhook neprojde, hovor se
nevrací v životním cyklu zpátky, selhání přepisu nesmaže nahrávku ani
metadata a po konečném výsledku už kontakt nejde vytočit.

### Že tlačítko Zavolat není odkaz `tel:`

`tests/call-button.test.tsx` hlídá komponentu: tlačítko je `<button>`,
kliknutí sáhne na `/api/calling/token` a `/api/calling/calls`, Twiliu se
předá jen id hovoru, chyba se ukáže česky a zavěšení otevře zápis
výsledku.

`tests/e2e/zavolat.mjs` to samé ověří ve skutečném prohlížeči proti
běžícímu serveru — včetně toho, že se otevře signalizační WebSocket
k Twiliu a že v databázi vznikne hovor u správného kontaktu:

```bash
npm run build && npm start &          # server na scratch databázi
DATABASE_URL=… BASE_URL=http://localhost:3000 \
  ADMIN_EMAIL=… ADMIN_PASSWORD=… \
  COMPANY_ID=… CONTACT_ID=… CALLER_ID=… \
  node tests/e2e/zavolat.mjs
```

Server u toho může běžet s **neplatnými** Twilio údaji — hovor pak skončí
chybou 31005 a nikam se nedovolá. O to jde: skript nesmí vytočit skutečný
telefonát a nic nepředstírá. Kdyby se tlačítko vrátilo na `tel:`,
neproběhl by ani jeden z kroků po kliknutí.

---

## 7. První skutečný hovor

### Nejdřív schéma, potom kód

Volání přidává tabulku `calls` a sloupce, bez kterých se nové obrazovky
nevykreslí. Deploy migrace **nespouští**, takže kdyby kód šel první,
vzniklo by okno, ve kterém aplikace očekává schéma, co neexistuje.

Ověřeno v obou směrech:

* nový kód na starém schématu **spadne** — chybí tabulka `calls`,
  sloupec `contacts.position` i `app_settings.call_recording_enabled`,
* starý kód na novém schématu **běží** — kompletní testovací sada
  předchozí verze prochází proti schématu s migrací 0007.

Pořadí je tedy jednoznačné: **migrovat, pak nasadit.**

```bash
# 1. co produkce opravdu má
psql "$PRODUCTION_DATABASE_URL" -c "select name from schema_migrations order by name;"

# 2. migrace, přes PŘÍMÉ spojení (port 5432, ne pooler 6543)
DATABASE_URL="postgresql://…:5432/postgres" npm run db:migrate
#    čekaný výstup: skip 0001–0004, apply 0005, 0006, 0007
#    když se objeví "apply" u 0001–0004, zastavte se a zjistěte proč

# 3. teprve teď kód
git push origin main     # nebo merge PR
```

Po migraci se hodí ověřit, že data zůstala na místě:

```sql
select
  (select count(*) from email_sends) as odeslane_emaily,
  (select count(*) from contacts)    as kontakty,
  (select count(*) from calls)       as hovory;   -- 0, tabulka je nová
```

### Pak samotný hovor

1. Doplňte všech šest `TWILIO_*` proměnných a **udělejte redeploy** —
   na Vercelu se proměnné zapékají do funkcí při buildu.
2. Otevřete **Nastavení → Volání**. Musí svítit „nastaveno“.
3. Klikněte na **Otestovat** u mikrofonu a povolte ho. (Prohlížeč pustí
   mikrofon jen na HTTPS nebo na `localhost`.)
4. Připojte headset.
5. Otevřete **Oslovení → Dnes** nebo detail firmy s telefonním číslem.
6. Klikněte **Zavolat**. Otevře se cockpit: uvidíte „Vytáčím“, pak
   „Vyzvání“ a po zvednutí běžící čas.
7. Zavěste. Objeví se panel „Jak hovor dopadl?“ — výsledek jde zapsat
   hned, i když se nahrávka ještě zpracovává.
8. Přepis a shrnutí se doplní samy, typicky do dvou minut (viz níže).
   Najdete je na detailu firmy v sekci **Telefonáty**.

Hovor přežije přechod na jinou stránku: dole zůstane lišta se jménem,
firmou, časem a tlačítky Ztlumit / Zavěsit.

### Jak dlouho trvá, než je přepis vidět

Zpracování jede na stejném ticku jako odesílání e-mailů, tedy jednou za
minutu (`vercel.json`, `* * * * *`). Od zavěšení k hotovému shrnutí:

| krok | typicky | nejhůř |
| --- | --- | --- |
| Twilio zpracuje nahrávku a zavolá webhook | 5–20 s | ~60 s |
| čekání na nejbližší tick | ~30 s | 60 s |
| přepis + analýza (v jednom ticku) | 10–25 s | ~40 s |
| **celkem** | **~1 minuta** | **~2,5 minuty** |

Přepis a analýza se dělají v jednom průběhu, pokud na to ve funkci zbývá
čas; když ne, analýza se odloží o tick (v odpovědi ticku se to hlásí jako
`deferred`). Na výsledek se nikde nečeká — zapsat ho jde hned po zavěšení.

Zkracovat to dál by znamenalo buď častější cron (Vercel kratší než minutu
neumí), nebo spouštět zpracování přímo z webhooku. To druhé by znamenalo
dlouhou práci ve funkci, kterou platí Twilio svým timeoutem — a hlavně by
pak neexistovalo místo, kde se znovu zkusí, co selhalo. Minuta čekání za
spolehlivost stojí.

## 8. Co musí ověřit živý hovor

Tohle se automaticky nasimulovat nedá — chce to jeden skutečný hovor
s headsetem. Projděte po řadě, zabere to pár minut.

**Zvuk a zařízení**

- [ ] Zavolat bez povoleného mikrofonu → hláška „Mikrofon je zakázaný.
      Povolte ho v adresním řádku prohlížeče.“, ne technická chyba.
- [ ] Zavolat s odpojeným headsetem → „Nenašel jsem mikrofon.“
- [ ] Během hovoru vytáhnout headset z USB → hovor běží dál, zvuk se
      přepne na zabudovaný mikrofon a reproduktor.
- [ ] Slyší se obě strany. Ztlumit skutečně ztlumí.
- [ ] Klávesnice: tón se na druhé straně ozve (otestujte na hlasové
      rozcestí, např. infolinku operátora).

**Průběh hovoru**

- [ ] Stavy jdou po sobě: Vytáčím → Vyzvání → běžící čas.
- [ ] Zavěšení z prohlížeče hovor opravdu ukončí.
- [ ] Zavěšení druhou stranou ukončí hovor i ve VEXY.
- [ ] Během hovoru přejít na jinou stránku ve VEXY → dole zůstane lišta
      s časem; kliknutí na ni vrátí celý cockpit i s kontextem.
- [ ] Vypnout na pár vteřin wi-fi → objeví se „Spojení vypadlo,
      obnovuji…“ a po obnovení hláška zmizí.
- [ ] Refresh (F5) během hovoru → hovor skončí (jinak to nejde), aplikace
      se nezasekne a jde hned volat znovu.

**Konce hovoru**

- [ ] Nezvednutý hovor → stav „Nezvedá“, žádná nahrávka.
- [ ] Obsazeno → stav „Obsazeno“.
- [ ] Odmítnutý hovor → hovor korektně skončí.
- [ ] Krátké zvednutí a zavěšení → délka sedí.
- [ ] Normální hovor → délka ve VEXY odpovídá délce v Twilio Console.

**Po hovoru**

- [ ] Panel „Jak hovor dopadl?“ se objeví hned po zavěšení.
- [ ] Výsledek jde zapsat dřív, než doběhne AI.
- [ ] Firma dostane správný další krok podle kadence.
- [ ] Do dvou minut přibude přepis a shrnutí v sekci Telefonáty.
- [ ] Přepis dává smysl česky.
- [ ] Zavřít prohlížeč hned po zavěšení, bez zápisu výsledku → hovor je
      v historii firmy, kontakt zůstal ve frontě, nic se neztratilo.

**Účet**

- [ ] V Twilio Console sedí počet hovorů s počtem, který jste vytočili —
      žádné hovory navíc.
- [ ] Volanému se zobrazilo číslo z `TWILIO_CALLER_ID`.

---

## 9. Nahrávání

Přepínač je v *Nastavení → Volání*. Když je vypnutý, hovory fungují dál,
jen z nich nevzniká nahrávka — a tedy ani přepis a analýza.

Nahrávky zůstávají u Twilia; VEXY si ukládá jen odkaz a stahuje je přes
server kvůli přepisu. Do prohlížeče se odkaz na nahrávku nikdy neposílá.

Právní stránku nahrávání hovorů si ověřte sami — aplikace o ní netvrdí nic.
