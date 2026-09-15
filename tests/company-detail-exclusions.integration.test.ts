import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Detail firmy v kontextu klienta.
 *
 * Serverový guard fungoval, ale obrazovka nabízela „Zavolat" i u firmy,
 * kterou klient vyloučil - tlačítko svítilo a server ho pak odmítl.
 * Tady se hlídá, že data, ze kterých se stránka kreslí, říkají o každém
 * kontaktu totéž, co potom rozhodne server.
 *
 * Vyloučení je vlastnost DVOJICE klient+firma, takže i tady je vždycky
 * vlastností konkrétního kontaktu: člověk v kampani VEXY může být
 * vyloučený, zatímco kolega ve vedlejší kampani ASN Plus ne.
 */

let sql: typeof import("@/lib/db").sql;
let companies: typeof import("@/lib/queries/companies");
let suppression: typeof import("@/lib/queries/suppression");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  companies = await import("@/lib/queries/companies");
  suppression = await import("@/lib/queries/suppression");
});

afterAll(async () => {
  await closeDatabase();
});

/** Jedna firma, dva klienti, každý se svým kontaktem v téhle firmě. */
async function sharedCompany() {
  const [asn] = await sql<{ id: string }[]>`insert into clients (name) values ('ASN Plus') returning id`;
  const [vexy] = await sql<{ id: string }[]>`insert into clients (name) values ('VEXY') returning id`;
  const [company] = await sql<{ id: string }[]>`
    insert into companies (name, status, ico) values ('Sdílená a.s.', 'ready', '25596641') returning id`;

  const campaigns: Record<string, string> = {};
  for (const [label, clientId] of [["asn", asn.id], ["vexy", vexy.id]] as const) {
    const seed = await seedCampaign({ contacts: [{ email: `${label}@sdilena.test` }] });
    await sql`update campaigns set client_id = ${clientId}, status = 'active', calling_enabled = true
               where id = ${seed.campaignId}`;
    await sql`update contacts set company_id = ${company.id}, phone = '+420777123456'
               where email = ${`${label}@sdilena.test`}`;
    await sql`update campaign_contacts set status = 'scheduled', call_status = 'new',
                                            next_send_at = now() - interval '1 minute'
               where campaign_id = ${seed.campaignId}`;
    campaigns[label] = seed.campaignId;
  }
  return { asnId: asn.id, vexyId: vexy.id, companyId: company.id, campaigns };
}

/** Kontakty firmy podle e-mailu, tak jak je uvidí stránka. */
async function rows(companyId: string) {
  const list = await companies.listCompanyContacts(companyId);
  return Object.fromEntries(list.map((c) => [c.email, c]));
}

