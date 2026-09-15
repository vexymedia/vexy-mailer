import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";
import { MIGRATIONS } from "@/lib/schema-contract.mjs";

/**
 * Health endpoint a brzda workeru.
 *
 * Dvě strany téhož pravidla: nasazení musí o nepřipravené databázi vědět,
 * a dokud je nepřipravená, nesmí se dít nic skutečného ven. Odeslat e-mail
 * a nemít kam zapsat výsledek je horší než neodeslat nic.
 *
 * Testuje se přes skutečné handlery, ne přes pomocné funkce - protože
 * přesně tudy to na produkci poteče.
 */

const BASE = "https://vexy.test";
const CRON_SECRET = "test-cron-secret";

let sql: typeof import("@/lib/db").sql;

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  process.env.CRON_SECRET = CRON_SECRET;
});

afterAll(async () => {
  await closeDatabase();
});

async function health(query = "") {
  const { GET } = await import("@/app/api/health/route");
  const response = await GET(new NextRequest(`${BASE}/api/health${query}`));
  return { status: response.status, body: await response.json() };
}

async function tick() {
  const { POST } = await import("@/app/api/cron/tick/route");
  const response = await POST(
    new NextRequest(`${BASE}/api/cron/tick`, {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
  );
  return { status: response.status, body: await response.json() };
}

// =========================================== dostupnost bez přihlášení

describe("health je dostupný bez přihlášení", () => {
  it("middleware ho pouští dál", async () => {
    // Bez téhle výjimky by probe dostal přesměrování na /login - tedy
    // odpověď 200 i v okamžiku, kdy je databáze pryč. Monitoring by pak
    // hlásil zdraví přesně tehdy, kdy je nejhůř.
    const { middleware } = await import("@/middleware");
    for (const path of ["/api/health", "/api/health?ready=1"]) {
      const response = middleware(new NextRequest(`${BASE}${path}`));
      expect(response.headers.get("location"), path).toBeNull();
    }
  });

  it("obyčejná stránka bez cookie se pořád přesměruje na login", async () => {
    const { middleware } = await import("@/middleware");
    const response = middleware(new NextRequest(`${BASE}/firmy`));
    expect(response.headers.get("location")).toContain("/login");
  });
});

// ==================================================== liveness a readiness

describe("health endpoint", () => {
  it("liveness odpoví ok a nesahá na databázi", async () => {
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    // Kdyby liveness padalo s databází, hosting by instanci restartoval
    // dokola a tím by výpadek databáze nespravil.
    expect(body).not.toHaveProperty("schema");
    expect(body).not.toHaveProperty("runtime");
  });

  it("readiness na zdravé databázi je ready", async () => {
    const { status, body } = await health("?ready=1");
    expect(status).toBe(200);
    expect(body.status).toBe("ready");
    // Runtime a schéma se hlásí ZVLÁŠŤ: na produkci se rozešly, schéma
    // bylo 15/15 a přesto padala každá stránka.
    expect(body.runtime.database).toBe("ok");
    expect(body.schema.ready).toBe(true);
    expect(body.schema.migrations.missing).toEqual([]);
    expect(body.schema.gaps).toEqual([]);
  });

  it("readiness s chybějící migrací vrací 503 a jmenuje ji", async () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    await sql`delete from schema_migrations where name = ${last}`;
    const { status, body } = await health("?ready=1");
    expect(status).toBe(503);
    expect(body.status).toBe("not_ready");
    // Runtime je v pořádku; pozadu je jen schéma.
    expect(body.runtime.database).toBe("ok");
    expect(body.schema.ready).toBe(false);
    expect(body.schema.migrations.missing).toContain(last);
  });

  it("readiness pozná i chybějící sloupec při zapsané migraci", async () => {
    await sql`alter table companies drop column ico`;
    const { status, body } = await health("?ready=1");
    expect(status).toBe(503);
    expect(body.schema.gaps.join(" ")).toContain("companies.ico");
  });

  it("session pooler shodí readiness, i když spojení funguje", async () => {
    // Přesně konfigurace, na které produkce spadla. Spojení otevřít jde,
    // takže by to bez téhle kontroly hlásilo ready - a EMAXCONNSESSION by
    // přišel až pod souběhem, tedy v provozu.
    vi.stubEnv("DATABASE_URL",
      "postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres");
    const { status, body } = await health("?ready=1");
    expect(status).toBe(503);
    expect(body.runtime.mode).toBe("session");
    expect(body.runtime.warning).toContain("6543");
    vi.unstubAllEnvs();
  });

  it("readiness hlásí režim a velikost poolu, ne adresu", async () => {
    const { body } = await health("?ready=1");
    expect(["transaction", "session", "direct", "unset"]).toContain(body.runtime.mode);
    expect(body.runtime.poolMax).toBe(1);
  });

  it("odpověď neobsahuje connection string ani jiné tajné hodnoty", async () => {
    const secrets = [process.env.DATABASE_URL, process.env.ENCRYPTION_KEY,
                     process.env.SESSION_SECRET, process.env.CRON_SECRET]
      .filter((v): v is string => Boolean(v && v.length >= 8));
    const rendered = JSON.stringify((await health("?ready=1")).body);
    for (const secret of secrets) expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("postgres://");
    expect(rendered).not.toContain("postgresql://");
  });
});

// ========================================= worker proti zastaralému schématu

describe("worker se zastaralým schématem nic neodešle", () => {
  /** Kampaň s krokem splatným teď. Bez brzdy by tick odeslal. */
  async function dueCampaign() {
    const seed = await seedCampaign({ contacts: [{ email: "ana@acme.test" }] });
    const { startCampaign } = await import("@/lib/queries/campaigns");
    const { clearPacing } = await import("./helpers/fixtures");
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    return seed;
  }

  async function sentCount(campaignId: string) {
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int from email_sends where campaign_id = ${campaignId}`;
    return row.count;
  }

  it("na zdravé databázi tick normálně odešle", async () => {
    const seed = await dueCampaign();
    const { status, body } = await tick();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(await sentCount(seed.campaignId)).toBe(1);
  });

  it("s chybějící migrací tick neodešle NIC a vrátí 503", async () => {
    const seed = await dueCampaign();
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    await sql`delete from schema_migrations where name = ${last}`;

    const { status, body } = await tick();
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.skipped).toBe("schema_out_of_date");
    expect(body.missingMigrations).toContain(last);
    // To hlavní: nic neodešlo.
    expect(await sentCount(seed.campaignId)).toBe(0);
  });

  it("s chybějícím sloupcem tick taky neodešle nic", async () => {
    const seed = await dueCampaign();
    await sql`alter table companies drop column ico`;

    const { status, body } = await tick();
    expect(status).toBe(503);
    expect(body.skipped).toBe("schema_out_of_date");
    expect(await sentCount(seed.campaignId)).toBe(0);
  });

  it("brzda nezmizí po opakovaném volání", async () => {
    const seed = await dueCampaign();
    await sql`delete from schema_migrations where name = ${MIGRATIONS[MIGRATIONS.length - 1]}`;
    for (let i = 0; i < 3; i++) expect((await tick()).status).toBe(503);
    expect(await sentCount(seed.campaignId)).toBe(0);
  });

  it("po dorovnání schématu se worker rozjede sám", async () => {
    const seed = await dueCampaign();
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    await sql`delete from schema_migrations where name = ${last}`;
    expect((await tick()).status).toBe(503);

    // Nasazení doběhlo a migraci dorovnalo. Žádný restart, žádný zásah.
    await sql`insert into schema_migrations (name) values (${last})`;
    expect((await tick()).status).toBe(200);
    expect(await sentCount(seed.campaignId)).toBe(1);
  });

  it("neautorizovaný tick je 401 dřív, než se kouká na schéma", async () => {
    const { POST } = await import("@/app/api/cron/tick/route");
    const response = await POST(
      new NextRequest(`${BASE}/api/cron/tick`, { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });

  it("chybová odpověď workeru neobsahuje tajné hodnoty", async () => {
    await sql`delete from schema_migrations where name = ${MIGRATIONS[MIGRATIONS.length - 1]}`;
    const rendered = JSON.stringify((await tick()).body);
    for (const secret of [process.env.DATABASE_URL, process.env.CRON_SECRET, process.env.ENCRYPTION_KEY]) {
      if (secret && secret.length >= 8) expect(rendered).not.toContain(secret);
    }
  });
});
