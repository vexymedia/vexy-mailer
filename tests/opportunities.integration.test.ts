import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Seznam příležitostí k předání klientovi.
 *
 * Poslední krok toho, co VEXY prodává. Čte se jen to, co už v databázi je -
 * žádná nová entita, žádná automatická klasifikace. Do seznamu se člověk
 * dostane jen tím, že někdo výslovně uložil výsledek hovoru nebo označil
 * odpověď za pozitivní.
 *
 * Testuje se hlavně to, co se do seznamu dostat NESMÍ: rozdělaná práce
 * a lidé, kteří řekli, že nechtějí být kontaktováni.
 */

let sql: typeof import("@/lib/db").sql;
let opportunities: typeof import("@/lib/queries/opportunities");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  opportunities = await import("@/lib/queries/opportunities");
});

afterAll(async () => {
  await closeDatabase();
});

/** Kampaň klienta s jedním kontaktem připraveným k volání. */
async function setup(clientName = "VEXY", email = "ana@acme.test") {
  const [client] = await sql<{ id: string }[]>`
    insert into clients (name) values (${clientName}) returning id`;
  const seed = await seedCampaign({ contacts: [{ email, first_name: "Ana" }] });
  await sql`update campaigns set client_id = ${client.id}, calling_enabled = true
             where id = ${seed.campaignId}`;
  const [company] = await sql<{ id: string }[]>`
    insert into companies (name, status) values (${`Acme ${clientName}`}, 'ready') returning id`;
  await sql`update contacts set company_id = ${company.id}, phone = '+420777123456',
                                position = 'jednatel' where email = ${email}`;
  const [cc] = await sql<{ id: string }[]>`
    select id from campaign_contacts where campaign_id = ${seed.campaignId}`;
  return { clientId: client.id, campaignId: seed.campaignId, contactCampaignId: cc.id,
           mailboxId: seed.mailboxId, contactId: seed.contactIds[0] };
}

/** Pozitivně označená konverzace. */
async function positiveConversation(s: Awaited<ReturnType<typeof setup>>) {
  const [cv] = await sql<{ id: string }[]>`
    insert into conversations (mailbox_id, contact_id, campaign_id, campaign_contact_id,
                               subject, last_message_at, classification)
    values (${s.mailboxId}, ${s.contactId}, ${s.campaignId}, ${s.contactCampaignId},
            'Krátký dotaz', now(), 'positive') returning id`;
  return cv.id;
}

// ================================================= co příležitost JE

describe("do seznamu se dostane jen hotové jednání", () => {
  it("sjednaná schůzka ano, i s poznámkou a termínem", async () => {
    const s = await setup();
    const meeting = new Date(Date.now() + 3 * 86_400_000);
    await sql`update campaign_contacts
                 set call_status = 'meeting_booked', last_call_outcome = 'meeting_booked',
                     meeting_at = ${meeting}, call_note = 'Řeší nábor, chce to vidět v úterý.'
               where id = ${s.contactCampaignId}`;

    const [row] = await opportunities.listOpportunities();
    expect(row.call_status).toBe("meeting_booked");
    expect(row.meeting_at?.getTime()).toBe(meeting.getTime());
    expect(row.call_note).toContain("nábor");
    // Kontext, který klient potřebuje, aby mohl navázat.
    expect(row.email).toBe("ana@acme.test");
    expect(row.phone).toBe("+420777123456");
    expect(row.position).toBe("jednatel");
    expect(row.company).toBe("Acme VEXY");
    expect(row.client_name).toBe("VEXY");
    expect(row.campaign_name).toBeTruthy();
  });

  it("získaný klient ano", async () => {
    const s = await setup();
    await sql`update campaign_contacts set call_status = 'won' where id = ${s.contactCampaignId}`;
    expect(await opportunities.listOpportunities()).toHaveLength(1);
  });

  it("pozitivně označená odpověď ano, s odkazem na vlákno", async () => {
    const s = await setup();
    const conversationId = await positiveConversation(s);
    const [row] = await opportunities.listOpportunities();
    expect(row.positive_reply).toBe(true);
    expect(row.conversation_id).toBe(conversationId);
  });

  it("schůzka i pozitivní odpověď dají JEDEN řádek, ne dva", async () => {
    const s = await setup();
    await positiveConversation(s);
    await sql`update campaign_contacts set call_status = 'meeting_booked'
               where id = ${s.contactCampaignId}`;
    const rows = await opportunities.listOpportunities();
    expect(rows).toHaveLength(1);
    expect(rows[0].positive_reply).toBe(true);
    expect(rows[0].call_status).toBe("meeting_booked");
  });
});

