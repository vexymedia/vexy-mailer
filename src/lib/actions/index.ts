"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { z } from "zod";
import { sql } from "@/lib/db";
import { requireAuth, checkPassword, createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { updateSettings } from "@/lib/settings";
import { parseContactsCsv } from "@/lib/csv";
import { hhmmToMinutes, assertValidTimezone } from "@/lib/schedule";
import { findUnknownVariables } from "@/lib/template";
import { importContacts, suppressEmail, unsuppressEmail } from "@/lib/queries/contacts";
import { createMailbox, deleteMailbox, testMailbox, updateMailbox } from "@/lib/queries/mailboxes";
import {
  pauseCampaign,
  skipStepAndResume,
  startCampaign,
  checkCampaignReadiness,
  setCampaignMailboxes,
} from "@/lib/queries/campaigns";
import {
  deleteConversation,
  markConversationRead,
  sendManualReply,
  setClassification,
} from "@/lib/queries/inbox";
import type { Classification } from "@/lib/types";

export interface ActionState {
  error?: string;
  success?: string;
  problems?: string[];
}

function fail(error: string, problems?: string[]): ActionState {
  return { error, problems };
}

// ---------------------------------------------------------------- auth

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const password = String(formData.get("password") ?? "");
  if (!password || !checkPassword(password)) {
    return fail("Incorrect password.");
  }
  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(), sessionCookieOptions);
  const next = String(formData.get("next") ?? "/");
  redirect(next.startsWith("/") ? next : "/");
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/login");
}

// ------------------------------------------------------------ settings

const settingsSchema = z.object({
  test_mode: z.boolean(),
  test_email: z.string().email().nullable(),
  test_behavior: z.enum(["redirect", "simulate"]),
});

export async function saveSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const testMode = formData.get("test_mode") === "on";
  const behavior = String(formData.get("test_behavior") ?? "redirect");
  const rawEmail = String(formData.get("test_email") ?? "").trim();

  const parsed = settingsSchema.safeParse({
    test_mode: testMode,
    test_email: rawEmail || null,
    test_behavior: behavior,
  });
  if (!parsed.success) return fail("Enter a valid test email address, or leave it blank.");

  // Refuse a configuration that would silently send nowhere.
  if (parsed.data.test_mode && parsed.data.test_behavior === "redirect" && !parsed.data.test_email) {
    return fail("Redirect mode needs a test email address to send to.");
  }

  await updateSettings(parsed.data);
  await logActivity({
    level: parsed.data.test_mode ? "info" : "warn",
    action: parsed.data.test_mode ? "Test mode enabled" : "TEST MODE DISABLED - live sending is on",
    detail: parsed.data.test_mode ? `Behaviour: ${parsed.data.test_behavior}` : null,
  });
  revalidatePath("/", "layout");
  return { success: parsed.data.test_mode ? "Test mode is on. Nothing will reach a real prospect." : "Test mode is OFF. Emails will go to real contacts." };
}

// ----------------------------------------------------------- mailboxes

const mailboxSchema = z.object({
  name: z.string().min(1, "Give the mailbox a name."),
  from_name: z.string().min(1, "From name is required."),
  from_email: z.string().email("From email is not a valid address."),
  smtp_host: z.string().min(1, "SMTP host is required."),
  smtp_port: z.coerce.number().int().min(1).max(65535),
  smtp_username: z.string().min(1, "SMTP username is required."),
  smtp_password: z.string().optional(),
  smtp_secure: z.boolean(),
  imap_host: z.string().nullable(),
  imap_port: z.coerce.number().int().min(1).max(65535).nullable(),
  imap_username: z.string().nullable(),
  imap_password: z.string().nullable(),
  imap_secure: z.boolean(),
  daily_limit: z.coerce.number().int().min(1).max(2000),
  timezone: z.string().min(1),
  enabled: z.boolean(),
});

function mailboxFromForm(formData: FormData) {
  const text = (key: string) => {
    const value = String(formData.get(key) ?? "").trim();
    return value === "" ? null : value;
  };
  return mailboxSchema.safeParse({
    name: String(formData.get("name") ?? "").trim(),
    from_name: String(formData.get("from_name") ?? "").trim(),
    from_email: String(formData.get("from_email") ?? "").trim().toLowerCase(),
    smtp_host: String(formData.get("smtp_host") ?? "").trim(),
    smtp_port: formData.get("smtp_port"),
    smtp_username: String(formData.get("smtp_username") ?? "").trim(),
    smtp_password: text("smtp_password") ?? undefined,
    smtp_secure: formData.get("smtp_secure") === "on",
    imap_host: text("imap_host"),
    imap_port: text("imap_port"),
    imap_username: text("imap_username"),
    imap_password: text("imap_password"),
    imap_secure: formData.get("imap_secure") === "on",
    daily_limit: formData.get("daily_limit"),
    timezone: String(formData.get("mailbox_timezone") ?? "Europe/Prague"),
    enabled: formData.get("enabled") === "on",
  });
}

