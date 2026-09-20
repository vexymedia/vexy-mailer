import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "./helpers/db";

/**
 * Jak je runtime připojený k databázi.
 *
 * Vzniklo z produkčního výpadku. DATABASE_URL mířila na Supabase pooler
 * v SESSION režimu (port 5432, strop 15 klientů) a klient měl `max: 5`.
 * Na Vercelu běží vedle sebe víc instancí funkce, takže se pool nenásobí
 * jednou - násobí se počtem instancí. Výsledek:
 *
 *     PostgresError (EMAXCONNSESSION) max clients reached in session mode
 *
 * Health endpoint přitom hlásil database: ok a migrace 15/15, protože
 * jedno spojení otevřít šlo. Rozbilo se to až pod souběhem.
 *
 * Tenhle soubor hlídá konfiguraci, ne chování při zátěži: že runtime drží
 * jedno spojení, nepoužívá prepared statements, nezakládá nové klienty po
 * requestech, a že migrace jedou po vlastní adrese.
 */

let db: typeof import("@/lib/db");
let status: typeof import("@/lib/system-status");

beforeEach(async () => {
  await resetDatabase();
  db = await import("@/lib/db");
  status = await import("@/lib/system-status");
});

afterAll(async () => {
  await closeDatabase();
});

/** Nastavení, se kterým postgres.js klienta opravdu vytvořil. */
function options(sql: unknown) {
  return (sql as { options: { max: number; prepare: boolean } }).options;
}

// ========================================== runtime klient je serverless

describe("runtime klient", () => {
  it("pool je omezený, ale ne na jedno spojení", () => {
    // Obě krajnosti už produkci položily, každá jinak.
    //
    // Nahoře: `max: 5` krát deset souběžných instancí je padesát klientů
    // proti stropu 15 session pooleru → EMAXCONNSESSION.
    //
    // Dole: `max: 1` znamená, že se na jedné Vercel instanci seřadí za
    // jedno spojení všechny souběžné requesty. Přihlášení pak spadlo na
    // svůj strop s „fáze=čekání-na-spojení" a stránky visely do 300 s,
    // přestože databáze byla v pořádku.
    const max = options(db.sql).max;
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(10);
  });

  it("nepoužívá prepared statements", () => {
    // Transaction pooler rozděluje spojení po transakcích, takže prepared
    // statement může skončit na jiném fyzickém spojení, než kde vznikl.
    expect(options(db.sql).prepare).toBe(false);
  });

  it("je to pořád tentýž klient, ne nový po každém importu", async () => {
    const again = await import("@/lib/db");
    expect(again.sql).toBe(db.sql);
  });

  it("sdílí se přes globalThis i v produkčním režimu", () => {
    // Dřív se na globalThis ukládal jen mimo produkci, což je naruby:
    // právě na produkci může být modul v jednom procesu instanciovaný
    // víckrát (jiný bundle pro stránku, pro route handler) a každá kopie
    // by si otevřela vlastní pool.
    const cached = (globalThis as unknown as { __vexySql?: unknown }).__vexySql;
    expect(cached).toBe(db.sql);
  });

  const TRANSACTION = "postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";
  const SESSION = "postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres";

  it("DB_POOL_MAX přebije výchozí hodnotu, nesmysly se ignorují", async () => {
    const { poolSizeFor } = await import("@/lib/db");
    expect(poolSizeFor("10", TRANSACTION)).toBe(10);
    expect(poolSizeFor("3", SESSION)).toBe(3);
    for (const junk of ["", "nesmysl", "0", "-3", undefined]) {
      expect(poolSizeFor(junk, SESSION)).toBe(1);
    }
  });

  it("session pooler zůstává na jednom spojení", async () => {
    // Port 5432 má strop 15 klientů na projekt (EMAXCONNSESSION). Tam
    // víc spojení na instanci znamená vyčerpat ho o to dřív.
    const { poolSizeFor } = await import("@/lib/db");
    expect(poolSizeFor(undefined, SESSION)).toBe(1);
  });

  it("transaction pooler musí unést víc než jedno spojení", async () => {
    // Tohle je ta regrese, která stála tři dny. S `max: 1` se na jedné
    // Vercel instanci seřadí za jedno spojení všechny souběžné requesty
    // a přihlášení spadne na svůj strop s „fáze=čekání-na-spojení",
    // přestože databáze je v pořádku.
    const { poolSizeFor } = await import("@/lib/db");
    expect(poolSizeFor(undefined, TRANSACTION)).toBeGreaterThan(1);
    // Přímé spojení (bez pooleru) taky není omezené stropem session módu.
    expect(poolSizeFor(undefined, "postgres://u:p@db.example.com:5432/postgres")).toBeGreaterThan(1);
  });
});

// ================================== nikde nevzniká další pool za běhu

