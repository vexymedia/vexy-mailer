import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { MIGRATIONS, REQUIRED, findMissing } from "@/lib/schema-contract.mjs";

/**
 * Stav systému a připravenost nasazení.
 *
 * Tohle je pojistka proti třídě chyb, která stála nejvíc času: aplikace
 * běží, vypadá funkčně, ale databáze je o migraci pozadu - a jediné, co
 * o tom kdy řekla, bylo "Application error ... Digest: ...".
 *
 * Hlídají se tři věci:
 *   1. Seznam migrací v kódu sedí se soubory na disku. Aplikace za běhu
 *      složku nevidí, takže porovnává proti seznamu - když se rozejde,
 *      přestane chybějící migraci poznat.
 *   2. Chybějící migrace i chybějící sloupec se opravdu poznají.
 *   3. Do prohlížeče se nedostane nic citlivého.
 */

let status: typeof import("@/lib/system-status");
let sql: typeof import("@/lib/db").sql;

beforeEach(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  status = await import("@/lib/system-status");
});

afterAll(async () => {
  await closeDatabase();
});

// ======================================= seznam migrací versus soubory

describe("kontrakt schématu", () => {
  it("seznam migrací sedí přesně se soubory na disku", () => {
    const onDisk = readdirSync(join(process.cwd(), "supabase", "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    // Rovnost oběma směry: přidaná migrace mimo seznam je stejná chyba
    // jako název v seznamu bez souboru.
    expect([...MIGRATIONS]).toEqual(onDisk);
  });

  it("migrace jsou v seznamu seřazené, takže se aplikují v pořadí", () => {
    expect([...MIGRATIONS]).toEqual([...MIGRATIONS].sort());
  });

  it("každý požadovaný sloupec odkazuje na existující migraci", () => {
    const numbers = new Set(MIGRATIONS.map((f) => f.slice(0, 4)));
    for (const need of REQUIRED) expect(numbers.has(need.since)).toBe(true);
  });
});

// ================================================ čerstvá versus pozadu

describe("stav schématu", () => {
  it("čistá databáze po migracích je připravená", async () => {
    const state = await status.readSchemaState();
    expect(state.reachable).toBe(true);
    expect(state.missingMigrations).toEqual([]);
    expect(state.gaps).toEqual([]);
    expect(status.schemaIsReady(state)).toBe(true);
    expect(state.appliedCount).toBe(state.expectedCount);
  });

  it("chybějící migrace se pozná a je pojmenovaná", async () => {
    await sql`delete from schema_migrations where name = ${MIGRATIONS[MIGRATIONS.length - 1]}`;
    const state = await status.readSchemaState();
    expect(state.missingMigrations).toEqual([MIGRATIONS[MIGRATIONS.length - 1]]);
    expect(status.schemaIsReady(state)).toBe(false);
  });

  it("chybějící sloupec se pozná i tehdy, když je migrace zapsaná", async () => {
    // Přesně ten případ, kvůli kterému se sloupce kontrolují zvlášť:
    // zápis v schema_migrations negarantuje, že migrace doběhla celá.
    await sql`alter table companies drop column ico`;
    const state = await status.readSchemaState();
    expect(state.missingMigrations).toEqual([]);
    expect(state.gaps.some((g) => g.table === "companies" && g.columns.includes("ico"))).toBe(true);
    expect(status.schemaIsReady(state)).toBe(false);
  });

  it("chybějící tabulka se pozná taky", async () => {
    await sql`drop table client_company_exclusions`;
    const state = await status.readSchemaState();
    expect(state.gaps.some((g) => g.table === "client_company_exclusions" && g.missingTable)).toBe(true);
  });

  it("findMissing na úplném schématu nic nehlásí", () => {
    const present = new Map<string, Set<string>>();
    for (const need of REQUIRED) {
      if (!present.has(need.table)) present.set(need.table, new Set());
      for (const column of need.columns) present.get(need.table)!.add(column);
    }
    expect(findMissing(present, REQUIRED)).toEqual([]);
  });
});

// ======================================================= žádné secrets

describe("diagnostika nevypisuje tajné hodnoty", () => {
  it("chyba připojení neobsahuje heslo, hosta ani connection string", () => {
    const leaky = Object.assign(
      new Error("connect ECONNREFUSED postgres://postgres:TAJNEHESLO@db.example.com:5432/postgres"),
      { code: "ECONNREFUSED" },
    );
    const message = status.safeDbError(leaky);
    expect(message).not.toContain("TAJNEHESLO");
    expect(message).not.toContain("db.example.com");
    expect(message).not.toContain("postgres://");
    expect(message.length).toBeGreaterThan(0);
  });

  it("neznámá chyba se zahodí, ne přeposílá", () => {
    const leaky = new Error("password authentication failed for user \"postgres:TAJNE\"");
    expect(status.safeDbError(leaky)).not.toContain("TAJNE");
  });

  it("odmítnuté přihlášení se pojmenuje srozumitelně", () => {
    expect(status.safeDbError(Object.assign(new Error("x"), { code: "28P01" })))
      .toContain("odmítla přihlašovací údaje");
  });

  it("celý stav systému neobsahuje hodnotu žádné tajné proměnné", async () => {
    // Skutečné hodnoty, které v prostředí testu jsou. Kdyby některá prosákla
    // do textu pro prohlížeč, chytne se to tady.
    const secrets = [
      process.env.DATABASE_URL,
      process.env.ENCRYPTION_KEY,
      process.env.SESSION_SECRET,
      process.env.CRON_SECRET,
    ].filter((v): v is string => Boolean(v && v.length >= 8));

    const rendered = JSON.stringify(await status.getSystemStatus());
    for (const secret of secrets) expect(rendered).not.toContain(secret);
  });
});

// ============================================== izolace podle subsystému

describe("subsystémy se hodnotí každý sám za sebe", () => {
  function find(list: Awaited<ReturnType<typeof status.getSystemStatus>>, key: string) {
    const item = list.subsystems.find((s) => s.key === key);
    if (!item) throw new Error(`chybí subsystém ${key}`);
    return item;
  }

  it("chybějící Twilio nedělá z aplikace nepřipravenou", async () => {
    for (const name of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SID",
                        "TWILIO_API_KEY_SECRET", "TWILIO_TWIML_APP_SID", "TWILIO_CALLER_ID"]) {
      vi.stubEnv(name, "");
    }
    const result = await status.getSystemStatus();
    expect(find(result, "twilio").level).toBe("missing");
    // E-mail ani databáze tím netrpí a aplikace je připravená.
    expect(result.ready).toBe(true);
    expect(find(result, "database").level).toBe("ok");
    vi.unstubAllEnvs();
  });

  it("nastavené Twilio se hlásí jako nakonfigurované, NE jako funkční", async () => {
    for (const [name, value] of [["TWILIO_ACCOUNT_SID", "AC1"], ["TWILIO_AUTH_TOKEN", "t"],
                                 ["TWILIO_API_KEY_SID", "SK1"], ["TWILIO_API_KEY_SECRET", "s"],
                                 ["TWILIO_TWIML_APP_SID", "AP1"], ["TWILIO_CALLER_ID", "+420111222333"]]) {
      vi.stubEnv(name, value);
    }
    const twilio = find(await status.getSystemStatus(), "twilio");
    // Tohle je celá pointa rozlišení: údaje existují, hovor neproběhl.
    expect(twilio.level).toBe("configured");
    expect(twilio.level).not.toBe("ok");
    expect(twilio.missingEnv ?? []).toEqual([]);
    vi.unstubAllEnvs();
  });

  it("bez schránek je SMTP jen nedostupné, ne rozbité", async () => {
    const result = await status.getSystemStatus();
    expect(find(result, "smtp").level).toBe("missing");
    expect(find(result, "smtp").action).toBeTruthy();
    expect(result.ready).toBe(true);
  });

  it("schránka bez IMAPu nechá SMTP v klidu", async () => {
    await sql`
      insert into mailboxes (name, from_name, from_email, smtp_host, smtp_port,
                             smtp_username, smtp_password_enc, smtp_secure, enabled, last_test_ok)
      values ('S', 'S', 's@example.com', 'smtp.example.com', 465, 's@example.com',
              'x', true, true, true)`;
    const result = await status.getSystemStatus();
    expect(find(result, "smtp").level).toBe("ok");
    expect(find(result, "imap").level).toBe("missing");
    expect(result.ready).toBe(true);
  });

  it("neotestovaná schránka je nakonfigurovaná, ne ověřená", async () => {
    await sql`
      insert into mailboxes (name, from_name, from_email, smtp_host, smtp_port,
                             smtp_username, smtp_password_enc, smtp_secure, enabled, last_test_ok)
      values ('S', 'S', 's@example.com', 'smtp.example.com', 465, 's@example.com',
              'x', true, true, false)`;
    expect(find(await status.getSystemStatus(), "smtp").level).toBe("configured");
  });

  it("chybějící migrace shodí připravenost a řekne která", async () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    await sql`delete from schema_migrations where name = ${last}`;
    const result = await status.getSystemStatus();
    expect(result.ready).toBe(false);
    expect(result.schemaReady).toBe(false);
    const migrations = find(result, "migrations");
    expect(migrations.level).toBe("attention");
    expect(migrations.summary).toContain(last);
  });

  it("chybějící APP_URL se pozná, ale nezastaví aplikaci", async () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    const result = await status.getSystemStatus();
    expect(find(result, "url").level).toBe("missing");
    expect(find(result, "url").missingEnv).toContain("APP_URL");
    expect(result.ready).toBe(true);
    vi.unstubAllEnvs();
  });

  it("každý subsystém má vysvětlení a ty problémové i návod", async () => {
    const result = await status.getSystemStatus();
    for (const item of result.subsystems) {
      expect(item.summary.length).toBeGreaterThan(0);
      if (item.level === "missing" || item.level === "attention") {
        expect(item.action, `${item.key} nemá návod`).toBeTruthy();
      }
    }
  });
});
