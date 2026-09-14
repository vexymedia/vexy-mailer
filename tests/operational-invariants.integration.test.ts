import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Provozní invarianty před ostrým nasazením.
 *
 * Většina těchhle věcí už v aplikaci funguje - tyhle testy je zamykají,
 * aby se nerozbily, až se bude sahat vedle. Kde něco nefungovalo, je to
 * v commitu vidět jako změna kódu, ne jen jako nový test.
 */

let sql: typeof import("@/lib/db").sql;
let calling: typeof import("@/lib/queries/calling");
let calls: typeof import("@/lib/queries/calls");
let dispatch: typeof import("@/lib/engine/dispatch");
let contacts: typeof import("@/lib/queries/contacts");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  calling = await import("@/lib/queries/calling");
  calls = await import("@/lib/queries/calls");
  dispatch = await import("@/lib/engine/dispatch");
  contacts = await import("@/lib/queries/contacts");
});

afterAll(async () => {
  await closeDatabase();
});

async function seedCalling(count = 3) {
  const seeded = await seedCampaign({
    contacts: Array.from({ length: count }, (_, i) => ({
      email: `lead${i}@test.test`,
      first_name: `Lead${i}`,
      company: `Firma ${i}`,
    })),
  });
  await sql`update campaigns set calling_enabled = true where id = ${seeded.campaignId}`;
  await sql`update contacts set phone = '+42077700000' || substr(email, 5, 1)`;
  return seeded;
}

describe("dva calleři najednou", () => {
  it("nedostanou stejnou firmu", async () => {
    await seedCalling(2);
    const jan = await calling.createCaller({ name: "Jan", email: null, phone: null });
    const petr = await calling.createCaller({ name: "Petr", email: null, phone: null });

    // Rezervace běží přes FOR UPDATE SKIP LOCKED, takže i současný požadavek
    // dostane jiný řádek - ne ten samý.
    const [a, b] = await Promise.all([
      calling.claimNextCall(null, jan),
      calling.claimNextCall(null, petr),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("cizí rezervaci druhý caller nepřevezme", async () => {
    const seeded = await seedCalling(1);
    const jan = await calling.createCaller({ name: "Jan", email: null, phone: null });
    const petr = await calling.createCaller({ name: "Petr", email: null, phone: null });

    expect(await calling.claimNextCall(null, jan)).toBe(seeded.campaignContactIds[0]);
    expect(await calling.claimNextCall(null, petr)).toBeNull();
    expect(await calling.getHeldCall(null, petr)).toBeNull();
  });
});

describe("opožděné události od providera", () => {
  it("se přiřadí ke svému hovoru, ne k tomu, co caller řeší teď", async () => {
    const seeded = await seedCalling(2);
    const jan = await calling.createCaller({ name: "Jan", email: null, phone: null });

    const first = await calls.startCall({
      campaignContactId: seeded.campaignContactIds[0], callerId: jan,
    });
    if (!first.ok) throw new Error(first.error);
    await calls.attachProviderCall(first.call.callId, "CA-first", null);
    await calls.recordCallStatus({ providerCallSid: "CA-first", status: "completed", durationSeconds: 30 });
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0], outcome: "no_answer", callerId: jan,
      callId: first.call.callId,
    });

    // Caller už pracuje na dalším kontaktu.
    const second = await calls.startCall({
      campaignContactId: seeded.campaignContactIds[1], callerId: jan,
    });
    if (!second.ok) throw new Error(second.error);
    await calls.attachProviderCall(second.call.callId, "CA-second", null);

    // A teprve teď dorazí nahrávka k PRVNÍMU hovoru.
    await calls.recordRecording({
      providerCallSid: "CA-first",
      recordingSid: "RE-first",
      recordingUrl: "https://api.twilio.com/recordings/RE-first",
      durationSeconds: 30,
      status: "completed",
    });

    expect((await calls.getCall(first.call.callId))?.recording_sid).toBe("RE-first");
    expect((await calls.getCall(second.call.callId))?.recording_sid).toBeNull();
  });

  it("nepřepíšou ručně zapsaný výsledek", async () => {
    const seeded = await seedCalling(1);
    const jan = await calling.createCaller({ name: "Jan", email: null, phone: null });

    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactIds[0], callerId: jan,
    });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, "CA-late", null);
    await calls.recordCallStatus({ providerCallSid: "CA-late", status: "completed", durationSeconds: 90 });

    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0], outcome: "meeting_booked", callerId: jan,
      callId: started.call.callId, meetingAt: new Date(Date.now() + 3 * 86_400_000),
    });

    // AI dorazí až potom a navrhne něco jiného.
    await calls.saveAnalysis({
      callId: started.call.callId,
      analysis: { summary: "Prospekt chtěl zavolat později.", outcome: "callback",
                  sentiment: "neutral", pains: [], needs: [], objections: [], buyingSignals: [],
                  competitorsMentioned: [], timing: null, budgetMentioned: null,
                  authoritySignal: null, nextStep: null, followUpAt: null,
                  recommendedFollowUp: null, importantQuotes: [] },
      provider: "test",
      suggestedOutcome: "callback",
    });

    // Návrh se uloží, ale rozhodnutí člověka zůstává.
    const [state] = await sql<{ call_status: string; meeting_booked: boolean }[]>`
      select call_status, meeting_booked from campaign_contacts
       where id = ${seeded.campaignContactIds[0]}
    `;
    expect(state.call_status).toBe("meeting_booked");
    expect(state.meeting_booked).toBe(true);
    expect((await calls.getCall(started.call.callId))?.suggested_outcome).toBe("callback");
  });
});

