/**
 * Strop na čekání.
 *
 * postgres.js nemá timeout na dotaz. Když je databáze nedostupná nebo
 * přetížená, `await sql\`...\`` čeká, dokud se spojení nevzdá - a to trvá
 * déle než trpělivost člověka u formuláře. Na přihlašovací cestě to
 * znamenalo, že se stránka nenačetla vůbec: měřeno 37 sekund a pak
 * chyba 500.
 *
 * Tohle není retry ani fronta. Jen se čeká nejvýš danou dobu a pak se
 * rozhodne bez databáze.
 */

export class TimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`Operace nedoběhla do ${ms} ms.`);
    this.name = "TimeoutError";
  }
}

/**
 * Vrátí výsledek, nebo vyhodí TimeoutError.
 *
 * Původní práce běží dál - přerušit dotaz v Postgresu odsud nejde. Jde
 * o to, že na něj nikdo nečeká.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Výsledek, nebo náhradní hodnota - když práce selže nebo nedoběhne včas.
 *
 * Pro místa, kde je odpověď "nevím" použitelná. Typicky přihlašovací
 * stránka: když se nedá zjistit, jestli je někdo přihlášený, ukáže se
 * formulář. To je horší zážitek než přesměrování, ale pořád použitelná
 * stránka - na rozdíl od chyby 500.
 */
export async function withTimeoutOr<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  try {
    return await withTimeout(work, ms);
  } catch {
    return fallback;
  }
}

/** Kolik smí čekat přihlašovací cesta. Člověk u formuláře čeká vteřiny. */
export const LOGIN_DB_TIMEOUT_MS = 5000;
/** Kolik smí čekat kontrola přihlášení při vykreslení /login. Ještě míň. */
export const SESSION_CHECK_TIMEOUT_MS = 2000;
/** Readiness probe má odpovědět rychle, nebo říct, že to nejde. */
export const READINESS_TIMEOUT_MS = 5000;
