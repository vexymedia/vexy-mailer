import { configureTestEnv } from "./db";

configureTestEnv();

export interface SeedOptions {
  steps?: { delay_days: number; subject: string; body: string }[];
  contacts?: { email: string; first_name?: string; company?: string }[];
  dailyLimit?: number;
  /** Weekdays only, instead of the always-open default. */
  weekdaysOnly?: boolean;
}

export interface Seed {
  mailboxId: string;
  campaignId: string;
  stepIds: string[];
  contactIds: string[];
  campaignContactIds: string[];
}

export async function seedCampaign(options: SeedOptions = {}): Promise<Seed> {
  const { sql } = await import("@/lib/db");
  const { encryptSecret } = await import("@/lib/crypto");

  const steps = options.steps ?? [
    { delay_days: 0, subject: "Hi {{first_name}}", body: "About {{company}}." },
    { delay_days: 3, subject: "Re: {{company}}", body: "Following up." },
    { delay_days: 4, subject: "Last one", body: "Closing the loop." },
  ];
  const contacts = options.contacts ?? [{ email: "a@example.com", first_name: "Ann", company: "Acme" }];
  // Default window is every day, all day, so tests are never window-blocked.
  const days = options.weekdaysOnly ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6, 7];

  const [mailbox] = await sql<{ id: string }[]>`
    insert into mailboxes (name, from_name, from_email, smtp_host, smtp_port, smtp_username,
                           smtp_password_enc, smtp_secure, last_test_ok)
    values ('Test', 'Tester', 'sender@example.com', 'smtp.example.com', 465, 'sender@example.com',
            ${encryptSecret("secret")}, true, true)
    returning id
  `;

  const [campaign] = await sql<{ id: string }[]>`
    insert into campaigns (name, mailbox_id, daily_limit, send_days,
                           send_start_minute, send_end_minute, timezone)
    values ('Test campaign', ${mailbox.id}, ${options.dailyLimit ?? 100},
            ${days as unknown as number[]}, 0, 1440, 'Europe/Prague')
    returning id
  `;

  const stepIds: string[] = [];
  for (const [index, step] of steps.entries()) {
    const [row] = await sql<{ id: string }[]>`
      insert into sequence_steps (campaign_id, step_number, delay_days, subject, body)
      values (${campaign.id}, ${index + 1}, ${step.delay_days}, ${step.subject}, ${step.body})
      returning id
    `;
    stepIds.push(row.id);
  }

  const contactIds: string[] = [];
  const campaignContactIds: string[] = [];
  for (const contact of contacts) {
    const [row] = await sql<{ id: string }[]>`
      insert into contacts (email, first_name, company)
      values (${contact.email}, ${contact.first_name ?? null}, ${contact.company ?? null})
      returning id
    `;
    contactIds.push(row.id);
    const [cc] = await sql<{ id: string }[]>`
      insert into campaign_contacts (campaign_id, contact_id) values (${campaign.id}, ${row.id})
      returning id
    `;
    campaignContactIds.push(cc.id);
  }

  return { mailboxId: mailbox.id, campaignId: campaign.id, stepIds, contactIds, campaignContactIds };
}

/** Puts the app in simulate mode: the engine runs end to end but sends nothing. */
export async function enableSimulateMode(): Promise<void> {
  const { sql } = await import("@/lib/db");
  await sql`update app_settings set test_mode = true, test_behavior = 'simulate', test_email = null where id = true`;
}

/** Clears the pacing cursor so the next tick is free to send immediately. */
export async function clearPacing(campaignId: string): Promise<void> {
  const { sql } = await import("@/lib/db");
  await sql`update campaigns set next_slot_at = null where id = ${campaignId}`;
  await sql`update campaign_contacts set next_send_at = now() - interval '1 minute'
             where campaign_id = ${campaignId} and status in ('scheduled','sent')`;
}
