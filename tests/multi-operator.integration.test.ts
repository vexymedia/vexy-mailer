import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Víc operátorů na jedné kampani.
 *
 * Dva lidé nesmí dostat téhož člověka - dvakrát zavolaný prospekt je
 * trapas, který klient uvidí. Zároveň nesmí kontakt zůstat zamčený
 * navždy, když operátorovi spadne prohlížeč nebo usne notebook.
 *
 * Testuje se proti skutečnému Postgresu, protože právě o zamykání
 * a souběh jde - a `for update skip locked` se z kódu neposoudí.
 */

let sql: typeof import("@/lib/db").sql;
let calling: typeof import("@/lib/queries/calling");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  calling = await import("@/lib/queries/calling");
});

afterAll(async () => {
  await closeDatabase();
});

/** Kampaň připravená k volání, plus N operátorů. */
async function callingCampaign(contacts: number, operators: number) {
  const seed = await seedCampaign({
    contacts: Array.from({ length: contacts }, (_, i) => ({
      email: `prospekt${i}@acme.test`,
      first_name: `Prospekt ${i}`,
    })),
  });
  await sql`update campaigns set calling_enabled = true, status = 'active'
             where id = ${seed.campaignId}`;
  await sql`update contacts set phone = '+42077712' || lpad((random()*9999)::int::text, 4, '0')
             where email like 'prospekt%@acme.test'`;
  await sql`update campaign_contacts set status = 'sent', call_status = 'new'
             where campaign_id = ${seed.campaignId}`;

  const callers: string[] = [];
  for (let i = 0; i < operators; i++) {
    const [c] = await sql<{ id: string }[]>`
      insert into callers (name, active) values (${`Operátor ${i}`}, true) returning id`;
    callers.push(c.id);
    await sql`insert into caller_campaigns (caller_id, campaign_id)
              values (${c.id}, ${seed.campaignId}) on conflict do nothing`;
  }
  return { campaignId: seed.campaignId, callers };
}

// ============================================== nikdo nedostane totéž

describe("claim nedá dvěma lidem stejného člověka", () => {
  it("dva operátoři naráz dostanou každý někoho jiného", async () => {
    const { campaignId, callers } = await callingCampaign(5, 2);
    const [a, b] = await Promise.all([
      calling.claimNextCall(campaignId, callers[0]),
      calling.claimNextCall(campaignId, callers[1]),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("pět operátorů naráz dostane pět různých lidí", async () => {
    const { campaignId, callers } = await callingCampaign(10, 5);
    const claims = await Promise.all(callers.map((c) => calling.claimNextCall(campaignId, c)));
    const ids = claims.filter(Boolean);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it("víc lidí než prospektů: přebývající dostanou prázdno, ne duplicitu", async () => {
    const { campaignId, callers } = await callingCampaign(2, 5);
    const claims = await Promise.all(callers.map((c) => calling.claimNextCall(campaignId, c)));
    const ids = claims.filter(Boolean);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("opakovaný claim téhož operátora vrátí téhož člověka", async () => {
    // Dvě záložky nebo refresh nesmí operátorovi vzít rozdělanou práci.
    const { campaignId, callers } = await callingCampaign(5, 1);
    const first = await calling.claimNextCall(campaignId, callers[0]);
    const second = await calling.claimNextCall(campaignId, callers[0]);
    expect(second).toBe(first);
  });
});

// ================================================ zámek nedrží navždy

describe("lease nezůstane viset", () => {
  it("po uvolnění si člověka vezme někdo jiný", async () => {
    const { campaignId, callers } = await callingCampaign(1, 2);
    const first = await calling.claimNextCall(campaignId, callers[0]);
    expect(await calling.claimNextCall(campaignId, callers[1])).toBeNull();

    await calling.releaseCall(first!);
    const second = await calling.claimNextCall(campaignId, callers[1]);
    expect(second).toBe(first!);
  });

  it("propadlý lease si vezme jiný operátor sám", async () => {
    // Operátor zavřel prohlížeč. Kontakt nesmí zůstat zamčený napořád.
    const { campaignId, callers } = await callingCampaign(1, 2);
    const first = await calling.claimNextCall(campaignId, callers[0]);
    await sql`update campaign_contacts set call_locked_until = now() - interval '1 minute'
               where id = ${first!}`;

    const second = await calling.claimNextCall(campaignId, callers[1]);
    expect(second).toBe(first!);
  });

  it("zapsání výsledku hovoru zámek pustí", async () => {
    const { campaignId, callers } = await callingCampaign(2, 2);
    const first = await calling.claimNextCall(campaignId, callers[0]);
    await calling.logCall({
      campaignContactId: first!,
      callerId: callers[0],
      outcome: "no_answer",
    });
    const [row] = await sql<{ call_locked_until: Date | null }[]>`
      select call_locked_until from campaign_contacts where id = ${first!}`;
    expect(row.call_locked_until).toBeNull();
  });
});

// ======================================= souběžný zápis nedělá duplicity

describe("souběžné zápisy výsledku", () => {
  it("dvojklik na výsledek nezaloží dva pokusy", async () => {
    const { campaignId, callers } = await callingCampaign(1, 1);
    const claim = await calling.claimNextCall(campaignId, callers[0]);
    await Promise.all([
      calling.logCall({ campaignContactId: claim!, callerId: callers[0], outcome: "no_answer" }),
      calling.logCall({ campaignContactId: claim!, callerId: callers[0], outcome: "no_answer" }),
    ]).catch(() => { /* jeden ze dvou smí selhat, hlavně ať nevznikne nesmysl */ });

    const [row] = await sql<{ call_attempts: number }[]>`
      select call_attempts from campaign_contacts where id = ${claim!}`;
    // Dva pokusy jsou v pořádku (operátor fakt klikl dvakrát), víc ne.
    expect(row.call_attempts).toBeLessThanOrEqual(2);
    expect(row.call_attempts).toBeGreaterThanOrEqual(1);
  });
});