describe("kontext klienta na detailu firmy", () => {
  it("bez vyloučení jsou akce dostupné oběma", async () => {
    const { companyId } = await sharedCompany();
    const byEmail = await rows(companyId);
    expect(byEmail["asn@sdilena.test"].client_excluded).toBe(false);
    expect(byEmail["vexy@sdilena.test"].client_excluded).toBe(false);
    expect(byEmail["asn@sdilena.test"].callable).toBe(true);
    expect(byEmail["vexy@sdilena.test"].callable).toBe(true);
  });

  it("vyloučení JEN pro aktuálního klienta vypne akce jen jemu", async () => {
    const { vexyId, companyId } = await sharedCompany();
    await suppression.excludeCompanyForClient({ clientId: vexyId, companyId, reason: "Konflikt." });

    const byEmail = await rows(companyId);
    expect(byEmail["vexy@sdilena.test"].client_excluded).toBe(true);
    expect(byEmail["vexy@sdilena.test"].callable).toBe(false);
    expect(byEmail["vexy@sdilena.test"].client_name).toBe("VEXY");

    // Druhý klient se nezměnil.
    expect(byEmail["asn@sdilena.test"].client_excluded).toBe(false);
    expect(byEmail["asn@sdilena.test"].callable).toBe(true);
  });

  it("vyloučení pro JINÉHO klienta na kontakt tohohle klienta nesáhne", async () => {
    const { asnId, companyId } = await sharedCompany();
    await suppression.excludeCompanyForClient({ clientId: asnId, companyId });

    const byEmail = await rows(companyId);
    expect(byEmail["asn@sdilena.test"].client_excluded).toBe(true);
    expect(byEmail["vexy@sdilena.test"].client_excluded).toBe(false);
    expect(byEmail["vexy@sdilena.test"].callable).toBe(true);
  });

  it("vyloučení pro oba klienty vypne akce u obou", async () => {
    const { asnId, vexyId, companyId } = await sharedCompany();
    await suppression.excludeCompanyForClient({ clientId: asnId, companyId });
    await suppression.excludeCompanyForClient({ clientId: vexyId, companyId });

    const byEmail = await rows(companyId);
    expect(Object.values(byEmail).every((c) => c.client_excluded)).toBe(true);
    expect(Object.values(byEmail).every((c) => !c.callable)).toBe(true);

    // Banner vypíše oba klienty, ne "všechny".
    const list = await suppression.listClientExclusions({ companyId });
    expect(list.map((e) => e.client_name).sort()).toEqual(["ASN Plus", "VEXY"]);
  });

  it("zrušení vyloučení akce zase zpřístupní", async () => {
    const { vexyId, companyId } = await sharedCompany();
    await suppression.excludeCompanyForClient({ clientId: vexyId, companyId });
    expect((await rows(companyId))["vexy@sdilena.test"].client_excluded).toBe(true);

    const [exclusion] = await suppression.listClientExclusions({ clientId: vexyId, companyId });
    await suppression.removeClientExclusion(exclusion.id);

    const byEmail = await rows(companyId);
    expect(byEmail["vexy@sdilena.test"].client_excluded).toBe(false);
    // Volání jde hned; e-mailová sekvence se ZÁMĚRNĚ neobnoví sama.
    expect(byEmail["vexy@sdilena.test"].callable).toBe(true);
  });

  it("kontakt mimo kampaň nemá klienta, a tím ani klientské vyloučení", async () => {
    const { asnId, vexyId, companyId } = await sharedCompany();
    await suppression.excludeCompanyForClient({ clientId: asnId, companyId });
    await suppression.excludeCompanyForClient({ clientId: vexyId, companyId });
    await sql`
      insert into contacts (email, company_id, phone)
      values ('mimo@sdilena.test', ${companyId}, '+420777999888')`;

    const byEmail = await rows(companyId);
    expect(byEmail["mimo@sdilena.test"].client_id).toBeNull();
    expect(byEmail["mimo@sdilena.test"].client_excluded).toBe(false);
  });
});

