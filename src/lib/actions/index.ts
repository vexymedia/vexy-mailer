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
import { createMailbox, deleteMailbox, testMailbox, testMailboxImap, updateMailbox } from "@/lib/queries/mailboxes";
import {
  pauseCampaign,
  skipStepAndResume,
  startCampaign,
  checkCampaignReadiness,
  setCampaignMailboxes,
  saveCampaignSchedule,
} from "@/lib/queries/campaigns";
import {
  deleteConversation,
  markConversationRead,
  sendManualReply,
  setClassification,
} from "@/lib/queries/inbox";
import {
  claimNextCall,
  createCaller,
  logCall,
  releaseCall,
  setCallerActive,
  updateMeeting,
} from "@/lib/queries/calling";
import { clearSelectedCaller, getSelectedCallerId, setSelectedCallerId } from "@/lib/caller-session";
import { updateCompany } from "@/lib/queries/companies";
import {
  COMPANY_PRIORITY_LABELS,
  COMPANY_STATUS_LABELS,
  type CompanyPriority,
  type CompanyStatus,
} from "@/lib/companies";
import { createWorkBlock, deleteWorkBlock } from "@/lib/queries/plan";
import { isActivityType } from "@/lib/plan";
import { callOutcomeLabel, isCallOutcome, isMeetingOutcome, type MeetingOutcome } from "@/lib/calling";
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
    return fail("Nesprávné heslo.");
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
  if (!parsed.success) return fail("Zadejte platnou testovací e-mailovou adresu, nebo pole nechte prázdné.");

  // Refuse a configuration that would silently send nowhere.
  if (parsed.data.test_mode && parsed.data.test_behavior === "redirect" && !parsed.data.test_email) {
    return fail("Přesměrování potřebuje testovací e-mailovou adresu, kam odesílat.");
  }

  await updateSettings(parsed.data);
  await logActivity({
    level: parsed.data.test_mode ? "info" : "warn",
    action: parsed.data.test_mode ? "Test mode enabled" : "TEST MODE DISABLED - live sending is on",
    detail: parsed.data.test_mode ? `Chování: ${parsed.data.test_behavior}` : null,
  });
  revalidatePath("/", "layout");
  return { success: parsed.data.test_mode ? "Testovací režim je zapnutý. K žádnému reálnému prospektovi se nic nedostane." : "Testovací režim je VYPNUTÝ. E-maily půjdou skutečným kontaktům." };
}

// ----------------------------------------------------------- mailboxes

const mailboxSchema = z.object({
  name: z.string().min(1, "Pojmenujte schránku."),
  from_name: z.string().min(1, "Jméno odesílatele je povinné."),
  from_email: z.string().email("E-mail odesílatele není platná adresa."),
  smtp_host: z.string().min(1, "SMTP server je povinný."),
  smtp_port: z.coerce.number().int().min(1).max(65535),
  smtp_username: z.string().min(1, "SMTP uživatel je povinný."),
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
    return fail(`"${parsed.data.timezone}" není platné IANA časové pásmo (například Europe/Prague).`);
  }
  try {
    if (id) await updateMailbox(id, parsed.data);
    else {
      if (!parsed.data.smtp_password) return fail("SMTP heslo je povinné.");
      await createMailbox(parsed.data);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Schránku se nepodařilo uložit.");
  }
  revalidatePath("/mailboxes");
  redirect("/mailboxes");
}

export async function testMailboxAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  if (!id) return fail("Nejdřív schránku uložte, pak ji otestujte.");
  try {
    const result = await testMailbox(id);
    revalidatePath("/mailboxes");
    if (!result.smtp.ok) return fail(`SMTP selhalo: ${result.smtp.error}`);
    if (result.imap.skipped) {
      return { success: "SMTP připojeno. IMAP není nastaveno, takže odpovědi se nebudou rozpoznávat automaticky." };
    }
    if (!result.imap.ok) {
      return { error: `SMTP připojeno, ale IMAP selhalo: ${result.imap.error}` };
    }
    return { success: "SMTP i IMAP jsou připojené." };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Test připojení selhal.");
  }
}

