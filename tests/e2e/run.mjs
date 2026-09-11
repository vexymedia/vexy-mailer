/**
 * Browser end-to-end check.
 *
 * Drives the real UI in Chromium against a running server, covering the whole
 * operator journey: sign in, add a mailbox, test its connection, import a CSV,
 * build a sequence, start a campaign, run the worker, suppress an address.
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
  await expectVisible(page, "text=Incorrect password", "wrong password is rejected");
  await shot(page, "login");

  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`);
  await expectVisible(page, "h1:has-text('Dashboard')", "correct password signs in");
  await expectVisible(page, "text=TEST MODE", "test mode banner is shown by default");
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
  await page.click('button:has-text("Add mailbox")');
  await page.waitForURL(`${BASE}/mailboxes`);
  await expectVisible(page, "text=Local test", "mailbox is created");
  await expectVisible(page, "text=untested", "a new mailbox starts untested");
  await expectVisible(page, "text=0 / 40", "the mailbox shows its daily limit and usage");

  // password must not be echoed back to the browser
  const html = await page.content();
  if (html.includes("secret")) fail("password is not sent to the client", "plaintext found in HTML");
  else ok("password is not sent to the client");

  await page.click('a:has-text("sender@example.com")');
  await page.click('button:has-text("Test connection")');
  await expectVisible(page, "text=SMTP connected", "test connection succeeds against the local server");
  await shot(page, "mailbox-tested");

  // ---- contacts ---------------------------------------------------------
  await page.goto(`${BASE}/contacts`);
  const csv = [
    "first_name,last_name,company,email,website",
    "Ann,Novak,Acme,ann@prospect.test,acme.test",
    "Petr,Svoboda,Globex,petr@prospect.test,globex.test",
    "Dup,Licate,Acme,ANN@PROSPECT.TEST,acme.test",
    "Bad,Row,NoEmail,not-an-email,x.test",
  ].join("\n");
  await page.setInputFiles('input[name="file"]', {
    name: "contacts.csv", mimeType: "text/csv", buffer: Buffer.from(csv),
  });
  await page.click('button:has-text("Import")');
  await expectVisible(page, "text=Imported 2 new contact", "CSV import creates only the valid, unique rows");
  await expectVisible(page, "text=not a valid email address", "the malformed row is reported");
  await expectVisible(page, "text=more than once", "the in-file duplicate is reported");
  await shot(page, "contacts-imported");

  // ---- campaign ---------------------------------------------------------
  await page.goto(`${BASE}/campaigns/new`);
  await page.fill('input[name="name"]', "E2E campaign");
  await page.check('input[name="mailbox_ids"]');
  await page.fill('input[name="daily_limit"]', "50");
  await page.fill('input[name="send_start"]', "00:00");
  await page.fill('input[name="send_end"]', "23:59");
  // The weekday checkboxes are sr-only behind their labels, so click the label.
  for (const day of ["Sat", "Sun"]) await page.click(`label:has-text("${day}")`);
  for (const day of [6, 7]) {
    if (!(await page.isChecked(`input[name="send_days"][value="${day}"]`))) {
      fail("weekday toggle checks its hidden input", `day ${day} did not toggle`);
    }
  }
  ok("weekday toggles work by clicking the label");
  await page.click('button:has-text("Create campaign")');
  await page.waitForURL(/\/campaigns\/[0-9a-f-]+/);
  const campaignUrl = page.url();
  await expectVisible(page, "text=draft", "a new campaign is created as a draft");
  await expectVisible(page, "text=The sequence has no steps", "readiness lists what is missing");
  await shot(page, "campaign-draft");

  // start must be refused while not ready
  page.once("dialog", (d) => d.accept());
  await page.click('button:has-text("Start campaign")');
  await expectVisible(page, "text=not ready to start", "an unready campaign refuses to start");

  // ---- sequence ---------------------------------------------------------
  await page.goto(`${campaignUrl}?tab=sequence`);
  await page.fill('input[name="step_0_subject"]', "Quick question about {{company}}");
  await page.fill('textarea[name="step_0_body"]', "Ahoj {{first_name|there}},\n\nnarazil jsem na {{company}}.");
  await page.click('button:has-text("Add follow-up")');
  await page.fill('input[name="step_1_subject"]', "Re: {{company}}");
  await page.fill('textarea[name="step_1_body"]', "Just following up.");
  await page.fill('input[name="step_1_delay"]', "3");
  await page.click('button:has-text("Save sequence")');
  await expectVisible(page, "text=Sequence saved: 2 step", "sequence saves two steps");
  await shot(page, "sequence");

  // typo in a variable name is caught
  await page.fill('input[name="step_1_subject"]', "Re: {{comapny}}");
  await page.click('button:has-text("Save sequence")');
  await expectVisible(page, "text=Unknown variable", "an unknown variable is rejected");
  await page.fill('input[name="step_1_subject"]', "Re: {{company}}");
  await page.click('button:has-text("Save sequence")');
  await expectVisible(page, "text=Sequence saved", "the corrected sequence saves");

  // ---- contacts into the campaign --------------------------------------
  await page.goto(`${campaignUrl}?tab=contacts`);
  await page.setInputFiles('input[name="file"]', {
    name: "contacts.csv", mimeType: "text/csv", buffer: Buffer.from(csv),
  });
  await page.click('button:has-text("Import")');
  await expectVisible(page, "text=2 added to the campaign", "contacts are added to the campaign");
  await shot(page, "campaign-contacts");

  // ---- start ------------------------------------------------------------
  await page.goto(campaignUrl);
  await expectVisible(page, "text=Ready to start", "the campaign becomes ready");
  page.once("dialog", (d) => d.accept());
  await page.click('button:has-text("Start campaign")');
  // The Start form is replaced by Pause, so assert on the resulting state.
  await expectVisible(page, 'button:has-text("Pause")', "the campaign starts");
  await expectVisible(page, "span:has-text('active')", "the campaign shows as active");
  await shot(page, "campaign-active");

  // ---- worker -----------------------------------------------------------
  await page.goto(`${BASE}/`);
  await page.click('button:has-text("Run worker now")');
  await expectVisible(page, "text=simulated", "the worker runs and simulates a send in test mode");
  await shot(page, "dashboard-active");

  await page.goto(`${campaignUrl}?tab=activity`);
  await expectVisible(page, "text=Email step 1 simulated", "the activity log records the simulated send");
  await shot(page, "activity");

  // ---- suppression ------------------------------------------------------
  await page.goto(`${BASE}/suppression`);
  await page.fill('input[name="email"]', "petr@prospect.test");
  await page.click('button:has-text("Add")');
  await expectVisible(page, "text=will never be contacted again", "an address can be suppressed");
  await shot(page, "suppression");

  await page.goto(`${campaignUrl}?tab=contacts`);
  await expectVisible(page, "text=unsubscribed", "the suppressed contact leaves the campaign");

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
  await expectVisible(page, "text=Test mode enabled", "settings shows test mode on");
  await page.check('input[name="test_mode"]');
  await page.click('input[value="redirect"]');
  await page.fill('input[name="test_email"]', "");
  await page.click('button:has-text("Save settings")');
  // Blocked client-side by `required`, so the form never submits.
  const invalid = await page.locator('input[name="test_email"]').evaluate((el) => !el.checkValidity());
  if (invalid) ok("redirect mode without an address is refused");
  else fail("redirect mode without an address is refused", "the form submitted anyway");
  await shot(page, "settings");

  // ---- inbox ------------------------------------------------------------
  await page.goto(`${BASE}/inbox`);
  await expectVisible(page, "h1:has-text('Inbox')", "the Inbox page renders");
  await expectVisible(page, "text=No replies yet", "an empty inbox says so");
  for (const label of ["All", "Unread", "Positive", "Needs action"]) {
    await expectVisible(page, `a:has-text("${label}")`, `inbox filter "${label}" is present`);
  }
  await expectVisible(page, 'select[name="campaign"]', "inbox can filter by campaign");
  await expectVisible(page, 'select[name="mailbox"]', "inbox can filter by mailbox");
  await expectVisible(page, 'input[name="q"]', "inbox has a search box");
  await shot(page, "inbox");

  await page.goto(`${BASE}/mailboxes`);
  await expectVisible(page, "text=Sent today", "mailboxes list shows today's usage");
  await shot(page, "mailboxes");

  // ---- other pages render ----------------------------------------------
  for (const [path, heading] of [["/activity", "Activity"], ["/campaigns", "Campaigns"], ["/contacts", "Contacts"], ["/inbox", "Inbox"]]) {
    await page.goto(BASE + path);
    await expectVisible(page, `h1:has-text("${heading}")`, `${path} renders`);
  }

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
  await page.click('button:has-text("Sign out")');
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
