#!/usr/bin/env node
/**
 * Akceptační scénář, doložený po schránkách.
 *
 *   600 kontaktů · 10 schránek · limit kampaně 100 · 70 % nových
 *
 * Pustí se proti SKUTEČNÉMU cron endpointu běžící aplikace v režimu
 * simulace a vypíše číslo pro každou schránku zvlášť. Vznikl proto, že
 * předchozí report tvrdil "14-15 zpráv na schránku" při stropu 100 a
 * deseti schránkách, což nemůže sedět - viz DNES versus CELKEM níž.
 *
 *   DATABASE_URL=… CRON_URL=… node scripts/acceptance.mjs
 */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const CRON_URL = process.env.CRON_URL;
const MAX_TICKS = Number(process.env.MAX_TICKS ?? 200);

const [campaign] = await sql`
  select id, name, daily_limit, new_ratio, timezone, status from campaigns order by created_at limit 1
`;
if (!campaign) throw new Error("Žádná kampaň.");

/** Hranice dnešního účetního dne v timezone kampaně. */
const dayStart = sql`date_trunc('day', now() at time zone ${campaign.timezone}) at time zone ${campaign.timezone}`;

let ticks = 0;
let lastAction = "nespuštěno";
for (let i = 0; i < MAX_TICKS; i++) {
  // Kurzor rozložení je pro akceptaci šum: testuje se strop, ne tempo.
  await sql`update campaigns set next_slot_at = null where id = ${campaign.id}`;
  const response = await fetch(CRON_URL);
  const body = await response.json();
  const outcome = (body.dispatch?.outcomes ?? []).find((o) => o.campaignId === campaign.id);
  ticks = i + 1;
  lastAction = outcome ? `${outcome.action}${outcome.detail ? ` (${outcome.detail})` : ""}` : "bez výsledku";
  if (!outcome || (outcome.action !== "sent" && outcome.action !== "simulated")) break;
}

const mailboxes = await sql`
  select m.id, m.from_email, m.enabled, m.last_test_ok, m.daily_limit, m.timezone,
         exists (select 1 from campaign_mailboxes cm
                  where cm.campaign_id = ${campaign.id} and cm.mailbox_id = m.id) as in_campaign,
         (select count(*)::int from email_sends es
           where es.mailbox_id = m.id
             and es.status in ('sending','sent','unknown','skipped')
             and coalesce(es.sent_at, es.claimed_at) >= ${dayStart}) as today,
         (select count(*)::int from email_sends es where es.mailbox_id = m.id) as total_ever
    from mailboxes m order by m.from_email
`;

const [pools] = await sql`
  select count(*)::int as total,
         count(*) filter (where pool = 'new')::int as new,
         count(*) filter (where pool = 'follow_up')::int as follow_up
    from email_sends
   where campaign_id = ${campaign.id}
     and status in ('sending','sent','unknown','skipped')
     and coalesce(sent_at, claimed_at) >= ${dayStart}
`;

const [backlog] = await sql`
  select count(*)::int as still_due,
         count(*) filter (where cc.current_step = 2)::int as on_step_2,
         count(*) filter (where cc.status = 'completed')::int as wrongly_completed
    from campaign_contacts cc
   where cc.campaign_id = ${campaign.id}
     and cc.last_sent_at is not null
     and cc.next_send_at is not null
     and cc.next_send_at <= now()
     and cc.status in ('scheduled','sent')
`;

const pad = (v, n) => String(v).padStart(n);
const why = (m) => {
  if (!m.in_campaign) return "není v kampani";
  if (!m.enabled) return "vypnutá";
  if (m.last_test_ok !== true) return "bez úspěšného testu spojení";
  if (m.today >= m.daily_limit) return "na vlastním limitu";
  return "použitelná";
};

console.log(`\nKampaň: ${campaign.name} · limit ${campaign.daily_limit} · nové ${campaign.new_ratio} % · ${campaign.timezone}\n`);
console.log("SCHRÁNKA                       LIMIT   DNES  CELKEM  DŮVOD");
console.log("-".repeat(78));
for (const m of mailboxes) {
  console.log(
    `${m.from_email.padEnd(30)} ${pad(m.daily_limit, 5)}  ${pad(m.today, 5)}  ${pad(m.total_ever, 6)}  ${why(m)}`,
  );
}
console.log("-".repeat(78));
const sumToday = mailboxes.reduce((s, m) => s + m.today, 0);
const sumEver = mailboxes.reduce((s, m) => s + m.total_ever, 0);
console.log(`${"SOUČET".padEnd(30)} ${" ".repeat(5)}  ${pad(sumToday, 5)}  ${pad(sumEver, 6)}\n`);

console.log(`schránek vytvořeno           ${mailboxes.length}`);
console.log(`schránek v kampani           ${mailboxes.filter((m) => m.in_campaign).length}`);
console.log(`schránek použitelných        ${mailboxes.filter((m) => why(m) === "použitelná" || (m.in_campaign && m.enabled && m.last_test_ok)).length}`);
console.log(`schránek, které poslaly      ${mailboxes.filter((m) => m.today > 0).length}`);
console.log(`\ndnes odesláno celkem         ${pools.total}   (součet po schránkách: ${sumToday})`);
console.log(`  z toho nových              ${pools.new}`);
console.log(`  z toho follow-upů          ${pools.follow_up}`);
console.log(`ticků do zastavení           ${ticks}`);
console.log(`výsledek posledního ticku    ${lastAction}`);
console.log(`\nfollow-upů stále splatných   ${backlog.still_due}`);
console.log(`  z toho na kroku 2          ${backlog.on_step_2}`);
console.log(`  omylem dokončených         ${backlog.wrongly_completed}`);

const ok = pools.total === sumToday && pools.total === (pools.new + pools.follow_up);
console.log(`\nsoučty sedí: ${ok ? "ANO" : "NE"}`);
await sql.end();
process.exit(ok ? 0 : 1);