/**
 * Tests IMAP on its own, so reply detection can be diagnosed without touching
 * SMTP - which matters when sending already works and only the inbox does not.
 */
export async function testMailboxImapAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  if (!id) return fail("Nejdřív schránku uložte, pak ji otestujte.");
  try {
    const result = await testMailboxImap(id);
    revalidatePath("/mailboxes");
    revalidatePath(`/mailboxes/${id}`);
    if (result.ok) return { success: "IMAP připojeno a INBOX otevřen. Detekce odpovědí může běžet." };
    return fail(result.error ?? "Test IMAP selhal.");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Test IMAP selhal.");
  }
}

export async function deleteMailboxAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const result = await deleteMailbox(String(formData.get("id") ?? ""));
  revalidatePath("/mailboxes");
  return result.ok ? { success: "Schránka smazána." } : fail(result.error ?? "Smazat se nepodařilo.");
}

// ----------------------------------------------------------- campaigns

const campaignSchema = z.object({
  name: z.string().min(1, "Pojmenujte kampaň."),
  mailbox_ids: z.array(z.string().uuid()).min(1, "Vyberte alespoň jednu odesílací schránku."),
  daily_limit: z.coerce.number().int().min(1).max(2000),
  timezone: z.string().min(1),
  send_days: z.array(z.number().int().min(1).max(7)).min(1, "Vyberte alespoň jeden den odesílání."),
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
    return fail("Časy odesílacího okna musí být ve tvaru 08:00.");
  }
  if (endMinute <= startMinute) return fail("Odesílací okno musí končit později, než začíná.");

  const timezone = String(formData.get("timezone") ?? "Europe/Prague");
  try {
    assertValidTimezone(timezone);
  } catch {
    return fail(`"${timezone}" není platné IANA časové pásmo (například Europe/Prague).`);
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

  let cursorCleared = false;
  if (id) {
    await sql`update campaigns set name = ${data.name}, updated_at = now() where id = ${id}`;
    // Schedule changes go through saveCampaignSchedule, which also invalidates
    // the pacing cursor - a cursor computed from the old window would otherwise
    // keep the campaign parked under settings that no longer apply.
    ({ cursorCleared } = await saveCampaignSchedule(id, {
      daily_limit: data.daily_limit,
      send_days: data.send_days,
      send_start_minute: data.send_start_minute,
      send_end_minute: data.send_end_minute,
      timezone: data.timezone,
    }));
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
    await logActivity({ action: "Kampaň vytvořena", detail: data.name, campaignId });
  }

  const { kept } = await setCampaignMailboxes(campaignId, data.mailbox_ids);
  if (cursorCleared) {
    revalidatePath(`/campaigns/${campaignId}`);
    revalidatePath("/");
    return {
      success: "Kampaň uložena.",
      problems: [
        "Rozložení odesílání bylo vynulováno, protože se změnil rozvrh. Kampaň může odeslat další " +
          "e-mail, jakmile bude v novém okně.",
        ...(kept.length ? [`${kept.join(", ")} zůstává mezi odesílateli: jsou na ni připnuté kontakty.`] : []),
      ],
    };
  }
  if (kept.length > 0) {
    revalidatePath(`/campaigns/${campaignId}`);
    return {
      success: "Kampaň uložena.",
      problems: [
        `${kept.join(", ")} zůstává mezi odesílateli: kontakty jsou už připnuté a vlákno se nikdy nepřesouvá na jiného odesílatele.`,
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
  if (!result.ok) return fail("Kampaň není připravená ke spuštění.", result.problems);
  return { success: "Kampaň běží. Worker začne odesílat v nejbližším okně." };
}

export async function pauseCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  await pauseCampaign(id);
  revalidatePath(`/campaigns/${id}`);
  revalidatePath("/");
  return { success: "Kampaň pozastavena. Žádné další e-maily se neodešlou." };
}

export async function deleteCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  const [campaign] = await sql<{ status: string }[]>`select status from campaigns where id = ${id}`;
  if (campaign?.status === "active") return fail("Před smazáním kampaň pozastavte.");
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
    if (!subject) return fail(`Krok ${steps.length + 1} nemá předmět.`);
    if (!body) return fail(`Krok ${steps.length + 1} nemá text.`);
    if (!Number.isInteger(delay) || delay < 0 || delay > 365) {
      return fail(`Krok ${steps.length + 1} má neplatnou prodlevu.`);
    }
    steps.push({ subject, body, delay_days: delay });
  }

  if (steps.length === 0) return fail("Kampaň potřebuje alespoň jeden krok.");
  if (steps[0].delay_days !== 0) return fail("Krok 1 musí mít prodlevu 0 dnů — je to první e-mail.");

  const unknown = new Set<string>();
  for (const step of steps) {
    for (const name of [...findUnknownVariables(step.subject), ...findUnknownVariables(step.body)]) {
      unknown.add(name);
    }
  }
  if (unknown.size > 0) {
    return fail(
      `Neznámé proměnné: ${[...unknown].map((v) => `{{${v}}}`).join(", ")}. ` +
        "Podporované: {{first_name}}, {{last_name}}, {{company}}, {{website}}, {{unsubscribe_link}}.",
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

  await logActivity({ action: "Sekvence upravena", detail: `${steps.length} kroků`, campaignId });
  revalidatePath(`/campaigns/${campaignId}`);
  return { success: `Sekvence uložena: ${steps.length} kroků.` };
}

// ------------------------------------------------------------ contacts

export async function importContactsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const file = formData.get("file");
  const campaignId = String(formData.get("campaign_id") ?? "") || null;

  if (!(file instanceof File) || file.size === 0) return fail("Vyberte CSV soubor k nahrání.");
  if (file.size > 10 * 1024 * 1024) return fail("Soubor je větší než 10 MB.");

  const parsed = parseContactsCsv(await file.text());
  if (parsed.rows.length === 0) {
    return fail(parsed.errors[0] ?? "V souboru nejsou žádné použitelné řádky.", parsed.errors.slice(0, 20));
  }

  const result = await importContacts(parsed.rows, campaignId);
  revalidatePath("/contacts");
  if (campaignId) revalidatePath(`/campaigns/${campaignId}`);

  const notes: string[] = [];
  if (parsed.errors.length) notes.push(...parsed.errors.slice(0, 20));
  if (parsed.ignoredColumns.length) notes.push(`Ignorované sloupce: ${parsed.ignoredColumns.join(", ")}.`);
  if (result.suppressed.length) {
    notes.push(`${result.suppressed.length} adres je na seznamu Nekontaktovat a do kampaně se nepřidaly.`);
  }

  return {
    success:
      `Naimportováno ${result.created} nových kontaktů; ${result.existing} už bylo známých.` +
      (campaignId ? ` ${result.addedToCampaign} přidáno do kampaně, ${result.skippedFromCampaign} přeskočeno.` : ""),
    problems: notes.length ? notes : undefined,
  };
}

export async function suppressEmailAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) return fail("Zadejte platnou e-mailovou adresu.");
  await suppressEmail(email, String(formData.get("reason") ?? "manual"), String(formData.get("note") ?? "") || undefined);
  revalidatePath("/suppression");
  revalidatePath("/contacts");
  return { success: `${email} už nikdy nebude kontaktován.` };
}