export async function saveMailboxAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  const parsed = mailboxFromForm(formData);
  if (!parsed.success) {
    return fail(parsed.error.issues.map((issue) => issue.message).join(" "));
  }
  try {
    assertValidTimezone(parsed.data.timezone);
  } catch {
    return fail(`"${parsed.data.timezone}" is not a valid IANA timezone (for example Europe/Prague).`);
  }
  try {
    if (id) await updateMailbox(id, parsed.data);
    else {
      if (!parsed.data.smtp_password) return fail("An SMTP password is required.");
      await createMailbox(parsed.data);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not save the mailbox.");
  }
  revalidatePath("/mailboxes");
  redirect("/mailboxes");
}

export async function testMailboxAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  if (!id) return fail("Save the mailbox before testing it.");
  try {
    const result = await testMailbox(id);
    revalidatePath("/mailboxes");
    if (!result.smtp.ok) return fail(`SMTP failed: ${result.smtp.error}`);
    if (result.imap.skipped) {
      return { success: "SMTP connected. No IMAP configured, so replies will not be detected automatically." };
    }
    if (!result.imap.ok) {
      return { error: `SMTP connected, but IMAP failed: ${result.imap.error}` };
    }
    return { success: "SMTP and IMAP both connected." };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Connection test failed.");
  }
}

export async function deleteMailboxAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const result = await deleteMailbox(String(formData.get("id") ?? ""));
  revalidatePath("/mailboxes");
  return result.ok ? { success: "Mailbox deleted." } : fail(result.error ?? "Could not delete.");
}

// ----------------------------------------------------------- campaigns

const campaignSchema = z.object({
  name: z.string().min(1, "Give the campaign a name."),
  mailbox_ids: z.array(z.string().uuid()).min(1, "Choose at least one sender mailbox."),
  daily_limit: z.coerce.number().int().min(1).max(2000),
  timezone: z.string().min(1),
  send_days: z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one sending day."),
  send_start_minute: z.number().int().min(0).max(1439),
  send_end_minute: z.number().int().min(1).max(1440),
});

export async function saveCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");

  let startMinute: number;
  let endMinute: number;
  try {
    startMinute = hhmmToMinutes(String(formData.get("send_start") ?? "08:00"));
    endMinute = hhmmToMinutes(String(formData.get("send_end") ?? "16:00"));
  } catch {
    return fail("Sending window times must look like 08:00.");
  }
  if (endMinute <= startMinute) return fail("The sending window must end after it starts.");

  const timezone = String(formData.get("timezone") ?? "Europe/Prague");
  try {
    assertValidTimezone(timezone);
  } catch {
    return fail(`"${timezone}" is not a valid IANA timezone (for example Europe/Prague).`);
  }

  const parsed = campaignSchema.safeParse({
    name: String(formData.get("name") ?? "").trim(),
    mailbox_ids: formData.getAll("mailbox_ids").map(String).filter(Boolean),
    daily_limit: formData.get("daily_limit"),
    timezone,
    send_days: formData.getAll("send_days").map(Number),
    send_start_minute: startMinute,
    send_end_minute: endMinute,
  });
  if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join(" "));

  const data = parsed.data;
  let campaignId = id;

  if (id) {
    await sql`
      update campaigns
         set name = ${data.name}, daily_limit = ${data.daily_limit},
             send_days = ${data.send_days}, send_start_minute = ${data.send_start_minute},
             send_end_minute = ${data.send_end_minute}, timezone = ${data.timezone}, updated_at = now()
       where id = ${id}
    `;
  } else {
    // Always draft. A new campaign never starts on its own.
    const [row] = await sql<{ id: string }[]>`
      insert into campaigns (name, daily_limit, send_days,
                             send_start_minute, send_end_minute, timezone, status)
      values (${data.name}, ${data.daily_limit}, ${data.send_days},
              ${data.send_start_minute}, ${data.send_end_minute}, ${data.timezone}, 'draft')
      returning id
    `;
    campaignId = row.id;
    await logActivity({ action: "Campaign created", detail: data.name, campaignId });
  }

  const { kept } = await setCampaignMailboxes(campaignId, data.mailbox_ids);
  if (kept.length > 0) {
    revalidatePath(`/campaigns/${campaignId}`);
    return {
      success: "Campaign saved.",
      problems: [
        `Kept ${kept.join(", ")} in the pool: contacts are already pinned to ${kept.length > 1 ? "them" : "it"} and a thread is never moved to another sender.`,
      ],
    };
  }

  revalidatePath("/campaigns");
  redirect(`/campaigns/${campaignId}`);
}

