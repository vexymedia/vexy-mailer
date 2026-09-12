/**
 * Doména firem bez databáze.
 *
 * Stejný vzor jako lib/calling.ts: štítky a typy, které potřebuje i
 * prohlížeč, musí být oddělené od dotazů — jinak se do klientského bundlu
 * dostane postgres driver.
 *
 * Hodnoty jsou anglické, protože jsou uložené v databázi a hlídané
 * constraintem. České je jen to, co člověk čte.
 */

export type CompanyPriority = "high" | "normal" | "low";

export type CompanyStatus =
  | "new"
  | "ready"
  | "in_progress"
  | "interested"
  | "meeting"
  | "won"
  | "lost"
  | "excluded";

export const COMPANY_PRIORITY_LABELS: Record<CompanyPriority, string> = {
  high: "Vysoká",
  normal: "Běžná",
  low: "Nízká",
};

export const COMPANY_STATUS_LABELS: Record<CompanyStatus, string> = {
  new: "Nová",
  ready: "Připravená",
  in_progress: "Oslovujeme",
  interested: "Zájem",
  meeting: "Schůzka",
  won: "Klient",
  lost: "Nerelevantní",
  excluded: "Vyloučená",
};

/** Stavy, u kterých už nedává smysl firmu dál oslovovat. */
export const CLOSED_COMPANY_STATUSES: CompanyStatus[] = ["won", "lost", "excluded"];

export function isCompanyPriority(value: string): value is CompanyPriority {
  return value in COMPANY_PRIORITY_LABELS;
}

export function isCompanyStatus(value: string): value is CompanyStatus {
  return value in COMPANY_STATUS_LABELS;
}

export function companyPriorityLabel(value: string | null): string {
  if (!value) return "—";
  return COMPANY_PRIORITY_LABELS[value as CompanyPriority] ?? value;
}

export function companyStatusLabel(value: string | null): string {
  if (!value) return "—";
  return COMPANY_STATUS_LABELS[value as CompanyStatus] ?? value;
}