export async function unsuppressEmailAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  await unsuppressEmail(String(formData.get("email") ?? ""));
  revalidatePath("/suppression");
  return { success: "Odebráno ze seznamu Nekontaktovat." };
}

export async function removeFromCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("campaign_contact_id") ?? "");
  const [row] = await sql<{ campaign_id: string }[]>`
    select campaign_id from campaign_contacts where id = ${id}
  `;
  await sql`delete from campaign_contacts where id = ${id}`;
  if (row) revalidatePath(`/campaigns/${row.campaign_id}`);
  return { success: "Kontakt odebrán z kampaně." };
}

export async function skipStepAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("campaign_contact_id") ?? "");
  await skipStepAndResume(id);
  revalidatePath("/campaigns");
  return { success: "Kontakt pokračuje dalším krokem." };
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
    success: `Worker proběhl. ${actions.length ? actions.join("; ") : "Žádné běžící kampaně."}${matched ? ` Rozpoznáno odpovědí: ${matched}.` : ""}`,
  };
}

// --------------------------------------------------------------- inbox

export async function sendReplyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return fail("Než odešlete, něco napište.");

  const result = await sendManualReply(conversationId, body);
  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");
  if (!result.ok) return fail(result.error ?? "Odpověď se nepodařilo odeslat.");
  return { success: "Odpověď odeslána." };
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
  return { success: "Stav uložen." };
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