export async function startCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  const result = await startCampaign(id);
  revalidatePath(`/campaigns/${id}`);
  revalidatePath("/");
  if (!result.ok) return fail("The campaign is not ready to start.", result.problems);
  return { success: "Campaign is active. The worker will start sending inside the next window." };
}

export async function pauseCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  await pauseCampaign(id);
  revalidatePath(`/campaigns/${id}`);
  revalidatePath("/");
  return { success: "Campaign paused. No further emails will be sent." };
}

export async function deleteCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  const [campaign] = await sql<{ status: string }[]>`select status from campaigns where id = ${id}`;
  if (campaign?.status === "active") return fail("Pause the campaign before deleting it.");
  await sql`delete from campaigns where id = ${id}`;
  revalidatePath("/campaigns");
  redirect("/campaigns");
}

export async function checkReadinessAction(campaignId: string): Promise<string[]> {
  await requireAuth();
  return (await checkCampaignReadiness(campaignId)).problems;
}

// ------------------------------------------------------- sequence steps

export async function saveStepsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const campaignId = String(formData.get("campaign_id") ?? "");
  const count = Number(formData.get("step_count") ?? 0);

  const steps: { subject: string; body: string; delay_days: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (formData.get(`step_${i}_deleted`) === "1") continue;
    const subject = String(formData.get(`step_${i}_subject`) ?? "").trim();
    const body = String(formData.get(`step_${i}_body`) ?? "").trim();
    const delay = Number(formData.get(`step_${i}_delay`) ?? 0);
    if (!subject && !body) continue;
    if (!subject) return fail(`Step ${steps.length + 1} has no subject.`);
    if (!body) return fail(`Step ${steps.length + 1} has no body.`);
    if (!Number.isInteger(delay) || delay < 0 || delay > 365) {
      return fail(`Step ${steps.length + 1} has an invalid delay.`);
    }
    steps.push({ subject, body, delay_days: delay });
  }

  if (steps.length === 0) return fail("A campaign needs at least one step.");
  if (steps[0].delay_days !== 0) return fail("Step 1 must have a delay of 0 days - it is the first email.");

  const unknown = new Set<string>();
  for (const step of steps) {
    for (const name of [...findUnknownVariables(step.subject), ...findUnknownVariables(step.body)]) {
      unknown.add(name);
    }
  }
  if (unknown.size > 0) {
    return fail(
      `Unknown variable(s): ${[...unknown].map((v) => `{{${v}}}`).join(", ")}. ` +
        "Supported: {{first_name}}, {{last_name}}, {{company}}, {{website}}, {{unsubscribe_link}}.",
    );
  }

  // Steps already sent must keep their identity: email_sends references
  // step_id, and that reference is what prevents a resend. Rewriting the rows
  // wholesale would orphan the ledger, so update in place and only ever append.
  await sql.begin(async (tx) => {
    const existing = await tx<{ id: string; step_number: number }[]>`
      select id, step_number from sequence_steps where campaign_id = ${campaignId} order by step_number
    `;
    for (const [index, step] of steps.entries()) {
      const stepNumber = index + 1;
      const match = existing.find((e) => e.step_number === stepNumber);
      if (match) {
        await tx`
          update sequence_steps
             set subject = ${step.subject}, body = ${step.body},
                 delay_days = ${step.delay_days}, updated_at = now()
           where id = ${match.id}
        `;
      } else {
        await tx`
          insert into sequence_steps (campaign_id, step_number, delay_days, subject, body)
          values (${campaignId}, ${stepNumber}, ${step.delay_days}, ${step.subject}, ${step.body})
        `;
      }
    }
    // Trailing steps the user removed. ON DELETE CASCADE clears their sends,
    // so only allow this while nothing has actually been sent for them.
    for (const row of existing.filter((e) => e.step_number > steps.length)) {
      const [{ count: sends }] = await tx<{ count: number }[]>`
        select count(*)::int as count from email_sends where step_id = ${row.id}
      `;
      if (sends === 0) await tx`delete from sequence_steps where id = ${row.id}`;
    }
  });

  await logActivity({ action: "Sequence updated", detail: `${steps.length} step(s)`, campaignId });
  revalidatePath(`/campaigns/${campaignId}`);
  return { success: `Sequence saved: ${steps.length} step(s).` };
}

