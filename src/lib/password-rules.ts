/**
 * Pravidla pro heslo bez kryptografie.
 *
 * Vlastní modul schválně: formulář uživatele je klientská komponenta
 * a `password.ts` sahá na `node:crypto`, který se do prohlížeče
 * nedostane. Sdílet se tak dá jen to, co je čistá logika.
 */

/**
 * Záměrně jen délka. Vynucená směs znaků lidi vede k `Heslo1!` a lepší
 * heslo to nedělá - délka ano.
 */
export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Heslo musí mít aspoň ${MIN_PASSWORD_LENGTH} znaků.`;
  }
  return null;
}