// --------------------------------------------------------------- volání

/**
 * Records one call and sends the caller straight back to the queue, which then
 * renders the next prospect. Two clicks per call - dial, then outcome - is the
 * whole point of the workspace, so nothing here asks for confirmation.
 */
export async function logCallAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const campaignContactId = String(formData.get("campaign_contact_id") ?? "");
  const outcome = String(formData.get("outcome") ?? "");
  if (!isCallOutcome(outcome)) return fail("Vyberte výsledek hovoru.");

  const parseWhen = (key: string): Date | null | "invalid" => {
    const raw = String(formData.get(key) ?? "").trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? "invalid" : parsed;
  };

  const callbackAt = parseWhen("callback_at");
  const meetingAt = parseWhen("meeting_at");
  if (callbackAt === "invalid" || meetingAt === "invalid") {
    return fail("Zadané datum není platné.");
  }

  const rawQualified = String(formData.get("meeting_qualified") ?? "");
  const meetingQualified = rawQualified === "" ? null : rawQualified === "yes";

  const rawDeal = String(formData.get("deal_value") ?? "").trim();
  const dealValue = rawDeal === "" ? null : Number(rawDeal.replace(",", "."));
  if (dealValue !== null && !Number.isFinite(dealValue)) {
    return fail("Hodnota obchodu musí být číslo.");
  }

  // From the session, not the form: an outcome is attributed to whoever is
  // actually at this workstation, and a stale tab cannot credit someone else.
  const callerId = await getSelectedCallerId();

  const result = await logCall({
    campaignContactId,
    outcome,
    callerId,
    note: String(formData.get("note") ?? "") || null,
    callbackAt,
    meetingAt,
    meetingQualified,
    dealValue,
  });
  if (!result.ok) return fail(result.error ?? "Hovor se nepodařilo uložit.");

  // Submitting an outcome is the caller asking for the next number, so the
  // next prospect is reserved here - by an action - and not by the render that
  // follows it. Nothing else in the workspace ever takes a lease.
  //
  // Prázdný scope znamená denní frontu napříč kampaněmi; vyplněný drží
  // callera v jedné kampani, jak to dělá workspace kampaně.
  if (callerId) {
    const scope = String(formData.get("campaign_scope") ?? "") || null;
    await claimNextCall(scope, callerId);
  }

  revalidatePath("/volani", "layout");
  revalidatePath("/osloveni", "layout");
  if (result.campaignId) revalidatePath(`/campaigns/${result.campaignId}`);
  return { success: `Uloženo: ${callOutcomeLabel(outcome)}.` };
}

/** Marks a booked meeting as held and/or judges it against the criteria. */
export async function updateMeetingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const campaignContactId = String(formData.get("campaign_contact_id") ?? "");
  const rawOutcome = String(formData.get("meeting_outcome") ?? "");
  const rawQualified = String(formData.get("qualified") ?? "");

  if (rawOutcome !== "" && !isMeetingOutcome(rawOutcome)) return fail("Neplatný stav schůzky.");

  const result = await updateMeeting(campaignContactId, {
    outcome: rawOutcome === "" ? undefined : (rawOutcome as MeetingOutcome),
    qualified: rawQualified === "" ? undefined : rawQualified === "yes",
  });
  if (!result.ok) return fail("Schůzka nebyla nalezena — nejprve ji domluvte přes výsledek hovoru.");

  revalidatePath("/volani", "layout");
  if (result.campaignId) revalidatePath(`/campaigns/${result.campaignId}`);
  return { success: "Schůzka aktualizována." };
}

