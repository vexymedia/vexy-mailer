import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Worker tick s JEDNÍM spojením v poolu.
 *
 * Podezření znělo: `max: 1` plus rezervované spojení plus advisory zámek
 * se navzájem zablokují — dotaz uvnitř drženého scope by čekal na spojení,
 * které drží ten samý kód. Taková smyčka nemá jak skončit a request visí
 * napořád.
 *
 * Tenhle soubor to měří, místo aby se o tom usuzovalo z kódu. Všechno
 * běží proti skutečnému Postgresu s `max: 1` a s tvrdým časovým limitem:
 * kdyby deadlock existoval, test nedoběhne a spadne na timeoutu, ne na
 * assertu.
 *
 * Jednička už produkční hodnota není - na transaction pooleru dusila
 * souběžné requesty, viz lib/db.ts. Tenhle soubor si ji ale vynucuje
 * schválně: je to nejtěsnější pool, jaký může nastat (`DB_POOL_MAX=1`
 * nebo session pooler), a právě v něm musí tick doběhnout.
 *
 * Hlídá čtyři věci:
 *   1. tick skončí,
 *   2. zámek se uvolní i při chybě,
 *   3. další dotaz (třeba přihlášení) není blokovaný,
 *   4. dva souběžné ticky nezpracují totéž dvakrát.
 */

const BASE = "https://vexy.test";
const CRON_SECRET = "test-cron-secret";
/** Krátký limit schválně: deadlock se pozná tím, že se do něj nevejde. */
const LIMIT = 20_000;

// MUSÍ být před prvním importem `@/lib/db` - klient se staví při importu.
process.env.DB_POOL_MAX = "1";

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

/** Kampaň s krokem splatným teď, ať má tick co dělat. */
async function dueCampaign() {
  const seed = await seedCampaign({ contacts: [{ email: "ana@acme.test" }] });
  const { startCampaign } = await import("@/lib/queries/campaigns");
  await startCampaign(seed.campaignId);
  await clearPacing(seed.campaignId);
  return seed;
}

