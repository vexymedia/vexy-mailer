/**
 * Akceptační scénář: 600 kontaktů, 10 schránek, limit 100, 70 % nových.
 * Seeduje jen data; den odbaví běžící worker přes /api/cron/tick.
 */
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { createCipheriv, randomBytes } from "node:crypto";

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

function encrypt(plain) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${enc.toString("base64")}.${cipher.getAuthTag().toString("base64")}`;
}

const [client] = await sql`insert into clients (name) values ('VEXY') returning id`;

const mailboxIds = [];
for (let i = 1; i <= 10; i++) {
  const [m] = await sql`
    insert into mailboxes (name, from_name, from_email, smtp_host, smtp_port, smtp_username,
                           smtp_password_enc, smtp_secure, last_test_ok, daily_limit, timezone)
    values (${`Schránka ${i}`}, ${`Obchodník ${i}`}, ${`obchod${i}@vexy.test`},
            'smtp.vexy.test', 465, ${`obchod${i}@vexy.test`}, ${encrypt("secret")},
            true, true, 100, 'Europe/Prague')
    returning id`;
  mailboxIds.push(m.id);
}

const [campaign] = await sql`
  insert into campaigns (name, client_id, daily_limit, new_ratio, send_days,
                         send_start_minute, send_end_minute, timezone, status, calling_enabled)
  values ('VEXY outbound Q3', ${client.id}, 100, 70,
          ${[1,2,3,4,5,6,7]}, 0, 1440, 'Europe/Prague', 'active', true)
  returning id`;
for (const id of mailboxIds) {
  await sql`insert into campaign_mailboxes (campaign_id, mailbox_id) values (${campaign.id}, ${id})`;
}

const steps = [];
for (const [i, s] of [
  { d: 0, subject: "Krátký dotaz, {{first_name}}", body: "Dobrý den,\n\npomáháme firmám jako {{company}}…" },
  { d: 3, subject: "Re: Krátký dotaz, {{first_name}}", body: "Ještě jednou dobrý den,\n\nposílám krátké připomenutí." },
  { d: 5, subject: "Re: Krátký dotaz, {{first_name}}", body: "Poslední ozvání — dám vědět, ať to nezdržuje." },
].entries()) {
  const [row] = await sql`
    insert into sequence_steps (campaign_id, step_number, delay_days, subject, body)
    values (${campaign.id}, ${i + 1}, ${s.d}, ${s.subject}, ${s.body}) returning id`;
  steps.push(row.id);
}

// 600 kontaktů, 120 firem po pěti.
for (let c = 0; c < 120; c++) {
  const [company] = await sql`
    insert into companies (name, priority, status, reason)
    values (${`Firma ${c + 1} s.r.o.`},
            ${c % 5 === 0 ? "high" : c % 3 === 0 ? "low" : "normal"},
            'ready', ${`Vyrábí komponenty, hledá nové obchodní kanály.`})
    returning id`;
  for (let k = 0; k < 5; k++) {
    const n = c * 5 + k;
    const [contact] = await sql`
      insert into contacts (email, first_name, last_name, company, company_id, phone)
      values (${`kontakt${n}@firma${c + 1}.test`}, ${`Jan${n}`}, ${`Novák${n}`},
              ${`Firma ${c + 1} s.r.o.`}, ${company.id},
              ${`+4207770${String(n).padStart(5, "0")}`})
      returning id`;
    await sql`
      insert into campaign_contacts (campaign_id, contact_id, status, current_step, next_send_at)
      values (${campaign.id}, ${contact.id}, 'scheduled', 1, now() - interval '1 minute')`;
  }
}

// 45 kontaktů uprostřed sekvence, splatných dnes a dřív - aby byl vidět
// follow-up pool i backlog po termínu.
const mid = await sql`
  select id, contact_id from campaign_contacts where campaign_id = ${campaign.id}
   order by created_at limit 45`;
for (const [i, cc] of mid.entries()) {
  const mailboxId = mailboxIds[i % mailboxIds.length];
  await sql`
    update campaign_contacts
       set status = 'sent', current_step = 2, last_sent_at = now() - interval '4 days',
           next_send_at = now() - ${`${i + 1} hours`}::interval,
           sender_mailbox_id = ${mailboxId}
     where id = ${cc.id}`;
  await sql`
    insert into email_sends (campaign_id, campaign_contact_id, step_id, step_number, status,
                             to_email, intended_email, subject, body, mailbox_id, pool,
                             claimed_at, sent_at, message_id)
    select ${campaign.id}, ${cc.id}, ${steps[0]}, 1, 'sent', c.email, c.email,
           'Krátký dotaz', 'text', ${mailboxId}, 'new',
           now() - interval '4 days', now() - interval '4 days', ${`<${randomUUID()}@vexy.test>`}
      from contacts c where c.id = ${cc.contact_id}`;
}

// Jeden caller pro telefonní půlku.
await sql`insert into callers (name, email) values ('Jan Volající', 'jan@vexy.test')`;

// Testovací režim: engine projde celý cyklus, ale nesáhne na SMTP.
await sql`update app_settings set test_mode = true, test_behavior = 'simulate', test_email = null where id = true`;

const [{ count }] = await sql`select count(*)::int as count from campaign_contacts`;
console.log(JSON.stringify({ campaignId: campaign.id, clientId: client.id, contacts: count }));
await sql.end();