const callingSchema = z.object({
  calling_enabled: z.boolean(),
  max_call_attempts: z.coerce.number().int().min(1).max(20),
  script_opening: z.string().nullable(),
  script_value: z.string().nullable(),
  script_objections: z.string().nullable(),
  script_closing: z.string().nullable(),
  qualification_criteria: z.string().nullable(),
});

export async function saveCallingSettingsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("campaign_id") ?? "");
  const text = (key: string) => String(formData.get(key) ?? "").trim() || null;

  const parsed = callingSchema.safeParse({
    calling_enabled: formData.get("calling_enabled") === "on",
    max_call_attempts: formData.get("max_call_attempts"),
    script_opening: text("script_opening"),
    script_value: text("script_value"),
    script_objections: text("script_objections"),
    script_closing: text("script_closing"),
    qualification_criteria: text("qualification_criteria"),
  });
  if (!parsed.success) return fail("Maximální počet pokusů musí být 1 až 20.");

  const data = parsed.data;
  await sql`
    update campaigns
       set calling_enabled = ${data.calling_enabled},
           max_call_attempts = ${data.max_call_attempts},
           script_opening = ${data.script_opening},
           script_value = ${data.script_value},
           script_objections = ${data.script_objections},
           script_closing = ${data.script_closing},
           qualification_criteria = ${data.qualification_criteria},
           updated_at = now()
     where id = ${id}
  `;
  revalidatePath(`/campaigns/${id}`);
  revalidatePath("/volani", "layout");
  return { success: "Nastavení volání uloženo." };
}

const economicsSchema = z.object({
  revenue_model: z.enum(["deal_values", "fixed", "per_meeting_booked", "per_qualified_meeting", "per_meeting_held", "per_client"]),
  revenue_amount: z.coerce.number().min(0),
  caller_cost_model: z.enum(["none", "fixed", "hourly", "per_connected_call"]),
  caller_cost_amount: z.coerce.number().min(0),
  caller_hours: z.coerce.number().min(0),
  additional_costs: z.coerce.number().min(0),
});

export async function saveEconomicsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("campaign_id") ?? "");
  const num = (key: string) => String(formData.get(key) ?? "0").replace(",", ".") || "0";

  const parsed = economicsSchema.safeParse({
    revenue_model: String(formData.get("revenue_model") ?? "deal_values"),
    revenue_amount: num("revenue_amount"),
    caller_cost_model: String(formData.get("caller_cost_model") ?? "none"),
    caller_cost_amount: num("caller_cost_amount"),
    caller_hours: num("caller_hours"),
    additional_costs: num("additional_costs"),
  });
  if (!parsed.success) return fail("Všechny částky musí být nezáporná čísla.");

  const data = parsed.data;
  await sql`
    update campaigns
       set revenue_model = ${data.revenue_model},
           revenue_amount = ${data.revenue_amount},
           caller_cost_model = ${data.caller_cost_model},
           caller_cost_amount = ${data.caller_cost_amount},
           caller_hours = ${data.caller_hours},
           additional_costs = ${data.additional_costs},
           updated_at = now()
     where id = ${id}
  `;
  revalidatePath(`/campaigns/${id}`);
  return { success: "Ekonomika kampaně uložena." };
}

// -------------------------------------------------------------- calleři

export async function saveCallerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return fail("Zadejte jméno callera.");
  await createCaller({
    name,
    email: String(formData.get("email") ?? "").trim().toLowerCase() || null,
    phone: String(formData.get("phone") ?? "").trim() || null,
  });
  revalidatePath("/tym");
  revalidatePath("/volani", "layout");
  return { success: `Caller ${name} přidán.` };
}

/**
 * Retires or reinstates a caller. Never a delete: call history, and therefore
 * the campaign's economics, reference the row.
 */
export async function toggleCallerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  const active = String(formData.get("active") ?? "") === "yes";
  await setCallerActive(id, active);
  revalidatePath("/tym");
  revalidatePath("/volani", "layout");
  return { success: active ? "Caller je znovu aktivní." : "Caller deaktivován." };
}

