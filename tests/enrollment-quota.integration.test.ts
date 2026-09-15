import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";
import type { ParsedContactRow } from "@/lib/csv";

/**
 * Co se smí započítat do klientovy kvóty.
 *
 * VEXY prodává „až 300 relevantních lidí měsíčně". Když se do kampaně
 * zapíše člověk, kterému se stejně nikdy nesmí napsat ani zavolat, je to
 * dvojí problém: klientovi ubude z kvóty někdo, koho nikdy nedostane,
 * a operátor vidí v kampani čísla, která neodpovídají skutečné práci.
 *
 * Serverové guardy odesílání i volání fungují a nic se neodešle. Tenhle
 * soubor hlídá to druhé: aby se takový kontakt do kampaně vůbec nedostal
 * a import o něm řekl proč.
 */

let sql: typeof import("@/lib/db").sql;
let contacts: typeof import("@/lib/queries/contacts");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  contacts = await import("@/lib/queries/contacts");
});

afterAll(async () => {
  await closeDatabase();
});

function row(email: string, overrides: Partial<ParsedContactRow> = {}): ParsedContactRow {
  return {
    email,
    first_name: "Ana",
    last_name: "Nováková",
    company: "Acme a.s.",
    website: null,
    phone: "+420777123456",
    position: null,
    ...overrides,
  } as ParsedContactRow;
}

/** Kampaň klienta VEXY, plus firma, kterou lze vyloučit. */
async function setup() {
  const [vexy] = await sql<{ id: string }[]>`insert into clients (name) values ('VEXY') returning id`;
  const seed = await seedCampaign({ contacts: [] });
  await sql`update campaigns set client_id = ${vexy.id} where id = ${seed.campaignId}`;
  const [company] = await sql<{ id: string }[]>`
    insert into companies (name, status, ico) values ('Acme a.s.', 'ready', '12345678') returning id`;
  return { clientId: vexy.id, campaignId: seed.campaignId, companyId: company.id };
}

async function enrolled(campaignId: string) {
  const [r] = await sql<{ count: number }[]>`
    select count(*)::int from campaign_contacts where campaign_id = ${campaignId}`;
  return r.count;
}

// ============================================ vyloučená firma se nezapíše

describe("klientské vyloučení se respektuje už při zápisu do kampaně", () => {
  it("kontakt z vyloučené firmy se do kampaně nedostane", async () => {
    const s = await setup();
    const suppression = await import("@/lib/queries/suppression");
    await suppression.excludeCompanyForClient({
      clientId: s.clientId, companyId: s.companyId, reason: "Vlastní zákazník.",
    });
    // Kontakt se naváže na tu vyloučenou firmu.
    await sql`insert into contacts (email, first_name, company, company_id)
              values ('ana@acme.test', 'Ana', 'Acme a.s.', ${s.companyId})`;

    const result = await contacts.importContacts([row("ana@acme.test")], s.campaignId);

    expect(await enrolled(s.campaignId)).toBe(0);
    expect(result.excluded).toBe(1);
    expect(result.addedToCampaign).toBe(0);
  });

  it("kontakt z nevyloučené firmy se zapíše normálně", async () => {
    const s = await setup();
    await sql`insert into contacts (email, first_name, company, company_id)
              values ('ana@acme.test', 'Ana', 'Acme a.s.', ${s.companyId})`;
    const result = await contacts.importContacts([row("ana@acme.test")], s.campaignId);
    expect(await enrolled(s.campaignId)).toBe(1);
    expect(result.addedToCampaign).toBe(1);
    expect(result.excluded).toBe(0);
  });

  it("vyloučení u JINÉHO klienta tuhle kampaň neomezí", async () => {
    const s = await setup();
    const [asn] = await sql<{ id: string }[]>`
      insert into clients (name) values ('ASN Plus') returning id`;
    const suppression = await import("@/lib/queries/suppression");
    await suppression.excludeCompanyForClient({
      clientId: asn.id, companyId: s.companyId, reason: "Konkurent.",
    });
    await sql`insert into contacts (email, first_name, company, company_id)
              values ('ana@acme.test', 'Ana', 'Acme a.s.', ${s.companyId})`;

    const result = await contacts.importContacts([row("ana@acme.test")], s.campaignId);
    expect(await enrolled(s.campaignId)).toBe(1);
    expect(result.excluded).toBe(0);
  });
});

// ================================================= klasifikace importu

describe("import řekne, co se s každým řádkem stalo", () => {
  it("rozliší nové, známé, vyloučené a suppressed — nic nezmizí potichu", async () => {
    const s = await setup();
    const suppression = await import("@/lib/queries/suppression");
    await suppression.excludeCompanyForClient({
      clientId: s.clientId, companyId: s.companyId, reason: "Vlastní zákazník.",
    });
    // vyloučený (firma), suppressed (globálně), známý, nový
    await sql`insert into contacts (email, first_name, company, company_id)
              values ('vylouceny@acme.test', 'A', 'Acme a.s.', ${s.companyId})`;
    await sql`insert into contacts (email, first_name) values ('znamy@jinde.test', 'B')`;
    await sql`insert into suppression_list (email, reason) values ('suppressed@jinde.test', 'unsubscribe')`;

    // Vyloučený je z Acme; ostatní schválně z jiné firmy, aby se
    // nevyloučili taky - vyloučení je vlastnost FIRMY, ne řádku.
    const jinde = { company: "Jinde s.r.o." };
    const result = await contacts.importContacts(
      [row("vylouceny@acme.test"), row("znamy@jinde.test", jinde),
       row("suppressed@jinde.test", jinde), row("novy@jinde.test", jinde)],
      s.campaignId,
    );

    // Součet klasifikací musí sedět na počet řádků. Žádný silent drop.
    const accounted = result.addedToCampaign + result.excluded + result.suppressed.length
      + result.alreadyInCampaign;
    expect(accounted).toBe(4);
    expect(result.excluded).toBe(1);
    expect(result.suppressed).toEqual(["suppressed@jinde.test"]);
    expect(result.addedToCampaign).toBe(2); // znamy + novy
  });

  it("stejný import podruhé nikoho nepřidá znovu", async () => {
    const s = await setup();
    const rows = [row("ana@acme.test"), row("petr@acme.test")];
    const first = await contacts.importContacts(rows, s.campaignId);
    expect(first.addedToCampaign).toBe(2);

    const second = await contacts.importContacts(rows, s.campaignId);
    expect(second.addedToCampaign).toBe(0);
    expect(second.alreadyInCampaign).toBe(2);
    expect(await enrolled(s.campaignId)).toBe(2);
  });

  it("import bez kampaně kontakty jen založí", async () => {
    const s = await setup();
    const result = await contacts.importContacts([row("ana@acme.test")]);
    expect(result.created).toBe(1);
    expect(result.addedToCampaign).toBe(0);
    void s;
  });
});
