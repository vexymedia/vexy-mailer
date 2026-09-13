import { sql } from "../db";
import { toE164 } from "../telephony/call-state";
import { logActivity } from "../activity";
import { isValidEmail, normaliseEmail, type ParsedContactRow } from "../csv";
import { schedulePendingContacts } from "./campaigns";

export interface ImportResult {
  created: number;
  existing: number;
  suppressed: string[];
  addedToCampaign: number;
  skippedFromCampaign: number;
}

/**
 * Imports parsed CSV rows and optionally enrols them in a campaign.
 *
 * Deduplication is by email, at the database level. An address that is already
 * known is never duplicated; blank fields on the existing record are filled in
 * from the new row, but nothing already there is overwritten.
 */
export async function importContacts(
  rows: ParsedContactRow[],
  campaignId?: string | null,
): Promise<ImportResult> {
  const result: ImportResult = {
    created: 0,
    existing: 0,
    suppressed: [],
    addedToCampaign: 0,
    skippedFromCampaign: 0,
  };
  if (rows.length === 0) return result;

  const suppressedRows = await sql<{ email: string }[]>`
    select email from suppression_list where email = any(${rows.map((r) => r.email)})
  `;
  const suppressed = new Set(suppressedRows.map((r) => r.email));
  result.suppressed = [...suppressed];

  for (const row of rows) {
    // `xmax = 0` distinguishes a fresh INSERT from an ON CONFLICT UPDATE.
    const [contact] = await sql<{ id: string; inserted: boolean }[]>`
      insert into contacts (email, first_name, last_name, company, website, phone, position)
      values (${row.email}, ${row.first_name}, ${row.last_name}, ${row.company},
              ${row.website}, ${row.phone}, ${row.position ?? null})
      on conflict (email) do update
         set first_name = coalesce(contacts.first_name, excluded.first_name),
             last_name  = coalesce(contacts.last_name,  excluded.last_name),
             company    = coalesce(contacts.company,    excluded.company),
             website    = coalesce(contacts.website,    excluded.website),
             position   = coalesce(contacts.position,   excluded.position),
             -- A re-import is the normal way a phone number arrives later, so
             -- fill a blank one in; never overwrite a number already there.
             phone      = coalesce(contacts.phone,      excluded.phone),
             updated_at = now()
      returning id, (xmax = 0) as inserted
    `;
    if (contact.inserted) result.created++;
    else result.existing++;

    if (campaignId) {
      if (suppressed.has(row.email)) {
        result.skippedFromCampaign++;
        continue;
      }
      const added = await sql<{ id: string }[]>`
        insert into campaign_contacts (campaign_id, contact_id)
        values (${campaignId}, ${contact.id})
        on conflict (campaign_id, contact_id) do nothing
        returning id
      `;
      if (added.length > 0) result.addedToCampaign++;
      else result.skippedFromCampaign++;
    }
  }

  // A contact imported into a campaign that is already running still has to be
  // scheduled, or it would never be sent anything.
  if (campaignId) await schedulePendingContacts(campaignId);

  await logActivity({
    action: "Kontakty naimportovány",
    detail:
      `${result.created} new, ${result.existing} already known` +
      (campaignId ? `, ${result.addedToCampaign} added to the campaign` : "") +
      (result.suppressed.length ? `, ${result.suppressed.length} on the suppression list` : ""),
    campaignId: campaignId ?? null,
  });

  return result;
}

/** Adds existing contacts to a campaign, silently skipping suppressed ones. */
export async function addContactsToCampaign(
  campaignId: string,
  contactIds: string[],
): Promise<{ added: number; skipped: number }> {
  if (contactIds.length === 0) return { added: 0, skipped: 0 };
  const rows = await sql<{ id: string }[]>`
    insert into campaign_contacts (campaign_id, contact_id)
    select ${campaignId}, c.id
      from contacts c
     where c.id = any(${contactIds}::uuid[])
       and not exists (select 1 from suppression_list s where s.email = c.email)
    on conflict (campaign_id, contact_id) do nothing
    returning id
  `;
  await schedulePendingContacts(campaignId);
  return { added: rows.length, skipped: contactIds.length - rows.length };
}