// ------------------------------------------------------------ contacts

export async function importContactsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const file = formData.get("file");
  const campaignId = String(formData.get("campaign_id") ?? "") || null;

  if (!(file instanceof File) || file.size === 0) return fail("Choose a CSV file to upload.");
  if (file.size > 10 * 1024 * 1024) return fail("The file is larger than 10 MB.");

  const parsed = parseContactsCsv(await file.text());
  if (parsed.rows.length === 0) {
    return fail(parsed.errors[0] ?? "No usable rows found in the file.", parsed.errors.slice(0, 20));
  }

  const result = await importContacts(parsed.rows, campaignId);
  revalidatePath("/contacts");
  if (campaignId) revalidatePath(`/campaigns/${campaignId}`);

  const notes: string[] = [];
  if (parsed.errors.length) notes.push(...parsed.errors.slice(0, 20));
  if (parsed.ignoredColumns.length) notes.push(`Ignored column(s): ${parsed.ignoredColumns.join(", ")}.`);
  if (result.suppressed.length) {
    notes.push(`${result.suppressed.length} address(es) are on the do-not-contact list and were not added to the campaign.`);
  }

  return {
    success:
      `Imported ${result.created} new contact(s); ${result.existing} were already known.` +
      (campaignId ? ` ${result.addedToCampaign} added to the campaign, ${result.skippedFromCampaign} skipped.` : ""),
    problems: notes.length ? notes : undefined,
  };
}

export async function suppressEmailAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) return fail("Enter a valid email address.");
  await suppressEmail(email, String(formData.get("reason") ?? "manual"), String(formData.get("note") ?? "") || undefined);
  revalidatePath("/suppression");
  revalidatePath("/contacts");
  return { success: `${email} will never be contacted again.` };
}

export async function unsuppressEmailAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  await unsuppressEmail(String(formData.get("email") ?? ""));
  revalidatePath("/suppression");
  return { success: "Removed from the do-not-contact list." };
}

export async function removeFromCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("campaign_contact_id") ?? "");
  const [row] = await sql<{ campaign_id: string }[]>`
    select campaign_id from campaign_contacts where id = ${id}
  `;
  await sql`delete from campaign_contacts where id = ${id}`;
  if (row) revalidatePath(`/campaigns/${row.campaign_id}`);
  return { success: "Contact removed from the campaign." };
}

export async function skipStepAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("campaign_contact_id") ?? "");
  await skipStepAndResume(id);
  revalidatePath("/campaigns");
  return { success: "Contact resumed at the next step." };
}

// ---------------------------------------------------------------- worker

/** Runs one worker tick by hand, for testing the setup from the UI. */
export async function runWorkerNowAction(_prev: ActionState): Promise<ActionState> {
  await requireAuth();
  const { dispatchTick } = await import("@/lib/engine/dispatch");
  const { pollReplies } = await import("@/lib/engine/replies");
  const dispatch = await dispatchTick();
  const replies = await pollReplies(true);
  revalidatePath("/", "layout");

  const actions = dispatch.outcomes.map((o) => `${o.campaignName}: ${o.action}${o.detail ? ` (${o.detail})` : ""}`);
  const matched = replies.mailboxes.reduce((sum, m) => sum + m.matched, 0);
  return {
    success: `Worker ran. ${actions.length ? actions.join("; ") : "No active campaigns."}${matched ? ` ${matched} reply/replies detected.` : ""}`,
  };
}

// --------------------------------------------------------------- inbox

export async function sendReplyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return fail("Write something before sending.");

  const result = await sendManualReply(conversationId, body);
  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");
  if (!result.ok) return fail(result.error ?? "The reply could not be sent.");
  return { success: "Reply sent." };
}

export async function classifyConversationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const classification = String(formData.get("classification") ?? "unclassified") as Classification;
  await setClassification(conversationId, classification);
  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");
  return { success: "Status updated." };
}

export async function markReadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const conversationId = String(formData.get("conversation_id") ?? "");
  await markConversationRead(conversationId);
  revalidatePath("/inbox");
  return {};
}

export async function deleteConversationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  await deleteConversation(String(formData.get("conversation_id") ?? ""));
  revalidatePath("/inbox");
  redirect("/inbox");
}
