import { configureTestEnv } from "./db";

configureTestEnv();

export interface MailboxSpec {
  email: string;
  dailyLimit?: number;
  enabled?: boolean;
  tested?: boolean;
}

/** Creates a mailbox with an explicit global daily limit. */
export async function createMailbox(spec: MailboxSpec): Promise<string> {
  const { sql } = await import("@/lib/db");
  const { encryptSecret } = await import("@/lib/crypto");
  const [row] = await sql<{ id: string }[]>`
    insert into mailboxes (name, from_name, from_email, smtp_host, smtp_port, smtp_username,
                           smtp_password_enc, smtp_secure, last_test_ok, daily_limit, timezone, enabled)
    values (${spec.email}, 'Sender', ${spec.email}, 'smtp.example.com', 465, ${spec.email},
            ${encryptSecret("secret")}, true, ${spec.tested ?? true},
            ${spec.dailyLimit ?? 40}, 'Europe/Prague', ${spec.enabled ?? true})
    returning id
  `;
  return row.id;
}

export interface CampaignSpec {
  name: string;
  mailboxIds: string[];
  dailyLimit?: number;
  steps?: { delay_days: number; subject: string; body: string }[];
  contacts?: string[];
}

/** Creates an always-open campaign with an explicit sender pool. */
export async function createCampaign(spec: CampaignSpec): Promise<{
  campaignId: string;
  contactIds: string[];
  campaignContactIds: string[];
}> {
  const { sql } = await import("@/lib/db");
  const steps = spec.steps ?? [{ delay_days: 0, subject: "S", body: "B" }];

  const [campaign] = await sql<{ id: string }[]>`
    insert into campaigns (name, daily_limit, send_days, send_start_minute, send_end_minute, timezone)
    values (${spec.name}, ${spec.dailyLimit ?? 1000}, '{1,2,3,4,5,6,7}', 0, 1440, 'Europe/Prague')
    returning id
  `;
  for (const mailboxId of spec.mailboxIds) {
    await sql`insert into campaign_mailboxes (campaign_id, mailbox_id) values (${campaign.id}, ${mailboxId})`;
  }
  for (const [index, step] of steps.entries()) {
    await sql`
      insert into sequence_steps (campaign_id, step_number, delay_days, subject, body)
      values (${campaign.id}, ${index + 1}, ${step.delay_days}, ${step.subject}, ${step.body})
    `;
  }

  const contactIds: string[] = [];
  const campaignContactIds: string[] = [];
  for (const email of spec.contacts ?? []) {
    const [c] = await sql<{ id: string }[]>`
      insert into contacts (email, first_name) values (${email}, 'X')
      on conflict (email) do update set updated_at = now()
      returning id
    `;
    contactIds.push(c.id);
    const [cc] = await sql<{ id: string }[]>`
      insert into campaign_contacts (campaign_id, contact_id) values (${campaign.id}, ${c.id})
      returning id
    `;
    campaignContactIds.push(cc.id);
  }
  return { campaignId: campaign.id, contactIds, campaignContactIds };
}

/** Makes every contact in a campaign due right now and clears campaign pacing. */
export async function makeAllDue(campaignId: string): Promise<void> {
  const { sql } = await import("@/lib/db");
  await sql`update campaigns set next_slot_at = null where id = ${campaignId}`;
  await sql`
    update campaign_contacts set next_send_at = now() - interval '1 minute'
     where campaign_id = ${campaignId} and status in ('pending', 'scheduled', 'sent')
  `;
}

/** Runs the dispatcher until it stops producing sends, bounded. */
export async function drain(campaignIds: string[], maxTicks = 60): Promise<void> {
  const { dispatchTick } = await import("@/lib/engine/dispatch");
  for (let i = 0; i < maxTicks; i++) {
    for (const id of campaignIds) await makeAllDue(id);
    const summary = await dispatchTick();
    const progressed = summary.outcomes.some(
      (o) => o.action === "sent" || o.action === "simulated",
    );
    if (!progressed) return;
  }
}

/** How many quota-consuming sends a mailbox has made today. */
export async function sentToday(mailboxId: string): Promise<number> {
  const { sql } = await import("@/lib/db");
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from email_sends
     where mailbox_id = ${mailboxId} and status in ('sent', 'unknown', 'skipped')
  `;
  return row.count;
}
