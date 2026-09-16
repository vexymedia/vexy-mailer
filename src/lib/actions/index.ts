"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { z } from "zod";
import { sql } from "@/lib/db";
import {
  createSessionToken,
  requireAdmin,
  requireAuth,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth";
import { verifyPassword, passwordProblem } from "@/lib/password";
import {
  createUser,
  getUserForLogin,
  setUserActive,
  setUserPassword,
  updateUser,
  type UserRole,
} from "@/lib/queries/users";
import { logActivity } from "@/lib/activity";
import { setCallRecordingEnabled, updateSettings } from "@/lib/settings";
import { parseContactsCsv } from "@/lib/csv";
import { hhmmToMinutes, assertValidTimezone } from "@/lib/schedule";
import { findUnknownVariables } from "@/lib/template";
import {
  createContact,
  importContacts,
  summariseImport,
  describeImport,
  saveOutreachContext,
  suppressEmail,
  unsuppressEmail,
  updateContact,
} from "@/lib/queries/contacts";
import { createMailbox, deleteMailbox, testMailbox, testMailboxImap, updateMailbox } from "@/lib/queries/mailboxes";
import { createClient, getClient, setAssignments } from "@/lib/queries/clients";
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
  scheduleNextStep,
  type QueueMode,
  createCaller,
  logCall,
  releaseCall,
  setCallerActive,
  updateMeeting,
} from "@/lib/queries/calling";
import { clearSelectedCaller, getSelectedCallerId, setSelectedCallerId } from "@/lib/caller-session";
import { createCompany, updateCompany } from "@/lib/queries/companies";
import {
  COMPANY_PRIORITY_LABELS,
  COMPANY_STATUS_LABELS,
  type CompanyPriority,
  type CompanyStatus,
} from "@/lib/companies";
import { createWorkBlock, deleteWorkBlock } from "@/lib/queries/plan";
import { isActivityType, plural } from "@/lib/plan";
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

/**
 * Hash, proti kterému se ověřuje heslo u neexistujícího účtu.
 *
 * Bez něj by přihlášení na neznámý e-mail odpovědělo znatelně rychleji
 * než na existující a dalo by se tím vyčíst, kdo v systému je. Je to
 * scrypt hash náhodného řetězce, který nikdo nezná.
 */
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// ---------------------------------------------------------------- auth

/**
 * Přihlášení e-mailem a heslem.
 *
 * Chybová hláška je jediná pro všechny případy - neexistující účet,
 * špatné heslo i deaktivovaný účet. Rozlišovat je by prozradilo, které
 * e-maily v systému jsou.
 */
export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const wrong = fail("Nesprávný e-mail nebo heslo.");
  if (!email || !password) return wrong;

  // Databáze může být nedostupná (výpadek, špatná adresa, vyčerpaný
  // pooler). Bez tohohle se výjimka prohnala ven z akce a člověk dostal
  // po patnácti sekundách čekání obecné „Application error" - tedy ani
  // nevěděl, jestli má zkusit jiné heslo, nebo počkat. Změřeno, ne
  // odhadnuto: 15 s a pád.
  //
  // Hláška je schválně jiná než u špatného hesla: tohle není chyba
  // uživatele. Podrobnost jde do logu serveru, do prohlížeče nikdy -
  // chyba z postgres.js běžně obsahuje hosta i uživatele.
  let user: Awaited<ReturnType<typeof getUserForLogin>>;
  try {
    user = await getUserForLogin(email);
  } catch (error) {
    console.error("[login] dotaz na uživatele selhal", error);
    return fail("Přihlášení se teď nepodařilo ověřit — databáze neodpovídá. Zkuste to prosím za chvíli.");
  }

  if (!user || !user.is_active) {
    // Heslo se ověří i tak, aby se z rychlosti odpovědi nedalo poznat,
    // jestli účet existuje.
    await verifyPassword(password, DUMMY_HASH);
    return wrong;
  }
  if (!(await verifyPassword(password, user.password_hash))) return wrong;

  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions);

  const next = String(formData.get("next") ?? "");
  // Caller nemá co dělat na admin přehledu: jde rovnou do práce.
  const home = user.role === "caller" ? "/osloveni" : "/";
  redirect(next.startsWith("/") && next !== "/login" ? next : home);
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
  await requireAdmin();
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
  new_ratio: z.coerce.number().int().min(0).max(100).default(70),
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
    new_ratio: formData.get("new_ratio") ?? 70,
    timezone: String(formData.get("mailbox_timezone") ?? "Europe/Prague"),
    enabled: formData.get("enabled") === "on",
  });
}

