import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Čísla o volání.
 *
 * Tyhle testy existují kvůli jedné konkrétní produkční chybě: proběhl
 * reálný 35sekundový hovor a Přehled i Tým ukazovaly nulu. Příčina byla
 * v tom, že se pokusy počítaly z `call_activities`, tedy z výsledku, který
 * caller zapsat nemusel. Hovor se odehrál, ale pro reporting neexistoval.
 *
 * Proto se tu netestuje formátování, ale definice: co je pokus, co je
 * spojený hovor a komu se to připíše.
 */

let sql: typeof import("@/lib/db").sql;
let calls: typeof import("@/lib/queries/calls");
let calling: typeof import("@/lib/queries/calling");
let reporting: typeof import("@/lib/queries/reporting");
let overview: typeof import("@/lib/queries/overview");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  calls = await import("@/lib/queries/calls");
  calling = await import("@/lib/queries/calling");
  reporting = await import("@/lib/queries/reporting");
  overview = await import("@/lib/queries/overview");
});

afterAll(async () => {
  await closeDatabase();
});

/** Kontakt mimo kampaň - ad-hoc hovor je pořád obchodní hovor. */
async function adHocContact(email = "vojtech@test.test") {
  const [contact] = await sql<{ id: string; company_id: string }[]>`
    insert into contacts (email, first_name, last_name, company, phone)
    values (${email}, 'Vojtěch', 'TEST', 'Test s.r.o.', '+420737485738')
    returning id, company_id
  `;
  return { contactId: contact.id, companyId: contact.company_id };
}

/**
 * Hovor tak, jak vzniká doopravdy: klik založí řádek, TwiML mu přidělí
 * SID a webhooky hlásí stav.
 */
async function dial(
  contactId: string,
  callerId: string,
  options: { sid?: string; status?: "completed" | "no_answer" | "busy" | "failed"; seconds?: number } = {},
) {
  const started = await calls.startCall({ contactId, callerId });
  if (!started.ok) throw new Error(started.error);
  const sid = options.sid ?? `CA-${Math.random().toString(16).slice(2)}`;
  await calls.attachProviderCall(started.call.callId, sid, "+420000000000");
  await calls.recordCallStatus({
    providerCallSid: sid,
    status: options.status ?? "completed",
    durationSeconds: options.seconds ?? null,
  });
  return { callId: started.call.callId, sid };
}

describe("definice pokusu a spojeného hovoru", () => {
  it("35s ad-hoc hovor bez zapsaného výsledku je 1 pokus a 1 spojený", async () => {
    const { contactId } = await adHocContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });

    await dial(contactId, callerId, { status: "completed", seconds: 35 });

    // Nikdo nezapsal výsledek - a přesto se hovor musí započítat.
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from call_activities
    `;
    expect(count).toBe(0);

    const metrics = await reporting.getCallMetrics();
    expect(metrics.attempts).toBe(1);
    expect(metrics.connected).toBe(1);
    expect(metrics.talk_seconds).toBe(35);
    expect(metrics.reach_rate).toBe(1);
  });

  it("hovor mimo kampaň se počítá v přehledu za 7 dní", async () => {
    const { contactId } = await adHocContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    await dial(contactId, callerId, { status: "completed", seconds: 35 });

    const week = await overview.getWeekSummary();
    expect(week.calls).toBe(1);
    expect(week.connected).toBe(1);
    expect(week.reach_rate).toBe(1);
  });

  it("hovor mimo kampaň se připíše callerovi", async () => {
    const { contactId } = await adHocContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    await dial(contactId, callerId, { status: "completed", seconds: 35 });

    const team = await calling.listCallersWithTotals();
    const jan = team.find((m) => m.id === callerId);
    expect(jan?.attempts).toBe(1);
    expect(jan?.connected_calls).toBe(1);
  });

  it("nepovedený hovor je pokus, ale ne spojený", async () => {
    const { contactId } = await adHocContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    await dial(contactId, callerId, { status: "failed" });

    const metrics = await reporting.getCallMetrics();
    expect(metrics.attempts).toBe(1);
    expect(metrics.connected).toBe(0);
    expect(metrics.reach_rate).toBe(0);
  });

  it("nezvednutý hovor je pokus, ale ne spojený", async () => {
    const { contactId } = await adHocContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    await dial(contactId, callerId, { status: "no_answer" });

    const metrics = await reporting.getCallMetrics();
    expect(metrics.attempts).toBe(1);
    expect(metrics.connected).toBe(0);
  });

  it("dvě Twilio větve jednoho hovoru jsou jeden pokus", async () => {
    const { contactId } = await adHocContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });

    const started = await calls.startCall({ contactId, callerId });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, "CA-parent", "+420000000000");

    // Obě větve hlásí stav pod stejným ParentCallSid - přesně jak to dělá
    // webhook: klientská větev i odchozí do sítě.
    await calls.recordCallStatus({ providerCallSid: "CA-parent", status: "in_progress" });
    await calls.recordCallStatus({
      providerCallSid: "CA-parent",
      status: "completed",
      durationSeconds: 35,
    });

    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from calls`;
    expect(count).toBe(1);

    const metrics = await reporting.getCallMetrics();
    expect(metrics.attempts).toBe(1);
    expect(metrics.connected).toBe(1);
  });

  it("spojený hovor zůstane spojený i bez výsledku", async () => {
    const { contactId } = await adHocContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    const { callId } = await dial(contactId, callerId, { status: "completed", seconds: 35 });

    const before = await reporting.getCallMetrics();
    await calling.logCall({ contactId, outcome: "no_answer", callerId, callId });
    const after = await reporting.getCallMetrics();

    // Výsledek "nezastižen" nesmí přepsat fakt, že hovor byl zvednutý.
    expect(before.connected).toBe(1);
    expect(after.connected).toBe(1);
    expect(after.attempts).toBe(1);
  });

  it("schůzka se započítá jednou, ne dvakrát", async () => {
    const { contactId } = await adHocContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    const { callId } = await dial(contactId, callerId, { status: "completed", seconds: 240 });

    await calling.logCall({
      contactId,
      outcome: "meeting_booked",
      callerId,
      callId,
      meetingAt: new Date(Date.now() + 3 * 86_400_000),
    });

    const metrics = await reporting.getCallMetrics();
    expect(metrics.attempts).toBe(1);
    expect(metrics.connected).toBe(1);
    expect(metrics.meetings).toBe(1);
    expect(metrics.meeting_rate).toBe(1);

    const team = await calling.listCallersWithTotals();
    expect(team.find((m) => m.id === callerId)?.meetings_booked).toBe(1);
  });

  it("hovor, který se nikdy nezačal vytáčet, není pokus", async () => {
    const { contactId } = await adHocContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });

    // Klik, který skončil dřív, než TwiML přidělil SID.
    const started = await calls.startCall({ contactId, callerId });
    expect(started.ok).toBe(true);

    const metrics = await reporting.getCallMetrics();
    expect(metrics.attempts).toBe(0);
  });

  it("ručně zapsaný hovor bez telefonátu se počítá taky", async () => {
    const { contactId } = await adHocContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });

    // Zápis z mobilu: aktivita bez `calls` řádku.
    await calling.logCall({ contactId, outcome: "not_interested", callerId });

    const metrics = await reporting.getCallMetrics();
    expect(metrics.attempts).toBe(1);
    expect(metrics.connected).toBe(1);
  });

  it("hovor s výsledkem se nepočítá dvakrát", async () => {
    const { contactId } = await adHocContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    const { callId } = await dial(contactId, callerId, { status: "completed", seconds: 35 });
    await calling.logCall({ contactId, outcome: "callback", callerId, callId,
      callbackAt: new Date(Date.now() + 86_400_000) });

    const metrics = await reporting.getCallMetrics();
    expect(metrics.attempts).toBe(1);
    expect(metrics.connected).toBe(1);
  });
});

