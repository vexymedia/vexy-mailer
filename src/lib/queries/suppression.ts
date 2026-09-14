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
  reason: string | null;
  created_at: Date;
}

export async function listClientExclusions(): Promise<ClientExclusion[]> {
  return sql<ClientExclusion[]>`
    select x.id, x.client_id, cl.name as client_name,
           x.company_id, co.name as company_name, x.reason, x.created_at
      from client_company_exclusions x
      join clients cl on cl.id = x.client_id
      join companies co on co.id = x.company_id
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
}): Promise<void> {
  await sql`
    insert into client_company_exclusions (client_id, company_id, reason)
    values (${input.clientId}, ${input.companyId}, ${input.reason ?? null})
    on conflict (client_id, company_id) do update set reason = excluded.reason
  `;
  await logActivity({
    action: "Firma vyloučena pro klienta",
    detail: input.reason ?? "Bez uvedení důvodu.",
  });
}

export async function removeClientExclusion(id: string): Promise<void> {
  await sql`delete from client_company_exclusions where id = ${id}`;
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
