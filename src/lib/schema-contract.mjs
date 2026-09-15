/**
 * Co databáze musí umět, aby ji tahle verze aplikace unesla.
 *
 * Jediný zdroj pravdy pro tři místa, která se nesmí rozejít:
 *   * `npm run db:check` v terminálu,
 *   * Stav systému v administraci,
 *   * readiness endpoint pro monitoring.
 *
 * Je to schválně prostý .mjs bez závislostí: importuje se i z Node
 * skriptu, kde TypeScript neběží. Typy k němu jsou v schema-contract.d.ts.
 *
 * MIGRATIONS je psané ručně, ne čtené z disku - na Vercelu se složka
 * supabase/migrations do funkce vůbec nedostane, takže by aplikace za
 * běhu neměla proti čemu porovnávat. Aby seznam nezestárnul, hlídá ho
 * test, který ho porovná se skutečnými soubory.
 */

/** Migrace, které tahle verze aplikace očekává, v pořadí použití. */
export const MIGRATIONS = [
  "0001_init.sql",
  "0002_multi_mailbox_and_inbox.sql",
  "0003_calling.sql",
  "0004_calling_hardening.sql",
  "0005_companies_and_plan.sql",
  "0006_outcomes_and_next_action.sql",
  "0007_calls.sql",
  "0008_transcript_speakers.sql",
  "0009_adhoc_calls.sql",
  "0010_primary_contact.sql",
  "0011_outreach_context.sql",
  "0012_users.sql",
  "0013_clients.sql",
  "0014_scheduler_pools_and_classification.sql",
  "0015_exclusions_ico_and_review.sql",
];

/**
 * Co aplikace potřebuje, po obrazovkách.
 *
 * Není to celé schéma - jsou to sloupce a tabulky přidané pozdějšími
 * migracemi, tedy přesně ty, které na starší databázi chybí. Kontroluje
 * se zvlášť od MIGRATIONS, protože se to může rozejít: zápis v
 * schema_migrations negarantuje, že migrace doběhla celá.
 */
export const REQUIRED = [
  { since: "0005", feature: "Firmy", table: "companies", columns: ["reason", "priority", "status", "owner_id"] },
  { since: "0006", feature: "Výsledky hovorů", table: "contacts", columns: ["position"] },
  { since: "0007", feature: "Volání z prohlížeče", table: "calls", columns: ["provider_call_sid", "answered_at", "call_activity_id"] },
  { since: "0008", feature: "Rozlišení řečníků", table: "calls", columns: ["transcript_segments", "recording_channels"] },
  { since: "0010", feature: "Hlavní kontakt", table: "contacts", columns: ["is_primary"] },
  { since: "0011", feature: "Detail firmy — Loom a úvodní věta", table: "contacts", columns: ["loom_url", "loom_title", "loom_sent_at", "loom_note", "call_opener"] },
  { since: "0012", feature: "Přihlašování", table: "users", columns: ["email", "password_hash", "role", "caller_id", "is_active"] },
  { since: "0013", feature: "Oddělení klientů", table: "clients", columns: ["name", "active"] },
  { since: "0013", feature: "Oddělení klientů", table: "campaigns", columns: ["client_id"] },
  { since: "0013", feature: "Přidělení kampaní", table: "caller_campaigns", columns: ["caller_id", "campaign_id"] },
  { since: "0014", feature: "Poměr nových a follow-upů", table: "campaigns", columns: ["new_ratio"] },
  { since: "0014", feature: "Rozdělení odeslání do poolů", table: "email_sends", columns: ["pool"] },
  { since: "0014", feature: "Nedoručení jako data", table: "email_sends", columns: ["bounce_type", "bounce_code", "bounce_detail", "bounced_at"] },
  { since: "0014", feature: "Klasifikace příchozí pošty", table: "messages", columns: ["message_class"] },
  { since: "0014", feature: "Důvod vyloučení", table: "suppression_list", columns: ["reason_code", "source"] },
  { since: "0014", feature: "Klientská vyloučení firem", table: "client_company_exclusions", columns: ["client_id", "company_id", "reason"] },
  { since: "0015", feature: "IČO firmy", table: "companies", columns: ["ico"] },
  { since: "0015", feature: "Autor vyloučení", table: "client_company_exclusions", columns: ["created_by"] },
  { since: "0015", feature: "Odpovědi ke kontrole", table: "replies", columns: ["needs_review"] },
];

/**
 * Co z požadovaného seznamu v databázi chybí.
 *
 * Čistá funkce nad tím, co databáze vrátila - aby šla otestovat bez
 * zásahu do schématu.
 */
export function findMissing(present, required = REQUIRED) {
  const missing = [];
  for (const need of required) {
    const columns = present.get(need.table);
    if (!columns) {
      missing.push({ ...need, missingTable: true, columns: need.columns });
      continue;
    }
    const absent = need.columns.filter((column) => !columns.has(column));
    if (absent.length > 0) missing.push({ ...need, missingTable: false, columns: absent });
  }
  return missing;
}
