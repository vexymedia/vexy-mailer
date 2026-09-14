/**
 * Důkaz, že tlačítko Zavolat není odkaz `tel:` a opravdu jede přes Twilio.
 *
 * Tohle vzniklo kvůli konkrétní regresi: v produkci se "Zavolat" chovalo
 * jako `href="tel:+420…"`, prohlížeč to předal systémovému telefonu a
 * aplikace o hovoru nevěděla nic. Unit testy hlídají komponentu, tenhle
 * skript hlídá výsledek ve skutečném prohlížeči proti běžícímu serveru.
 *
 * Co se ověřuje na detailu firmy:
 *   1. na stránce není JEDINÝ odkaz `tel:`,
 *   2. obě tlačítka Zavolat (hlavička i řádek kontaktu) jsou <button>,
 *   3. kliknutí sáhne na /api/calling/token a /api/calling/calls,
 *   4. v databázi vznikne hovor u SPRÁVNÉHO kontaktu a firmy,
 *   5. prohlížeč načte @twilio/voice-sdk a otevře se cockpit se stavem.
 *
 * Hovor se nikam nedovolá: server běží s neplatnými Twilio údaji, takže
 * SDK skončí chybou. To je záměr - skutečný telefonát tenhle skript
 * vytočit nesmí a nic se tu nepředstírá. Kdyby se tlačítko vrátilo na
 * `tel:`, neproběhl by ani jeden z kroků 3-5.
 *
 * Použití:
 *
 *   DATABASE_URL=… BASE_URL=http://localhost:3100 \
 *   ADMIN_EMAIL=… ADMIN_PASSWORD=… COMPANY_ID=… CALLER_ID=… \
 *   node tests/e2e/zavolat.mjs
 */
import { chromium } from "playwright";
import postgres from "postgres";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@vexy.test";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const COMPANY_ID = process.env.COMPANY_ID ?? "";
const CONTACT_ID = process.env.CONTACT_ID ?? "";
const CALLER_ID = process.env.CALLER_ID ?? "";
const CHROMIUM = process.env.CHROMIUM_PATH ?? undefined;

const steps = [];
function ok(label) { steps.push(true); console.log(`  PASS  ${label}`); }
function fail(label, detail) {
  steps.push(false);
  process.exitCode = 1;
  console.error(`  FAIL  ${label}\n        ${detail}`);
}
function check(label, condition, detail = "") {
  if (condition) ok(label);
  else fail(label, detail);
}

const sql = postgres(DATABASE_URL, { max: 1, prepare: false });

// Koho se čeká v cockpitu, se čte z databáze, ne z konstanty ve skriptu:
// jinak by se skript dal pustit jen proti jednomu konkrétnímu seedu.
const [expected] = await sql`
  select coalesce(nullif(btrim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''), email) as name,
         phone
    from contacts where id = ${CONTACT_ID}
`;
const browser = await chromium.launch({
  ...(CHROMIUM ? { executablePath: CHROMIUM } : {}),
  // Mikrofon bez hardwaru: prohlížeč podstrčí tichý vstup. Nenahrazuje to
  // telefonii, jen to nahradí headset, který v CI není.
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
await context.grantPermissions(["microphone"], { origin: BASE });
const page = await context.newPage();

const apiCalls = [];
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/calling/")) {
    apiCalls.push(`${request.method()} ${url.pathname}`);
  }
});
// Voice SDK se ohlásí tím, že otevře signalizační WebSocket k Twiliu.
// Je to jediný důkaz, který nejde zaměnit za nic jiného: `tel:` odkaz ani
// jakákoli naše atrapa by ho neotevřely.
const sockets = [];
page.on("websocket", (socket) => sockets.push(socket.url()));

