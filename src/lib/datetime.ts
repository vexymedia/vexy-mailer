/**
 * České formátování data a času, bez databáze a bez Reactu.
 *
 * Časová zóna je napevno Europe/Prague. Server běží v UTC, prohlížeč
 * uživatele v Praze - kdyby si každý formátoval po svém, server a klient by
 * po hydrataci ukazovaly jiný čas schůzky. Produkt je český, takže jedna
 * pevná zóna je správná odpověď, ne kompromis.
 */

export const APP_TIME_ZONE = "Europe/Prague";

const dateTimeFormat = new Intl.DateTimeFormat("cs-CZ", {
  timeZone: APP_TIME_ZONE,
  day: "numeric",
  month: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormat = new Intl.DateTimeFormat("cs-CZ", {
  timeZone: APP_TIME_ZONE,
  day: "numeric",
  month: "numeric",
  year: "numeric",
});

const shortDateFormat = new Intl.DateTimeFormat("cs-CZ", {
  timeZone: APP_TIME_ZONE,
  day: "numeric",
  month: "numeric",
});

const timeFormat = new Intl.DateTimeFormat("cs-CZ", {
  timeZone: APP_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
});

const weekdayFormat = new Intl.DateTimeFormat("cs-CZ", {
  timeZone: APP_TIME_ZONE,
  weekday: "short",
});

function toDate(value: Date | string): Date {
  return typeof value === "string" ? new Date(value) : value;
}

export function formatDateTime(value: Date | string | null): string {
  if (!value) return "—";
  return dateTimeFormat.format(toDate(value));
}

export function formatDate(value: Date | string | null): string {
  if (!value) return "—";
  return dateFormat.format(toDate(value));
}

export function formatTime(value: Date | string | null): string {
  if (!value) return "—";
  return timeFormat.format(toDate(value));
}

/** Kalendářní den v pražské zóně, jako "2026-09-12". */
export function pragueDay(value: Date | string): string {
  const date = toDate(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return parts;
}

/**
 * "Dnes 10:30", "Zítra 9:00", "Po termínu · 10. 9. 14:00", "út 16. 9. 14:00".
 *
 * Caller potřebuje na první pohled poznat, jestli je termín jeho dnešní
 * práce, nebo něco, co už mělo být hotové.
 */
export function formatWhen(value: Date | string | null, now: Date = new Date()): string {
  if (!value) return "—";
  const date = toDate(value);
  const day = pragueDay(date);
  const today = pragueDay(now);
  const tomorrow = pragueDay(new Date(now.getTime() + 86_400_000));

  if (day === today) return `Dnes ${timeFormat.format(date)}`;
  if (day === tomorrow) return `Zítra ${timeFormat.format(date)}`;
  if (day < today) return `Po termínu · ${shortDateFormat.format(date)}`;
  return `${weekdayFormat.format(date)} ${shortDateFormat.format(date)} ${timeFormat.format(date)}`;
}

/** Je termín splatný, tedy dnes nebo dřív? */
export function isDue(value: Date | string | null, now: Date = new Date()): boolean {
  if (!value) return false;
  return pragueDay(toDate(value)) <= pragueDay(now);
}

export function isOverdue(value: Date | string | null, now: Date = new Date()): boolean {
  if (!value) return false;
  return pragueDay(toDate(value)) < pragueDay(now);
}

export function isToday(value: Date | string | null, now: Date = new Date()): boolean {
  if (!value) return false;
  return pragueDay(toDate(value)) === pragueDay(now);
}
