/**
 * Browser end-to-end check.
 *
 * Drives the real UI in Chromium against a running server, covering the whole
 * operator journey: sign in, add a mailbox, test its connection, import a CSV,
 * build a sequence, start a campaign, run the worker, suppress an address, and
 * then the calling half: add a caller, turn calling on, dial the queue and log
 * a booked, qualified meeting.
 *
 * The UI is Czech, so the selectors are Czech. Input names, routes and the
 * status values in the database stay English and are asserted as such.
 *
 * Usage (see README, "Verifying a deployment"):
 *
 *   node tests/e2e/fake-smtp.mjs &     # a local SMTP server on port 2525
 *   npm run build && npm start &
 *   APP_PASSWORD=... CRON_SECRET=... SESSION_SECRET=... DATABASE_URL=... \
 *     SMTP_PORT=2525 node tests/e2e/run.mjs
 *
 * It writes to the database the server points at, so aim it at a scratch
 * database, never at production data. SESSION_SECRET and DATABASE_URL must be
 * the same values the server is running with: the unsubscribe checks mint a
 * real signed link for a real contact and drive it over HTTP, which is the
 * only place the GET/HEAD safety rule can be proved against actual routing
 * rather than against the handler in isolation.
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import postgres from "postgres";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PASSWORD = process.env.APP_PASSWORD ?? "devpassword";
const CRON_SECRET = process.env.CRON_SECRET ?? "devcron";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const CHROMIUM = process.env.CHROMIUM_PATH ?? undefined;
const OUT = process.env.OUT_DIR;
const steps = [];
let stepNo = 0;

function ok(label) { steps.push(`  PASS  ${label}`); console.log(`  PASS  ${label}`); }
function fail(label, detail) {
  console.error(`  FAIL  ${label}\n        ${detail}`);
  process.exitCode = 1;
  steps.push(`  FAIL  ${label}: ${detail}`);
}
async function expectVisible(page, selector, label) {
  try {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 8000 });
    ok(label);
  } catch { fail(label, `selector not visible: ${selector}`); }
}
async function shot(page, name) {
  if (OUT) await page.screenshot({ path: `${OUT}/${String(++stepNo).padStart(2, "0")}-${name}.png`, fullPage: true });
}

const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

try {
  // ---- login ------------------------------------------------------------
  await page.goto(`${BASE}/`);
  await expectVisible(page, 'input[name="password"]', "unauthenticated visit redirects to login");
  await page.fill('input[name="password"]', "wrong-password");
  await page.click('button[type="submit"]');
  await expectVisible(page, "text=Nesprávné heslo", "wrong password is rejected");
  await shot(page, "login");

  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`);
  await expectVisible(page, "h1:has-text('Přehled')", "correct password signs in");
  await expectVisible(page, "text=TESTOVACÍ REŽIM", "test mode banner is shown by default");
  await shot(page, "dashboard-empty");

  // ---- mailbox ----------------------------------------------------------
  await page.goto(`${BASE}/mailboxes/new`);
  await page.fill('input[name="name"]', "Local test");
  await page.fill('input[name="from_name"]', "Vojtech");
  await page.fill('input[name="from_email"]', "sender@example.com");
  await page.fill('input[name="smtp_host"]', "127.0.0.1");
  await page.fill('input[name="smtp_port"]', String(process.env.SMTP_PORT));
  await page.fill('input[name="smtp_username"]', "sender@example.com");
  await page.fill('input[name="smtp_password"]', "secret");
  await page.fill('input[name="daily_limit"]', "40");
  await page.uncheck('input[name="smtp_secure"]');
  await page.uncheck('input[name="imap_secure"]');
  await shot(page, "mailbox-form");
  await page.click('button:has-text("Přidat schránku")');
  await page.waitForURL(`${BASE}/mailboxes`);
  await expectVisible(page, "text=Local test", "mailbox is created");
  await expectVisible(page, "text=neotestováno", "a new mailbox starts untested");
  await expectVisible(page, "text=0 / 40", "the mailbox shows its daily limit and usage");

  // password must not be echoed back to the browser
  const html = await page.content();
  if (html.includes("secret")) fail("password is not sent to the client", "plaintext found in HTML");
  else ok("password is not sent to the client");

  await page.click('a:has-text("sender@example.com")');
  await page.click('button:has-text("Otestovat připojení")');
  await expectVisible(page, "text=SMTP připojeno", "test connection succeeds against the local server");
  await shot(page, "mailbox-tested");

  // ---- contacts ---------------------------------------------------------
  await page.goto(`${BASE}/contacts`);
  const csv = [
    "first_name,last_name,company,email,website,phone",
    "Ann,Novak,Acme,ann@prospect.test,acme.test,+420777000001",
    "Petr,Svoboda,Globex,petr@prospect.test,globex.test,+420777000002",
    "Dup,Licate,Acme,ANN@PROSPECT.TEST,acme.test,+420777000003",
    "Bad,Row,NoEmail,not-an-email,x.test,+420777000004",
  ].join("\n");
  await page.setInputFiles('input[name="file"]', {
    name: "contacts.csv", mimeType: "text/csv", buffer: Buffer.from(csv),
  });
  await page.click('button:has-text("Importovat")');
  await expectVisible(page, "text=Naimportováno 2 nových kontaktů", "CSV import creates only the valid, unique rows");
  await expectVisible(page, "text=není platná e-mailová adresa", "the malformed row is reported");
  await expectVisible(page, "text=je v souboru víckrát", "the in-file duplicate is reported");
  await expectVisible(page, "text=+420777000001", "the phone number is imported for calling");
  await shot(page, "contacts-imported");

  // ---- campaign ---------------------------------------------------------
  await page.goto(`${BASE}/campaigns/new`);
  await page.fill('input[name="name"]', "E2E campaign");
  await page.check('input[name="mailbox_ids"]');
  await page.fill('input[name="daily_limit"]', "50");
  await page.fill('input[name="send_start"]', "00:00");
  await page.fill('input[name="send_end"]', "23:59");
  // The weekday checkboxes are sr-only behind their labels, so click the label.
  // Targeted through the input's value, not the label text: has-text is a
  // case-insensitive SUBSTRING match, so "Ne" also matches the mailbox label
  // ("sender@...") and clicking that would silently deselect the sender.
  for (const day of [6, 7]) await page.click(`label:has(input[name="send_days"][value="${day}"])`);
  for (const day of [6, 7]) {
    if (!(await page.isChecked(`input[name="send_days"][value="${day}"]`))) {
      fail("weekday toggle checks its hidden input", `day ${day} did not toggle`);
    }
  }
  ok("weekday toggles work by clicking the label");
  await page.click('button:has-text("Vytvořit kampaň")');
  await page.waitForURL(/\/campaigns\/[0-9a-f-]+/);
  const campaignUrl = page.url();
  await expectVisible(page, "text=koncept", "a new campaign is created as a draft");
  await expectVisible(page, "text=Sekvence nemá žádné kroky", "readiness lists what is missing");
  await shot(page, "campaign-draft");

  // start must be refused while not ready
  page.once("dialog", (d) => d.accept());
  await page.click('button:has-text("Spustit kampaň")');
  await expectVisible(page, "text=není připravená ke spuštění", "an unready campaign refuses to start");

  // ---- sequence ---------------------------------------------------------
  await page.goto(`${campaignUrl}?tab=sekvence`);
  await page.fill('input[name="step_0_subject"]', "Quick question about {{company}}");
  await page.fill('textarea[name="step_0_body"]', "Ahoj {{first_name|there}},\n\nnarazil jsem na {{company}}.");
  await page.click('button:has-text("Přidat follow-up")');
  await page.fill('input[name="step_1_subject"]', "Re: {{company}}");
  await page.fill('textarea[name="step_1_body"]', "Just following up.");
  await page.fill('input[name="step_1_delay"]', "3");
  await page.click('button:has-text("Uložit sekvenci")');
  await expectVisible(page, "text=Sekvence uložena: 2 kroků", "sequence saves two steps");
  await shot(page, "sequence");

  // typo in a variable name is caught
  await page.fill('input[name="step_1_subject"]', "Re: {{comapny}}");
  await page.click('button:has-text("Uložit sekvenci")');
  await expectVisible(page, "text=Neznámé proměnné", "an unknown variable is rejected");
  await page.fill('input[name="step_1_subject"]', "Re: {{company}}");
  await page.click('button:has-text("Uložit sekvenci")');
  await expectVisible(page, "text=Sekvence uložena", "the corrected sequence saves");

  // ---- contacts into the campaign --------------------------------------
  await page.goto(`${campaignUrl}?tab=kontakty`);
  await page.setInputFiles('input[name="file"]', {
    name: "contacts.csv", mimeType: "text/csv", buffer: Buffer.from(csv),
  });
  await page.click('button:has-text("Importovat")');
  await expectVisible(page, "text=2 přidáno do kampaně", "contacts are added to the campaign");
  await shot(page, "campaign-contacts");

  // ---- start ------------------------------------------------------------
  await page.goto(campaignUrl);
  await expectVisible(page, "text=Připraveno ke spuštění", "the campaign becomes ready");
  page.once("dialog", (d) => d.accept());
  await page.click('button:has-text("Spustit kampaň")');
  // The Start form is replaced by Pause, so assert on the resulting state.
  await expectVisible(page, 'button:has-text("Pozastavit")', "the campaign starts");
  await expectVisible(page, "span:has-text('běží')", "the campaign shows as active");
  await shot(page, "campaign-active");

  // ---- worker -----------------------------------------------------------
  await page.goto(`${BASE}/`);
  await page.click('button:has-text("Spustit worker")');
  await expectVisible(page, "text=simulated", "the worker runs and simulates a send in test mode");
  await shot(page, "dashboard-active");

  await page.goto(`${campaignUrl}?tab=aktivita`);
  await expectVisible(page, "text=E-mail krok 1 simulován", "the activity log records the simulated send");
  await shot(page, "activity");

  // ---- suppression ------------------------------------------------------
  await page.goto(`${BASE}/suppression`);
  await page.fill('input[name="email"]', "petr@prospect.test");
  await page.click('button:has-text("Přidat")');
  await expectVisible(page, "text=už nikdy nebude kontaktován", "an address can be suppressed");
  await shot(page, "suppression");

  await page.goto(`${campaignUrl}?tab=kontakty`);
  await expectVisible(page, "text=odhlášeno", "the suppressed contact leaves the campaign");

  // ---- unsubscribe: GET and HEAD must not unsubscribe anybody -----------
  // Every link in an email is fetched by things that are not the recipient:
  // Safe Links rewrites, spam filters scoring the mail, link checkers issuing
  // HEAD, clients prefetching a preview. Only a deliberate POST - the confirm
  // button, or a mail client's RFC 8058 one-click - may remove an address.
  if (!SESSION_SECRET || !DATABASE_URL) {
    fail("unsubscribe safety checks", "SESSION_SECRET and DATABASE_URL are required (see the usage note above)");
  } else {
    const db = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [target] = await db`
        select id, email from contacts where email = ${"ann@prospect.test"}
      `;
      if (!target) {
        fail("unsubscribe safety checks", "the imported contact ann@prospect.test was not found");
      } else {
        const token = createHmac("sha256", SESSION_SECRET)
          .update(`unsub:${target.id}`)
          .digest("hex")
          .slice(0, 32);
        const url = `${BASE}/u/${target.id}/${token}`;
        const suppressed = async () =>
          (await db`select 1 from suppression_list where email = ${target.email}`).length > 0;

        // A link scanner sweeping the mail.
        const head = await fetch(url, { method: "HEAD" });
        if (head.status === 200) ok("HEAD on the unsubscribe URL is served, not rejected");
        else fail("HEAD on the unsubscribe URL is served, not rejected", `got ${head.status}`);
        if (!(await suppressed())) ok("HEAD does not unsubscribe the contact");
        else fail("HEAD does not unsubscribe the contact", `${target.email} was suppressed by a HEAD`);

        // A human, or a preview fetch, opening the link.
        const get = await fetch(url);
        const getBody = await get.text();
        if (get.status === 200) ok("GET on the unsubscribe URL renders");
        else fail("GET on the unsubscribe URL renders", `got ${get.status}`);
        if (!(await suppressed())) ok("GET does not unsubscribe the contact");
        else fail("GET does not unsubscribe the contact", `${target.email} was suppressed by a GET`);
        if (/<form[^>]+method="post"/i.test(getBody)) ok("GET offers an explicit confirmation form");
        else fail("GET offers an explicit confirmation form", "no POST form in the response");

        // The recipient actually deciding.
        const post = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        });
        if (post.status === 200) ok("POST performs the unsubscribe");
        else fail("POST performs the unsubscribe", `got ${post.status}`);
        if (await suppressed()) ok("the contact is suppressed after the explicit POST");
        else fail("the contact is suppressed after the explicit POST", `${target.email} is not on the list`);

        // A forged link changes nothing.
        const forged = await fetch(`${BASE}/u/${target.id}/${"0".repeat(32)}`, { method: "POST" });
        if (forged.status === 400) ok("a forged unsubscribe token is refused");
        else fail("a forged unsubscribe token is refused", `got ${forged.status}`);
      }
    } finally {
      await db.end({ timeout: 5 });
    }
  }

  // ---- settings ---------------------------------------------------------
  await page.goto(`${BASE}/settings`);
  await expectVisible(page, "text=Testovací režim zapnutý", "settings shows test mode on");
  await page.check('input[name="test_mode"]');
  await page.click('input[value="redirect"]');
  await page.fill('input[name="test_email"]', "");
  await page.click('button:has-text("Uložit nastavení")');
  // Blocked client-side by `required`, so the form never submits.
  const invalid = await page.locator('input[name="test_email"]').evaluate((el) => !el.checkValidity());
  if (invalid) ok("redirect mode without an address is refused");
  else fail("redirect mode without an address is refused", "the form submitted anyway");
  await shot(page, "settings");

  // ---- inbox ------------------------------------------------------------
  await page.goto(`${BASE}/inbox`);
  await expectVisible(page, "h1:has-text('Doručená pošta')", "the Inbox page renders");
  await expectVisible(page, "text=Zatím žádné odpovědi", "an empty inbox says so");
  for (const label of ["Vše", "Nepřečtené", "Pozitivní", "Vyžaduje akci"]) {
    await expectVisible(page, `a:has-text("${label}")`, `inbox filter "${label}" is present`);
  }
  await expectVisible(page, 'select[name="campaign"]', "inbox can filter by campaign");
  await expectVisible(page, 'select[name="mailbox"]', "inbox can filter by mailbox");
  await expectVisible(page, 'input[name="q"]', "inbox has a search box");
  await shot(page, "inbox");

  await page.goto(`${BASE}/mailboxes`);
  await expectVisible(page, "text=Dnes odesláno", "mailboxes list shows today's usage");
  await shot(page, "mailboxes");

  // ---- other pages render ----------------------------------------------
  for (const [path, heading] of [["/activity", "Aktivita"], ["/campaigns", "Kampaně"], ["/contacts", "Kontakty"], ["/inbox", "Doručená pošta"], ["/calleri", "Calleři"], ["/volani", "Volání"]]) {
    await page.goto(BASE + path);
    await expectVisible(page, `h1:has-text("${heading}")`, `${path} renders`);
  }

  // ---- calling ----------------------------------------------------------
  // The whole caller journey: a caller exists, the campaign is switched on,
  // the queue offers someone, and one logged outcome books a qualified meeting.
  await page.goto(`${BASE}/calleri`);
  await page.fill('input[name="name"]', "Jan Caller");
  await page.click('button:has-text("Přidat callera")');
  await expectVisible(page, "text=Caller Jan Caller přidán", "a caller can be added");
  await expectVisible(page, "text=aktivní", "a new caller is active");

  await page.goto(`${campaignUrl}?tab=volani`);
  await page.check('input[name="calling_enabled"]');
  await page.fill('input[name="max_call_attempts"]', "4");
  await page.fill('textarea[name="qualification_criteria"]', "Rozhoduje o marketingu. 10+ zaměstnanců.");
  await page.fill('textarea[name="script_opening"]', "Dobrý den, tady Jan z VEXY.");
  await page.click('button:has-text("Uložit nastavení volání")');
  await expectVisible(page, "text=Nastavení volání uloženo", "calling can be switched on for a campaign");
  await shot(page, "calling-settings");

  await page.goto(`${BASE}/volani`);
  await expectVisible(page, "text=E2E campaign", "the campaign appears in the calling list");
  await page.click('a:has-text("Volat")');
  await page.waitForURL(/\/volani\/[0-9a-f-]+/);

  // Who is at this workstation is asked once per shift, before any prospect is
  // handed out - a leased prospect needs an owner.
  await expectVisible(page, "text=Kdo dnes volá?", "the workspace asks who is calling before dialling");
  await page.click('label:has(input[name="caller_id"])');
  await page.click('button:has-text("Začít volat")');
  await expectVisible(page, "text=VOLAT +420777000", "the workspace offers a dialable number");
  await expectVisible(page, "text=Volá Jan Caller", "the chosen caller is shown and can be swapped");
  await expectVisible(page, "text=Dobrý den, tady Jan z VEXY.", "the script panel shows the opening");
  await expectVisible(page, "text=Pokus 1 z 4", "the workspace shows the attempt count");
  await shot(page, "calling-workspace");

  await page.click('button:has-text("Domluvená schůzka")');
  await expectVisible(page, 'input[name="meeting_at"]', "booking a meeting asks for a date");
  await expectVisible(page, "text=Rozhoduje o marketingu", "the qualification criteria are shown at the decision");
  await page.click('button:has-text("Uložit schůzku")');
  await expectVisible(page, "text=Uloženo: Domluvená schůzka", "the meeting is logged");
  await shot(page, "calling-logged");

  await page.goto(`${campaignUrl}?tab=volani`);
  await expectVisible(page, "text=kvalifikovaná", "the booked meeting is recorded as qualified");

  // A meeting in the diary is not a meeting that happened, and a no-show is
  // neither. The lifecycle is set on the contact's own page.
  await page.goto(`${campaignUrl}?tab=volani&filter=meetings_booked`);
  await page.locator("table a[href^='/kontakt/']").first().click();
  await page.waitForURL(/\/kontakt\/[0-9a-f-]+/);
  await expectVisible(page, "text=Naplánovaná", "a booked meeting starts as merely scheduled");
  await page.click('button:has-text("Nedorazil")');
  // The control deliberately shows no banner, so assert the state itself: the
  // meeting's own status line, not one of the four buttons offering to set it.
  await expectVisible(page, "aside dd:has-text('Nedorazil')", "the meeting can be marked a no-show");
  await page.goto(`${campaignUrl}?tab=volani`);
  await expectVisible(page, "text=Nedorazil", "the no-show shows on the campaign");
  await page.goto(`${campaignUrl}?tab=ekonomika`);
  await expectVisible(page, "h2:has-text('Náklad na výsledek')", "the economics tab renders");
  await shot(page, "calling-economics");

  // ---- unauthenticated cron endpoint ------------------------------------
  const unauth = await page.request.post(`${BASE}/api/cron/tick`);
  if (unauth.status() === 401) ok("the cron endpoint rejects an unauthenticated call");
  else fail("the cron endpoint rejects an unauthenticated call", `got ${unauth.status()}`);

  const auth = await page.request.post(`${BASE}/api/cron/tick`, {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  if (auth.ok()) ok("the cron endpoint accepts the correct secret");
  else fail("the cron endpoint accepts the correct secret", `got ${auth.status()}`);

  // ---- sign out ---------------------------------------------------------
  await page.goto(`${BASE}/`);
  await page.click('button:has-text("Odhlásit")');
  await page.waitForURL(/\/login/);
  ok("sign out returns to the login page");

  const realErrors = consoleErrors.filter((text) => !/favicon|404 \(Not Found\)/i.test(text));
  if (realErrors.length === 0) ok("no browser console errors");
  else fail("no browser console errors", realErrors.slice(0, 5).join(" | "));
} catch (error) {
  fail("run completed without an exception", error.message);
  await shot(page, "crash");
} finally {
  await browser.close();
  if (OUT) writeFileSync(`${OUT}/results.txt`, steps.join("\n"));
  const failures = steps.filter((s) => s.startsWith("  FAIL")).length;
  console.log(`\n${steps.length - failures}/${steps.length} checks passed`);
}
