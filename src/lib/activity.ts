import { sql } from "./db";
import type { LogLevel } from "./types";

export interface ActivityInput {
  action: string;
  detail?: string | null;
  level?: LogLevel;
  campaignId?: string | null;
  contactId?: string | null;
  campaignContactId?: string | null;
}

/**
 * Appends to the activity log. Never throws: a logging failure must not be
 * able to abort a send that already happened.
 */
export async function logActivity(input: ActivityInput): Promise<void> {
  try {
    await sql`
      insert into activity_logs (level, action, detail, campaign_id, contact_id, campaign_contact_id)
      values (
        ${input.level ?? "info"},
        ${input.action},
        ${input.detail ?? null},
        ${input.campaignId ?? null},
        ${input.contactId ?? null},
        ${input.campaignContactId ?? null}
      )
    `;
  } catch (error) {
    console.error("[activity] failed to write log entry", input.action, error);
  }
}
