import { sql } from "../db";
import { logActivity } from "../activity";
import { classifyBounce, extractStatus, type BounceType } from "../bounce";

/**
 * Nedoručení jako data, ne jako záhada.
 *
 * Bounce se ukládá k ODESLANÉMU e-mailu, ne jako samostatná entita - tam
 * už je kampaň, kontakt, schránka i krok, takže se nic nemusí dohledávat
 * a nic se nemůže rozejít.
 *
 * Jediné, co smí bounce udělat s kontaktem, je globální suppression - a
 * to výhradně u HARD_INVALID, tedy "tahle adresa neexistuje". Reputace,
 * politika a spam jsou problémy NAŠEHO odesílání; zablokovat kvůli nim
 * příjemce znamená vyhodit platný lead za vlastní chybu.
 */

export interface RecordBounceInput {
  mailboxId: string;
  contactId: string | null;
  campaignContactId: string | null;
  subject: string | null;
  bodyText: string | null;
  headers: Record<string, string>;
  fromEmail: string;
  receivedAt: Date;
}

/** Vytáhne Diagnostic-Code / Final-Recipient / Status z těla DSN. */
export function parseDsn(bodyText: string | null): {
  status: string | null;
  diagnosticCode: string | null;
  finalRecipient: string | null;
  reportingMta: string | null;
  action: string | null;
} {
  const text = bodyText ?? "";
  const field = (name: string): string | null => {
    // DSN pole se smí zalomit; pokračovací řádek začíná bílým znakem.
    const re = new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, "im");
    const match = re.exec(text);
    return match ? match[1].replace(/\r?\n[ \t]+/g, " ").trim() : null;
  };
  const diagnosticCode = field("Diagnostic-Code");
  return {
    status: field("Status") ?? extractStatus(diagnosticCode) ?? extractStatus(text),
    diagnosticCode,
    finalRecipient: field("Final-Recipient")?.replace(/^rfc822;\s*/i, "") ?? null,
    reportingMta: field("Reporting-MTA")?.replace(/^dns;\s*/i, "") ?? null,
    action: field("Action"),
  };
}

/**
 * Zpracuje hlášení o nedoručení.
 *
 * Návratová hodnota říká, co se stalo - používá to test i log. Když se
 * nepodaří spárovat s konkrétním odeslaným e-mailem, bounce se stejně
 * zaloguje: vědět, že nám něco padá, je cennější než čistá tabulka.
 */
export async function recordBounce(input: RecordBounceInput): Promise<{
  type: BounceType;
  matchedSendId: string | null;
  suppressed: boolean;
}> {
  const dsn = parseDsn(input.bodyText);
  const verdict = classifyBounce({
    status: dsn.status,
    diagnosticCode: dsn.diagnosticCode ?? input.bodyText?.slice(0, 2000) ?? null,
    subject: input.subject,
    action: dsn.action,
  });

  // Komu to vlastně nešlo. Final-Recipient je přesnější než cokoli, co
  // bychom uhádli z vlákna.
  const recipient = dsn.finalRecipient?.toLowerCase().trim() ?? null;

  // Spárování s konkrétním odeslaným e-mailem: nejdřív přes vlákno,
  // jinak přes poslední odeslaný e-mail na tuhle adresu z téhle schránky.
  const [match] = await sql<{ id: string; campaign_id: string; intended_email: string }[]>`
    select id, campaign_id, intended_email
      from email_sends
     where status in ('sent', 'unknown')
       and (
         (${input.campaignContactId}::uuid is not null
          and campaign_contact_id = ${input.campaignContactId}::uuid)
         or (${recipient}::text is not null
             and lower(intended_email) = ${recipient}::text
             and mailbox_id = ${input.mailboxId})
       )
     order by sent_at desc nulls last
     limit 1
  `;

  if (match) {
    await sql`
      update email_sends
         set bounce_type = ${verdict.type},
             bounce_code = ${dsn.status},
             bounce_detail = ${(dsn.diagnosticCode ?? input.subject ?? "").slice(0, 2000)},
             bounced_at = ${input.receivedAt}
       where id = ${match.id}
    `;
  }

  // ------------------------------------------------------------ suppression
  //
  // JEDINÝ důvod, který smí zablokovat příjemce. Reputace ani politika
  // o jeho adrese neříkají nic.
  let suppressed = false;
  const email = recipient ?? match?.intended_email ?? null;
  if (verdict.suppressRecipient && email) {
    const { suppressEmail } = await import("./contacts");
    await suppressEmail(email, "hard_invalid", dsn.diagnosticCode?.slice(0, 500) ?? "Adresa neexistuje.", {
      reasonCode: "hard_invalid",
      source: "bounce",
    });
    suppressed = true;
  }

  await logActivity({
    level: verdict.senderProblem ? "error" : "warn",
    action: `Nedoručeno — ${verdict.label}`,
    detail:
      `${email ?? "neznámý příjemce"} přes ${input.fromEmail}` +
      (dsn.status ? ` · status ${dsn.status}` : "") +
      (dsn.diagnosticCode ? ` · ${dsn.diagnosticCode.slice(0, 300)}` : "") +
      (verdict.senderProblem
        ? " · Problém je na straně odesílatele, příjemce se neblokuje."
        : suppressed
          ? " · Adresa přidána na seznam Nekontaktovat."
          : ""),
    campaignId: match?.campaign_id ?? null,
    contactId: input.contactId,
    campaignContactId: input.campaignContactId,
  });

  return { type: verdict.type, matchedSendId: match?.id ?? null, suppressed };
}