describe("attribution", () => {
  it("hovor se připíše tomu, kdo ho spustil", async () => {
    const { contactId } = await adHocContact();
    const jan = await calling.createCaller({ name: "Jan", email: null, phone: null });
    const eva = await calling.createCaller({ name: "Eva", email: null, phone: null });

    await dial(contactId, jan, { status: "completed", seconds: 35 });

    const byCaller = await reporting.getMetricsByCaller();
    expect(byCaller.get(jan)?.attempts).toBe(1);
    expect(byCaller.get(eva)).toBeUndefined();
  });

  it("historický hovor bez attribution nespadne a zůstane v celkových číslech", async () => {
    const { contactId } = await adHocContact();

    // Hovor z doby před attribution: caller_id je null.
    const started = await calls.startCall({ contactId, callerId: null });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, "CA-legacy", null);
    await calls.recordCallStatus({
      providerCallSid: "CA-legacy",
      status: "completed",
      durationSeconds: 42,
    });

    const total = await reporting.getCallMetrics();
    expect(total.attempts).toBe(1);
    expect(total.connected).toBe(1);

    // Nikomu se nepřipíše a nikdo si ho nevymyslí.
    const byCaller = await reporting.getMetricsByCaller();
    expect(byCaller.size).toBe(0);

    // A /tym se z toho nesmí složit.
    const team = await calling.listCallersWithTotals();
    expect(team).toEqual([]);
  });
});

describe("odvozené sazby", () => {
  it("bez pokusů nemá dovolatelnost hodnotu", async () => {
    const metrics = await reporting.getCallMetrics();
    expect(metrics.attempts).toBe(0);
    expect(metrics.reach_rate).toBeNull();
    expect(metrics.meeting_rate).toBeNull();
  });

  it("bez spojených hovorů nemá meeting rate hodnotu", async () => {
    const { contactId } = await adHocContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    await dial(contactId, callerId, { status: "no_answer" });

    const metrics = await reporting.getCallMetrics();
    expect(metrics.reach_rate).toBe(0);
    expect(metrics.meeting_rate).toBeNull();
  });
});

describe("denní postup callera", () => {
  it("používá stejné metriky jako přehled", async () => {
    const seeded = await seedCampaign({
      contacts: [{ email: "sef@acme.test", first_name: "Ana", company: "Acme" }],
    });
    await sql`update campaigns set calling_enabled = true where id = ${seeded.campaignId}`;
    await sql`update contacts set phone = '+420777123456' where email = 'sef@acme.test'`;
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });

    const [contact] = await sql<{ id: string }[]>`select id from contacts where email = 'sef@acme.test'`;
    await dial(contact.id, callerId, { status: "completed", seconds: 35 });

    const progress = await calling.getCallerDayProgress(callerId);
    const metrics = await reporting.getCallMetrics({ callerId, from: startOfToday() });
    expect(progress.attempts).toBe(metrics.attempts);
    expect(progress.connected).toBe(metrics.connected);
    expect(progress.meetings).toBe(metrics.meetings);
    expect(progress.attempts).toBe(1);
  });
});

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
