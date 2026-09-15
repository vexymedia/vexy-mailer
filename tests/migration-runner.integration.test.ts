import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TEST_DATABASE_URL, closeDatabase, configureTestEnv } from "./helpers/db";
import { MIGRATIONS } from "@/lib/schema-contract.mjs";

const run = promisify(execFile);

/**
 * Migrační runner a release krok.
 *
 * Tohle je jediné místo, které na produkci mění schéma, takže se testuje
 * jako skutečný proces - spuštěný přesně tak, jak ho spustí nasazení.
 * Volat vnitřní funkci by minulo právě to, co se může pokazit: návratový
 * kód, hlášku a chování bez proměnných prostředí.
 *
 * Každý test si staví vlastní databázi, aby si běhy nešlapaly po sobě.
 */

configureTestEnv();
const BASE = TEST_DATABASE_URL.slice(0, TEST_DATABASE_URL.lastIndexOf("/"));
const SUFFIX = TEST_DATABASE_URL.includes("?")
  ? TEST_DATABASE_URL.slice(TEST_DATABASE_URL.indexOf("?"))
  : "";

/** Všechny databáze, které si testy vyrobily. Uklízí se na konci. */
const scratch: string[] = [];
function urlFor(name: string) {
  return `${BASE}/${name}${SUFFIX}`;
}

