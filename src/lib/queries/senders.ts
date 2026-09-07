import { sql } from "../db";
import { allMailboxCapacity } from "../engine/allocation";
import type { SenderOption } from "@/components/campaign-form";

/**
 * The sender-pool picker's options: every mailbox, its usage today, and
 * whether a contact is already pinned to it in this campaign (in which case it
 * cannot be removed from the pool without stranding that thread).
 */
export async function listSenderOptions(campaignId?: string | null): Promise<SenderOption[]> {
  const [capacity, mailboxes, pinned] = await Promise.all([
    allMailboxCapacity(sql),
    sql<{ id: string; name: string; from_email: string; enabled: boolean; daily_limit: number }[]>`
      select id, name, from_email, enabled, daily_limit from mailboxes order by from_email
    `,
    campaignId
      ? sql<{ sender_mailbox_id: string }[]>`
          select distinct sender_mailbox_id from campaign_contacts
           where campaign_id = ${campaignId} and sender_mailbox_id is not null
        `
      : Promise.resolve([] as { sender_mailbox_id: string }[]),
  ]);

  const usage = new Map(capacity.map((c) => [c.mailbox_id, c.used_today]));
  const pinnedIds = new Set(pinned.map((p) => p.sender_mailbox_id));

  return mailboxes.map((m) => ({
    id: m.id,
    name: m.name,
    from_email: m.from_email,
    enabled: m.enabled,
    daily_limit: m.daily_limit,
    used_today: usage.get(m.id) ?? 0,
    pinned: pinnedIds.has(m.id),
  }));
}
