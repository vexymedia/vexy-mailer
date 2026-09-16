import postgres from "postgres";
import { env } from "./env";

/**
 * Runtime klient k databázi. Jeden na proces, sdílený přes globalThis.
 *
 * Tohle je serverless kód: na Vercelu běží každý request v nějaké instanci
 * funkce a takových instancí jede vedle sebe klidně deset. Velikost poolu
 * se proto NENÁSOBÍ jednou - násobí se počtem živých instancí.
 *
 * Právě na tom produkce spadla. Klient měl `max: 5`, adresa mířila na
 * Supabase pooler v SESSION režimu (port 5432, strop 15 klientů) a pár
 * souběžných instancí ten strop vyčerpalo:
 *
 *     PostgresError (EMAXCONNSESSION) max clients reached in session mode
 *
 * Odsud dvě pravidla, která se nesmí porušit:
 *
 *   1. `max: 1`, jak Supabase pro serverless doporučuje. Instancí je
 *      vedle sebe víc a s Fluid Compute může jedna obsloužit i několik
 *      requestů naráz - o důvod víc držet na instanci jedno spojení
 *      a nechat souběžné dotazy čekat ve frontě, místo aby si každý bral
 *      další spojení a tím se násobily dvakrát.
 *
 *   2. `prepare: false`. Transaction pooler (port 6543) rozděluje spojení
 *      po jednotlivých transakcích, takže prepared statement založený
 *      v jedné může skončit na jiném fyzickém spojení. PgBouncer to
 *      v transakčním režimu neumí a postgres.js by na tom padal.
 *
 * Runtime patří na TRANSACTION pooler (:6543). Migrace jsou jiný případ -
 * potřebují session semantiku kvůli advisory zámku - a mají proto vlastní
 * spojení, viz scripts/migrate.mjs a MIGRATION_DATABASE_URL.
 */

type Sql = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as { __vexySql?: Sql };

/**
 * Kolik spojení smí jedna instance držet.
 *
 * Výchozí 1, protože tohle běží serverless. `DB_POOL_MAX` je únikový
 * východ pro nasazení na dlouhoběžící server (jeden proces, žádné
 * násobení instancemi) - na Vercelu se nenastavuje.
 */
export function poolSizeFor(raw: string | undefined): number {
  const override = Number(raw);
  return Number.isFinite(override) && override > 0 ? override : 1;
}

function poolSize(): number {
  return poolSizeFor(process.env.DB_POOL_MAX);
}

function createClient(): Sql {
  const url = env.databaseUrl;
  return postgres(url, {
    max: poolSize(),
    idle_timeout: 20,
    // Pět sekund, ne patnáct. Na navázání spojení přes pooler to bohatě
    // stačí a je to doba, po kterou se dá u formuláře čekat. Patnáct
    // znamenalo, že se nedostupná databáze projevila až dávno poté, co
    // to člověk vzdal.
    connect_timeout: 5,
    // Nikdy prepared statements. Přes transaction pooler nefungují a přes
    // přímé spojení je nepotřebujeme natolik, aby stálo za to mít dvě
    // různá chování podle tvaru adresy - to je přesně ten druh rozdílu,
    // který se projeví až na produkci.
    prepare: false,
    // TLS se vyžaduje, ne jen preferuje. `prefer` znamená „zkus TLS,
    // a když nepůjde, jeď nešifrovaně" - to je pro produkční databázi
    // špatná výchozí volba. Na `?sslmode=require` v adrese se navíc
    // spoléhat nejde: postgres.js dává přednost options objektu před
    // parametry z URL, takže by ho tenhle řádek přebil.
    ssl: url.includes("sslmode=disable") ? false : "require",
    onnotice: () => {},
  });
}

/**
 * Cachuje se VŽDY, produkci nevyjímaje.
 *
 * Dřív to bylo jen mimo produkci, což je přesně naruby: na produkci může
 * být modul v jednom procesu instanciovaný víckrát (jiný bundle pro
 * stránku, pro route handler, pro server action) a každá kopie by si
 * otevřela vlastní pool. Sdílení přes globalThis tomu brání.
 */
export const sql: Sql = globalForDb.__vexySql ?? createClient();
globalForDb.__vexySql = sql;

/** Postgres unique-violation SQLSTATE. */
export const UNIQUE_VIOLATION = "23505";
/** Raised by the suppression-list trigger. */
export const CHECK_VIOLATION = "23514";

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;
}

export function isSuppressionViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; message?: string };
  return err.code === CHECK_VIOLATION && Boolean(err.message?.includes("suppression list"));
}