describe("terminální výsledek zruší neplatnou budoucí práci", () => {
  it("schůzka vyřadí kontakt z fronty", async () => {
    const seeded = await seedCalling(1);
    const jan = await calling.createCaller({ name: "Jan", email: null, phone: null });
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0], outcome: "meeting_booked", callerId: jan,
      meetingAt: new Date(Date.now() + 3 * 86_400_000),
    });
    expect(await calling.listCallQueue(null, { callerId: jan })).toHaveLength(0);
  });

  it("špatné číslo vyřadí kontakt, i když měl naplánovaný další pokus", async () => {
    const seeded = await seedCalling(1);
    const jan = await calling.createCaller({ name: "Jan", email: null, phone: null });

    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0], outcome: "no_answer", callerId: jan,
    });
    const [scheduled] = await sql<{ next_call_at: Date | null }[]>`
      select next_call_at from campaign_contacts where id = ${seeded.campaignContactIds[0]}
    `;
    expect(scheduled.next_call_at).not.toBeNull();

    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0], outcome: "wrong_number", callerId: jan,
    });
    // Starý naplánovaný pokus nesmí kontakt vrátit do fronty.
    await sql`update campaign_contacts set next_call_at = now() - interval '1 hour'
               where id = ${seeded.campaignContactIds[0]}`;
    expect(await calling.listCallQueue(null, { callerId: jan })).toHaveLength(0);
  });

  it("vyčerpané pokusy zastaví volání", async () => {
    const seeded = await seedCalling(1);
    await sql`update campaigns set max_call_attempts = 2 where id = ${seeded.campaignId}`;
    const jan = await calling.createCaller({ name: "Jan", email: null, phone: null });

    for (let i = 0; i < 2; i++) {
      await calling.logCall({
        campaignContactId: seeded.campaignContactIds[0], outcome: "no_answer", callerId: jan,
      });
    }
    await sql`update campaign_contacts set next_call_at = now() - interval '1 hour'
               where id = ${seeded.campaignContactIds[0]}`;
    expect(await calling.listCallQueue(null, { callerId: jan })).toHaveLength(0);
  });
});

