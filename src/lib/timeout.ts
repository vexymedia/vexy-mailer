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

  // Když vyhraje timeout, `work` běží dál a může se později odmítnout.
  // Bez tohohle by z toho byla neodchycená rejection - a ta v serverless
  // runtime shodí celou instanci funkce, tedy i requesty, které s tím
  // nemají nic společného.
  work.catch(() => {});

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
 * Dotaz, který se dá zrušit.
 *
 * `sql\`...\`` z postgres.js je thenable s metodou `cancel()`. Typ sem
 * nejde importovat bez generik, která se na volajícím místě stejně
 * neuplatní, takže tohle je ta nejmenší část, na které nám záleží.
 */
export interface CancellableQuery<T> extends PromiseLike<T> {
  cancel(): void;
}

/**
 * Jako `withTimeout`, ale vypršení strop dotaz SKUTEČNĚ zruší.
 *
 * Tohle je ten rozdíl, na kterém přihlášení padalo. postgres.js ruší svůj
 * jediný časovač (`connectTimer`) na první ReadyForQuery, takže dotaz na
 * navázaném spojení nemá strop žádný. Když se ho `withTimeout` jen
 * přestane držet, dotaz zůstane viset NA SPOJENÍ - a postgres.js další
 * dotazy přiřazuje i na obsazené spojení (`busy.shift()`). Při `max: 1`
 * se tak za zadrhnutý dotaz zařadí každé další přihlášení v téhle
 * instanci a selhává stejně. Z jednorázového zádrhelu je trvalý výpadek.
 *
 * `cancel()` pošle databázi CancelRequest po samostatném spojení. Dotaz
 * skončí, spojení se vrátí do poolu použitelné a další přihlášení má
 * čistý start.
 *
 * Když zrušení samo selže (pooler ho nepropustí, spojení je mrtvé),
 * nejsme na tom hůř než předtím - proto se chyba jen spolkne.
 */
export async function withQueryTimeout<T>(query: CancellableQuery<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve(query);

  // Po zrušení se dotaz odmítne. Nikdo už na něj nečeká, takže bez
  // tohohle by z toho byla neodchycená rejection - a ta v serverless
  // runtime shodí celou instanci i s cizími requesty.
  work.catch(() => {});

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            query.cancel();
          } catch {
            // Zrušit to nešlo. Pořád platí, že na dotaz nikdo nečeká.
          }
          reject(new TimeoutError(ms));
        }, ms);
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

/**
 * Kolik smí trvat navázání spojení. Musí odpovídat `connect_timeout`
 * v lib/db.ts - je to tatáž věc, jen v jiné jednotce.
 */
export const DB_CONNECT_BUDGET_MS = 5000;

/**
 * Kolik smí trvat samotný dotaz, jakmile spojení stojí.
 */
export const DB_QUERY_BUDGET_MS = 3000;

/**
 * Strop pro databázový krok přihlášení.
 *
 * SOUČET, ne libovolné číslo. Tohle je přesně ta chyba, kterou to tu
 * jednou už mělo: strop byl 5000 ms a `connect_timeout` taky 5 s, takže
 * na studeném serverless startu pokryl rozpočet jen navázání spojení
 * a na dotaz nezbylo nic. Race byla prohraná předem a přihlášení hlásilo
 * „databáze neodpovídá", i když databáze odpovídala normálně - readiness
 * přes tentýž pool procházel.
 *
 * Strop na dotaz proto MUSÍ být větší než strop na spojení. Hlídá to test.
 */
export const LOGIN_DB_TIMEOUT_MS = DB_CONNECT_BUDGET_MS + DB_QUERY_BUDGET_MS;
/** Kolik smí čekat kontrola přihlášení při vykreslení /login. Ještě míň. */
export const SESSION_CHECK_TIMEOUT_MS = 2000;
/**
 * Readiness probe má odpovědět rychle, nebo říct, že to nejde.
 *
 * Platí tu týž invariant jako u přihlášení: strop musí být větší než
 * rozpočet na spojení, jinak by na studeném startu vypršel dřív, než se
 * stihne připojit, a probe by hlásil „not_ready" u zdravé databáze.
 */
export const READINESS_TIMEOUT_MS = DB_CONNECT_BUDGET_MS + DB_QUERY_BUDGET_MS;
