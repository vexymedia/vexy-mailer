import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Oddělení klientů.
 *
 * V systému vedle sebe žije ASN Plus a vlastní outbound VEXY. Firmy
 * a kontakty jsou schválně GLOBÁLNÍ - tatáž firma může být relevantní
 * pro oba. Co se oddělit musí, je obchodní stav a práce: ten žije pod
 * kampaní, a caller smí vidět jen kampaně, které mu někdo přidělil.
 *
 * Tohle je bezpečnostní hranice, ne kosmetika. Testuje se server.
 */

let sql: typeof import("@/lib/db").sql;
let calling: typeof import("@/lib/queries/calling");
let calls: typeof import("@/lib/queries/calls");
let clients: typeof import("@/lib/queries/clients");
let pilot: typeof import("@/lib/queries/pilot");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  calling = await import("@/lib/queries/calling");
  calls = await import("@/lib/queries/calls");
  clients = await import("@/lib/queries/clients");
  pilot = await import("@/lib/queries/pilot");
});

afterAll(async () => {
  await closeDatabase();
});

/**
 * Dva klienti, dvě kampaně, dva callery.
 *
 * Jan volá za ASN, Petr za VEXY. Firma "Shared Industries" je záměrně
 * v obou - přesně tak to v provozu vypadá.
 */
async function seedTwoClients() {
  const asnSeed = await seedCampaign({
    contacts: [
      { email: "asn-lead@test.test", first_name: "Asn", company: "Shared Industries" },
      { email: "asn-only@test.test", first_name: "Pouze", company: "Asn Only" },
    ],
  });
  const vexySeed = await seedCampaign({
    contacts: [{ email: "vexy-lead@test.test", first_name: "Vexy", company: "Vexy Only" }],
  });

  await sql`update campaigns set calling_enabled = true, name = 'Pilot elektronika CZ/SK'
             where id = ${asnSeed.campaignId}`;
  await sql`update campaigns set calling_enabled = true, name = 'VEXY vlastní outbound'
             where id = ${vexySeed.campaignId}`;
  await sql`update contacts set phone = '+420777000001' where email = 'asn-lead@test.test'`;
  await sql`update contacts set phone = '+420777000002' where email = 'asn-only@test.test'`;
  await sql`update contacts set phone = '+420777000003' where email = 'vexy-lead@test.test'`;

  const asnClient = await clients.createClient("ASN Plus");
  const vexyClient = await clients.createClient("VEXY");
  if (!asnClient.ok || !vexyClient.ok) throw new Error("klienti se nezaložili");
  await sql`update campaigns set client_id = ${asnClient.id} where id = ${asnSeed.campaignId}`;
  await sql`update campaigns set client_id = ${vexyClient.id} where id = ${vexySeed.campaignId}`;

  const jan = await calling.createCaller({ name: "Jan", email: null, phone: null });
  const petr = await calling.createCaller({ name: "Petr", email: null, phone: null });
  await clients.setAssignments(jan, [asnSeed.campaignId]);
  await clients.setAssignments(petr, [vexySeed.campaignId]);

  const [asnContact] = await sql<{ id: string }[]>`
    select id from contacts where email = 'asn-lead@test.test'
  `;
  const [vexyContact] = await sql<{ id: string }[]>`
    select id from contacts where email = 'vexy-lead@test.test'
  `;

  return {
    asn: { campaignId: asnSeed.campaignId, clientId: asnClient.id, contactId: asnContact.id,
           campaignContactIds: asnSeed.campaignContactIds },
    vexy: { campaignId: vexySeed.campaignId, clientId: vexyClient.id, contactId: vexyContact.id,
            campaignContactIds: vexySeed.campaignContactIds },
    jan,
    petr,
  };
}

