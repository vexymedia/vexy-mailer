# Volání z prohlížeče

VEXY umí vytočit prospekta přímo z prohlížeče: caller sedí u notebooku
s headsetem, klikne na **Zavolat** a prospektovi zazvoní normální telefon.
Z hovoru pak vznikne nahrávka, přepis, AI shrnutí a návrh dalšího kroku.

Bez Twilio proměnných aplikace funguje dál — tlačítko **Zavolat** se chová
jako dřív a otevře telefon v počítači (`tel:`). Nic se nerozbije, jen se
nevolá přes prohlížeč.

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
npm run db:migrate     # potřebuje migraci 0007_calls.sql
npm run dev
```

Bez Twilio proměnných uvidíte v *Nastavení → Volání* stav „není
nastaveno“ a seznam chybějících proměnných. Tlačítko Zavolat zůstane
funkční jako `tel:` odkaz.

Webhooky potřebují veřejnou URL. Twilio se na `localhost` nedostane,
takže při lokálním testování skutečných hovorů potřebujete tunel —
například `cloudflared tunnel --url http://localhost:3000` nebo
`ngrok http 3000`. Žádnou závislost kvůli tomu do projektu nepřidávejte;
je to nástroj, ne součást aplikace. Výslednou adresu dejte do
`TWILIO_WEBHOOK_BASE_URL` **a** do Voice Request URL v TwiML App.

Bez tunelu hovor proběhne, ale nedorazí stavové události ani nahrávka —
hovor zůstane ve stavu „Vytáčím“ a nezpracuje se.

---

## 5. Webhooky

| Endpoint | Kdo volá | Co dělá |
| --- | --- | --- |
| `POST /api/calling/voice` | Twilio při `Device.connect()` | vrátí TwiML `<Dial>` s číslem z databáze |
| `POST /api/calling/status` | Twilio v průběhu hovoru | posouvá stav (`ringing` → `in_progress` → `completed`) |
| `POST /api/calling/recording` | Twilio po zpracování nahrávky | uloží odkaz a délku nahrávky |

Všechny tři ověřují hlavičku `X-Twilio-Signature` proti `TWILIO_AUTH_TOKEN`.
Bez platného podpisu vrátí `403` a nic nezmění. Jsou proto v middlewaru
mezi veřejnými cestami — Twilio se přihlásit neumí.

Události chodí opakovaně a mimo pořadí. Zápis je idempotentní a stav
hovoru se nikdy nevrací zpátky: jednou ukončený hovor zůstane ukončený.

**Časté chyby**

* `403` na všech webhoodech → `TWILIO_WEBHOOK_BASE_URL` neodpovídá URL, na
  kterou Twilio skutečně volá (typicky http/https nebo chybějící doména).
* Hovor zůstane „Vytáčím“ → webhooky nedorazily; zkontrolujte tunel nebo
  Voice Request URL v TwiML App.
* Nahrávka se nikdy nezpracuje → chybí `OPENAI_API_KEY`, nebo neběží
  `/api/cron/tick`.

---

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

---

## 7. První skutečný hovor

1. Doplňte všech šest `TWILIO_*` proměnných a nasaďte (na Vercelu
   redeploy, aby se zapekly).
2. Aplikujte migraci: `npm run db:migrate`.
3. Otevřete **Nastavení → Volání**. Musí svítit „nastaveno“.
4. Klikněte na **Otestovat** u mikrofonu a povolte ho. (Prohlížeč pustí
   mikrofon jen na HTTPS nebo na `localhost`.)
5. Připojte headset.
6. Otevřete **Oslovení → Dnes** nebo detail firmy s telefonním číslem.
7. Klikněte **Zavolat**. Otevře se cockpit: uvidíte „Vytáčím“, pak
   „Vyzvání“ a po zvednutí běžící čas.
8. Zavěste. Objeví se panel „Jak hovor dopadl?“ — výsledek jde zapsat
   hned, i když se nahrávka ještě zpracovává.
9. Do minuty (jeden tick) se doplní přepis, do druhé shrnutí a návrh
   výsledku. Najdete je na detailu firmy v sekci **Telefonáty**.

Hovor přežije přechod na jinou stránku: dole zůstane lišta se jménem,
firmou, časem a tlačítky Ztlumit / Zavěsit.

---

## 8. Nahrávání

Přepínač je v *Nastavení → Volání*. Když je vypnutý, hovory fungují dál,
jen z nich nevzniká nahrávka — a tedy ani přepis a analýza.

Nahrávky zůstávají u Twilia; VEXY si ukládá jen odkaz a stahuje je přes
server kvůli přepisu. Do prohlížeče se odkaz na nahrávku nikdy neposílá.

Právní stránku nahrávání hovorů si ověřte sami — aplikace o ní netvrdí nic.