// ================================================ co příležitost NENÍ

describe("rozdělaná práce a odmítnutí se nepočítají", () => {
  it("nevolaný kontakt ne", async () => {
    await setup();
    expect(await opportunities.listOpportunities()).toHaveLength(0);
  });

  it("domluvený callback ne — to je práce operátora, ne jednání pro klienta", async () => {
    const s = await setup();
    await sql`update campaign_contacts set call_status = 'callback',
                                           next_call_at = now() + interval '1 day'
               where id = ${s.contactCampaignId}`;
    expect(await opportunities.listOpportunities()).toHaveLength(0);
  });

  it("nemá zájem ne", async () => {
    const s = await setup();
    await sql`update campaign_contacts set call_status = 'lost', last_call_outcome = 'not_interested'
               where id = ${s.contactCampaignId}`;
    expect(await opportunities.listOpportunities()).toHaveLength(0);
  });

  it("„nevolat“ vypadne, i když má v historii pozitivní vlákno", async () => {
    const s = await setup();
    await positiveConversation(s);
    await sql`update campaign_contacts set call_status = 'do_not_call', status = 'unsubscribed'
               where id = ${s.contactCampaignId}`;
    expect(await opportunities.listOpportunities()).toHaveLength(0);
  });

  it("neutrální konverzace ne", async () => {
    const s = await setup();
    await sql`insert into conversations (mailbox_id, contact_id, campaign_id, campaign_contact_id,
                                         subject, last_message_at, classification)
              values (${s.mailboxId}, ${s.contactId}, ${s.campaignId}, ${s.contactCampaignId},
                      'Krátký dotaz', now(), 'later')`;
    expect(await opportunities.listOpportunities()).toHaveLength(0);
  });
});

// ==================================================== oddělení klientů

describe("klienti se nemíchají", () => {
  it("filtr podle kampaně vrátí jen tu jednu", async () => {
    const a = await setup("VEXY", "ana@acme.test");
    const b = await setup("ASN Plus", "petr@jinde.test");
    await sql`update campaign_contacts set call_status = 'meeting_booked'
               where id in (${a.contactCampaignId}, ${b.contactCampaignId})`;

    expect(await opportunities.listOpportunities()).toHaveLength(2);
    const onlyA = await opportunities.listOpportunities({ campaignId: a.campaignId });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].client_name).toBe("VEXY");
  });

  it("filtr podle klienta taky", async () => {
    const a = await setup("VEXY", "ana@acme.test");
    const b = await setup("ASN Plus", "petr@jinde.test");
    await sql`update campaign_contacts set call_status = 'won'
               where id in (${a.contactCampaignId}, ${b.contactCampaignId})`;
    const onlyB = await opportunities.listOpportunities({ clientId: b.clientId });
    expect(onlyB).toHaveLength(1);
    expect(onlyB[0].client_name).toBe("ASN Plus");
  });
});

// ================================================== řazení a stabilita

describe("seznam je použitelný", () => {
  it("nejnovější aktivita je nahoře", async () => {
    const a = await setup("VEXY", "ana@acme.test");
    const b = await setup("VEXY 2", "petr@jinde.test");
    await sql`update campaign_contacts set call_status = 'meeting_booked',
                                           updated_at = now() - interval '2 days'
               where id = ${a.contactCampaignId}`;
    await sql`update campaign_contacts set call_status = 'meeting_booked', updated_at = now()
               where id = ${b.contactCampaignId}`;

    const rows = await opportunities.listOpportunities();
    expect(rows[0].email).toBe("petr@jinde.test");
  });

  it("prázdný seznam nespadne", async () => {
    expect(await opportunities.listOpportunities()).toEqual([]);
    expect(await opportunities.countOpportunities()).toBe(0);
  });
});