export interface ContactOverviewRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  website: string | null;
  phone: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  status: string | null;
  last_sent_at: Date | null;
  next_send_at: Date | null;
  replied: boolean;
  suppressed: boolean;
}

/** The contacts table shown in the UI: one row per contact per campaign. */
export async function listContactOverview(options: {
  search?: string;
  campaignId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: ContactOverviewRow[]; total: number }> {
  const search = options.search?.trim() ? `%${options.search.trim().toLowerCase()}%` : null;
  const campaignId = options.campaignId ?? null;
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;

  const rows = await sql<ContactOverviewRow[]>`
    select c.id, c.email, c.first_name, c.last_name, c.company, c.website, c.phone,
           cc.campaign_id,
           cp.name as campaign_name,
           cc.status,
           cc.last_sent_at,
           cc.next_send_at,
           (cc.status = 'replied') as replied,
           exists (select 1 from suppression_list s where s.email = c.email) as suppressed
      from contacts c
      left join campaign_contacts cc on cc.contact_id = c.id
      left join campaigns cp on cp.id = cc.campaign_id
     where (${search}::text is null
            or lower(c.email) like ${search}
            or lower(coalesce(c.first_name, '')) like ${search}
            or lower(coalesce(c.last_name, ''))  like ${search}
            or lower(coalesce(c.company, ''))    like ${search})
       and (${campaignId}::uuid is null or cc.campaign_id = ${campaignId}::uuid)
     order by c.created_at desc, cp.name nulls first
     limit ${limit} offset ${offset}
  `;

  const [{ count: total }] = await sql<{ count: number }[]>`
    select count(*)::int as count
      from contacts c
      left join campaign_contacts cc on cc.contact_id = c.id
     where (${search}::text is null
            or lower(c.email) like ${search}
            or lower(coalesce(c.first_name, '')) like ${search}
            or lower(coalesce(c.last_name, ''))  like ${search}
            or lower(coalesce(c.company, ''))    like ${search})
       and (${campaignId}::uuid is null or cc.campaign_id = ${campaignId}::uuid)
  `;

  return { rows, total };
}

/**
 * Adds an address to the global do-not-contact list and pulls it out of every
 * campaign it is currently in. The database trigger keeps it out of future ones.
 */
export async function suppressEmail(email: string, reason: string, note?: string): Promise<void> {
  const normalised = email.trim().toLowerCase();
  await sql.begin(async (tx) => {
    await tx`
      insert into suppression_list (email, reason, note)
      values (${normalised}, ${reason}, ${note ?? null})
      on conflict (email) do nothing
    `;
    await tx`
      update campaign_contacts cc
         set status = 'unsubscribed', next_send_at = null, updated_at = now()
        from contacts c
       where c.id = cc.contact_id
         and c.email = ${normalised}
         and cc.status not in ('unsubscribed')
    `;
  });
  const [existing] = await sql<{ id: string }[]>`
    select id from contacts where email = ${normalised}
  `;
  await logActivity({
    action: "Kontakt odhlášen",
    detail: `${normalised} — důvod: ${reason}`,
    // Bez contactId by se odhlášení v Aktivitě zobrazilo bez toho, koho se týká.
    contactId: existing?.id ?? null,
  });
}

export async function unsuppressEmail(email: string): Promise<void> {
  await sql`delete from suppression_list where email = ${email.trim().toLowerCase()}`;
  await logActivity({ action: "Zrušeno nekontaktovat", detail: email.trim().toLowerCase(), level: "warn" });
}

// ------------------------------------------------------ ruční zakládání

export type ContactWriteResult =
  | { ok: true; id: string }
  | { ok: false; error: "duplicate" | "invalid_email" | "invalid_phone" | "not_found" };

export interface ContactInput {
  firstName?: string | null;
  lastName?: string | null;
  position?: string | null;
  email: string;
  phone?: string | null;
  isPrimary?: boolean;
}

/**
 * Telefon se ukládá jen ve tvaru, který jde vytočit.
 *
 * České číslo se běžně píše jako 737485738 nebo 737 485 738; obojí musí
 * projít jako +420737485738. Co se na telefonní číslo nedá převést, se
 * neuloží vůbec - polovičatě uložené číslo by se ukázalo až ve chvíli,
 * kdy na něj někdo zkusí zavolat.
 */
function normalisedPhone(raw: string | null | undefined): string | null | "invalid" {
  const value = raw?.trim();
  if (!value) return null;
  return toE164(value) ?? "invalid";
}

export async function createContact(
  companyId: string,
  input: ContactInput,
): Promise<ContactWriteResult> {
  const email = normaliseEmail(input.email ?? "");
  if (!email || !isValidEmail(email)) return { ok: false, error: "invalid_email" };

  const phone = normalisedPhone(input.phone);
  if (phone === "invalid") return { ok: false, error: "invalid_phone" };

  const [company] = await sql<{ name: string }[]>`
    select name from companies where id = ${companyId}
  `;
  if (!company) return { ok: false, error: "not_found" };

  const [existing] = await sql<{ id: string }[]>`select id from contacts where email = ${email}`;
  if (existing) return { ok: false, error: "duplicate" };

  // `company` (text) je pořád zdroj pravdy pro import a trigger z něj
  // dopočítá company_id, takže se sem píše jméno firmy, ne jen id.
  const [row] = await sql<{ id: string }[]>`
    insert into contacts (email, first_name, last_name, position, phone, company, is_primary)
    values (${email}, ${input.firstName?.trim() || null}, ${input.lastName?.trim() || null},
            ${input.position?.trim() || null}, ${phone}, ${company.name},
            ${input.isPrimary ?? false})
    returning id
  `;
  if (input.isPrimary) await makePrimary(companyId, row.id);

  await logActivity({ action: "Kontakt vytvořen", detail: email, contactId: row.id });
  return { ok: true, id: row.id };
}

export async function updateContact(
  contactId: string,
  input: ContactInput,
): Promise<ContactWriteResult> {
  const email = normaliseEmail(input.email ?? "");
  if (!email || !isValidEmail(email)) return { ok: false, error: "invalid_email" };

  const phone = normalisedPhone(input.phone);
  if (phone === "invalid") return { ok: false, error: "invalid_phone" };

  const [current] = await sql<{ company_id: string | null }[]>`
    select company_id from contacts where id = ${contactId}
  `;
  if (!current) return { ok: false, error: "not_found" };

  const [clash] = await sql<{ id: string }[]>`
    select id from contacts where email = ${email} and id <> ${contactId}
  `;
  if (clash) return { ok: false, error: "duplicate" };

  await sql`
    update contacts
       set email = ${email},
           first_name = ${input.firstName?.trim() || null},
           last_name = ${input.lastName?.trim() || null},
           position = ${input.position?.trim() || null},
           phone = ${phone},
           is_primary = ${input.isPrimary ?? false},
           updated_at = now()
     where id = ${contactId}
  `;
  if (input.isPrimary && current.company_id) await makePrimary(current.company_id, contactId);

  await logActivity({ action: "Kontakt upraven", detail: email, contactId });
  return { ok: true, id: contactId };
}

/** Hlavní kontakt je ve firmě jen jeden. */
async function makePrimary(companyId: string, contactId: string): Promise<void> {
  await sql`
    update contacts set is_primary = (id = ${contactId}), updated_at = now()
     where company_id = ${companyId}
  `;
}