/** Spustí skript jako proces. Nikdy nehází - návratový kód je výsledek. */
async function script(
  file: string,
  { url, env = {}, args = [] }: { url?: string; env?: Record<string, string>; args?: string[] } = {},
) {
  try {
    const { stdout, stderr } = await run("node", [`scripts/${file}`, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // Skripty čtou .env.local; prázdný řetězec dotenv nepřepíše, takže
        // se tím dá otestovat i chování bez proměnné.
        //
        // Migrace jedou po MIGRATION_DATABASE_URL. DATABASE_URL se tu
        // nastavuje na zjevný nesmysl: kdyby ho runner omylem použil,
        // test spadne místo toho, aby tiše prošel.
        MIGRATION_DATABASE_URL: url ?? "",
        DATABASE_URL: url ? "postgres://nikdo:nic@127.0.0.1:1/nic" : "",
        ...env,
      },
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

async function admin() {
  const postgres = (await import("postgres")).default;
  return postgres(urlFor("postgres"), { max: 1, prepare: false, onnotice: () => {} });
}

async function freshDatabase(): Promise<string> {
  const name = `vexy_rel_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const sql = await admin();
  try {
    await sql.unsafe(`drop database if exists ${name}`);
    await sql.unsafe(`create database ${name}`);
  } finally {
    await sql.end();
  }
  scratch.push(name);
  return urlFor(name);
}

async function query<T>(url: string, text: string): Promise<T[]> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    return (await sql.unsafe(text)) as unknown as T[];
  } finally {
    await sql.end();
  }
}

afterAll(async () => {
  await closeDatabase();
  if (scratch.length === 0) return;
  const sql = await admin();
  try {
    for (const name of scratch) {
      // Uklízení nesmí shodit výsledek testů.
      await sql.unsafe(`drop database if exists ${name}`).catch(() => {});
    }
  } finally {
    await sql.end();
  }
});

// ============================================================ čistá databáze

describe("čistá databáze", () => {
  it("se zmigruje celá a ve správném pořadí", async () => {
    const url = await freshDatabase();
    const result = await script("migrate.mjs", { url });
    expect(result.code).toBe(0);

    const rows = await query<{ name: string }>(
      url,
      "select name from schema_migrations order by applied_at, name",
    );
    expect(rows.map((r) => r.name)).toEqual([...MIGRATIONS]);
  });

  it("po migraci projde kontrola schématu", async () => {
    const url = await freshDatabase();
    await script("migrate.mjs", { url });
    const check = await script("release.mjs", { url, args: ["--check"] });
    expect(check.code).toBe(0);
    expect(check.out).toContain("schéma odpovídá aplikaci");
  });
});

// ======================================================== opakovaný běh

describe("idempotence", () => {
  it("druhý běh nic nemění", async () => {
    const url = await freshDatabase();
    await script("migrate.mjs", { url });
    const before = await query<{ name: string; applied_at: Date }>(
      url, "select name, applied_at from schema_migrations order by name");

    const second = await script("migrate.mjs", { url });
    expect(second.code).toBe(0);
    expect(second.out).toContain("aktuální");

    const after = await query<{ name: string; applied_at: Date }>(
      url, "select name, applied_at from schema_migrations order by name");
    // Ani jeden řádek se nepřepsal - tedy se nic znovu nepustilo.
    expect(after.map((r) => r.applied_at.getTime())).toEqual(
      before.map((r) => r.applied_at.getTime()),
    );
  });

  it("release na aktuální databázi taky nic nemění", async () => {
    const url = await freshDatabase();
    await script("migrate.mjs", { url });
    const result = await script("release.mjs", { url });
    expect(result.code).toBe(0);
    expect(result.out).toContain("byla aktuální");
  });
});

// ==================================================== databáze pozadu

describe("databáze pozadu za aplikací", () => {
  const last = MIGRATIONS[MIGRATIONS.length - 1];

  it("chybějící migrace se pozná a pojmenuje", async () => {
    const url = await freshDatabase();
    await script("migrate.mjs", { url });
    await query(url, `delete from schema_migrations where name = '${last}'`);

    const check = await script("release.mjs", { url, args: ["--check"] });
    expect(check.code).toBe(1);
    expect(check.out).toContain(last);
  });

  it("release ji dorovná a skončí úspěchem", async () => {
    const url = await freshDatabase();
    await script("migrate.mjs", { url });
    await query(url, `delete from schema_migrations where name = '${last}'`);
    await query(url, "alter table companies drop column ico");

    const release = await script("release.mjs", { url });
    expect(release.code).toBe(0);
    expect(release.out).toContain("schéma odpovídá aplikaci");

    const [row] = await query<{ count: string }>(
      url,
      "select count(*) from information_schema.columns where table_name='companies' and column_name='ico'",
    );
    expect(Number(row.count)).toBe(1);
  });

  it("chybějící sloupec při zapsané migraci se pozná taky", async () => {
    const url = await freshDatabase();
    await script("migrate.mjs", { url });
    // Migrace zapsaná zůstane; sloupec zmizí. Přesně stav, na který
    // kontrola jen podle schema_migrations nestačí.
    await query(url, "alter table replies drop column needs_review");

    const check = await script("release.mjs", { url, args: ["--check"] });
    expect(check.code).toBe(1);
    expect(check.out).toContain("replies.needs_review");
  });
});

// ============================================== bezpečné selhání

describe("selhává bezpečně a srozumitelně", () => {
  it("špatné přihlašovací údaje: jasná hláška, žádný stack trace", async () => {
    const result = await script("release.mjs", {
      url: `${BASE.replace("//postgres:", "//postgres:rozhodne-spatne-heslo-")}/postgres${SUFFIX}`,
    });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/přihlašovací údaje|nepodařilo připojit/);
    expect(result.out).not.toContain("at Object.");
    expect(result.out).not.toContain("node_modules");
  });

  it("hláška o chybě neobsahuje heslo z connection stringu", async () => {
    const result = await script("release.mjs", {
      url: `${BASE.replace("//postgres:", "//postgres:UPLNE-TAJNE-HESLO-")}/postgres${SUFFIX}`,
    });
    expect(result.out).not.toContain("UPLNE-TAJNE-HESLO");
    expect(result.out).not.toContain("postgres://");
  });

  it("neexistující databáze skončí srozumitelně", async () => {
    const result = await script("release.mjs", { url: urlFor("vexy_neexistuje_xyz") });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/neexistuje|nepodařilo připojit/);
  });

  it("bez DATABASE_URL se přeskočí, ale nespadne — lokální build musí projít", async () => {
    const result = await script("release.mjs");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Přeskočeno");
  });

  it("preview nasazení NESMÍ migrovat produkční databázi", async () => {
    const url = await freshDatabase();
    const result = await script("release.mjs", { url, env: { VERCEL_ENV: "preview" } });
    expect(result.code).toBe(0);
    expect(result.out).toContain("preview");

    // Nejlepší důkaz: nevznikla ani tabulka se záznamem migrací.
    const [row] = await query<{ name: string | null }>(
      url, "select to_regclass('public.schema_migrations') as name");
    expect(row.name).toBeNull();
  });

  it("produkční nasazení migruje", async () => {
    const url = await freshDatabase();
    const result = await script("release.mjs", { url, env: { VERCEL_ENV: "production" } });
    expect(result.code).toBe(0);
    const rows = await query<{ name: string }>(url, "select name from schema_migrations");
    expect(rows).toHaveLength(MIGRATIONS.length);
  });

  it("release:check nikdy nemigruje, ani na produkci", async () => {
    const url = await freshDatabase();
    const result = await script("release.mjs", {
      url, env: { VERCEL_ENV: "production" }, args: ["--check"],
    });
    expect(result.code).toBe(1); // schéma neodpovídá — a to je správně
    const [row] = await query<{ name: string | null }>(
      url, "select to_regclass('public.schema_migrations') as name");
    expect(row.name).toBeNull();
  });
});

// ============================== oddělené spojení pro migrace a runtime

describe("migrace jezdí po vlastní adrese", () => {
  it("použije MIGRATION_DATABASE_URL, i když DATABASE_URL ukazuje jinam", async () => {
    // Pomocník `script` schválně nastavuje DATABASE_URL na neplatnou
    // adresu. Když migrace projde, znamená to, že runner sáhl po té
    // správné proměnné.
    const url = await freshDatabase();
    const result = await script("migrate.mjs", { url });
    expect(result.code).toBe(0);
    const rows = await query<{ name: string }>(url, "select name from schema_migrations");
    expect(rows).toHaveLength(MIGRATIONS.length);
  });

  it("odmítne migrovat přes transaction pooler", async () => {
    // Advisory zámek je vázaný na sezení; v transakčním režimu by nedržel
    // a dvě souběžná nasazení by o sobě nevěděla. Radši hlasité selhání.
    const result = await script("release.mjs", {
      url: "postgres://uzivatel:heslo@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain("transaction pooler");
    expect(result.out).toContain("MIGRATION_DATABASE_URL");
    // Ani v téhle hlášce nesmí být heslo z adresy.
    expect(result.out).not.toContain("heslo");
  });

  it("session pooler projde", async () => {
    const { migrationUrlProblem } = await import("../scripts/migrate.mjs");
    expect(
      migrationUrlProblem("postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"),
    ).toBeNull();
  });

  it("bez obou proměnných se přeskočí, ale nespadne", async () => {
    const result = await script("release.mjs");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Přeskočeno");
  });
});

// ============================================ advisory zámek doopravdy

describe("advisory zámek drží po celý běh", () => {
  it("cizí spojení zámek během migrace nezíská a po doběhnutí ano", async () => {
    // Tohle je jediné, co brání dvěma souběžným nasazením migrovat naráz,
    // takže se to testuje proti skutečnému Postgresu, ne z úvahy o kódu.
    const url = await freshDatabase();
    const postgres = (await import("postgres")).default;
    const { connect, applyMigrations } = await import("../scripts/migrate.mjs");

    const runner = connect(url);
    const other = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    let grabbedDuringRun: boolean | null = null;

    try {
      await applyMigrations(runner, {
        onProgress: async ({ status }) => {
          if (status !== "applying" || grabbedDuringRun !== null) return;
          const [row] = await other<{ got: boolean }[]>`
            select pg_try_advisory_lock(4120250915) as got`;
          grabbedDuringRun = row.got;
          if (row.got) await other`select pg_advisory_unlock(4120250915)`;
        },
      });

      expect(grabbedDuringRun, "zámek byl během běhu volný").toBe(false);

      const [after] = await other<{ got: boolean }[]>`
        select pg_try_advisory_lock(4120250915) as got`;
      expect(after.got, "zámek zůstal viset i po doběhnutí").toBe(true);
      await other`select pg_advisory_unlock(4120250915)`;
    } finally {
      await runner.end();
      await other.end();
    }
  });

  it("zámek se uvolní i když migrace selže", async () => {
    const url = await freshDatabase();
    const postgres = (await import("postgres")).default;
    const { connect, applyMigrations } = await import("../scripts/migrate.mjs");
    const runner = connect(url);
    const other = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

    try {
      // Selhání uprostřed: onProgress vyhodí výjimku.
      await expect(
        applyMigrations(runner, {
          onProgress: ({ status }) => {
            if (status === "applying") throw new Error("schválně");
          },
        }),
      ).rejects.toThrow("schválně");

      const [row] = await other<{ got: boolean }[]>`
        select pg_try_advisory_lock(4120250915) as got`;
      expect(row.got, "zámek zůstal viset po chybě").toBe(true);
      await other`select pg_advisory_unlock(4120250915)`;
    } finally {
      await runner.end();
      await other.end();
    }
  });
});
