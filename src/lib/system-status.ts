import { sql } from "./db";
import { MIGRATIONS, REQUIRED, findMissing, type SchemaGap } from "./schema-contract.mjs";
import { missingTwilioEnv } from "./telephony/twilio";

/**
 * Stav systému: jedna odpověď na otázku „je tohle nasazení použitelné?".
 *
 * Vzniklo z opakovaného scénáře, kdy na produkci chyběla migrace a jediné,
 * co o tom aplikace řekla, bylo „Application error … Digest: …". Odtud se
 * nedalo poznat nic; člověk musel otevřít terminál, nastavit DATABASE_URL
 * a pustit skript, aby se dozvěděl jedinou větu.
 *
 * Dvě pravidla, na kterých tenhle modul stojí:
 *
 *   1. NIKDY nevrací tajné hodnoty. Ani connection string, ani heslo, ani
 *      kus tokenu. Jen názvy proměnných, které chybí - ty tajné nejsou.
 *   2. Rozlišuje „nakonfigurováno" od „ověřeno naživo". Že existují
 *      proměnné pro Twilio neznamená, že projde hovor. Tvrdit „funguje"
 *      na základě přítomnosti env proměnné je horší než neříct nic.
 *
 * Nic nemění. Je to čtení, ne oprava.
 *
 * Tenhle modul je SERVER-ONLY - importuje `@/lib/db` a čte proměnné
 * prostředí. Do klientské komponenty nesmí.
 */

// ------------------------------------------------------------------ typy

/**
 * Jak si subsystém stojí.
 *
 *   ok           - funguje, a víme to.
 *   configured   - nastavené je všechno, ale naživo to nikdo neověřil.
 *   missing      - chybí konfigurace. Funkce je nedostupná, ne rozbitá.
 *   attention    - nastavené to je, ale něco nesedí. Tohle chce zásah.
 *   unknown      - nešlo zjistit.
 */
export type StatusLevel = "ok" | "configured" | "missing" | "attention" | "unknown";

export interface SubsystemStatus {
  key: string;
  label: string;
  level: StatusLevel;
  /** Jedna věta pro člověka. Nikdy neobsahuje tajnou hodnotu. */
  summary: string;
  /** Co s tím. Prázdné, když není co dělat. */
  action?: string;
  /** Názvy chybějících proměnných. Názvy, NE hodnoty. */
  missingEnv?: string[];
  /** Podrobnosti do rozbalovacího seznamu. Taky bez tajných hodnot. */
  details?: string[];
}

export interface SystemStatus {
  subsystems: SubsystemStatus[];
  /** Je databáze na schématu, které tahle verze aplikace potřebuje? */
  schemaReady: boolean;
  /** Je aplikace celkově připravená obsluhovat provoz? */
  ready: boolean;
  checkedAt: Date;
}

// -------------------------------------------------------------- databáze

export interface SchemaState {
  reachable: boolean;
  /** Proč se nepřipojilo. Už pročištěné - bez hesla a hostu. */
  error?: string;
  appliedCount: number;
  expectedCount: number;
  missingMigrations: string[];
  gaps: SchemaGap[];
}

/**
 * Chyba z databáze očištěná o cokoli citlivého.
 *
 * postgres.js do zprávy běžně dává host, port i uživatele, a při chybné
 * adrese může vzniknout i celý connection string. Do prohlížeče nesmí nic
 * z toho, takže se chyba překládá na známé případy a jinak se zahodí.
 */
export function safeDbError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  switch (code) {
    case "28P01":
    case "28000":
      return "Databáze odmítla přihlašovací údaje.";
    case "3D000":
      return "Databáze s tímto jménem neexistuje.";
    case "ECONNREFUSED":
      return "Databáze odmítla spojení — neběží, nebo je jinde.";
    case "ETIMEDOUT":
    case "CONNECT_TIMEOUT":
      return "Databáze neodpověděla včas.";
    case "ENOTFOUND":
      return "Adresa databáze se nepodařila přeložit.";
    case "42P01":
      return "V databázi chybí tabulka, kterou aplikace čte.";
    default:
      return "K databázi se nepodařilo připojit.";
  }
}