export async function saveMailboxAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
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
  await requireAdmin();
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
  await requireAdmin();
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
  await requireAdmin();
  const result = await deleteMailbox(String(formData.get("id") ?? ""));
  revalidatePath("/mailboxes");
  return result.ok ? { success: "Schránka smazána." } : fail(result.error ?? "Smazat se nepodařilo.");
}

// ----------------------------------------------------------- campaigns

const campaignSchema = z.object({
  name: z.string().min(1, "Pojmenujte kampaň."),
  mailbox_ids: z.array(z.string().uuid()).min(1, "Vyberte alespoň jednu odesílací schránku."),
  daily_limit: z.coerce.number().int().min(1).max(2000),
  new_ratio: z.coerce.number().int().min(0).max(100).default(70),
  timezone: z.string().min(1),
  send_days: z.array(z.number().int().min(1).max(7)).min(1, "Vyberte alespoň jeden den odesílání."),
  send_start_minute: z.number().int().min(0).max(1439),
  send_end_minute: z.number().int().min(1).max(1440),
});

export async function saveCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
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
    new_ratio: formData.get("new_ratio") ?? 70,
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
      new_ratio: data.new_ratio,
      send_days: data.send_days,
      send_start_minute: data.send_start_minute,
      send_end_minute: data.send_end_minute,
      timezone: data.timezone,
    }));
  } else {
    // Always draft. A new campaign never starts on its own.
    const [row] = await sql<{ id: string }[]>`
      insert into campaigns (name, daily_limit, new_ratio, send_days,
                             send_start_minute, send_end_minute, timezone, status)
      values (${data.name}, ${data.daily_limit}, ${data.new_ratio}, ${data.send_days},
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
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const result = await startCampaign(id);
  revalidatePath(`/campaigns/${id}`);
  revalidatePath("/");
  if (!result.ok) return fail("Kampaň není připravená ke spuštění.", result.problems);
  return { success: "Kampaň běží. Worker začne odesílat v nejbližším okně." };
}

export async function pauseCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  await pauseCampaign(id);
  revalidatePath(`/campaigns/${id}`);
  revalidatePath("/");
  return { success: "Kampaň pozastavena. Žádné další e-maily se neodešlou." };
}

export async function deleteCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const [campaign] = await sql<{ status: string }[]>`select status from campaigns where id = ${id}`;
  if (campaign?.status === "active") return fail("Před smazáním kampaň pozastavte.");
  await sql`delete from campaigns where id = ${id}`;
  revalidatePath("/campaigns");
  redirect("/campaigns");
}

export async function checkReadinessAction(campaignId: string): Promise<string[]> {
  await requireAdmin();
  return (await checkCampaignReadiness(campaignId)).problems;
}

// ------------------------------------------------------- sequence steps

export async function saveStepsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
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

  await logActivity({ action: "Sekvence upravena", detail: plural(steps.length, "krok", "kroky", "kroků"), campaignId });
  revalidatePath(`/campaigns/${campaignId}`);
  return { success: `Sekvence uložena: ${steps.length} kroků.` };
}

// ------------------------------------------------------------ contacts

export async function importContactsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
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

  // Jeden součet, který sedí na počet řádků v souboru. Bez něj se ztrácely
  // neplatné řádky mezi parserem a importem a nešlo doložit, kolik lidí
  // se do kampaně opravdu dostalo - tedy kolik se má počítat do kvóty.
  const summary = summariseImport(parsed, result, Boolean(campaignId));

  const notes: string[] = [];
  if (parsed.errors.length) notes.push(...parsed.errors.slice(0, 20));
  if (parsed.ignoredColumns.length) notes.push(`Ignorované sloupce: ${parsed.ignoredColumns.join(", ")}.`);
  if (result.excluded) {
    notes.push(`${result.excluded} kontaktů je z firem, které si tenhle klient vyloučil.`);
  }
  if (result.suppressed.length) {
    notes.push(`${result.suppressed.length} adres je na seznamu Nekontaktovat a do kampaně se nepřidaly.`);
  }
  if (!summary.reconciles) {
    // Nemělo by nastat. Když ano, je lepší to říct, než tiše vydat číslo,
    // podle kterého se fakturuje.
    notes.push("Pozor: součet kategorií nesedí na počet řádků v souboru. Zkontrolujte import.");
  }

  return { success: describeImport(summary), problems: notes.length ? notes : undefined };
}

export async function suppressEmailAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) return fail("Zadejte platnou e-mailovou adresu.");
  await suppressEmail(email, String(formData.get("reason") ?? "manual"), String(formData.get("note") ?? "") || undefined);
  revalidatePath("/suppression");
  revalidatePath("/contacts");
  return { success: `${email} už nikdy nebude kontaktován.` };
}

export async function unsuppressEmailAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  await unsuppressEmail(String(formData.get("email") ?? ""));
  revalidatePath("/suppression");
  return { success: "Odebráno ze seznamu Nekontaktovat." };
}

/**
 * Hromadné vrácení do oběhu.
 *
 * Odhlášení, stížnosti na spam a ruční bloky neprojdou - a není to
 * kontrola v UI, kterou by šlo obejít jinou cestou: odmítá je sama
 * `restoreSuppressed`.
 */
export async function restoreSuppressedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const { restoreSuppressed, SUPPRESSION_LABELS } = await import("@/lib/queries/suppression");
  const code = String(formData.get("reason_code") ?? "") as
    import("@/lib/queries/suppression").SuppressionReasonCode;
  if (!(code in SUPPRESSION_LABELS)) return fail("Neznámý důvod.");

  const result = await restoreSuppressed(code);
  revalidatePath("/suppression");
  if (result.refused) {
    return fail("Odhlášení, stížnosti na spam ani ruční bloky se hromadně nevracejí.");
  }
  return { success: `Vráceno do oběhu: ${result.restored}.` };
}

// ------------------------------------------- klientská vyloučení firem

/**
 * Vyloučí firmu pro JEDNOHO klienta.
 *
 * Oprávnění: administrátor. Caller firmu vyloučit nesmí - je to
 * rozhodnutí o obchodním vztahu, ne výsledek hovoru. `requireAdmin()`
 * je serverová kontrola, ne jen schování tlačítka.
 */
export async function excludeCompanyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const clientId = String(formData.get("client_id") ?? "");
  const companyId = String(formData.get("company_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || null;
  if (!clientId || !companyId) return fail("Vyberte klienta.");

  const { excludeCompanyForClient, listClientExclusions } = await import("@/lib/queries/suppression");
  const already = await listClientExclusions({ clientId, companyId });
  if (already.length > 0) {
    return fail(`Firma je pro klienta ${already[0].client_name} už vyloučená.`);
  }

  await excludeCompanyForClient({ clientId, companyId, reason, createdBy: user.id });
  revalidatePath(`/firmy/${companyId}`);
  revalidatePath("/suppression");
  return { success: "Firma je pro tohoto klienta vyloučená. Naplánované kroky byly zrušeny." };
}

export async function removeCompanyExclusionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
  const id = String(formData.get("exclusion_id") ?? "");
  const companyId = String(formData.get("company_id") ?? "");
  if (!id) return fail("Chybí vyloučení.");

  const { removeClientExclusion } = await import("@/lib/queries/suppression");
  await removeClientExclusion(id);
  if (companyId) revalidatePath(`/firmy/${companyId}`);
  revalidatePath("/suppression");
  return { success: "Vyloučení zrušeno. Sekvence se neobnovují automaticky." };
}

export interface ExclusionPreviewState {
  error?: string;
  clientId?: string;
  clientName?: string;
  matches?: import("@/lib/queries/suppression").ExclusionMatch[];
  notes?: string[];
}

/**
 * Náhled importu. ČTE A POČÍTÁ, nic nezapisuje.
 *
 * Vylučovací seznam umí tiše vyhodit stovky leadů, takže se člověk musí
 * podívat na výsledek párování dřív, než se cokoli uloží.
 */
export async function previewExclusionImportAction(
  _prev: ExclusionPreviewState,
  formData: FormData,
): Promise<ExclusionPreviewState> {
  await requireAdmin();
  const clientId = String(formData.get("client_id") ?? "");
  const file = formData.get("file");
  if (!clientId) return { error: "Vyberte klienta." };
  if (!(file instanceof File) || file.size === 0) return { error: "Vyberte CSV soubor." };
  if (file.size > 5 * 1024 * 1024) return { error: "Soubor je větší než 5 MB." };

  const [{ name: clientName } = { name: "" }] = await sql<{ name: string }[]>`
    select name from clients where id = ${clientId}
  `;
  if (!clientName) return { error: "Klient neexistuje." };

  const { parseExclusionsCsv } = await import("@/lib/csv");
  const parsed = parseExclusionsCsv(await file.text());
  if (parsed.rows.length === 0) {
    return { error: parsed.errors[0] ?? "V souboru nejsou žádné použitelné řádky." };
  }

  const { matchExclusions } = await import("@/lib/queries/suppression");
  const matches = await matchExclusions(clientId, parsed.rows);
  return { clientId, clientName, matches, notes: parsed.errors.slice(0, 20) };
}

/** Zapíše jen jednoznačné shody z potvrzeného náhledu. */
export async function applyExclusionImportAction(
  _prev: { error?: string; success?: string },
  formData: FormData,
): Promise<{ error?: string; success?: string }> {
  const user = await requireAdmin();
  const clientId = String(formData.get("client_id") ?? "");
  if (!clientId) return { error: "Chybí klient." };

  let matches: import("@/lib/queries/suppression").ExclusionMatch[];
  try {
    matches = JSON.parse(String(formData.get("payload") ?? "[]"));
  } catch {
    return { error: "Náhled se nepodařilo přečíst. Nahrajte soubor znovu." };
  }
  if (!Array.isArray(matches) || matches.length === 0) return { error: "Náhled je prázdný." };

  // Náhled přišel z prohlížeče, takže se na něj nespoléháme: napáruje se
  // znovu na serveru a zapíše se jen to, co i teď vyjde jednoznačně.
  const { matchExclusions, applyExclusionImport } = await import("@/lib/queries/suppression");
  const fresh = await matchExclusions(
    clientId,
    matches.map((m) => ({ line: m.line, ico: m.ico, name: m.name, reason: m.reason })),
  );

  const result = await applyExclusionImport({
    clientId,
    matches: fresh,
    defaultReason: "Z importovaného vylučovacího seznamu.",
    createdBy: user.id,
  });
  revalidatePath("/suppression");
  return {
    success:
      `Vyloučeno ${result.created} firem.` +
      (result.skipped > 0 ? ` ${result.skipped} řádků přeskočeno (nejednoznačné, nenalezené nebo už vyloučené).` : ""),
  };
}

export async function removeFromCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const id = String(formData.get("campaign_contact_id") ?? "");
  const [row] = await sql<{ campaign_id: string }[]>`
    select campaign_id from campaign_contacts where id = ${id}
  `;
  await sql`delete from campaign_contacts where id = ${id}`;
  if (row) revalidatePath(`/campaigns/${row.campaign_id}`);
  return { success: "Kontakt odebrán z kampaně." };
}

export async function skipStepAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const id = String(formData.get("campaign_contact_id") ?? "");
  await skipStepAndResume(id);
  revalidatePath("/campaigns");
  return { success: "Kontakt pokračuje dalším krokem." };
}

// ---------------------------------------------------------------- worker

/** Runs one worker tick by hand, for testing the setup from the UI. */
export async function runWorkerNowAction(_prev: ActionState): Promise<ActionState> {
  await requireAdmin();
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
  await requireAdmin();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return fail("Než odešlete, něco napište.");

  const result = await sendManualReply(conversationId, body);
  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");
  if (!result.ok) return fail(result.error ?? "Odpověď se nepodařilo odeslat.");
  return { success: "Odpověď odeslána." };
}

/**
 * Zařazení odpovědi - a všechno, co z něj plyne.
 *
 * Dřív to jen přepsalo štítek. Člověk pak musel zvlášť zastavit sekvenci
 * a zvlášť odhlásit adresu, tedy otevřít další dvě obrazovky kvůli jedné
 * odpovědi. Teď se to udělá zároveň, protože jinak to udělat nedává
 * smysl:
 *
 *   Odhlásit    → globální suppression (a tím i konec všech sekvencí)
 *   Nemá zájem  → konec sekvencí u tohohle kontaktu
 *   Špatná osoba → konec sekvence JEN u tohohle kontaktu, ne u firmy
 *
 * Pozitivní a Později sekvenci nezastavují nad rámec toho, co už udělala
 * samotná odpověď: kontakt je od ní `replied` a žádný další automat mu
 * nic nepošle.
 */
export async function classifyConversationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const classification = String(formData.get("classification") ?? "unclassified") as Classification;

  const { getConversation } = await import("@/lib/queries/inbox");
  const conversation = await getConversation(conversationId);
  if (!conversation) return fail("Konverzace nebyla nalezena.");

  await setClassification(conversationId, classification);

  if (classification === "unsubscribe") {
    const { suppressEmail } = await import("@/lib/queries/contacts");
    await suppressEmail(conversation.contact_email, "unsubscribe", "Zařazeno ručně v Komunikaci.", {
      reasonCode: "unsubscribe",
      source: "inbox",
    });
  } else if (classification === "not_interested" || classification === "wrong_person") {
    // Konec automatiky na tomhle kontaktu. Firma se NEuzavírá: "špatná
    // osoba" znamená špatnou osobu, ne špatnou firmu.
    await sql`
      update campaign_contacts
         set next_send_at = null, updated_at = now()
       where contact_id = ${conversation.contact_id}
         and status in ('pending', 'scheduled', 'sent')
    `;
  }

  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");
  return { success: "Uloženo." };
}

/**
 * Uzavře posouzení odpovědi, která přišla od jiné adresy.
 *
 * Dvě možnosti a nic mezi tím: buď to byl prospekt z jiné adresy (konec
 * sekvence), nebo nesouvisející zpráva (sekvence pokračuje podle
 * PŮVODNÍHO termínu, ne od teď).
 */
export async function resolveReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const replyId = String(formData.get("reply_id") ?? "");
  const verdict = String(formData.get("verdict") ?? "");
  const conversationId = String(formData.get("conversation_id") ?? "");
  if (verdict !== "relevant" && verdict !== "unrelated") return fail("Neplatné rozhodnutí.");

  const { resolveReview } = await import("@/lib/queries/inbox");
  const result = await resolveReview(replyId, verdict);
  if (!result.ok) return fail("Tohle posouzení už někdo uzavřel.");

  if (conversationId) revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");
  return {
    success:
      verdict === "relevant"
        ? "Označeno jako odpověď prospekta. Další automatické kroky se neodešlou."
        : "Uzavřeno jako nesouvisející. Sekvence pokračuje podle původního harmonogramu.",
  };
}

export async function markReadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const conversationId = String(formData.get("conversation_id") ?? "");
  await markConversationRead(conversationId);
  revalidatePath("/inbox");
  return {};
}

export async function deleteConversationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
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
  const user = await requireAuth();
  const campaignContactId = String(formData.get("campaign_contact_id") ?? "").trim();
  // Kontakt mimo kampaň. Každý skutečný hovor musí jít klasifikovat.
  const contactId = String(formData.get("contact_id") ?? "").trim();
  const outcome = String(formData.get("outcome") ?? "");
  if (!isCallOutcome(outcome)) return fail("Vyberte výsledek hovoru.");
  if (!campaignContactId && !contactId) return fail("Chybí kontakt.");

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

  // Telefonát, ze kterého výsledek vzešel. Nepovinné: zápis z mobilu
  // žádný nemá a musí jít uložit stejně.
  const rawCallId = String(formData.get("call_id") ?? "").trim();

  const result = await logCall({
    campaignContactId: campaignContactId || null,
    contactId: contactId || null,
    outcome,
    callerId,
    callId: rawCallId || null,
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
    // Režim se přenáší z formuláře, aby blok "follow-up" nepodstrčil
    // callerovi po prvním zápisu úplně nevolanou firmu.
    await claimNextCall(scope, callerId, readMode(formData), user.role === "caller");
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
  await requireAdmin();
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
  await requireAdmin();
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
  await requireAdmin();
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
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const active = String(formData.get("active") ?? "") === "yes";
  await setCallerActive(id, active);
  revalidatePath("/tym");
  revalidatePath("/volani", "layout");
  return { success: active ? "Caller je znovu aktivní." : "Caller deaktivován." };
}

/** Records who is at this workstation, for the rest of the shift. */
export async function selectCallerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
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
  await requireAdmin();
  const holding = String(formData.get("campaign_contact_id") ?? "");
  if (holding) await releaseCall(holding);
  await clearSelectedCaller();
  const next = String(formData.get("next") ?? "");
  const campaignId = String(formData.get("campaign_id") ?? "");
  redirect(next.startsWith("/") ? next : campaignId ? `/volani/${campaignId}` : "/osloveni");
}

/** Pracovní režim z formuláře - viz QueueMode v queries/calling.ts. */
function readMode(formData: FormData): QueueMode | null {
  const raw = String(formData.get("mode") ?? "");
  return raw === "first" || raw === "followup" ? raw : null;
}

/**
 * Hands the caller the next prospect. The only other place a lease is taken,
 * and it exists because a lease must come from somebody pressing something -
 * never from a page rendering or a router prefetching it.
 */
export async function nextCallAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireAuth();
  const campaignId = String(formData.get("campaign_id") ?? "") || null;
  const callerId = await getSelectedCallerId();
  if (!callerId) return fail("Nejdřív vyberte, kdo volá.");

  const claimed = await claimNextCall(
    campaignId,
    callerId,
    readMode(formData),
    // Caller dostane další firmu jen z přidělených kampaní.
    user.role === "caller",
  );
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

  // IČO se normalizuje (mezery, vodicí nuly) - jinak by se tentýž
  // subjekt v každém exportu tvářil jako jiná firma a vylučovací
  // seznam by ho nenašel.
  const rawIco = formData.get("ico");
  let ico: string | null | undefined;
  if (rawIco !== null) {
    const trimmed = String(rawIco).trim();
    if (trimmed === "") {
      ico = null;
    } else {
      const { normaliseIco } = await import("@/lib/csv");
      const parsed = normaliseIco(trimmed);
      if (!parsed) return fail("IČO musí být číslo (nejvýš 12 číslic).");
      ico = parsed;
    }
  }

  const ok = await updateCompany(id, {
    reason: text("reason"),
    note: text("note"),
    ico,
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

/**
 * Oprava firmy, která zůstala bez dalšího kroku. Není to zápis hovoru,
 * takže se nedotkne počtu pokusů ani timeline hovorů.
 */
export async function scheduleNextStepAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const campaignContactId = String(formData.get("campaign_contact_id") ?? "");
  if (!campaignContactId) return fail("Vyberte kontakt.");

  const raw = String(formData.get("next_call_at") ?? "").trim();
  if (!raw) return fail("Zadejte datum a čas dalšího kroku.");
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return fail("Zadané datum není platné.");

  const result = await scheduleNextStep(campaignContactId, at);
  if (!result.ok) return fail(result.error ?? "Další krok se nepodařilo naplánovat.");

  revalidatePath("/firmy");
  if (result.companyId) revalidatePath(`/firmy/${result.companyId}`);
  revalidatePath("/");
  revalidatePath("/osloveni", "layout");
  return { success: "Další krok naplánován." };
}

/** Nahrávání hovorů je samostatný přepínač, ne součást testovacího režimu. */
export async function setCallRecordingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
  await setCallRecordingEnabled(formData.get("call_recording_enabled") !== null);
  revalidatePath("/settings");
  return { success: "Uloženo." };
}

/** Ruční založení firmy před hovorem. */
export async function createCompanyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return fail("Vyplňte název firmy.");

  const priority = String(formData.get("priority") ?? "normal");
  const result = await createCompany({
    name,
    website: String(formData.get("website") ?? ""),
    reason: String(formData.get("reason") ?? ""),
    priority: priority in COMPANY_PRIORITY_LABELS ? (priority as CompanyPriority) : "normal",
  });
  if (!result.ok) {
    return fail(
      result.error === "duplicate"
        ? `Firma „${name}“ už existuje.`
        : "Firmu se nepodařilo založit.",
    );
  }

  revalidatePath("/firmy");
  revalidatePath("/");
  redirect(`/firmy/${result.id}`);
}

const CONTACT_ERRORS: Record<string, string> = {
  duplicate: "Kontakt s tímhle e-mailem už existuje.",
  invalid_email: "Zadejte platnou e-mailovou adresu.",
  invalid_phone:
    "Telefonní číslo nejde vytočit. Zadejte ho jako 737485738 nebo +420737485738.",
  invalid_url: "Odkaz na video musí začínat http:// nebo https://.",
  not_found: "Firma nebo kontakt nebyly nalezeny.",
};

/** Založení i úprava kontaktu. Jedna akce, aby formulář byl jen jeden. */
export async function saveContactAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const contactId = String(formData.get("contact_id") ?? "").trim();
  const companyId = String(formData.get("company_id") ?? "").trim();

  const input = {
    firstName: String(formData.get("first_name") ?? ""),
    lastName: String(formData.get("last_name") ?? ""),
    position: String(formData.get("position") ?? ""),
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    isPrimary: formData.get("is_primary") !== null,
  };

  const result = contactId
    ? await updateContact(contactId, input)
    : companyId
      ? await createContact(companyId, input)
      : ({ ok: false, error: "not_found" } as const);

  if (!result.ok) return fail(CONTACT_ERRORS[result.error] ?? "Kontakt se nepodařilo uložit.");

  if (companyId) revalidatePath(`/firmy/${companyId}`);
  revalidatePath("/firmy");
  return { success: contactId ? "Kontakt upraven." : "Kontakt přidán." };
}

/**
 * Co prospekt dostal a čím na to navázat.
 *
 * Vlastní akce, ne součást uložení kontaktu: kdo doplňuje Loom, needituje
 * jméno a telefon - a obráceně. Jedna sloučená akce by při uložení
 * kontaktu Loom smazala.
 */
export async function saveOutreachContextAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
  const contactId = String(formData.get("contact_id") ?? "").trim();
  if (!contactId) return fail("Chybí kontakt.");
  const companyId = String(formData.get("company_id") ?? "").trim();

  const rawSentAt = String(formData.get("loom_sent_at") ?? "").trim();
  let loomSentAt: Date | null = null;
  if (rawSentAt) {
    const parsed = new Date(rawSentAt);
    if (Number.isNaN(parsed.getTime())) return fail("Datum odeslání videa není platné.");
    loomSentAt = parsed;
  }

  const result = await saveOutreachContext(contactId, {
    loomUrl: String(formData.get("loom_url") ?? ""),
    loomTitle: String(formData.get("loom_title") ?? ""),
    loomSentAt,
    loomNote: String(formData.get("loom_note") ?? ""),
    opener: String(formData.get("call_opener") ?? ""),
  });
  if (!result.ok) return fail(CONTACT_ERRORS[result.error] ?? "Kontext se nepodařilo uložit.");

  if (companyId) revalidatePath(`/firmy/${companyId}`);
  revalidatePath("/osloveni");
  return { success: "Kontext oslovení uložen." };
}

// ----------------------------------------------------------- týdenní plán

export async function createWorkBlockAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
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
  await requireAdmin();
  await deleteWorkBlock(String(formData.get("id") ?? ""));
  revalidatePath("/osloveni/plan");
  return { success: "Blok smazán." };
}

// -------------------------------------------------------------- uživatelé

const USER_ERRORS: Record<string, string> = {
  duplicate: "Uživatel s tímhle e-mailem už existuje.",
  invalid_email: "Zadejte platnou e-mailovou adresu.",
  caller_required: "Vyberte, které obchodní identitě uživatel odpovídá.",
  caller_taken: "Tahle obchodní identita už má svoje přihlášení.",
  last_admin: "Tohle je poslední administrátor — jinak by se do nastavení nedostal nikdo.",
  not_found: "Uživatel nebyl nalezen.",
};

function readRole(formData: FormData): UserRole | null {
  const raw = String(formData.get("role") ?? "");
  return raw === "admin" || raw === "caller" ? raw : null;
}

/** Založení i úprava uživatele. Jedna akce, aby byl formulář jen jeden. */
export async function saveUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const role = readRole(formData);
  if (!role) return fail("Vyberte roli.");

  const userId = String(formData.get("user_id") ?? "").trim();
  const email = String(formData.get("email") ?? "");
  const name = String(formData.get("name") ?? "");
  // Obchodní identita dává smysl jen u callera; u admina se zahazuje,
  // i kdyby ji formulář poslal.
  const callerId = role === "caller" ? String(formData.get("caller_id") ?? "") || null : null;

  if (userId) {
    const result = await updateUser(userId, { email, name, role, callerId });
    if (!result.ok) return fail(USER_ERRORS[result.error] ?? "Uživatele se nepodařilo uložit.");
    revalidatePath("/uzivatele");
    return { success: "Uživatel upraven." };
  }

  const password = String(formData.get("password") ?? "");
  const problem = passwordProblem(password);
  if (problem) return fail(problem);

  const result = await createUser({ email, name, role, callerId, password });
  if (!result.ok) return fail(USER_ERRORS[result.error] ?? "Uživatele se nepodařilo založit.");
  revalidatePath("/uzivatele");
  return { success: "Uživatel přidán." };
}

export async function setUserPasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
  const userId = String(formData.get("user_id") ?? "").trim();
  if (!userId) return fail("Chybí uživatel.");

  const password = String(formData.get("password") ?? "");
  const problem = passwordProblem(password);
  if (problem) return fail(problem);

  const result = await setUserPassword(userId, password);
  if (!result.ok) return fail(USER_ERRORS[result.error] ?? "Heslo se nepodařilo změnit.");
  revalidatePath("/uzivatele");
  return { success: "Heslo změněno." };
}

export async function toggleUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const userId = String(formData.get("user_id") ?? "").trim();
  if (!userId) return fail("Chybí uživatel.");
  // Vypnout sám sebe by znamenalo okamžité odhlášení bez cesty zpátky.
  if (userId === admin.id) return fail("Sami sebe deaktivovat nemůžete.");

  const active = String(formData.get("active") ?? "") === "yes";
  const result = await setUserActive(userId, active);
  if (!result.ok) return fail(USER_ERRORS[result.error] ?? "Stav se nepodařilo změnit.");
  revalidatePath("/uzivatele");
  return { success: active ? "Uživatel aktivován." : "Uživatel deaktivován." };
}

// ------------------------------------------------------------------ klienti

/**
 * Klient a přidělení kampaní.
 *
 * Nejmenší věc, která dělá provoz jednoznačným, když v systému vedle sebe
 * běží ASN Plus a vlastní outbound VEXY.
 */
export async function createClientAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const result = await createClient(String(formData.get("name") ?? ""));
  if (!result.ok) {
    return fail(
      result.error === "duplicate"
        ? "Klient s tímhle názvem už existuje."
        : "Zadejte název klienta.",
    );
  }
  revalidatePath("/klienti");
  revalidatePath("/campaigns");
  return { success: "Klient přidán." };
}

/** Zařadí kampaň pod klienta. Bez klienta je kampaň jen pro administrátora. */
export async function setCampaignClientAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
  const campaignId = String(formData.get("campaign_id") ?? "").trim();
  if (!campaignId) return fail("Chybí kampaň.");
  const clientId = String(formData.get("client_id") ?? "").trim() || null;

  if (clientId && !(await getClient(clientId))) return fail("Klient nebyl nalezen.");

  await sql`
    update campaigns set client_id = ${clientId}, updated_at = now() where id = ${campaignId}
  `;
  revalidatePath("/klienti");
  revalidatePath(`/campaigns/${campaignId}`);
  return { success: clientId ? "Kampaň zařazena." : "Kampaň bez klienta." };
}

/**
 * Které kampaně caller zpracovává.
 *
 * Tohle je hranice mezi klienty: bez přidělení caller nedostane žádnou
 * práci a nic cizího neuvidí.
 */
export async function setCallerCampaignsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
  const callerId = String(formData.get("caller_id") ?? "").trim();
  if (!callerId) return fail("Chybí caller.");

  const campaignIds = formData
    .getAll("campaign_ids")
    .map((value) => String(value))
    .filter((value) => /^[0-9a-f-]{36}$/i.test(value));

  await setAssignments(callerId, campaignIds);
  revalidatePath("/tym");
  revalidatePath("/osloveni");
  return {
    success: campaignIds.length === 0
      ? "Caller nemá přidělenou žádnou kampaň — frontu uvidí prázdnou."
      : `Přiděleno: ${campaignIds.length} ${campaignIds.length === 1 ? "kampaň" : campaignIds.length < 5 ? "kampaně" : "kampaní"}.`,
  };
}