describe("fronta je omezená na přidělené kampaně", () => {
  it("caller vidí jen svého klienta", async () => {
    const { asn, vexy, jan, petr } = await seedTwoClients();

    const janQueue = await calling.listCallQueue(null, {
      callerId: jan, scopedToAssignments: true,
    });
    expect(janQueue.every((row) => row.campaign_id === asn.campaignId)).toBe(true);
    expect(janQueue.some((row) => row.contact_id === vexy.contactId)).toBe(false);

    const petrQueue = await calling.listCallQueue(null, {
      callerId: petr, scopedToAssignments: true,
    });
    expect(petrQueue.every((row) => row.campaign_id === vexy.campaignId)).toBe(true);
    expect(petrQueue.some((row) => row.contact_id === asn.contactId)).toBe(false);
  });

  it("caller bez přidělení nedostane nic", async () => {
    const { asn } = await seedTwoClients();
    const novy = await calling.createCaller({ name: "Nový", email: null, phone: null });

    // Fail-closed: nepřidělený caller nesmí dostat cizí frontu jen proto,
    // že mu nikdo nic nenastavil.
    expect(await calling.listCallQueue(null, { callerId: novy, scopedToAssignments: true }))
      .toHaveLength(0);
    expect(await calling.claimNextCall(null, novy, null, true)).toBeNull();

    // Administrátor (bez omezení) frontu vidí celou.
    expect((await calling.listCallQueue(null, { callerId: novy })).length).toBeGreaterThan(0);
    expect(asn.campaignId).toBeTruthy();
  });

  it("rezervace další firmy respektuje přidělení", async () => {
    const { asn, jan } = await seedTwoClients();

    const claimed = await calling.claimNextCall(null, jan, null, true);
    expect(claimed).not.toBeNull();
    expect(asn.campaignContactIds).toContain(claimed as string);
  });

  it("odebrané přidělení schová i drženou firmu", async () => {
    const { jan } = await seedTwoClients();
    await calling.claimNextCall(null, jan, null, true);
    expect(await calling.getHeldCall(null, jan, true)).not.toBeNull();

    await clients.setAssignments(jan, []);
    expect(await calling.getHeldCall(null, jan, true)).toBeNull();
  });
});