describe("žádné další pooly v runtime kódu", () => {
  /** Všechny .ts/.tsx soubory aplikace. */
  function appFiles(dir = "src"): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...appFiles(full));
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("jediné místo, kde se volá postgres(), je lib/db.ts", () => {
    // Každé další volání by za běhu založilo vlastní pool. Přesně tak se
    // strop vyčerpá, aniž by to bylo z jednoho souboru vidět.
    const callers = appFiles().filter((file) =>
      /(^|[^\w.])postgres\s*\(/.test(readFileSync(file, "utf8")),
    );
    expect(callers).toEqual(["src/lib/db.ts"]);
  });

  it("health endpoint nezakládá spojení navíc", async () => {
    // Readiness probe běží často. Kdyby si otevíral vlastního klienta,
    // strop poolu by nešetřil, ale vyčerpával.
    const source = readFileSync("src/lib/system-status.ts", "utf8");
    expect(source).not.toMatch(/(^|[^\w.])postgres\s*\(/);
    expect(await status.pingDatabase()).toEqual({ ok: true });
  });

  it("opakovaný ping nepřidává spojení", async () => {
    // Podstatné je, že strop poolu je za běhu pořád týž - ne jaké má číslo.
    const before = options(db.sql).max;
    for (let i = 0; i < 5; i++) expect((await status.pingDatabase()).ok).toBe(true);
    expect(options(db.sql).max).toBe(before);
  });
});

// ============================================== rozpoznání režimu adresy

describe("režim připojení", () => {
  it("port 6543 je transaction pooler", () => {
    expect(status.connectionMode(
      "postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
    )).toBe("transaction");
  });

  it("port 5432 na pooleru je session — právě to produkci položilo", () => {
    expect(status.connectionMode(
      "postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres",
    )).toBe("session");
  });

  it("vlastní Postgres je přímé spojení", () => {
    expect(status.connectionMode("postgres://postgres:x@127.0.0.1:5432/vexy")).toBe("direct");
  });

  it("prázdná adresa je unset", () => {
    expect(status.connectionMode("")).toBe("unset");
    expect(status.connectionMode("  ")).toBe("unset");
  });

  it("bez argumentu se čte z prostředí", () => {
    // Výchozí hodnota parametru; `undefined` sem proto patří stejně jako
    // vynechaný argument a znamená „vezmi DATABASE_URL", ne „nic".
    vi.stubEnv("DATABASE_URL",
      "postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres");
    expect(status.connectionMode()).toBe("transaction");
    vi.unstubAllEnvs();
  });

  it("vrací JEN režim, nikdy kus adresy", () => {
    const url = "postgresql://uzivatel:TAJNE-HESLO@db.example.com:5432/postgres";
    const mode = status.connectionMode(url);
    expect(["transaction", "session", "direct", "unset"]).toContain(mode);
    expect(mode).not.toContain("TAJNE-HESLO");
    expect(mode).not.toContain("db.example.com");
  });
});

// ============================ session pooler se nesmí tvářit jako v pořádku

describe("Stav systému pozná špatný pooler", () => {
  function database(list: Awaited<ReturnType<typeof status.getSystemStatus>>) {
    const item = list.subsystems.find((s) => s.key === "database");
    if (!item) throw new Error("chybí subsystém database");
    return item;
  }

  it("session pooler hlásí jako Vyžaduje pozornost, ne V pořádku", async () => {
    vi.stubEnv("DATABASE_URL",
      "postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres");
    const item = database(await status.getSystemStatus());
    expect(item.level).toBe("attention");
    expect(item.action).toContain("6543");
    vi.unstubAllEnvs();
  });

  it("u transaction pooleru je klid", async () => {
    vi.stubEnv("DATABASE_URL",
      "postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres");
    expect(database(await status.getSystemStatus()).level).toBe("ok");
    vi.unstubAllEnvs();
  });

  it("runtime a schéma jsou dvě oddělené položky", async () => {
    // Na produkci se rozešly: schéma 15/15 v pořádku, a přesto padala
    // každá stránka. Jedna společná položka by to zamlžila.
    const result = await status.getSystemStatus();
    const keys = result.subsystems.map((s) => s.key);
    expect(keys).toContain("database");
    expect(keys).toContain("migrations");
    expect(database(result).label).toContain("runtime");
  });

  it("popis režimu neobsahuje hostitele ani heslo", async () => {
    const secret = process.env.DATABASE_URL ?? "";
    const rendered = JSON.stringify(await status.getSystemStatus());
    if (secret.length >= 8) expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("postgres://");
    expect(rendered).not.toContain("postgresql://");
  });
});

// ================================== secrets se nesmí dostat do prohlížeče

describe("nic serverového v klientském kódu", () => {
  function appFiles(dir = "src"): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...appFiles(full));
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  /** Soubory s "use client" — ty se posílají do prohlížeče. */
  const clientFiles = () =>
    appFiles().filter((file) => /^\s*["']use client["']/m.test(readFileSync(file, "utf8")));

  it("klientské komponenty neimportují databázi ani stav systému", () => {
    // Import by do bundlu vtáhl connection string i celý postgres.js.
    const offenders = clientFiles().filter((file) =>
      /from\s+["'](@\/lib\/db|@\/lib\/system-status|@\/lib\/env|postgres)["']/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("klientské komponenty nečtou process.env", () => {
    // Server může předat hodnotu propem; číst prostředí v prohlížeči
    // znamená, že ji Next musí vypéct do bundlu.
    const offenders = clientFiles().filter((file) =>
      /process\.env\./.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("v postaveném bundlu není žádná tajná hodnota", () => {
    // Běží jen když existuje build. Plnou kontrolu dělá verifikace po
    // `npm run build`; tohle je pojistka, aby se na ni nezapomnělo.
    let files: string[];
    try {
      files = appFiles(".next/static");
    } catch {
      return; // není co kontrolovat
    }
    const blob = files
      .filter((f) => /\.(js|css|map|json)$/.test(f))
      .map((f) => readFileSync(f, "utf8"))
      .join("");

    for (const name of ["DATABASE_URL", "MIGRATION_DATABASE_URL", "ENCRYPTION_KEY",
                        "SESSION_SECRET", "CRON_SECRET", "TWILIO_AUTH_TOKEN"]) {
      const value = process.env[name];
      if (value && value.length >= 8) expect(blob, `${name} je v bundlu`).not.toContain(value);
    }
    expect(blob).not.toMatch(/postgres(ql)?:\/\/[^"'\s]{10,}/);
  });
});