describe("obrazovka nabídne jen to, co server pustí", () => {
  it("vyloučený kontakt nejde vytočit přímým voláním serveru", async () => {
    const { vexyId, companyId, campaigns } = await sharedCompany();
    const calls = await import("@/lib/queries/calls");
    const calling = await import("@/lib/queries/calling");
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    await suppression.excludeCompanyForClient({ clientId: vexyId, companyId });

    const [cc] = await sql<{ id: string }[]>`
      select id from campaign_contacts where campaign_id = ${campaigns.vexy}`;
    const result = await calls.startCall({ campaignContactId: cc.id, callerId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("client_excluded");
  });

  it("vyloučenému kontaktu neodejde e-mail ani přímým během dispatcheru", async () => {
    const { vexyId, companyId, campaigns } = await sharedCompany();
    const { dispatchTick } = await import("@/lib/engine/dispatch");
    await suppression.excludeCompanyForClient({ clientId: vexyId, companyId });
    // Vyloučení kroky zahodí; i kdyby je něco vrátilo, dispatcher je nevezme.
    await sql`update campaign_contacts set next_send_at = now() - interval '1 minute'
               where campaign_id = ${campaigns.vexy}`;

    for (let i = 0; i < 5; i++) {
      await sql`update campaigns set next_slot_at = null`;
      await dispatchTick();
    }
    const [row] = await sql<{ vexy: number; asn: number }[]>`
      select count(*) filter (where campaign_id = ${campaigns.vexy})::int as vexy,
             count(*) filter (where campaign_id = ${campaigns.asn})::int as asn
        from email_sends`;
    expect(row.vexy).toBe(0);
    expect(row.asn).toBeGreaterThan(0);
  });

  it("nevyloučenému klientovi volání i e-mail dál fungují", async () => {
    const { vexyId, companyId, campaigns } = await sharedCompany();
    const calls = await import("@/lib/queries/calls");
    const calling = await import("@/lib/queries/calling");
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    await suppression.excludeCompanyForClient({ clientId: vexyId, companyId });

    const [cc] = await sql<{ id: string }[]>`
      select id from campaign_contacts where campaign_id = ${campaigns.asn}`;
    expect((await calls.startCall({ campaignContactId: cc.id, callerId })).ok).toBe(true);

    const { dispatchTick } = await import("@/lib/engine/dispatch");
    for (let i = 0; i < 4; i++) {
      await sql`update campaigns set next_slot_at = null`;
      await dispatchTick();
    }
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from email_sends where campaign_id = ${campaigns.asn}`;
    expect(row.count).toBeGreaterThan(0);
  });
});

// ============================================== vlákno v Komunikaci

/**
 * Detail firmy není jediné místo, odkud jde zavolat. Vlákno v Komunikaci
 * má Zavolat v postranním panelu a platí pro něj totéž: klient kampaně
 * toho vlákna rozhoduje, jestli se smí volat.
 */
describe("vlákno konverzace zná vyloučení svého klienta", () => {
  async function conversationFor(campaignId: string) {
    const inbox = await import("@/lib/queries/inbox");
    const [row] = await sql<{ cc: string; contact: string; mailbox: string }[]>`
      select cc.id as cc, cc.contact_id as contact, cm.mailbox_id as mailbox
        from campaign_contacts cc
        join campaign_mailboxes cm on cm.campaign_id = cc.campaign_id
       where cc.campaign_id = ${campaignId} limit 1`;
    const [conversation] = await sql<{ id: string }[]>`
      insert into conversations (mailbox_id, contact_id, campaign_id, campaign_contact_id,
                                 subject, last_message_at)
      values (${row.mailbox}, ${row.contact}, ${campaignId}, ${row.cc}, 'Krátký dotaz', now())
      returning id`;
    return inbox.getConversation(conversation.id);
  }

  it("vyloučený klient → vlákno hlásí zákaz i s jménem klienta", async () => {
    const shared = await sharedCompany();
    await suppression.excludeCompanyForClient({
      clientId: shared.vexyId, companyId: shared.companyId, reason: "Vlastní zákazník.",
    });
    const conversation = await conversationFor(shared.campaigns.vexy);
    expect(conversation?.client_excluded).toBe(true);
    expect(conversation?.excluded_for_client).toBe("VEXY");
  });

  it("vyloučení u JINÉHO klienta tohle vlákno neomezí", async () => {
    const shared = await sharedCompany();
    await suppression.excludeCompanyForClient({
      clientId: shared.vexyId, companyId: shared.companyId, reason: "Vlastní zákazník.",
    });
    const conversation = await conversationFor(shared.campaigns.asn);
    expect(conversation?.client_excluded).toBe(false);
    expect(conversation?.excluded_for_client).toBeNull();
  });

  it("bez vyloučení se volat smí", async () => {
    const shared = await sharedCompany();
    const conversation = await conversationFor(shared.campaigns.vexy);
    expect(conversation?.client_excluded).toBe(false);
  });

  it("zrušení vyloučení vlákno zase uvolní", async () => {
    const shared = await sharedCompany();
    await suppression.excludeCompanyForClient({
      clientId: shared.vexyId, companyId: shared.companyId, reason: "Vlastní zákazník.",
    });
    const [exclusion] = await sql<{ id: string }[]>`
      select id from client_company_exclusions where client_id = ${shared.vexyId}`;
    await suppression.removeClientExclusion(exclusion.id);
    expect((await conversationFor(shared.campaigns.vexy))?.client_excluded).toBe(false);
  });
});