/** Records who is at this workstation, for the rest of the shift. */
export async function selectCallerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const callerId = String(formData.get("caller_id") ?? "");
  const campaignId = String(formData.get("campaign_id") ?? "");
  if (!callerId) return fail("Vyberte, kdo volá.");

  const [caller] = await sql<{ id: string }[]>`
    select id from callers where id = ${callerId} and active
  `;
  if (!caller) return fail("Tento caller neexistuje nebo je deaktivovaný.");

  await setSelectedCallerId(callerId);
  await claimNextCall(campaignId || null, callerId);
  const next = String(formData.get("next") ?? "");
  redirect(next.startsWith("/") ? next : campaignId ? `/volani/${campaignId}` : "/osloveni");
}

/**
 * Hands the workstation back. The prospect currently held is released rather
 * than left leased, so the next caller is offered them immediately.
 */
export async function clearCallerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const holding = String(formData.get("campaign_contact_id") ?? "");
  if (holding) await releaseCall(holding);
  await clearSelectedCaller();
  const next = String(formData.get("next") ?? "");
  const campaignId = String(formData.get("campaign_id") ?? "");
  redirect(next.startsWith("/") ? next : campaignId ? `/volani/${campaignId}` : "/osloveni");
}

/**
 * Hands the caller the next prospect. The only other place a lease is taken,
 * and it exists because a lease must come from somebody pressing something -
 * never from a page rendering or a router prefetching it.
 */
export async function nextCallAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const campaignId = String(formData.get("campaign_id") ?? "") || null;
  const callerId = await getSelectedCallerId();
  if (!callerId) return fail("Nejdřív vyberte, kdo volá.");

  const claimed = await claimNextCall(campaignId, callerId);
  if (campaignId) revalidatePath(`/volani/${campaignId}`);
  revalidatePath("/osloveni");
  if (!claimed) return { success: "Fronta je prázdná — nikdo další k volání není." };
  return {};
}

// ---------------------------------------------------------------- firmy

export async function saveCompanyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("company_id") ?? "");
  if (!id) return fail("Chybí firma.");

  const priority = String(formData.get("priority") ?? "");
  const status = String(formData.get("status") ?? "");
  if (priority && !(priority in COMPANY_PRIORITY_LABELS)) return fail("Neplatná priorita.");
  if (status && !(status in COMPANY_STATUS_LABELS)) return fail("Neplatný stav firmy.");

  const text = (key: string) => {
    const raw = formData.get(key);
    if (raw === null) return undefined;
    return String(raw).trim() || null;
  };

  const ok = await updateCompany(id, {
    reason: text("reason"),
    note: text("note"),
    priority: priority ? (priority as CompanyPriority) : undefined,
    status: status ? (status as CompanyStatus) : undefined,
    ownerId: formData.get("owner_id") === null ? undefined : String(formData.get("owner_id") ?? "") || null,
  });
  if (!ok) return fail("Firma nebyla nalezena.");

  revalidatePath("/firmy");
  revalidatePath(`/firmy/${id}`);
  revalidatePath("/");
  return { success: "Uloženo." };
}

// ----------------------------------------------------------- týdenní plán

export async function createWorkBlockAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  const date = String(formData.get("block_date") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail("Zadejte datum bloku.");

  let startMinute: number;
  let endMinute: number;
  try {
    startMinute = hhmmToMinutes(String(formData.get("start") ?? "09:00"));
    endMinute = hhmmToMinutes(String(formData.get("end") ?? "11:00"));
  } catch {
    return fail("Časy musí být ve tvaru 09:00.");
  }
  if (endMinute <= startMinute) return fail("Blok musí končit později, než začíná.");

  const activityType = String(formData.get("activity_type") ?? "calling");
  if (!isActivityType(activityType)) return fail("Neplatný typ aktivity.");

  await createWorkBlock({
    date,
    startMinute,
    endMinute,
    callerId: String(formData.get("caller_id") ?? "") || null,
    activityType,
    note: String(formData.get("note") ?? "").trim() || null,
  });

  revalidatePath("/osloveni/plan");
  return { success: "Blok naplánován." };
}

export async function deleteWorkBlockAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();
  await deleteWorkBlock(String(formData.get("id") ?? ""));
  revalidatePath("/osloveni/plan");
  return { success: "Blok smazán." };
}
