import { sql } from "../db";
import { logActivity } from "../activity";

/**
 * Nekontaktovat: audit, scope a bezpečné obnovení.
 *
 * Výchozí postoj: NIC se hromadně nevrací do oběhu. Odhlášení a stížnost
 * na spam jsou rozhodnutí druhé strany a ta se nepřehodnocují. Vrátit se
 * smí jen to, co tam skončilo z technického důvodu, který o příjemci nic
 * neříká - typicky blok kvůli reputaci NAŠÍ domény.
 *
 * Proto má každý řádek `reason_code` z uzavřeného číselníku. Volný text
 * `reason` zůstává vedle: je v něm historie a přepsat ji by znamenalo
 * tvrdit, že víme víc, než víme.
 */

export type SuppressionReasonCode =
  | "unsubscribe"
  | "spam_complaint"
  | "manual_dnc"
  | "hard_invalid"
  | "not_interested"
  | "bounce_technical"
  | "import"
  | "legacy";

export const SUPPRESSION_LABELS: Record<SuppressionReasonCode, string> = {
  unsubscribe: "Odhlášení",
  spam_complaint: "Stížnost na spam",
  manual_dnc: "Ručně zablokováno",
  hard_invalid: "Adresa neexistuje",
  not_interested: "Nemá zájem",
  bounce_technical: "Technická chyba doručení",
  import: "Z importu",
  legacy: "Starší záznam bez důvodu",
};

/**
 * Co se NIKDY nevrací automaticky.
 *
 * Odhlášení a stížnost na spam jsou právní i lidský závazek. Ručně
 * zablokovaný kontakt je rozhodnutí kolegy - to se taky nepřebíjí
 * automatikou. Neexistující adresa se vrátit může jen ručně: možná se
 * změnila, ale hádat to hromadně nemá smysl.
 */
export const NEVER_RESTORE: SuppressionReasonCode[] = [
  "unsubscribe",
  "spam_complaint",
  "manual_dnc",
];

/**
 * Co se dá bezpečně vrátit.
 *
 * Jen technické důvody. Blok kvůli reputaci naší domény neříká
 * o příjemci vůbec nic - je to naše chyba a vyhodit za ni platný lead
 * je čistá ztráta.
 */
export const SAFE_TO_RESTORE: SuppressionReasonCode[] = ["bounce_technical"];

export interface SuppressionGroup {
  reason_code: SuppressionReasonCode;
  label: string;
  source: string | null;
  count: number;
  oldest: Date;
  newest: Date;
  /** Smí se tahle skupina vrátit do oběhu? */
  disposition: "keep" | "restorable" | "review";
}

/**
 * DRY RUN. Jen čte a počítá - nic nemění.
 *
 * Tohle je ta obrazovka, kterou si člověk prohlédne dřív, než cokoli
 * pustí. Hromadná změna produkčních dat naslepo je přesně to, co tady
 * nikdo nechce.
 */
export async function auditSuppression(): Promise<SuppressionGroup[]> {
  const rows = await sql<
    { reason_code: SuppressionReasonCode; source: string | null; count: number; oldest: Date; newest: Date }[]
  >`
    select reason_code, source, count(*)::int as count,
           min(created_at) as oldest, max(created_at) as newest
      from suppression_list
     group by reason_code, source
     order by count desc
  `;
  return rows.map((row) => ({
    ...row,
    label: SUPPRESSION_LABELS[row.reason_code] ?? row.reason_code,
    disposition: NEVER_RESTORE.includes(row.reason_code)
      ? "keep"
      : SAFE_TO_RESTORE.includes(row.reason_code)
        ? "restorable"
        : "review",
  }));
}

export interface RestorePreview {
  /** Adresy, které by se vrátily. Vypisují se, ne jen počítají. */
  emails: string[];
  blocked: number;
}

/**
 * Co by se stalo, kdyby se to pustilo. NIC nemění.
 */