/** Stav schématu proti kontraktu téhle verze aplikace. */
export async function readSchemaState(): Promise<SchemaState> {
  const empty = {
    appliedCount: 0,
    expectedCount: MIGRATIONS.length,
    missingMigrations: [...MIGRATIONS],
    gaps: [] as SchemaGap[],
  };

  try {
    await sql`select 1`;
  } catch (error) {
    return { reachable: false, error: safeDbError(error), ...empty };
  }

  try {
    const [table] = await sql<{ name: string | null }[]>`
      select to_regclass('public.schema_migrations') as name`;
    const applied = table?.name
      ? new Set(
          (await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name),
        )
      : new Set<string>();

    // Sloupce se kontrolují zvlášť od migrací, protože se to může rozejít:
    // zápis v schema_migrations negarantuje, že migrace doběhla celá.
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'public'`;
    const present = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!present.has(row.table_name)) present.set(row.table_name, new Set());
      present.get(row.table_name)!.add(row.column_name);
    }

    const missingMigrations = MIGRATIONS.filter((file) => !applied.has(file));
    return {
      reachable: true,
      appliedCount: MIGRATIONS.length - missingMigrations.length,
      expectedCount: MIGRATIONS.length,
      missingMigrations,
      gaps: findMissing(present, REQUIRED),
    };
  } catch (error) {
    return { reachable: true, error: safeDbError(error), ...empty };
  }
}

/** Je schéma na úrovni, kterou tahle verze aplikace potřebuje? */
export function schemaIsReady(state: SchemaState): boolean {
  return state.reachable && state.missingMigrations.length === 0 && state.gaps.length === 0;
}

// -------------------------------------------------------------- schránky

interface MailboxSummary {
  total: number;
  enabled: number;
  smtpTested: number;
  imapConfigured: number;
}

async function readMailboxes(): Promise<MailboxSummary | null> {
  try {
    const [row] = await sql<MailboxSummary[]>`
      select count(*)::int as total,
             count(*) filter (where enabled)::int as enabled,
             count(*) filter (where last_test_ok)::int as "smtpTested",
             count(*) filter (where imap_host is not null and btrim(imap_host) <> '')::int
               as "imapConfigured"
        from mailboxes`;
    return row ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- celkový stav

/** Jak se runtime režim pojmenuje na obrazovce. Bez hostitele a hesla. */
const CONNECTION_LABEL: Record<ConnectionMode, string> = {
  transaction: "Přes transaction pooler (port 6543) — pro serverless správně.",
  session: "Přes session pooler (port 5432) — pro serverless nevhodné.",
  direct: "Přímé spojení k Postgresu.",
  unset: "Adresa databáze není nastavená.",
};

/** Názvy proměnných, bez kterých se aplikace vůbec nerozběhne. */
export const CORE_ENV_VARS = ["DATABASE_URL", "ENCRYPTION_KEY", "SESSION_SECRET", "CRON_SECRET"] as const;

/** Které z nezbytných proměnných chybí. Vrací NÁZVY, ne hodnoty. */
export function missingCoreEnv(): string[] {
  return CORE_ENV_VARS.filter((name) => !process.env[name]?.trim());
}

/** Veřejná adresa, na kterou chodí webhooky a odkazy na odhlášení. */
function publicUrlStatus(): SubsystemStatus {
  const explicit = process.env.APP_URL?.trim();
  const inferred = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (explicit) {
    return {
      key: "url",
      label: "Veřejná adresa",
      level: "configured",
      summary: `Nastavená přes APP_URL na ${explicit}.`,
      details: ["Odkazy na odhlášení a Twilio webhooky míří sem."],
    };
  }
  if (inferred) {
    return {
      key: "url",
      label: "Veřejná adresa",
      level: "attention",
      summary: "APP_URL není nastavená, používá se adresa z Vercelu.",
      action:
        "Nastavte APP_URL na produkční doménu. Bez ní by preview nasazení " +
        "generovalo odkazy na odhlášení mířící samo na sebe.",
      missingEnv: ["APP_URL"],
    };
  }
  return {
    key: "url",
    label: "Veřejná adresa",
    level: "missing",
    summary: "Není známá veřejná adresa aplikace.",
    action: "Nastavte APP_URL. Bez ní nejdou generovat odkazy na odhlášení.",
    missingEnv: ["APP_URL"],
  };
}

/**
 * Posbírá stav všech subsystémů.
 *
 * Každý se hodnotí SÁM ZA SEBE: chybějící Twilio nesmí vypadat jako
 * problém s e-mailem. Kdo co potřebuje, je vidět na první pohled.
 */
export async function getSystemStatus(): Promise<SystemStatus> {
  const [schema, mailboxes] = await Promise.all([readSchemaState(), readMailboxes()]);
  const subsystems: SubsystemStatus[] = [];
  const mode = connectionMode();
  const override = Number(process.env.DB_POOL_MAX);
  const poolMax = Number.isFinite(override) && override > 0 ? override : 1;

  // ---- databáze -----------------------------------------------------
  //
  // Dvě různé otázky, které se na produkci rozešly: jestli runtime vůbec
  // otevře spojení, a jestli je schéma na správné úrovni. Migrace hlásily
  // 15/15 a přesto padala každá stránka. Proto to jsou dva řádky, ne jeden.
  const missingCore = missingCoreEnv();
  if (!schema.reachable) {
    subsystems.push({
      key: "database",
      label: "Databáze (runtime)",
      level: "attention",
      summary: schema.error ?? "K databázi se nepodařilo připojit.",
      action: missingCore.includes("DATABASE_URL")
        ? "Chybí proměnná DATABASE_URL."
        : "Zkontrolujte DATABASE_URL v nastavení hostingu. Na Vercelu sem patří " +
          "Supabase TRANSACTION pooler (port 6543) a adresa musí obsahovat " +
          "?sslmode=require.",
      missingEnv: missingCore.length > 0 ? missingCore : undefined,
      details: [CONNECTION_LABEL[mode], `Nejvýš ${poolMax} spojení na instanci.`],
    });
  } else if (mode === "session") {
    // Session pooler má strop 15 klientů a serverless ho vyčerpá. Tohle
    // je přesně ta konfigurace, na které produkce spadla na
    // EMAXCONNSESSION - takže se nesmí tvářit jako „v pořádku".
    subsystems.push({
      key: "database",
      label: "Databáze (runtime)",
      level: "attention",
      summary: "Připojení funguje, ale vede přes SESSION pooler (port 5432).",
      action:
        "Přepněte DATABASE_URL na TRANSACTION pooler (port 6543). Session režim " +
        "drží spojení po celou dobu sezení a při víc souběžných instancích " +
        "narazí na strop (EMAXCONNSESSION).",
      details: [CONNECTION_LABEL[mode], `Nejvýš ${poolMax} spojení na instanci.`],
    });
  } else {
    subsystems.push({
      key: "database",
      label: "Databáze (runtime)",
      level: missingCore.length > 0 ? "attention" : "ok",
      summary: "Připojení funguje.",
      missingEnv: missingCore.length > 0 ? missingCore : undefined,
      action: missingCore.length > 0 ? `Chybí proměnné: ${missingCore.join(", ")}.` : undefined,
      details: [CONNECTION_LABEL[mode], `Nejvýš ${poolMax} spojení na instanci.`],
    });
  }

  // ---- migrace ------------------------------------------------------
  if (!schema.reachable) {
    subsystems.push({
      key: "migrations",
      label: "Migrace (schéma)",
      level: "unknown",
      summary: "Nešlo zjistit — databáze neodpovídá.",
    });
  } else if (schemaIsReady(schema)) {
    subsystems.push({
      key: "migrations",
      label: "Migrace (schéma)",
      level: "ok",
      summary: `Aktuální — všech ${schema.expectedCount} je aplikovaných.`,
    });
  } else {
    // Chybějící migrace jsou už ve shrnutí; v podrobnostech by se jen
    // zopakovaly. Sem patří jen to, co je navíc: konkrétní sloupce.
    const details = [
      ...schema.gaps.map((gap) =>
        gap.missingTable
          ? `Chybí tabulka ${gap.table} (${gap.since} · ${gap.feature})`
          : `Chybí ${gap.table}.${gap.columns.join(", ")} (${gap.since} · ${gap.feature})`,
      ),
    ];
    subsystems.push({
      key: "migrations",
      label: "Migrace (schéma)",
      level: "attention",
      summary:
        schema.missingMigrations.length > 0
          ? `Databáze není připravená pro tuhle verzi aplikace. Chybí migrace: ${schema.missingMigrations.join(", ")}.`
          : "Databáze hlásí migrace jako aplikované, ale chybí sloupce, které aplikace čte.",
      action: "Spusťte nasazení znovu, nebo `npm run db:migrate` proti téhle databázi.",
      details,
    });
  }

  // ---- SMTP ---------------------------------------------------------
  if (!mailboxes) {
    subsystems.push({
      key: "smtp",
      label: "SMTP (odesílání)",
      level: "unknown",
      summary: "Nešlo zjistit — schránky se nepodařilo načíst.",
    });
  } else if (mailboxes.total === 0) {
    subsystems.push({
      key: "smtp",
      label: "SMTP (odesílání)",
      level: "missing",
      summary: "Není nastavená žádná schránka. Nic se neodesílá.",
      action: "Přidejte schránku v Nastavení → Schránky.",
    });
  } else if (mailboxes.enabled === 0) {
    subsystems.push({
      key: "smtp",
      label: "SMTP (odesílání)",
      level: "attention",
      summary: `Schránek je ${mailboxes.total}, ale žádná není zapnutá.`,
      action: "Zapněte aspoň jednu v Nastavení → Schránky.",
    });
  } else {
    // „Otestováno" znamená, že proti serveru proběhlo přihlášení - ne že
    // dorazil e-mail příjemci. To je jiná věc a tady se netvrdí.
    const verified = mailboxes.smtpTested > 0;
    subsystems.push({
      key: "smtp",
      label: "SMTP (odesílání)",
      level: verified ? "ok" : "configured",
      summary: verified
        ? `Zapnutých schránek: ${mailboxes.enabled}, přihlášení ověřené u ${mailboxes.smtpTested}.`
        : `Zapnutých schránek: ${mailboxes.enabled}. Přihlášení zatím u žádné neověřené.`,
      action: verified
        ? undefined
        : "Otestujte schránku tlačítkem v Nastavení → Schránky. Bez toho se neví, jestli údaje platí.",
      details: ["Ověřuje se přihlášení k serveru, ne doručení příjemci."],
    });
  }

  // ---- IMAP ---------------------------------------------------------
  if (!mailboxes) {
    subsystems.push({
      key: "imap",
      label: "IMAP (příjem odpovědí)",
      level: "unknown",
      summary: "Nešlo zjistit — schránky se nepodařilo načíst.",
    });
  } else if (mailboxes.imapConfigured === 0) {
    subsystems.push({
      key: "imap",
      label: "IMAP (příjem odpovědí)",
      level: "missing",
      summary: "Žádná schránka nemá IMAP. Odpovědi se nenačítají.",
      action:
        "Doplňte IMAP u schránky v Nastavení → Schránky. Odesílání funguje i bez toho, " +
        "jen se nedozvíte, že někdo odpověděl.",
    });
  } else {
    subsystems.push({
      key: "imap",
      label: "IMAP (příjem odpovědí)",
      level: "configured",
      summary: `IMAP má nastavených ${mailboxes.imapConfigured} z ${mailboxes.total} schránek.`,
      details: ["Že se pošta opravdu načte, se pozná až podle příchozích odpovědí."],
    });
  }

  // ---- Twilio -------------------------------------------------------
  const missingTwilio = missingTwilioEnv();
  subsystems.push(
    missingTwilio.length === 0
      ? {
          key: "twilio",
          label: "Twilio (volání)",
          level: "configured",
          summary: "Přihlašovací údaje jsou nastavené.",
          details: [
            "Že hovor opravdu projde, se pozná až prvním skutečným hovorem.",
            "Voice Request URL v Twilio musí mířit na /api/calling/voice.",
          ],
        }
      : {
          key: "twilio",
          label: "Twilio (volání)",
          level: "missing",
          summary: "Volání z prohlížeče není nastavené.",
          action:
            "Doplňte proměnné v nastavení hostingu. E-mailová část aplikace " +
            "funguje i bez nich.",
          missingEnv: missingTwilio,
        },
  );

  // ---- veřejná adresa -----------------------------------------------
  subsystems.push(publicUrlStatus());

  const schemaReady = schemaIsReady(schema);
  return {
    subsystems,
    schemaReady,
    // Připravenost = databáze a schéma. Chybějící Twilio nebo IMAP dělá
    // jednu funkci nedostupnou, ale aplikace jako celek funguje.
    ready: schemaReady,
    checkedAt: new Date(),
  };
}

/**
 * Rychlý dotaz do databáze pro health endpoint.
 *
 * Používá SDÍLENÉHO klienta, ne vlastní spojení. Původně si otevíral svoje
 * s tím, že „nemá zdržovat pool uživatelů" - jenže v serverless je to přesně
 * naopak: každý probe by byl další klient navíc a readiness se volá často.
 * Tím se strop poolu nešetří, tím se vyčerpává.
 *
 * Sdílený klient má max 1 spojení, takže tenhle `select 1` se nejhůř zařadí
 * za probíhající dotaz.
 */
export async function pingDatabase(): Promise<{ ok: boolean; error?: string }> {
  if (!process.env.DATABASE_URL?.trim()) {
    return { ok: false, error: "Chybí proměnná DATABASE_URL." };
  }
  try {
    await sql`select 1`;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: safeDbError(error) };
  }
}

// ------------------------------------------------- tvar runtime spojení

/**
 * Jak je runtime připojený. Žádný host, žádné heslo - jen režim.
 *
 *   transaction - Supabase transaction pooler (:6543). Tohle sem patří.
 *   session     - session pooler (:5432). Strop 15 klientů, na serverless
 *                 se vyčerpá a skončí to EMAXCONNSESSION.
 *   direct      - přímé spojení k Postgresu.
 *   unset       - proměnná chybí.
 */
export type ConnectionMode = "transaction" | "session" | "direct" | "unset";

/**
 * Určí režim z adresy. Vrací JEN výčtovou hodnotu, nikdy kus adresy -
 * tenhle údaj se zobrazuje v prohlížeči.
 *
 * Port je to jediné, co Supabase pooler odlišuje: 6543 je transaction,
 * 5432 session. Jméno hostitele je u obou stejné.
 */
export function connectionMode(url: string | undefined = process.env.DATABASE_URL): ConnectionMode {
  const trimmed = url?.trim();
  if (!trimmed) return "unset";
  const pooler = trimmed.includes("pooler.supabase.com");
  if (trimmed.includes(":6543")) return "transaction";
  if (pooler) return "session";
  return "direct";
}

/**
 * Stav runtime spojení, oddělený od stavu schématu.
 *
 * Jsou to dvě různé otázky a na produkci se rozešly: migrace byly v pořádku
 * (15/15, žádné chybějící sloupce) a přesto každá stránka padala, protože
 * runtime nemohl otevřít spojení. Proto to health endpoint i Stav systému
 * hlásí zvlášť.
 */
export interface RuntimeConnection {
  ok: boolean;
  mode: ConnectionMode;
  /** Kolik spojení smí jedna instance držet. */
  poolMax: number;
  error?: string;
}

export async function readRuntimeConnection(): Promise<RuntimeConnection> {
  const mode = connectionMode();
  const override = Number(process.env.DB_POOL_MAX);
  const poolMax = Number.isFinite(override) && override > 0 ? override : 1;
  const ping = await pingDatabase();
  return { ok: ping.ok, mode, poolMax, error: ping.error };
}