try {
  // ---------------------------------------------------------------- login
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  check("přihlášení projde", !page.url().includes("/login"), `zůstal na ${page.url()}`);

  // Administrátor volá pod konkrétní obchodní identitou; bez ní server
  // hovor záměrně nezaloží.
  await context.addCookies([
    { name: "vexy_caller", value: CALLER_ID, url: BASE, httpOnly: true, sameSite: "Lax" },
  ]);

  // -------------------------------------------------------- detail firmy
  await page.goto(`${BASE}/firmy/${COMPANY_ID}`);
  await page.waitForLoadState("networkidle");

  const telLinks = await page.locator('a[href^="tel:"]').count();
  check("na detailu firmy není žádný odkaz tel:", telLinks === 0, `nalezeno ${telLinks}`);

  // Hlavičkové CTA + jedno tlačítko na každý kontakt s telefonem, takže
  // přesný počet závisí na datech. Podstatné je, že jich je aspoň dvě
  // (obě varianty z detailu firmy) a že žádné z nich není odkaz.
  const buttons = page.locator("button[data-call-button='twilio']");
  const buttonCount = await buttons.count();
  check("obě varianty tlačítka Zavolat jsou <button>", buttonCount >= 2, `nalezeno ${buttonCount}`);

  const tagNames = await buttons.evaluateAll((nodes) => nodes.map((n) => n.tagName));
  check("žádné z nich není <a>", tagNames.every((t) => t === "BUTTON"), tagNames.join(", "));

  // ------------------------------------------------------------ kliknutí
  const before = await sql`select count(*)::int as count from calls`;
  await buttons.first().click();
  // Řetěz token → /calls → Twilio SDK; SDK se stahuje až teď.
  await page.waitForTimeout(6000);

  check(
    "kliknutí si vyžádalo přístupový token",
    apiCalls.includes("GET /api/calling/token"),
    apiCalls.join(" | ") || "žádný požadavek na /api/calling/",
  );
  check(
    "kliknutí založilo hovor na serveru",
    apiCalls.includes("POST /api/calling/calls"),
    apiCalls.join(" | ") || "žádný požadavek na /api/calling/",
  );

  const after = await sql`select count(*)::int as count from calls`;
  check("v databázi přibyl hovor", after[0].count === before[0].count + 1,
    `před ${before[0].count}, po ${after[0].count}`);

  const [row] = await sql`
    select contact_id, company_id, caller_id, destination, status
      from calls order by created_at desc limit 1
  `;
  check("hovor sedí na správný kontakt", row?.contact_id === CONTACT_ID, String(row?.contact_id));
  check("hovor sedí na správnou firmu", row?.company_id === COMPANY_ID, String(row?.company_id));
  check("hovor má přiřazeného callera", row?.caller_id === CALLER_ID, String(row?.caller_id));
  check("vytáčí se číslo z databáze", row?.destination === expected?.phone,
    `${row?.destination} != ${expected?.phone}`);

  check(
    "prohlížeč otevřel Twilio signalizační WebSocket",
    sockets.some((url) => /twilio\.com/i.test(url)),
    sockets.join(" | ") || "žádný WebSocket se neotevřel",
  );

  // ------------------------------------------------------------- cockpit
  const cockpit = page.locator("[data-call-surface='cockpit']");
  check("otevřel se cockpit hovoru", (await cockpit.count()) === 1, "cockpit na stránce není");

  const text = (await cockpit.count()) ? await cockpit.innerText() : await page.locator("body").innerText();
  check("cockpit ukazuje volaný kontakt", text.includes(expected?.name ?? "\u0000"), text.slice(0, 400));
  check("cockpit ukazuje vytáčené číslo", text.includes(expected?.phone ?? "\u0000"), text.slice(0, 400));
  const stateVisible = ["Vytáčím", "Vyzvání", "Hovor", "Nepodařilo se", "Hovor ukončen"]
    .filter((label) => text.includes(label));
  check("stav hovoru je vidět", stateVisible.length > 0, text.slice(0, 400));

  if (process.env.OUT_DIR) {
    await page.screenshot({ path: `${process.env.OUT_DIR}/zavolat-cockpit.png`, fullPage: true });
  }
  console.log("\n--- cockpit ---\n" + text.slice(0, 900));
} catch (error) {
  fail("skript doběhl bez výjimky", error instanceof Error ? error.stack : String(error));
} finally {
  await browser.close();
  await sql.end();
}

const passed = steps.filter(Boolean).length;
console.log(`\n${passed}/${steps.length} kontrol prošlo.`);