export async function previewRestore(reasonCode: SuppressionReasonCode): Promise<RestorePreview> {
  if (NEVER_RESTORE.includes(reasonCode)) {
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from suppression_list where reason_code = ${reasonCode}
    `;
    return { emails: [], blocked: row.count };
  }
  const rows = await sql<{ email: string }[]>`
    select email from suppression_list where reason_code = ${reasonCode} order by created_at desc limit 500
  `;
  return { emails: rows.map((r) => r.email), blocked: 0 };
}

/**
 * Skutečné obnovení. Odhlášení a stížnosti neprojdou ani na přímý
 * příkaz - to není omezení UI, ale vlastnost téhle funkce.
 */
export async function restoreSuppressed(
  reasonCode: SuppressionReasonCode,
): Promise<{ restored: number; refused: boolean }> {
  if (NEVER_RESTORE.includes(reasonCode)) {
    return { restored: 0, refused: true };
  }
  const rows = await sql<{ email: string }[]>`
    delete from suppression_list where reason_code = ${reasonCode} returning email
  `;
  if (rows.length > 0) {
    await logActivity({
      level: "warn",
      action: "Obnoveno z Nekontaktovat",
      detail: `${rows.length} adres s důvodem „${SUPPRESSION_LABELS[reasonCode]}“ se vrátilo do oběhu.`,
    });
  }
  return { restored: rows.length, refused: false };
}

// ------------------------------------------------- vyloučení firem u klienta

export interface ClientExclusion {
  id: string;
  client_id: string;
  client_name: string;
  company_id: string;
  company_name: string;
  ico: string | null;
  reason: string | null;
  created_at: Date;
  /** Kdo vyloučení založil. Null u importu bez přihlášeného uživatele. */
  created_by_name: string | null;
}

export async function listClientExclusions(filters: {
  clientId?: string | null;
  search?: string | null;
  companyId?: string | null;
} = {}): Promise<ClientExclusion[]> {
  const search = filters.search?.trim() ? `%${filters.search.trim().toLowerCase()}%` : null;
  return sql<ClientExclusion[]>`
    select x.id, x.client_id, cl.name as client_name,
           x.company_id, co.name as company_name, co.ico, x.reason, x.created_at,
           u.name as created_by_name
      from client_company_exclusions x
      join clients cl on cl.id = x.client_id
      join companies co on co.id = x.company_id
      left join users u on u.id = x.created_by
     where (${filters.clientId ?? null}::uuid is null or x.client_id = ${filters.clientId ?? null}::uuid)
       and (${filters.companyId ?? null}::uuid is null or x.company_id = ${filters.companyId ?? null}::uuid)
       and (${search}::text is null
            or lower(co.name) like ${search}
            or coalesce(co.ico, '') like ${search}
            or lower(cl.name) like ${search})
     order by cl.name, co.name
  `;
}

/**
 * „Tahle firma je už klientem ASN Plus.“
 *
 * Vyloučí firmu POUZE pro jednoho klienta. Pro ostatní klienty zůstává
 * firma normálně k oslovení - to je celý rozdíl proti
 * `companies.status = 'excluded'`, který platí globálně.
 */
export async function excludeCompanyForClient(input: {
  clientId: string;
  companyId: string;
  reason?: string | null;
  createdBy?: string | null;
}): Promise<void> {
  const paused = await sql.begin(async (tx) => {
    await tx`
      insert into client_company_exclusions (client_id, company_id, reason, created_by)
      values (${input.clientId}, ${input.companyId}, ${input.reason ?? null},
              ${input.createdBy ?? null})
      on conflict (client_id, company_id) do update
         set reason = excluded.reason,
             created_by = coalesce(excluded.created_by, client_company_exclusions.created_by)
    `;
    /**
     * Rozplánované kroky se ZAHODÍ, ne jen odfiltrují.
     *
     * Kdyby se jen filtrovaly, `next_send_at` by u nich dál ubíhalo do
     * minulosti - a v den, kdy někdo vyloučení zruší, by naráz odletěla
     * celá nahromaděná várka follow-upů. Vyloučení je rozhodnutí
     * "přestaňte", ne pauza s dohnáním.
     *
     * Odeslaná historie ani stav kontaktu se nemění: kdo bude chtít
     * sekvenci zpátky, naplánuje ji vědomě.
     */
    return tx<{ id: string }[]>`
      update campaign_contacts cc
         set next_send_at = null, updated_at = now()
        from campaigns cp, contacts c
       where cp.id = cc.campaign_id
         and c.id = cc.contact_id
         and cp.client_id = ${input.clientId}
         and c.company_id = ${input.companyId}
         and cc.next_send_at is not null
      returning cc.id
    `;
  });

  await logActivity({
    action: "Firma vyloučena pro klienta",
    detail:
      (input.reason ?? "Bez uvedení důvodu.") +
      (paused.length > 0
        ? ` Zrušeno ${paused.length} naplánovaných kroků — zrušení vyloučení je samo neobnoví.`
        : ""),
  });
}

/**
 * Zruší vyloučení. ZÁMĚRNĚ nic nerozjede: kroky zrušené při vyloučení
 * zůstávají zrušené, takže se po zrušení nespustí zadržená vlna.
 */
export async function removeClientExclusion(id: string): Promise<void> {
  const [row] = await sql<{ client_id: string; company_id: string }[]>`
    delete from client_company_exclusions where id = ${id}
    returning client_id, company_id
  `;
  if (row) {
    await logActivity({
      action: "Klientské vyloučení zrušeno",
      detail: "Firma je pro klienta znovu k oslovení. Sekvence se neobnovují automaticky.",
    });
  }
}

// ------------------------------------------------------------------ výpis

export interface SuppressionRow {
  id: string;
  email: string;
  reason_code: SuppressionReasonCode;
  label: string;
  source: string | null;
  note: string | null;
  created_at: Date;
  restorable: boolean;
}

export async function listSuppression(filter?: "review" | "restorable" | "all"): Promise<SuppressionRow[]> {
  const rows = await sql<Omit<SuppressionRow, "label" | "restorable">[]>`
    select id, email, reason_code, source, note, created_at
      from suppression_list
     where (${filter ?? "all"} = 'all'
            or (${filter ?? "all"} = 'review' and reason_code = 'legacy')
            or (${filter ?? "all"} = 'restorable' and reason_code = any(${SAFE_TO_RESTORE})))
     order by created_at desc
     limit 500
  `;
  return rows.map((row) => ({
    ...row,
    label: SUPPRESSION_LABELS[row.reason_code] ?? row.reason_code,
    restorable: !NEVER_RESTORE.includes(row.reason_code),
  }));
}

// -------------------------------------------- import vylučovacího seznamu

export type ExclusionMatchKind = "matched" | "ambiguous" | "not_found" | "already_excluded";

export interface ExclusionMatch {
  line: number;
  ico: string | null;
  name: string | null;
  reason: string | null;
  kind: ExclusionMatchKind;
  /** Firma, na kterou se to napároval. Null u ambiguous a not_found. */
  companyId: string | null;
  companyName: string | null;
  /** Kandidáti u nejednoznačné shody, ať je vidět, proč se nevybralo. */
  candidates: { id: string; name: string }[];
}

/**
 * Napáruje řádky vylučovacího seznamu na firmy. NIC NEMĚNÍ.
 *
 * Pořadí signálů:
 *   1. IČO. Jednoznačné, a proto první.
 *   2. Přesný název po normalizaci (malá písmena, bez právní formy
 *      a interpunkce). Jen když vyjde PRÁVĚ JEDNA firma.
 *
 * Víc firem se stejným názvem = `ambiguous`. Automaticky se nevybírá:
 * vyloučit špatnou firmu znamená tiše přijít o leady a nikdo si toho
 * nevšimne.
 */
export async function matchExclusions(
  clientId: string,
  rows: import("../csv").ParsedExclusionRow[],
): Promise<ExclusionMatch[]> {
  const { normaliseIco } = await import("../csv");

  const icos = rows.map((r) => normaliseIco(r.ico)).filter((v): v is string => v !== null);
  const names = rows.map((r) => normaliseCompanyName(r.name)).filter((v): v is string => v !== null);

  const byIco = new Map<string, { id: string; name: string }>();
  if (icos.length > 0) {
    for (const row of await sql<{ id: string; name: string; ico: string }[]>`
      select id, name, ico from companies where ico = any(${icos})
    `) {
      byIco.set(row.ico, { id: row.id, name: row.name });
    }
  }

  const byName = new Map<string, { id: string; name: string }[]>();
  if (names.length > 0) {
    for (const row of await sql<{ id: string; name: string; key: string }[]>`
      select id, name, lower(btrim(regexp_replace(name,
        '\\s*(s\\.r\\.o\\.|a\\.s\\.|spol\\. s r\\.o\\.|s r o|sro|as|z\\.s\\.|o\\.p\\.s\\.)\\s*$',
        '', 'i'))) as key
        from companies
    `) {
      const list = byName.get(row.key) ?? [];
      list.push({ id: row.id, name: row.name });
      byName.set(row.key, list);
    }
  }

  const existing = new Set(
    (await sql<{ company_id: string }[]>`
      select company_id from client_company_exclusions where client_id = ${clientId}
    `).map((r) => r.company_id),
  );

  return rows.map((row) => {
    const base = { line: row.line, ico: row.ico, name: row.name, reason: row.reason };
    const ico = normaliseIco(row.ico);
    const hit = ico ? byIco.get(ico) : undefined;
    if (hit) {
      return {
        ...base,
        kind: existing.has(hit.id) ? ("already_excluded" as const) : ("matched" as const),
        companyId: hit.id,
        companyName: hit.name,
        candidates: [],
      };
    }

    const key = normaliseCompanyName(row.name);
    const candidates = key ? (byName.get(key) ?? []) : [];
    if (candidates.length === 1) {
      const only = candidates[0];
      return {
        ...base,
        kind: existing.has(only.id) ? ("already_excluded" as const) : ("matched" as const),
        companyId: only.id,
        companyName: only.name,
        candidates: [],
      };
    }
    if (candidates.length > 1) {
      // Dvě firmy téhož jména. Vybrat jednu by byl tip, ne shoda.
      return { ...base, kind: "ambiguous" as const, companyId: null, companyName: null, candidates };
    }
    return { ...base, kind: "not_found" as const, companyId: null, companyName: null, candidates: [] };
  });
}

/** Název na porovnatelný tvar: bez právní formy, interpunkce a diakritiky velikosti. */
function normaliseCompanyName(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value
    .toLowerCase()
    .replace(/\s*(s\.r\.o\.|a\.s\.|spol\. s r\.o\.|s r o|sro|as|z\.s\.|o\.p\.s\.)\s*$/i, "")
    .replace(/[.,;]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

/**
 * Zapíše jen to, co se jednoznačně napárovalo. Opakovaný import téhož
 * seznamu tedy nic nezdvojí - `already_excluded` se přeskočí.
 */
export async function applyExclusionImport(input: {
  clientId: string;
  matches: ExclusionMatch[];
  defaultReason: string;
  createdBy?: string | null;
}): Promise<{ created: number; skipped: number }> {
  let created = 0;
  for (const match of input.matches) {
    if (match.kind !== "matched" || !match.companyId) continue;
    await excludeCompanyForClient({
      clientId: input.clientId,
      companyId: match.companyId,
      reason: match.reason ?? input.defaultReason,
      createdBy: input.createdBy ?? null,
    });
    created++;
  }
  return { created, skipped: input.matches.length - created };
}