// ------------------------------------------------------------------ přehled

export interface MailboxHealth {
  mailbox_id: string;
  name: string;
  from_email: string;
  enabled: boolean;
  daily_limit: number;
  sent_today: number;
  hard_invalid: number;
  temporary: number;
  reputation_blocks: number;
  last_error: string | null;
  last_test_ok: boolean | null;
}

/**
 * Zdraví schránek za posledních 7 dní.
 *
 * Schválně čtyři čísla, ne dvacet. Tohle není deliverability SaaS -
 * je to odpověď na "je něco v nepořádku a s čím".
 */
export async function listMailboxHealth(days = 7): Promise<MailboxHealth[]> {
  return sql<MailboxHealth[]>`
    with window_sends as (
      select mailbox_id, bounce_type, status, sent_at, claimed_at
        from email_sends
       where coalesce(sent_at, claimed_at) >= now() - ${`${days} days`}::interval
    )
    select m.id as mailbox_id, m.name, m.from_email, m.enabled, m.daily_limit,
           m.last_test_ok,
           coalesce(m.imap_last_error, m.last_test_error) as last_error,
           (select count(*)::int from email_sends es
             where es.mailbox_id = m.id
               and es.status in ('sending', 'sent', 'unknown', 'skipped')
               and coalesce(es.sent_at, es.claimed_at)
                   >= date_trunc('day', now() at time zone m.timezone) at time zone m.timezone
           ) as sent_today,
           count(*) filter (where w.bounce_type = 'HARD_INVALID')::int as hard_invalid,
           count(*) filter (where w.bounce_type in
             ('SOFT_TEMPORARY', 'MAILBOX_FULL', 'RATE_LIMIT', 'NETWORK_ERROR'))::int as temporary,
           count(*) filter (where w.bounce_type in
             ('REPUTATION_BLOCK', 'POLICY_BLOCK', 'SPAM_REJECTION'))::int as reputation_blocks
      from mailboxes m
      left join window_sends w on w.mailbox_id = m.id
     group by m.id
     order by m.from_email
  `;
}

/**
 * Práh, po kterém stojí za to schránku pozastavit.
 *
 * Volba čísel: veřejná doporučení odesílatelů se shodují na tom, že
 * hard bounce rate nad 2 % je problém a nad 5 % už ohrožuje doménu
 * (Google Email Sender Guidelines uvádí jako cíl "pod 0,3 %" u spam
 * rate; Microsoft SNDS a běžná praxe ESP pracují s 2 % u bounce rate).
 * Bereme 5 % jako mez, kdy se ozveme, a zároveň vyžadujeme aspoň 20
 * odeslaných e-mailů, aby dva bouncy z pěti nezastavily celou schránku.
 *
 * Reputation/policy bloky mají vlastní, nižší mez: ty neškálují s
 * objemem, jeden opakující se blok znamená, že další posílání jen
 * prohlubuje problém.
 */
export const HEALTH_THRESHOLDS = {
  minimumSends: 20,
  hardBounceRate: 0.05,
  reputationBlocks: 3,
};

export function mailboxProblem(health: MailboxHealth): string | null {
  if (health.reputation_blocks >= HEALTH_THRESHOLDS.reputationBlocks) {
    return `${health.reputation_blocks} bloků kvůli reputaci nebo politice serveru. Řešte doménu, ne kontakty.`;
  }
  const total = health.sent_today + health.hard_invalid + health.temporary;
  if (total >= HEALTH_THRESHOLDS.minimumSends) {
    const rate = health.hard_invalid / total;
    if (rate >= HEALTH_THRESHOLDS.hardBounceRate) {
      return `${Math.round(rate * 100)} % e-mailů jde na neexistující adresy. Zkontrolujte kvalitu importu.`;
    }
  }
  if (health.last_test_ok === false) return "Poslední test spojení selhal.";
  if (!health.enabled) return "Schránka je vypnutá.";
  return null;
}
