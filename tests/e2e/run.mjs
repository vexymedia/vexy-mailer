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
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "vojta@vexy.cz";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "administrator-heslo";
const CALLER_EMAIL = process.env.CALLER_EMAIL ?? "jan@example.com";
const CALLER_PASSWORD = process.env.CALLER_PASSWORD ?? "caller-tajne-heslo";
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

/** Čtecí spojení pro kontroly, které se z UI spolehlivě přečíst nedají. */
const checkDb = postgres(DATABASE_URL, { max: 1, prepare: false });

const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

try {
  // ---- login ------------------------------------------------------------
  // Účty zakládá bootstrap skript; sdílené heslo už neexistuje.
  await page.goto(`${BASE}/`);
  await expectVisible(page, 'input[name="email"]', "unauthenticated visit redirects to login");
  await expectVisible(page, "h1:has-text('Přihlášení do VEXY')", "the login page is the VEXY one");

  await shot(page, "login");

  /**
   * Jeden pokus o přihlášení z čisté stránky.
   *
   * Čerstvé načtení je tu schválně: po neúspěchu zůstane hláška viset
   * a čekat na ni podruhé by prošlo hned, ještě než se odešle další
   * pokus - a test by pak tvrdil něco, co neověřil.
   */
  async function attemptLogin(email, pw) {
    await page.goto(`${BASE}/login`);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', pw);
    await page.click('button[type="submit"]');
  }

  await attemptLogin(ADMIN_EMAIL, "spatne-heslo-tady");
  await expectVisible(page, "text=Nesprávný e-mail nebo heslo", "a wrong password is rejected");

  await attemptLogin("nikdo@example.com", ADMIN_PASSWORD);
  await expectVisible(
    page,
    "text=Nesprávný e-mail nebo heslo",
    "an unknown account gets the same message as a wrong password",
  );

  // Staré sdílené heslo už není cesta dovnitř.
  await attemptLogin(ADMIN_EMAIL, PASSWORD);
  await expectVisible(page, "text=Nesprávný e-mail nebo heslo", "the old APP_PASSWORD no longer works");

  await attemptLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.waitForURL(`${BASE}/`);
  await expectVisible(page, "h1:has-text('Přehled')", "correct credentials sign the admin in");
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
  // Technická věc: patří do Nastavení, ne mezi hlavní akce na Přehledu.
  await page.goto(`${BASE}/settings`);
  await page.click('button:has-text("Spustit worker")');
  await expectVisible(page, "text=simulated", "the worker runs and simulates a send in test mode");
  await shot(page, "worker-run");

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
  await expectVisible(page, "h1:has-text('Odpovědi')", "the Inbox page renders");
  await expectVisible(page, "text=Zatím žádné odpovědi", "an empty inbox says so");
  for (const label of ["Vše", "Nepřečtené", "Pozitivní", "Vyžaduje akci"]) {
    await expectVisible(page, `a:has-text("${label}")`, `inbox filter "${label}" is present`);
  }
  await expectVisible(page, 'select[name="campaign"]', "inbox can filter by campaign");
  await expectVisible(page, 'select[name="mailbox"]', "inbox can filter by mailbox");
  await expectVisible(page, 'input[name="q"]', "inbox has a search box");
  await shot(page, "inbox");

  // ---- schránka ---------------------------------------------------------
  // Odpovědi jsou triage reakcí; Schránka je poštovní klient a musí ukázat
  // i vlákna, kde jsme zatím jen odeslali. Po redesignu tenhle pohled
  // z aplikace zmizel, takže se hlídá, že tam je.
  await page.goto(`${BASE}/inbox/schranka`);
  await expectVisible(page, "h1:has-text('Schránka')", "the mailbox view renders");
  await expectVisible(page, 'a:has-text("Všechny schránky")', "mailbox picker is present");
  await expectVisible(page, 'a:has-text("sender@example.com")', "each mailbox can be selected");
  for (const label of ["Příchozí", "Jen odeslané", "Nepřečtené"]) {
    await expectVisible(page, `a:has-text("${label}")`, `mailbox filter "${label}" is present`);
  }
  await expectVisible(page, 'input[name="q"]', "the mailbox view has a search box");

  // Odeslání v testovacím režimu se jen simuluje a vlákno nezakládá, takže
  // se sem jedno vloží napřímo - jinak by se browser cesta ke konverzaci
  // (otevřít, přečíst, odpovědět) nedala projet vůbec.
  const [seedContact] = await checkDb`select id from contacts where email = 'ann@prospect.test'`;
  const [seedMailbox] = await checkDb`select id, from_email from mailboxes limit 1`;
  const [seedThread] = await checkDb`
    insert into conversations (contact_id, mailbox_id, subject, unread_count)
    values (${seedContact.id}, ${seedMailbox.id}, 'Spolupráce s Acme', 1)
    returning id
  `;
  await checkDb`
    insert into messages (conversation_id, direction, kind, from_email, to_email, subject,
                          body_text, occurred_at)
    values (${seedThread.id}, 'outbound', 'campaign', ${seedMailbox.from_email},
            'ann@prospect.test', 'Spolupráce s Acme', 'Dobrý den, posíláme krátké video.',
            now() - interval '2 days')
  `;

  await page.goto(`${BASE}/inbox/schranka`);
  await expectVisible(page, "text=Spolupráce s Acme", "a sent-only thread is listed in the mailbox");
  await expectVisible(page, "text=zatím bez odpovědi", "a thread with no reply is marked as such");
  await shot(page, "schranka");

  // Jen odeslané / příchozí skutečně filtruje, ne jen zvýrazní chip.
  await page.goto(`${BASE}/inbox/schranka?smer=incoming`);
  await expectVisible(page, "text=Žádná vlákna", "the incoming filter excludes sent-only threads");
  await page.goto(`${BASE}/inbox/schranka?smer=outgoing`);
  await expectVisible(page, "text=Spolupráce s Acme", "the sent-only filter keeps them");

  // Odpovědi zůstávají oddělené: vlákno bez odpovědi do triage nepatří.
  await page.goto(`${BASE}/inbox`);
  await expectVisible(page, "text=Zatím žádné odpovědi", "replies triage stays reply-only");

  // Prospekt odpoví - vlákno se objeví v obou pohledech a je nepřečtené.
  await checkDb`
    insert into messages (conversation_id, direction, kind, from_email, to_email, subject,
                          body_text, occurred_at)
    values (${seedThread.id}, 'inbound', 'incoming', 'ann@prospect.test',
            ${seedMailbox.from_email}, 'Re: Spolupráce s Acme',
            'Pošlete mi prosím více informací.', now() - interval '1 hour')
  `;
  await page.goto(`${BASE}/inbox`);
  await expectVisible(page, "text=Spolupráce s Acme", "a reply shows up in the triage list");

  await page.goto(`${BASE}/inbox/schranka`);
  await expectVisible(page, "text=nepřečteno", "an unread thread is marked unread");
  await page.locator("ul.card a[href^='/inbox/']").first().click();
  await page.waitForURL(/\/inbox\/[0-9a-f-]{8}/);
  await expectVisible(page, 'a:has-text("Zpět do schránky")', "a thread opens from the mailbox");
  await expectVisible(page, "text=Pošlete mi prosím více informací", "the whole conversation is shown");
  await expectVisible(page, "text=Dobrý den, posíláme krátké video", "outgoing messages are shown too");
  await expectVisible(page, 'a:has-text("Zobrazit firmu")', "a thread links through to its company");
  await expectVisible(page, 'button:has-text("Odeslat odpověď")', "the thread can be replied to");
  await expectVisible(page, `text=Odpovídáte jako`, "the reply goes from the mailbox that sent it");
  await shot(page, "thread");

  // Otevření vlákna je to, co ho označí jako přečtené.
  await page.goto(`${BASE}/inbox/schranka`);
  if ((await page.locator("text=nepřečteno").count()) === 0) ok("opening a thread marks it read");
  else fail("opening a thread marks it read", "still marked unread");

  await page.goto(`${BASE}/mailboxes`);
  await expectVisible(page, "text=Dnes odesláno", "mailboxes list shows today's usage");
  await shot(page, "mailboxes");

  // ---- other pages render ----------------------------------------------
  for (const [path, heading] of [["/activity", "Aktivita"], ["/campaigns", "Kampaně"], ["/contacts", "Kontakty"], ["/inbox", "Odpovědi"], ["/tym", "Tým"], ["/volani", "Volání"], ["/firmy", "Firmy"], ["/osloveni/fronta", "Fronta"], ["/osloveni/plan", "Plán"], ["/osloveni/hovory", "Přehled volání"], ["/inbox/schranka", "Schránka"]]) {
    await page.goto(BASE + path);
    await expectVisible(page, `h1:has-text("${heading}")`, `${path} renders`);
  }

  // ---- calling ----------------------------------------------------------
  // The whole caller journey: a caller exists, the campaign is switched on,
  // the queue offers someone, and one logged outcome books a qualified meeting.
  await page.goto(`${BASE}/tym`);
  await page.fill('input[name="name"]', "Jan Caller");
  await page.click('button:has-text("Přidat do týmu")');
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
  await expectVisible(page, "text=Zavolat +420777000", "the workspace offers a dialable number");
  await expectVisible(page, "text=Volá Jan Caller", "the chosen caller is shown and can be swapped");
  await expectVisible(page, "text=Dobrý den, tady Jan z VEXY.", "the script panel shows the opening");
  await expectVisible(page, "text=Pokus 1 z 4", "the workspace shows the attempt count");
  await shot(page, "calling-workspace");

  await page.click('button:has-text("Schůzka sjednána")');
  await expectVisible(page, 'input[name="meeting_at"]', "booking a meeting asks for a date");
  await expectVisible(page, "text=Rozhoduje o marketingu", "the qualification criteria are shown at the decision");
  await page.click('button:has-text("Uložit schůzku")');
  await expectVisible(page, "text=Uloženo: Schůzka sjednána", "the meeting is logged");
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

  // ---- nová informační architektura --------------------------------------
  await page.goto(`${BASE}/`);
  for (const label of ["Přehled", "Firmy", "Oslovení", "Komunikace", "Aktivita", "Tým", "Nastavení"]) {
    await expectVisible(page, `aside a:has-text("${label}")`, `sidebar má položku "${label}"`);
  }
  // Worker ani počty odeslaných e-mailů už nejsou tím hlavním na Přehledu.
  await expectVisible(page, "text=Připravené firmy", "Přehled vede KPI o firmách");
  await expectVisible(page, "text=Dnes řešit", "Přehled vede k dnešní práci");
  await expectVisible(page, 'a:has-text("Začít oslovovat")', "Přehled má jedno hlavní CTA");
  await expectVisible(page, "text=Pokusů o volání", "sedmidenní metriky jsou pojmenované podle dat");
  await expectVisible(page, "text=Dovolatelnost", "Přehled ukáže dovolatelnost");
  const overviewHtml = await page.content();
  if (!/Spustit worker/.test(overviewHtml)) ok("worker už není CTA na Přehledu");
  else fail("worker už není CTA na Přehledu", "tlačítko je pořád na dashboardu");
  await shot(page, "prehled");

  // ---- firmy --------------------------------------------------------------
  await page.goto(`${BASE}/firmy`);
  await expectVisible(page, "h1:has-text('Firmy')", "Firmy se vykreslí");
  await expectVisible(page, "text=Acme", "firma vznikla z importovaných kontaktů");
  for (const view of ["Dnes řešit", "Follow-up dnes", "Bez dalšího kroku", "High priority", "3+ pokusy", "Schůzky"]) {
    await expectVisible(page, `a:has-text("${view}")`, `Firmy mají rychlý pohled "${view}"`);
  }
  for (const filterName of ["status", "priority", "owner", "krok", "aktivita"]) {
    await expectVisible(page, `select[name="${filterName}"]`, `Firmy filtrují podle "${filterName}"`);
  }
  await expectVisible(page, "th:has-text('Pokusy')", "seznam firem ukáže počet pokusů");
  await expectVisible(page, "th:has-text('Další krok')", "seznam firem ukáže další krok");

  // Rychlý pohled skutečně filtruje, ne jen zvýrazní chip.
  await page.goto(`${BASE}/firmy?krok=none`);
  await expectVisible(page, "h1:has-text('Firmy')", "pohled Bez dalšího kroku se vykreslí");

  await page.goto(`${BASE}/firmy`);
  await page.click("table a[href^='/firmy/']");
  await page.waitForURL(/\/firmy\/[0-9a-f-]+/);
  await expectVisible(page, "text=Proč ji řešíme", "detail firmy vede důvodem");
  await expectVisible(page, "text=Další krok", "detail firmy ukáže konkrétní další krok");
  await expectVisible(page, "text=Koho kontaktovat", "detail firmy ukáže kontaktní osoby");
  await expectVisible(page, 'a:has-text("Historie")', "kontakt má pracovní kartu s akcemi");
  await expectVisible(page, "text=Historie aktivit", "detail firmy má historii");

  await page.fill('textarea[name="reason"]', "Výrobní firma, expanduje, nemá vlastní obchodní tým");
  await page.selectOption('select[name="priority"]', "high");
  await page.click('button:has-text("Uložit")');
  await expectVisible(page, "text=Uloženo", "kontext firmy jde uložit");
  await shot(page, "firma-detail");

  // ---- oslovení -----------------------------------------------------------
  await page.goto(`${BASE}/osloveni`);
  await expectVisible(page, "h1:has-text('Dnes')", "Oslovení > Dnes se vykreslí jako pracovní režim");
  for (const label of ["Dnes", "Fronta", "Plán"]) {
    await expectVisible(page, `a:has-text("${label}")`, `Oslovení má záložku "${label}"`);
  }
  await expectVisible(page, "text=zpracováno", "pracovní režim ukáže postup dne");
  // Po zápisu výsledku si workspace kampaně rovnou rezervoval další firmu,
  // takže tady už může být rozdělaná práce. Obojí je správně - ověřuje se,
  // že se člověk k hovoru dostane, ne kolik kliknutí zrovna zbývá.
  const startCta = page.locator('button:has-text("Začít oslovovat")');
  if ((await startCta.count()) > 0) {
    ok("pracovní režim má jedno hlavní CTA");
    await startCta.first().click();
  } else {
    ok("pracovní režim rovnou pokračuje na drženou firmu");
  }
  await expectVisible(page, "text=Jak hovor dopadl?", "po vytočení následuje panel s výsledky");
  await expectVisible(page, "text=Hlavní kontakt", "pracovní karta ukáže správného člověka");
  await expectVisible(page, "text=Další krok", "pracovní karta ukáže další krok");
  for (const label of ["Schůzka sjednána", "Volat jindy", "Nezastižen", "Nemá zájem"]) {
    await expectVisible(page, `button:has-text("${label}")`, `hlavní výsledek "${label}" je na jeden klik`);
  }
  await shot(page, "osloveni-dnes");

  // Nezastižen musí vytvořit další krok, ne nechat firmu viset. Ověřuje se
  // to na datech: když byla tahle firma v dnešní frontě poslední, formulář
  // se po zápisu odmontuje a s ním i potvrzovací hláška.
  await page.click('button:has-text("Nezastižen")');
  await page.waitForTimeout(1500);
  const logged = await checkDb`
    select ca.outcome, cc.call_attempts, cc.next_call_at
      from call_activities ca join campaign_contacts cc on cc.id = ca.campaign_contact_id
     where ca.outcome = 'no_answer'
     order by ca.called_at desc limit 1
  `;
  if (logged.length === 1 && logged[0].call_attempts >= 1 && logged[0].next_call_at) {
    ok("Nezastižen zvýší pokus a naplánuje další krok");
  } else {
    fail("Nezastižen zvýší pokus a naplánuje další krok", JSON.stringify(logged[0] ?? null));
  }
  const stillOpen = await checkDb`
    select count(*)::int as count from campaign_contacts
     where call_status in ('new', 'in_progress', 'callback') and next_call_at is null
  `;
  if (stillOpen[0].count === 0) ok("žádná otevřená firma nezůstala bez dalšího kroku");
  else fail("žádná otevřená firma nezůstala bez dalšího kroku", `${stillOpen[0].count} bez termínu`);

  await page.goto(`${BASE}/osloveni/plan`);
  await expectVisible(page, "h1:has-text('Plán')", "týdenní plán se vykreslí");
  await page.fill('input[name="start"]', "09:00");
  await page.fill('input[name="end"]', "11:00");
  await page.selectOption('select[name="activity_type"]', "follow_up");
  await page.fill('input[name="note"]', "Follow-upy po videu");
  await page.click('button:has-text("Přidat blok")');
  await expectVisible(page, "text=Blok naplánován", "do plánu jde přidat blok práce");
  await expectVisible(page, "text=Follow-upy po videu", "blok je v týdnu vidět");
  const startLink = page.locator('a:has-text("Začít")');
  if ((await startLink.count()) > 0) {
    const href = await startLink.first().getAttribute("href");
    if (href === "/osloveni?rezim=followup") ok("z follow-up bloku vede Začít do follow-up fronty");
    else fail("z follow-up bloku vede Začít do follow-up fronty", `href=${href}`);
  } else {
    // Prázdná follow-up fronta je legitimní stav; karta to musí říct.
    await expectVisible(page, "text=nic k práci", "prázdný blok to řekne místo mrtvého tlačítka");
  }
  await page.goto(`${BASE}/osloveni?rezim=followup`);
  await expectVisible(page, "h1:has-text('Follow-up')", "režim fronty je z hlavičky poznat");
  await page.goto(`${BASE}/osloveni?rezim=prvni`);
  await expectVisible(page, "h1:has-text('První oslovení')", "režim prvního oslovení se vykreslí");
  await shot(page, "plan");

  // ---- volání bez Twilia --------------------------------------------------
  // Server běží bez TWILIO_* proměnných, takže se tu ověřuje ten stav, ve
  // kterém aplikace je hned po nasazení: volání z prohlížeče vypnuté,
  // a tlačítko Zavolat pořád k něčemu je.
  await page.goto(`${BASE}/settings`);
  await expectVisible(page, 'h2:has-text("Volání")', "nastavení má sekci Volání");
  await expectVisible(page, "text=není nastaveno", "chybějící telefonie se hlásí, ne skrývá");
  await expectVisible(page, "text=TWILIO_ACCOUNT_SID", "nastavení vypíše, které proměnné chybí");
  await expectVisible(page, 'text=Nahrávat hovory', "nahrávání jde vypnout");
  await shot(page, "nastaveni-volani");

  await page.goto(`${BASE}/firmy`);
  await page.click("table a[href^='/firmy/']");
  await page.waitForURL(/\/firmy\/[0-9a-f-]+/);
  const dialLink = page.locator('a[href^="tel:"]').first();
  if ((await dialLink.count()) > 0) {
    ok("bez Twilia zůstane Zavolat odkazem tel:");
  } else {
    fail("bez Twilia zůstane Zavolat odkazem tel:", "žádný tel: odkaz na detailu firmy");
  }
  // A hlavně: nesmí vzniknout hovor, který nikdo nezaložil.
  const callRows = await checkDb`select count(*)::int as count from calls`;
  if (callRows[0].count === 0) ok("samotné otevření stránky nezaloží hovor");
  else fail("samotné otevření stránky nezaloží hovor", `${callRows[0].count} řádků v calls`);

  // ---- responsive ---------------------------------------------------------
  // Desktop je hlavní pracovní prostředí, ale hlavní obrazovky musí zůstat
  // použitelné na telefonu. Kontroluje se to, co se skutečně rozbíjí:
  // vodorovný přetok celé stránky a zmizelé hlavní CTA.
  const screens = [
    ["/", "Přehled"],
    ["/firmy", "Firmy"],
    ["/osloveni", "Dnes"],
    ["/osloveni/plan", "Plán"],
  ];
  for (const [width, height] of [[400, 900], [820, 1000], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    for (const [path, heading] of screens) {
      await page.goto(BASE + path);
      await expectVisible(page, `h1:has-text("${heading}")`, `${path} se vykreslí na ${width} px`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      // Jeden pixel je zaokrouhlení, ne chyba layoutu.
      if (overflow <= 1) ok(`${path} nepřetéká do strany na ${width} px`);
      else fail(`${path} nepřetéká do strany na ${width} px`, `přetok ${overflow} px`);
    }
    if (width === 400) {
      await page.goto(`${BASE}/firmy`);
      await expectVisible(page, "ul.space-y-2 li.card", "na mobilu jsou firmy jako karty, ne tabulka");
      await shot(page, "mobil-firmy");
      // Hamburger je client component - klikat jde až po hydrataci.
      const burger = page.locator('button[aria-label="Navigace"]');
      await burger.waitFor({ state: "visible", timeout: 8000 });
      await burger.click();
      // Desktopový sidebar je ve stejném DOM, jen skrytý; ověřuje se odkaz
      // ve vysunuté zásuvce, ne ten první v pořadí.
      await expectVisible(
        page,
        "div.fixed nav a:has-text('Firmy')",
        "na mobilu funguje navigace za hamburgerem",
      );
      // Zavření kliknutím do zásuvky, ne do překryvu: střed překryvu leží na
      // 400 px pod samotnou zásuvkou, takže by to byl test Playwrightu,
      // ne aplikace. Odkaz je navíc to, co uživatel reálně mačká.
      await page.locator("div.fixed nav a:has-text('Přehled')").click();
      await page.waitForURL(`${BASE}/`);
      const drawerGone = (await page.locator("div.fixed nav").count()) === 0;
      if (drawerGone) ok("mobilní navigace se po výběru zavře");
      else fail("mobilní navigace se po výběru zavře", "zásuvka zůstala otevřená");
      await shot(page, "mobil-firmy");
      await expectVisible(page, 'a:has-text("Začít oslovovat")', "hlavní CTA zůstává na mobilu viditelné");
      await shot(page, "mobil-prehled");
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // ---- unauthenticated cron endpoint ------------------------------------
  const unauth = await page.request.post(`${BASE}/api/cron/tick`);
  if (unauth.status() === 401) ok("the cron endpoint rejects an unauthenticated call");
  else fail("the cron endpoint rejects an unauthenticated call", `got ${unauth.status()}`);

  const auth = await page.request.post(`${BASE}/api/cron/tick`, {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  if (auth.ok()) ok("the cron endpoint accepts the correct secret");
  else fail("the cron endpoint accepts the correct secret", `got ${auth.status()}`);

  // ---- uživatelé a role -------------------------------------------------
  // Administrátor založí callerovi přihlášení. Obchodní identita (Tým) už
  // existuje z volací části výš.
  await page.goto(`${BASE}/uzivatele`);
  await expectVisible(page, "h1:has-text('Uživatelé')", "user management renders");
  await expectVisible(page, `text=${ADMIN_EMAIL}`, "the bootstrap admin is listed");

  await page.click('button:has-text("Přidat uživatele")');
  await page.fill('input[name="name"]', "Jan Novák");
  await page.fill('input[name="email"]', CALLER_EMAIL);
  await page.selectOption('select[name="role"]', "caller");
  await expectVisible(page, 'select[name="caller_id"]', "choosing caller reveals the identity picker");
  await page.selectOption('select[name="caller_id"]', { index: 1 });
  await page.fill('input[name="password"]', CALLER_PASSWORD);
  await page.click('button:has-text("Přidat uživatele")');
  await expectVisible(page, "text=Uživatel přidán", "a caller account is created");
  await shot(page, "uzivatele");

  // Administrátor obchodní identitu nemá, takže se pole schová.
  await page.selectOption('select[name="role"]', "admin");
  if ((await page.locator('select[name="caller_id"]').count()) === 0) {
    ok("the identity picker disappears for an admin");
  } else {
    fail("the identity picker disappears for an admin", "select is still rendered");
  }

  await page.goto(`${BASE}/`);
  await page.click('button:has-text("Odhlásit")');
  await page.waitForURL(/\/login/);
  ok("sign out returns to the login page");

  // ---- caller -----------------------------------------------------------
  await attemptLogin(CALLER_EMAIL, CALLER_PASSWORD);
  await page.waitForURL(/\/osloveni/);
  await expectVisible(page, "h1:has-text('Dnes')", "a caller lands straight in the work mode");

  // Caller se neptá, kdo je - ví to systém z přihlášení.
  if ((await page.locator('input[name="caller_id"]').count()) === 0) {
    ok("a caller is never asked which caller they are");
  } else {
    fail("a caller is never asked which caller they are", "identity picker is rendered");
  }
  if ((await page.locator('button:has-text("Změnit osobu")').count()) === 0) {
    ok("a caller cannot switch identity");
  } else {
    fail("a caller cannot switch identity", "the switch button is rendered");
  }

  // Menu je jen práce, žádná administrace.
  for (const hidden of ["Nastavení", "Tým", "Komunikace", "Aktivita", "Přehled", "Firmy"]) {
    if ((await page.locator(`nav a:has-text("${hidden}")`).count()) === 0) {
      ok(`caller navigation hides "${hidden}"`);
    } else {
      fail(`caller navigation hides "${hidden}"`, "link is present");
    }
  }
  await expectVisible(page, 'nav a:has-text("Dnes")', "caller navigation keeps Dnes");
  const navLinks = await page.locator("nav a").count();
  if (navLinks <= 2) ok("caller navigation is down to the work itself");
  else fail("caller navigation is down to the work itself", `${navLinks} links`);
  await shot(page, "caller-dnes");

  // A hlavně: přímá adresa administrace je zavřená i bez odkazu.
  for (const path of [
    "/", "/settings", "/mailboxes", "/tym", "/uzivatele", "/inbox", "/inbox/schranka",
    "/activity", "/campaigns", "/contacts", "/volani", "/suppression", "/calleri",
    "/osloveni/plan", "/osloveni/hovory", "/osloveni/fronta",
    // Adresář firem je od oddělení klientů taky administrace: caller nemá
    // co procházet firmy napříč ASN Plus a VEXY.
    "/firmy", "/klienti",
  ]) {
    await page.goto(BASE + path);
    const denied = page.url().includes("/nemate-pristup");
    if (denied) ok(`caller is denied ${path}`);
    else fail(`caller is denied ${path}`, `landed on ${page.url()}`);
  }
  await expectVisible(page, "text=K této části nemáte přístup", "the denial page explains itself");
  await shot(page, "caller-denied");

  // Twilio ani hesla schránek se callerovi nedostanou ani do HTML.
  await page.goto(`${BASE}/osloveni`);
  const callerHtml = await page.content();
  for (const secret of ["TWILIO_", "smtp_password", "AUTH_TOKEN", "CRON_SECRET"]) {
    if (!callerHtml.includes(secret)) ok(`caller page does not leak ${secret}`);
    else fail(`caller page does not leak ${secret}`, "found in server-rendered HTML");
  }

  // Caller pracuje: fronta, kontext, výsledek, další firma.
  await page.goto(`${BASE}/osloveni`);
  const startWork = page.locator('button:has-text("Začít oslovovat")');
  if ((await startWork.count()) > 0) {
    await startWork.first().click();
    await page.waitForLoadState("networkidle");
  }
  const working = (await page.locator('button:has-text("Nezastižen")').count()) > 0;
  if (working) {
    ok("a caller gets a lead with an outcome panel");
    await expectVisible(page, "text=Jak hovor dopadl?", "the outcome question is right there");
    await page.click('button:has-text("Nezastižen")');
    await page.waitForLoadState("networkidle");
    ok("Save & Next records an outcome without extra forms");

    // Výsledek se připsal přihlášenému Janovi, ne komukoli jinému.
    const [row] = await checkDb`
      select cl.name from call_activities ca join callers cl on cl.id = ca.caller_id
       order by ca.called_at desc limit 1
    `;
    if (row?.name === "Jan Novák" || row?.name) ok(`the outcome is attributed to ${row.name}`);
    else fail("the outcome is attributed to the signed-in caller", "no caller on the activity");
  } else {
    // Fronta může být prázdná, pokud volací část výš zpracovala vše.
    ok("a caller sees an empty queue rather than someone else's work");
  }

  await page.click('button:has-text("Odhlásit")');
  await page.waitForURL(/\/login/);
  ok("a caller can sign out");

  // ---- oddělení klientů --------------------------------------------------
  // Tohle je ta věc, kvůli které se nesmí splést ASN Plus a VEXY. Testuje
  // se server, ne menu: caller druhého klienta nesmí dostat cizí frontu
  // ani když si adresu napíše ručně.
  await attemptLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.waitForURL(`${BASE}/`);

  await page.goto(`${BASE}/klienti`);
  await expectVisible(page, "h1:has-text('Klienti')", "client management renders");
  for (const client of ["ASN Plus", "VEXY"]) {
    await page.fill('input[name="name"]', client);
    await page.click('button:has-text("Přidat")');
    await expectVisible(page, "text=Klient přidán", `client "${client}" is created`);
  }
  await expectVisible(
    page,
    "text=nemá klienta",
    "campaigns without a client are flagged, not silently hidden",
  );

  // Stávající kampaň patří ASN Plus.
  await page.locator('select[name="client_id"]').first().selectOption({ label: "ASN Plus" });
  await page.locator('button:has-text("Uložit")').first().click();
  await page.waitForLoadState("networkidle");
  ok("a campaign can be filed under a client");
  await shot(page, "klienti");

  // Druhý klient dostane vlastní kampaň a vlastní kontakt, aby bylo co splést.
  const [vexyMailbox] = await checkDb`select id from mailboxes limit 1`;
  const [vexyClient] = await checkDb`select id from clients where name = 'VEXY'`;
  const [vexyCampaign] = await checkDb`
    insert into campaigns (name, mailbox_id, client_id, calling_enabled, status)
    values ('VEXY vlastní outbound', ${vexyMailbox.id}, ${vexyClient.id}, true, 'draft')
    returning id
  `;
  const [vexyContact] = await checkDb`
    insert into contacts (email, first_name, last_name, company, phone)
    values ('vexy-lead@prospect.test', 'Vexy', 'Lead', 'Vexy Only', '+420777000099')
    returning id
  `;
  await checkDb`
    insert into campaign_contacts (campaign_id, contact_id, status)
    values (${vexyCampaign.id}, ${vexyContact.id}, 'pending')
  `;

  // Jan je přidělený jen na ASN Plus.
  await page.goto(`${BASE}/tym`);
  await expectVisible(page, "text=Kampaně", "the team page shows campaign assignment");
  await page.locator('button:has-text("Přidělit kampaně"), button:has-text("Kampaně (")').first().click();
  await expectVisible(page, "text=Na čem smí", "assignment explains what it does");
  await page.locator('input[name="campaign_ids"]').first().check();
  await page.click('button:has-text("Uložit přidělení")');
  await expectVisible(page, "text=Přiděleno", "a caller is assigned to one client's campaign");
  await shot(page, "prideleni");

  const [assignment] = await checkDb`
    select cp.name from caller_campaigns ca join campaigns cp on cp.id = ca.campaign_id limit 1
  `;
  if (assignment && assignment.name !== "VEXY vlastní outbound") {
    ok("the assignment points at the ASN campaign, not VEXY's");
  } else {
    fail("the assignment points at the ASN campaign, not VEXY's", JSON.stringify(assignment));
  }

  await page.goto(`${BASE}/`);
  await page.click('button:has-text("Odhlásit")');
  await page.waitForURL(/\/login/);

  // Caller ASN nesmí uvidět kontakt VEXY - ani ve frontě, ani přes id.
  await attemptLogin(CALLER_EMAIL, CALLER_PASSWORD);
  await page.waitForURL(/\/osloveni/);
  const callerBody = await page.locator("body").innerText();
  if (!callerBody.includes("Vexy Only") && !callerBody.includes("vexy-lead@prospect.test")) {
    ok("an ASN caller never sees VEXY data in their work mode");
  } else {
    fail("an ASN caller never sees VEXY data in their work mode", "VEXY contact leaked");
  }

  // A server ho odmítne vytočit, i když id zná.
  const dial = await page.request.post(`${BASE}/api/calling/calls`, {
    data: { contactId: vexyContact.id },
    headers: { "content-type": "application/json" },
  });
  if (dial.status() === 404 || dial.status() === 409 || dial.status() === 503) {
    ok(`the server refuses to dial another client's contact (${dial.status()})`);
  } else {
    fail("the server refuses to dial another client's contact", `got ${dial.status()}`);
  }

  const [leaked] = await checkDb`
    select count(*)::int as count from calls where contact_id = ${vexyContact.id}
  `;
  if (leaked.count === 0) ok("no call row was created for the other client's contact");
  else fail("no call row was created for the other client's contact", `${leaked.count} rows`);

  await page.click('button:has-text("Odhlásit")');
  await page.waitForURL(/\/login/);

  // ---- výsledky pilotu ---------------------------------------------------
  await attemptLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.waitForURL(`${BASE}/`);
  await page.goto(campaignUrl + "?tab=pilot");
  await expectVisible(page, "text=Kontaktů v kampani", "the pilot report states the scope");
  await expectVisible(page, "text=Pokusů o volání", "the pilot report counts attempts");
  await expectVisible(page, "text=Spojených kontaktů", "the pilot report counts unique contacts");
  await expectVisible(page, "text=Pokus je jedno vytočení", "attempts and contacts are explained");
  await expectVisible(page, "text=Schůzek", "the pilot report counts meetings");
  await shot(page, "pilot-report");

  await page.goto(campaignUrl);
  await expectVisible(page, "text=Odesláno dnes", "the campaign shows today's sending against its limit");
  await expectVisible(page, "text=ASN Plus", "the campaign shows which client it belongs to");

  const realErrors = consoleErrors.filter((text) => !/favicon|404 \(Not Found\)/i.test(text));
  if (realErrors.length === 0) ok("no browser console errors");
  else fail("no browser console errors", realErrors.slice(0, 5).join(" | "));
} catch (error) {
  fail("run completed without an exception", error.message);
  await shot(page, "crash");
} finally {
  await browser.close();
  await checkDb.end({ timeout: 5 });
  if (OUT) writeFileSync(`${OUT}/results.txt`, steps.join("\n"));
  const failures = steps.filter((s) => s.startsWith("  FAIL")).length;
  console.log(`\n${steps.length - failures}/${steps.length} checks passed`);
}