describe("callback", () => {
  it("existuje právě jednou a změna ho nahradí, nezaloží druhý", async () => {
    const seeded = await seedCalling(1);
    const jan = await calling.createCaller({ name: "Jan", email: null, phone: null });

    const first = new Date(Date.now() + 2 * 86_400_000);
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0], outcome: "callback", callerId: jan,
      callbackAt: first,
    });
    const second = new Date(Date.now() + 5 * 86_400_000);
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0], outcome: "callback", callerId: jan,
      callbackAt: second,
    });

    // Další krok je jeden, ten poslední - ne dva soupeřící termíny.
    const [state] = await sql<{ call_status: string; next_call_at: Date }[]>`
      select call_status, next_call_at from campaign_contacts
       where id = ${seeded.campaignContactIds[0]}
    `;
    expect(state.call_status).toBe("callback");
    expect(state.next_call_at.getTime()).toBe(second.getTime());
  });

  it("po dokončení callbacku nezůstane starý termín", async () => {
    const seeded = await seedCalling(1);
    const jan = await calling.createCaller({ name: "Jan", email: null, phone: null });

    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0], outcome: "callback", callerId: jan,
      callbackAt: new Date(Date.now() + 86_400_000),
    });
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0], outcome: "not_interested", callerId: jan,
    });

    const [state] = await sql<{ call_status: string; next_call_at: Date | null }[]>`
      select call_status, next_call_at from campaign_contacts
       where id = ${seeded.campaignContactIds[0]}
    `;
    expect(state.call_status).toBe("lost");
    expect(state.next_call_at).toBeNull();
  });
});

describe("deaktivace callera", () => {
  it("zastaví novou práci, ale historii nepřepíše", async () => {
    const seeded = await seedCalling(1);
    const jan = await calling.createCaller({ name: "Jan", email: null, phone: null });
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0], outcome: "no_answer", callerId: jan,
    });

    await calling.setCallerActive(jan, false);

    // Historie zůstává jeho.
    const [activity] = await sql<{ caller_id: string }[]>`
      select caller_id from call_activities
    `;
    expect(activity.caller_id).toBe(jan);
    const team = await calling.listCallersWithTotals();
    expect(team.find((m) => m.id === jan)?.attempts).toBe(1);

    // Ale mezi aktivní už nepatří.
    expect((await calling.listCallers({ activeOnly: true })).some((c) => c.id === jan)).toBe(false);
  });
});