async function sentCount(campaignId: string) {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int from email_sends where campaign_id = ${campaignId}`;
  return row.count;
}

async function lockRow(name = "dispatch") {
  const [row] = await sql<{ locked_until: Date }[]>`
    select locked_until from worker_locks where name = ${name}`;
  return row;
}

// ============================================ pool je opravdu jednomístný

describe("výchozí bod", () => {
  it("test běží s nejtěsnějším možným poolem", () => {
    // Kdyby se tohle rozešlo, celý soubor by netestoval to, co má.
    expect((sql as unknown as { options: { max: number } }).options.max).toBe(1);
  });
});

// ==================================================== tick vždycky skončí

describe("tick s jedním spojením doběhne", () => {
  it("prázdná databáze: skončí do limitu", { timeout: LIMIT }, async () => {
    const { status, body } = await tick();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("se splatnou kampaní: skončí a opravdu odešle", { timeout: LIMIT }, async () => {
    const seed = await dueCampaign();
    const { status, body } = await tick();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(await sentCount(seed.campaignId)).toBe(1);
  });

  it("deset ticků po sobě: žádný se nezasekne", { timeout: LIMIT }, async () => {
    await dueCampaign();
    for (let i = 0; i < 10; i++) expect((await tick()).status).toBe(200);
  });
});

// ============================================== zámek se vždycky uvolní

describe("lease zámku", () => {
  it("po doběhnutí je zámek volný", { timeout: LIMIT }, async () => {
    await dueCampaign();
    await tick();
    const row = await lockRow();
    // releaseLock posouvá platnost do minulosti, takže je hned k mání.
    expect(row.locked_until.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("uvolní se i když uvnitř něco spadne", { timeout: LIMIT }, async () => {
    const { withLock, acquireLock } = await import("@/lib/engine/locks");
    await expect(
      withLock("dispatch", 60_000, "test", async () => {
        throw new Error("schválně");
      }),
    ).rejects.toThrow("schválně");

    // Když by `finally` chybělo, tohle by neprošlo až do vypršení lease.
    expect(await acquireLock("dispatch", 60_000, "druhy")).toBe(true);
  });

  it("zaseknutý držitel neblokuje navždy — lease vyprší", { timeout: LIMIT }, async () => {
    const { acquireLock } = await import("@/lib/engine/locks");
    // Držitel, který zmizel uprostřed (timeout funkce, redeploy).
    await sql`update worker_locks set locked_until = now() + interval '1 hour',
                                      holder = 'mrtvy' where name = 'dispatch'`;
    expect(await acquireLock("dispatch", 1000, "novy")).toBe(false);

    await sql`update worker_locks set locked_until = now() - interval '1 second'
               where name = 'dispatch'`;
    expect(await acquireLock("dispatch", 1000, "novy")).toBe(true);
  });
});

// ================================== po ticku se dá normálně dál pracovat

describe("po ticku není pool ucpaný", () => {
  it("běžný dotaz projde hned po ticku", { timeout: LIMIT }, async () => {
    await dueCampaign();
    await tick();
    const [row] = await sql<{ one: number }[]>`select 1 as one`;
    expect(row.one).toBe(1);
  });

  it("přihlášení funguje hned po ticku", { timeout: LIMIT }, async () => {
    // Přesně to, co na produkci viselo. Jde přes stejný sdílený pool.
    const users = await import("@/lib/queries/users");
    await users.createUser({
      email: "admin@vexy.test", name: "Admin", role: "admin",
      password: "DostatecneDlouheHeslo1", callerId: null,
    });
    await dueCampaign();
    await tick();

    const found = await users.getUserForLogin("admin@vexy.test");
    expect(found?.email).toBe("admin@vexy.test");
  });

  it("transakce projde hned po ticku", { timeout: LIMIT }, async () => {
    await dueCampaign();
    await tick();
    // sql.begin si bere spojení z téhož poolu. Kdyby ho tick nevrátil,
    // tohle by čekalo donekonečna.
    const out = await sql.begin(async (tx) => {
      const [row] = await tx<{ two: number }[]>`select 2 as two`;
      return row.two;
    });
    expect(out).toBe(2);
  });

  it("dotaz běžící SOUBĚŽNĚ s tickem se taky dočká", { timeout: LIMIT }, async () => {
    await dueCampaign();
    // Obojí na jediném spojení: musí se to prostřídat, ne zaseknout.
    const [tickResult, row] = await Promise.all([
      tick(),
      sql<{ three: number }[]>`select 3 as three`,
    ]);
    expect(tickResult.status).toBe(200);
    expect(row[0].three).toBe(3);
  });
});

// ======================================== souběžné ticky nedělají duplicity

describe("souběžné ticky", () => {
  it("dva ticky naráz neodešlou tentýž krok dvakrát", { timeout: LIMIT }, async () => {
    const seed = await dueCampaign();
    const [a, b] = await Promise.all([tick(), tick()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Jeden odešle, druhý narazí na lease a nic neudělá.
    expect(await sentCount(seed.campaignId)).toBe(1);
  });

  it("pět ticků naráz taky ne", { timeout: LIMIT }, async () => {
    const seed = await dueCampaign();
    const results = await Promise.all([tick(), tick(), tick(), tick(), tick()]);
    for (const r of results) expect(r.status).toBe(200);
    expect(await sentCount(seed.campaignId)).toBe(1);
    // A zámek zůstal použitelný.
    const { acquireLock } = await import("@/lib/engine/locks");
    expect(await acquireLock("dispatch", 60_000, "po-souběhu")).toBe(true);
  });
});

// ================================ instrumentace: kde přesně to stojí

describe("tick hlásí, kde je", () => {
  it("odpověď nese dobu každého kroku", { timeout: LIMIT }, async () => {
    await dueCampaign();
    const { body } = await tick();
    // Když by request na produkci neskončil, odpověď nevznikne - ale
    // v logu zůstane poslední `[cron] > krok` bez svého `<`.
    expect(Object.keys(body.steps)).toEqual(["schema", "dispatch", "replies", "calls"]);
    for (const ms of Object.values(body.steps)) {
      expect(typeof ms).toBe("number");
    }
  });

  it("kroky jsou i v odpovědi se zastaralým schématem", { timeout: LIMIT }, async () => {
    const { MIGRATIONS } = await import("@/lib/schema-contract.mjs");
    await sql`delete from schema_migrations where name = ${MIGRATIONS[MIGRATIONS.length - 1]}`;
    const { status, body } = await tick();
    expect(status).toBe(503);
    expect(body.steps.schema).toBeTypeOf("number");
  });

  it("i selhaný tick řekne, kam došel", { timeout: LIMIT }, async () => {
    // Rozbijeme tabulku, kterou dispatcher čte, až po kontrole schématu
    // by to neprošlo - tak ji shodíme rovnou a čekáme 500 s kroky.
    await dueCampaign();
    await sql`drop table worker_locks`;
    const { status, body } = await tick();
    expect(status).toBe(500);
    expect(body.ok).toBe(false);
    // Došlo se aspoň ke schématu; víc říct nemusí.
    expect(body.steps).toBeTypeOf("object");
  });
});
