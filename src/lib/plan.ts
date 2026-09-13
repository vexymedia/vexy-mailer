/**
 * Doména týdenního plánu bez databáze — štítky a datumová aritmetika,
 * kterou potřebuje i prohlížeč.
 */

export type ActivityType = "calling" | "follow_up" | "email" | "research" | "other";

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  calling: "První oslovení",
  follow_up: "Follow-up",
  email: "E-maily",
  research: "Příprava firem",
  other: "Jiné",
};

export function isActivityType(value: string): value is ActivityType {
  return value in ACTIVITY_TYPE_LABELS;
}

/** Pondělí týdne, do kterého `date` spadá. */
export function startOfWeek(date: Date): Date {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = copy.getUTCDay() === 0 ? 7 : copy.getUTCDay();
  copy.setUTCDate(copy.getUTCDate() - (weekday - 1));
  return copy;
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/** `YYYY-MM-DD` v UTC — stejná konvence, jakou má sloupec `date`. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * České skloňování počtu: 1 kontakt, 2 kontakty, 5 kontaktů.
 * Angličtina si vystačí s "s", čeština ne — a "1 kontaktů" v UI vyčnívá.
 */
export function plural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return `${count} ${one}`;
  if (count >= 2 && count <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}