describe("vytáčení mimo přidělení", () => {
  it("caller nevytočí kontakt cizího klienta ani se známým id", async () => {
    const { vexy, jan } = await seedTwoClients();

    const result = await calls.startCall({
      contactId: vexy.contactId,
      callerId: jan,
      scopedToAssignments: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Hláška se nesmí lišit od neexistujícího kontaktu, jinak prozradí,
    // že u jiného klienta takový kontakt je.
    expect(result.code).toBe("not_found");

    const [row] = await sql<{ count: number }[]>`select count(*)::int as count from calls`;
    expect(row.count).toBe(0);
  });

  it("caller vytočí kontakt ze své kampaně", async () => {
    const { asn, jan } = await seedTwoClients();
    const result = await calls.startCall({
      contactId: asn.contactId,
      callerId: jan,
      scopedToAssignments: true,
    });
    expect(result.ok).toBe(true);
  });

  it("administrátor vytočí komukoliv", async () => {
    const { vexy, jan } = await seedTwoClients();
    const result = await calls.startCall({ contactId: vexy.contactId, callerId: jan });
    expect(result.ok).toBe(true);
  });

  it("caller nevidí konverzaci cizího klienta", async () => {
    const { asn, vexy, jan } = await seedTwoClients();
    const [mailbox] = await sql<{ id: string }[]>`select id from mailboxes limit 1`;

    const [vexyThread] = await sql<{ id: string }[]>`
      insert into conversations (contact_id, mailbox_id, subject)
      values (${vexy.contactId}, ${mailbox.id}, 'VEXY vlákno') returning id
    `;
    const [asnThread] = await sql<{ id: string }[]>`
      insert into conversations (contact_id, mailbox_id, subject)
      values (${asn.contactId}, ${mailbox.id}, 'ASN vlákno') returning id
    `;

    expect(await clients.callerMaySeeConversation(jan, vexyThread.id)).toBe(false);
    expect(await clients.callerMaySeeConversation(jan, asnThread.id)).toBe(true);
  });
});

describe("stejná firma u dvou klientů", () => {
  it("výsledek u jednoho klienta nezavře práci u druhého", async () => {
    const { asn, vexy, jan, petr } = await seedTwoClients();

    // Tentýž člověk je v obou kampaních - tak, jak to v provozu bývá.
    const [shared] = await sql<{ id: string }[]>`
      select id from contacts where email = 'asn-lead@test.test'
    `;
    const [vexyMembership] = await sql<{ id: string }[]>`
      insert into campaign_contacts (campaign_id, contact_id, status)
      values (${vexy.campaignId}, ${shared.id}, 'pending') returning id
    `;

    // U ASN řekne "nemá zájem".
    await calling.logCall({
      campaignContactId: asn.campaignContactIds[0],
      outcome: "not_interested",
      callerId: jan,
    });

    const [asnState] = await sql<{ call_status: string }[]>`
      select call_status from campaign_contacts where id = ${asn.campaignContactIds[0]}
    `;
    const [vexyState] = await sql<{ call_status: string }[]>`
      select call_status from campaign_contacts where id = ${vexyMembership.id}
    `;

    // ASN skončilo, VEXY běží dál. "Nemá zájem o ASN" není "nemá zájem o VEXY".
    expect(asnState.call_status).toBe("lost");
    expect(vexyState.call_status).toBe("new");

    // A Petr toho člověka ve své frontě pořád má.
    await sql`update contacts set phone = '+420777000001' where id = ${shared.id}`;
    const petrQueue = await calling.listCallQueue(null, {
      callerId: petr, scopedToAssignments: true,
    });
    expect(petrQueue.some((row) => row.contact_id === shared.id)).toBe(true);
  });

  it("globální nevolat platí všude, na rozdíl od výsledku v kampani", async () => {
    const { asn, vexy, petr } = await seedTwoClients();
    const [shared] = await sql<{ id: string }[]>`
      select id from contacts where email = 'asn-lead@test.test'
    `;
    await sql`
      insert into campaign_contacts (campaign_id, contact_id, status)
      values (${vexy.campaignId}, ${shared.id}, 'pending')
    `;

    // "Nekontaktovat" je jiná kategorie než obchodní výsledek: ta platí
    // napříč klienty, protože to je přání člověka, ne stav obchodu.
    await calling.logCall({
      campaignContactId: asn.campaignContactIds[0],
      outcome: "do_not_call",
      callerId: petr,
    });

    const petrQueue = await calling.listCallQueue(null, {
      callerId: petr, scopedToAssignments: true,
    });
    expect(petrQueue.some((row) => row.contact_id === shared.id)).toBe(false);
  });
});

describe("reporting je oddělený", () => {
  it("čísla kampaně obsahují jen vlastního klienta", async () => {
    const { asn, vexy, jan, petr } = await seedTwoClients();

    await calling.logCall({
      campaignContactId: asn.campaignContactIds[0],
      outcome: "meeting_booked",
      callerId: jan,
      meetingAt: new Date(Date.now() + 3 * 86_400_000),
    });
    await calling.logCall({
      campaignContactId: vexy.campaignContactIds[0],
      outcome: "not_interested",
      callerId: petr,
    });

    const asnReport = await pilot.getPilotReport(asn.campaignId);
    const vexyReport = await pilot.getPilotReport(vexy.campaignId);

    expect(asnReport.meetings).toBe(1);
    expect(vexyReport.meetings).toBe(0);
    expect(vexyReport.disqualified).toBe(1);
    expect(asnReport.disqualified).toBe(0);
    expect(asnReport.target_contacts).toBe(2);
    expect(vexyReport.target_contacts).toBe(1);
  });
});