describe("e-mail: denní limit a idempotence", () => {
  it("limit se počítá stejně jako ho ukazuje obrazovka", async () => {
    const seeded = await seedCampaign({
      contacts: Array.from({ length: 5 }, (_, i) => ({ email: `m${i}@test.test`, first_name: `M${i}` })),
    });
    await sql`update campaigns set daily_limit = 2 where id = ${seeded.campaignId}`;
    const { startCampaign } = await import("@/lib/queries/campaigns");
    expect((await startCampaign(seeded.campaignId)).ok).toBe(true);
    await clearPacing(seeded.campaignId);

    for (let i = 0; i < 4; i++) {
      await dispatch.dispatchTick();
      await clearPacing(seeded.campaignId);
    }

    const [sent] = await sql<{ count: number }[]>`
      select count(*)::int as count from email_sends
       where status in ('sent', 'unknown', 'skipped')
    `;
    // Limit je limit: víc než dva e-maily za den neodejdou, ať se worker
    // spustí kolikrát chce.
    expect(sent.count).toBe(2);

    const { listCampaignStats } = await import("@/lib/queries/dashboard");
    const stats = (await listCampaignStats()).find((c) => c.id === seeded.campaignId);
    // Obrazovka musí říkat totéž co odesílač, jinak si nikdo nebude jistý.
    expect(stats?.sent_today).toBe(2);
  });

  it("opakovaný běh workeru nepošle týž krok dvakrát", async () => {
    const seeded = await seedCampaign({
      contacts: [{ email: "jeden@test.test", first_name: "Jeden" }],
    });
    const { startCampaign } = await import("@/lib/queries/campaigns");
    expect((await startCampaign(seeded.campaignId)).ok).toBe(true);
    await clearPacing(seeded.campaignId);

    await Promise.all([dispatch.dispatchTick(), dispatch.dispatchTick(), dispatch.dispatchTick()]);

    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from email_sends
       where campaign_contact_id = ${seeded.campaignContactIds[0]} and step_number = 1
    `;
    expect(row.count).toBe(1);
  });

  it("odpověď těsně před odesláním follow-up zastaví", async () => {
    const seeded = await seedCampaign({
      contacts: [{ email: "odpovedel@test.test", first_name: "Odpověděl" }],
    });
    const { startCampaign } = await import("@/lib/queries/campaigns");
    expect((await startCampaign(seeded.campaignId)).ok).toBe(true);
    await clearPacing(seeded.campaignId);
    // Prospekt odpověděl poté, co byl follow-up naplánovaný.
    await sql`update campaign_contacts set status = 'replied', next_send_at = now(), current_step = 2
               where id = ${seeded.campaignContactIds[0]}`;

    await dispatch.dispatchTick();

    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from email_sends where status = 'sent'
    `;
    expect(row.count).toBe(0);
  });

  it("odhlášený příjemce nedostane nic, i když je krok naplánovaný", async () => {
    const seeded = await seedCampaign({
      contacts: [{ email: "odhlasen@test.test", first_name: "Odhlášen" }],
    });
    const { startCampaign } = await import("@/lib/queries/campaigns");
    expect((await startCampaign(seeded.campaignId)).ok).toBe(true);
    await clearPacing(seeded.campaignId);
    await contacts.suppressEmail("odhlasen@test.test", "manual");

    await dispatch.dispatchTick();

    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from email_sends where status = 'sent'
    `;
    expect(row.count).toBe(0);
  });
});

describe("import", () => {
  it("rozliší nové, existující a odhlášené a nic tiše nezahodí", async () => {
    const seeded = await seedCampaign({ contacts: [{ email: "uz@test.test", first_name: "Už" }] });
    await contacts.suppressEmail("odhlaseny@test.test", "manual");

    const result = await contacts.importContacts(
      [
        { email: "novy@test.test", first_name: "Nový", last_name: null, company: "Nová",
          website: null, phone: "+420777123456", position: null, line: 2 },
        { email: "uz@test.test", first_name: "Už", last_name: null, company: null,
          website: null, phone: null, position: null, line: 3 },
        { email: "odhlaseny@test.test", first_name: "Odhlášený", last_name: null, company: null,
          website: null, phone: null, position: null, line: 4 },
      ],
      seeded.campaignId,
    );

    expect(result.created).toBe(2);
    expect(result.existing).toBe(1);
    expect(result.suppressed).toEqual(["odhlaseny@test.test"]);
    // Do kampaně se nepřidá odhlášený ani ten, kdo v ní už je.
    expect(result.skippedFromCampaign).toBe(2);
    expect(result.addedToCampaign).toBe(1);
    // Součet sedí: nic nezmizelo bez vysvětlení.
    expect(result.created + result.existing).toBe(3);
  });

  it("stejný e-mail dvakrát nezaloží druhý kontakt", async () => {
    const seeded = await seedCampaign({ contacts: [] });
    const row = { email: "jeden@test.test", first_name: "Jeden", last_name: null,
                  company: "Firma", website: null, phone: "+420777123456", position: null,
                  line: 2 };

    await contacts.importContacts([row], seeded.campaignId);
    const second = await contacts.importContacts([row], seeded.campaignId);

    expect(second.created).toBe(0);
    expect(second.existing).toBe(1);
    const [count] = await sql<{ count: number }[]>`
      select count(*)::int as count from contacts where email = 'jeden@test.test'
    `;
    expect(count.count).toBe(1);
  });
});
