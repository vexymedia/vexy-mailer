import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";
import type { CallAnalysis } from "@/lib/telephony/call-state";
import type { AnalysisProvider, TranscriptionProvider } from "@/lib/telephony/transcription";

/**
 * Volání z prohlížeče proti skutečné databázi.
 *
 * Twilio ani přepisovač se tu nevolají - jsou to vyměnitelné providery a
 * v testu jsou nahrazené. Testuje se to, co je naše: dohledání čísla na
 * serveru, životní cyklus hovoru, webhooky mimo pořadí a to, že selhání
 * AI nesmí smazat hovor, který se skutečně odehrál.
 */

let sql: typeof import("@/lib/db").sql;
let calls: typeof import("@/lib/queries/calls");
let calling: typeof import("@/lib/queries/calling");
let companies: typeof import("@/lib/queries/companies");
let pipeline: typeof import("@/lib/telephony/pipeline");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  calls = await import("@/lib/queries/calls");
  calling = await import("@/lib/queries/calling");
  companies = await import("@/lib/queries/companies");
  pipeline = await import("@/lib/telephony/pipeline");
});

afterAll(async () => {
  await closeDatabase();
});

async function seed(options: { phone?: string | null } = {}) {
  const result = await seedCampaign({
    contacts: [{ email: "sef@acme.test", first_name: "Ana", company: "Acme" }],
  });
  await sql`update campaigns set calling_enabled = true where id = ${result.campaignId}`;
  const phone = options.phone === undefined ? "+420777123456" : options.phone;
  await sql`update contacts set phone = ${phone} where email = 'sef@acme.test'`;
  const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
  const [company] = await sql<{ id: string }[]>`select id from companies where name = 'Acme'`;
  return { ...result, callerId, companyId: company.id, campaignContactId: result.campaignContactIds[0] };
}

/** Hovor dovedený do stavu "nahrávka k dispozici", jako po skutečném telefonátu. */
async function completedCall(seeded: Awaited<ReturnType<typeof seed>>, sid = "CA-test-1") {
  const started = await calls.startCall({
    campaignContactId: seeded.campaignContactId,
    callerId: seeded.callerId,
  });
  if (!started.ok) throw new Error(started.error);
  await calls.attachProviderCall(started.call.callId, sid, "+420222222222");
  await calls.recordCallStatus({ providerCallSid: sid, status: "in_progress" });
  await calls.recordCallStatus({ providerCallSid: sid, status: "completed", durationSeconds: 222 });
  await calls.recordRecording({
    providerCallSid: sid,
    recordingSid: "RE-test-1",
    recordingUrl: "https://api.twilio.com/recordings/RE-test-1",
    durationSeconds: 220,
    status: "completed",
  });
  return started.call;
}

// ---------------------------------------------------- dohledání destinace
describe("kam se volá, rozhoduje server", () => {
  it("dohledá číslo kontaktu a znormalizuje ho", async () => {
    const seeded = await seed({ phone: "777 123 456" });
    const result = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.call.destination).toBe("+420777123456");
    expect(result.call.contactName).toBe("Ana");
    expect(result.call.companyId).toBe(seeded.companyId);

    // Číslo se uloží jako snímek: pozdější změna kontaktu záznam nepřepíše.
    await sql`update contacts set phone = '+420999999999' where email = 'sef@acme.test'`;
    const stored = await calls.getCall(result.call.callId);
    expect(stored?.destination).toBe("+420777123456");
  });

  it("odmítne kontakt bez čísla a s nesmyslným číslem", async () => {
    const withoutPhone = await seed({ phone: null });
    const a = await calls.startCall({
      campaignContactId: withoutPhone.campaignContactId,
      callerId: null,
    });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe("no_phone");

    await sql`update contacts set phone = 'zavolat na recepci' where email = 'sef@acme.test'`;
    const b = await calls.startCall({
      campaignContactId: withoutPhone.campaignContactId,
      callerId: null,
    });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe("no_phone");

    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from calls`;
    expect(count).toBe(0);
  });

  it("nedovolí zavolat člověku na do-not-call listu", async () => {
    const seeded = await seed();
    await sql`
      insert into call_suppression (contact_id, reason)
      values (${seeded.contactIds[0]}, 'do_not_call')
    `;
    const result = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("suppressed");
  });

  it("nedovolí zavolat do uzavřené firmy", async () => {
    const seeded = await seed();
    await companies.updateCompany(seeded.companyId, { status: "excluded" });
    const result = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("closed");
  });
});

// -------------------------------------------------------- životní cyklus
describe("životní cyklus hovoru", () => {
  it("projde vytáčení, spojení a ukončení", async () => {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    if (!started.ok) throw new Error(started.error);

    await calls.attachProviderCall(started.call.callId, "CA-1", "+420222222222");
    await calls.recordCallStatus({ providerCallSid: "CA-1", status: "ringing" });
    expect((await calls.getCall(started.call.callId))?.status).toBe("ringing");

    await calls.recordCallStatus({ providerCallSid: "CA-1", status: "in_progress" });
    const answered = await calls.getCall(started.call.callId);
    expect(answered?.status).toBe("in_progress");
    expect(answered?.answered_at).not.toBeNull();

    await calls.recordCallStatus({
      providerCallSid: "CA-1",
      status: "completed",
      durationSeconds: 222,
    });
    const done = await calls.getCall(started.call.callId);
    expect(done?.status).toBe("completed");
    expect(done?.duration_seconds).toBe(222);
    expect(done?.ended_at).not.toBeNull();
  });

  it("nevrátí hovor zpátky, když webhooky dorazí mimo pořadí", async () => {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, "CA-2", null);

    await calls.recordCallStatus({ providerCallSid: "CA-2", status: "completed", durationSeconds: 10 });
    // Opožděné "vyzvání" nesmí ukončený hovor oživit.
    await calls.recordCallStatus({ providerCallSid: "CA-2", status: "ringing" });
    const row = await calls.getCall(started.call.callId);
    expect(row?.status).toBe("completed");
    expect(row?.duration_seconds).toBe(10);
  });

  it("u nedovolaného hovoru nečeká na nahrávku", async () => {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, "CA-3", null);
    await calls.recordCallStatus({ providerCallSid: "CA-3", status: "no_answer" });

    const row = await calls.getCall(started.call.callId);
    expect(row?.recording_status).toBe("disabled");
    // Jinak by hovor navždy hlásil "nahrávka se zpracovává".
    expect(row?.transcript_status).toBe("skipped");
    expect(row?.analysis_status).toBe("skipped");
  });

  it("ignoruje webhook k hovoru, který nezná", async () => {
    expect(await calls.recordCallStatus({ providerCallSid: "CA-neznamy", status: "completed" }))
      .toBeNull();
    expect(
      await calls.recordRecording({
        providerCallSid: "CA-neznamy",
        recordingSid: "RE",
        recordingUrl: "https://example.test/r",
        durationSeconds: 1,
        status: "completed",
      }),
    ).toBeNull();
  });
});

// ------------------------------------------------------------- nahrávka
describe("nahrávka", () => {
  it("se uloží až z webhooku, ne při zavěšení", async () => {
    const seeded = await seed();
    const call = await completedCall(seeded);
    const row = await calls.getCall(call.callId);
    expect(row?.recording_status).toBe("available");
    expect(row?.recording_url).toBe("https://api.twilio.com/recordings/RE-test-1");
    expect(row?.recording_duration_seconds).toBe(220);
  });

  it("chybějící nahrávku označí a nedrží přepis ve frontě", async () => {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, "CA-4", null);
    await calls.recordCallStatus({ providerCallSid: "CA-4", status: "completed" });
    await calls.recordRecording({
      providerCallSid: "CA-4",
      recordingSid: null,
      recordingUrl: null,
      durationSeconds: null,
      status: "absent",
    });

    const row = await calls.getCall(started.call.callId);
    expect(row?.recording_status).toBe("failed");
    expect(row?.transcript_status).toBe("skipped");
    // Metadata hovoru zůstávají: hovor se odehrál, i když nahrávka není.
    expect(row?.status).toBe("completed");
    expect(row?.destination).toBe("+420777123456");
  });
});

// ------------------------------------------------ souběžné pokusy o hovor
describe("jeden caller, jeden hovor", () => {
  it("odmítne druhý hovor, dokud ten první opravdu běží", async () => {
    const seeded = await seed();
    const first = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    if (!first.ok) throw new Error(first.error);
    await calls.attachProviderCall(first.call.callId, "CA-live", null);
    await calls.recordCallStatus({ providerCallSid: "CA-live", status: "in_progress" });

    const second = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("already_calling");

    // Po ukončení jde volat zase.
    await calls.recordCallStatus({ providerCallSid: "CA-live", status: "completed" });
    const third = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    expect(third.ok).toBe(true);
  });

  it("dva souběžné požadavky vytvoří právě jeden vytočitelný hovor", async () => {
    const seeded = await seed();

    // Dvě záložky mačkají Zavolat ve stejný okamžik. Bez serializace obě
    // projdou kontrolou dřív, než kterákoli stihne zapsat - a vytočí se
    // dvě linky, obě placené.
    const results = await Promise.all([
      calls.startCall({ campaignContactId: seeded.campaignContactId, callerId: seeded.callerId }),
      calls.startCall({ campaignContactId: seeded.campaignContactId, callerId: seeded.callerId }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(2);

    // Vytočit se ale smí právě jeden: TwiML endpoint pouští jen `queued`.
    const rows = await sql<{ status: string }[]>`select status from calls`;
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(1);
  });

  it("deset souběžných požadavků nechá vytočitelný pořád jen jeden", async () => {
    const seeded = await seed();
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        calls.startCall({ campaignContactId: seeded.campaignContactId, callerId: seeded.callerId }),
      ),
    );
    expect(attempts.every((r) => r.ok)).toBe(true);

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from calls where status = 'queued'
    `;
    expect(count).toBe(1);
  });

  it("hovor, který se k providerovi nedostal, další volání neblokuje", async () => {
    const seeded = await seed();
    const abandoned = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    if (!abandoned.ok) throw new Error(abandoned.error);

    // Druhá záložka. Zaseknutý pokus se nesmí stát patnáctiminutovou
    // blokádou - uzavře se a jde se dál.
    const next = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    expect(next.ok).toBe(true);

    const superseded = await calls.getCall(abandoned.call.callId);
    expect(superseded?.status).toBe("failed");
    expect(superseded?.recording_status).toBe("disabled");
  });

  it("nahrazený hovor už TwiML endpoint nevytočí", async () => {
    const seeded = await seed();
    const first = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    if (!first.ok) throw new Error(first.error);
    await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });

    // Tenhle stav čte /api/calling/voice, než cokoli vytočí.
    const stale = await calls.getCallForDial(first.call.callId);
    expect(stale?.status).not.toBe("queued");
  });
});

// ------------------------------------------ nezapsaný výsledek po hovoru
describe("hovor bez zapsaného výsledku", () => {
  /** Hovor, který proběhl a caller pak zavřel notebook. */
  async function hungUpWithoutLogging(seeded: Awaited<ReturnType<typeof seed>>) {
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, "CA-hung", null);
    await calls.recordCallStatus({
      providerCallSid: "CA-hung",
      status: "completed",
      durationSeconds: 130,
    });
    return started.call;
  }

  it("nabídne se k dopsání a ví, komu se volalo", async () => {
    const seeded = await seed();
    const call = await hungUpWithoutLogging(seeded);

    const pending = await calls.getUnloggedCall({ callerId: seeded.callerId });
    expect(pending?.id).toBe(call.callId);
    expect(pending?.contact_name).toBe("Ana");
    expect(pending?.company_name).toBe("Acme");
  });

  it("kontakt se mezitím nesmí znovu vytočit jako běžný lead", async () => {
    const seeded = await seed();
    await hungUpWithoutLogging(seeded);

    // Tohle je ta chyba, kterou to má chytit: prospekt se zavolá podruhé,
    // protože o prvním hovoru nikde není zapsaný výsledek.
    expect(await calling.listCallQueue(seeded.campaignId)).toHaveLength(0);
    expect(await calling.claimNextCall(seeded.campaignId, seeded.callerId)).toBeNull();
  });

  it("nenabídne se ani přes rezervaci, která zavřený notebook přežila", async () => {
    const seeded = await seed();
    // Caller si kontakt rezervoval, zavolal a zavřel notebook. Rezervace
    // platí ještě pár minut - pracovní režim ho proto po návratu měl
    // stále nabídnutý k vytočení.
    const claimed = await calling.claimNextCall(seeded.campaignId, seeded.callerId);
    expect(claimed).toBe(seeded.campaignContactId);
    await hungUpWithoutLogging(seeded);

    expect(await calling.getHeldCall(seeded.campaignId, seeded.callerId)).toBeNull();
  });

  it("po dopsání výsledku se vrátí do normálního běhu", async () => {
    const seeded = await seed();
    const call = await hungUpWithoutLogging(seeded);

    await calling.logCall({
      campaignContactId: seeded.campaignContactId,
      outcome: "no_answer",
      callerId: seeded.callerId,
      callId: call.callId,
    });

    // Nabídka zmizí...
    expect(await calls.getUnloggedCall({ callerId: seeded.callerId })).toBeNull();
    // ...a kadence normálně naplánovala další pokus.
    const [row] = await sql<{ call_attempts: number; next_call_at: Date | null }[]>`
      select call_attempts, next_call_at from campaign_contacts where id = ${seeded.campaignContactId}
    `;
    expect(row.call_attempts).toBe(1);
    expect(row.next_call_at).not.toBeNull();
  });

  it("nenabízí hovor, který se nikdy nespojil", async () => {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    if (!started.ok) throw new Error(started.error);
    // Nikdy nedostal SID od providera - není co zapisovat.
    expect(await calls.getUnloggedCall({ callerId: seeded.callerId })).toBeNull();
    // A kontakt zůstává normálně ve frontě.
    expect(await calling.listCallQueue(seeded.campaignId)).toHaveLength(1);
  });

  it("po dni už kontakt nedrží a vrátí ho do fronty", async () => {
    const seeded = await seed();
    const call = await hungUpWithoutLogging(seeded);
    await sql`
      update calls set started_at = now() - interval '20 hours' where id = ${call.callId}
    `;
    // Věčná blokáda by byla horší než riziko druhého hovoru po dni.
    expect(await calls.getUnloggedCall({ callerId: seeded.callerId })).toBeNull();
    expect(await calling.listCallQueue(seeded.campaignId)).toHaveLength(1);
  });
});

// ----------------------------------------- ztracené události od providera
describe("když webhook nedorazí", () => {
  it("uzavře hovor, který se rozjel a nikdy neskončil", async () => {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, "CA-stuck", null);
    await calls.recordCallStatus({ providerCallSid: "CA-stuck", status: "in_progress" });

    // Běžící hovor se uklidit nesmí.
    expect(await calls.reapAbandonedCalls()).toBe(0);
    expect((await calls.getCall(started.call.callId))?.status).toBe("in_progress");

    await sql`
      update calls set started_at = now() - interval '3 hours' where id = ${started.call.callId}
    `;
    expect(await calls.reapAbandonedCalls()).toBe(1);
    expect((await calls.getCall(started.call.callId))?.status).toBe("failed");
  });

  it("přestane slibovat nahrávku, která nedorazila", async () => {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, "CA-norec", null);
    await calls.recordCallStatus({
      providerCallSid: "CA-norec",
      status: "completed",
      durationSeconds: 90,
    });
    expect((await calls.getCall(started.call.callId))?.recording_status).toBe("pending");

    // Čerstvě ukončený hovor na nahrávku právem čeká.
    expect(await calls.reapAbandonedCalls()).toBe(0);

    await sql`
      update calls set ended_at = now() - interval '45 minutes' where id = ${started.call.callId}
    `;
    expect(await calls.reapAbandonedCalls()).toBe(1);
    const row = await calls.getCall(started.call.callId);
    expect(row?.recording_status).toBe("failed");
    expect(row?.transcript_status).toBe("skipped");
    // Hovor sám zůstává platný: proběhl a trval devadesát vteřin.
    expect(row?.status).toBe("completed");
    expect(row?.duration_seconds).toBe(90);
  });
});

// -------------------------------------------------------------- pipeline
const ANALYSIS: CallAnalysis = {
  summary: "Firma expanduje, zajímá je nábor.",
  outcome: "callback",
  sentiment: "positive",
  pains: ["nestíhají nábor"],
  needs: [],
  objections: ["teď nemají čas"],
  buyingSignals: ["ozvěte se v pondělí"],
  competitorsMentioned: [],
  timing: "příští týden",
  budgetMentioned: null,
  authoritySignal: "jednatel",
  nextStep: "Zavolat v pondělí",
  followUpAt: "2026-09-21",
  recommendedFollowUp: "Poslat referenci před hovorem",
  importantQuotes: ["Zavolejte v pondělí."],
};

function fakeProviders(overrides: {
  transcribe?: TranscriptionProvider["transcribe"];
  analyse?: AnalysisProvider["analyse"];
} = {}) {
  const transcription: TranscriptionProvider = {
    name: "test",
    transcribe:
      overrides.transcribe ??
      (async () => ({
        ok: true as const,
        result: { text: "Dobrý den, tady Jan.", language: "cs", provider: "test" },
      })),
  };
  const analysis: AnalysisProvider = {
    name: "test",
    analyse: overrides.analyse ?? (async () => ({ ok: true as const, analysis: ANALYSIS })),
  };
  return { transcription, analysis };
}

describe("přepis a analýza", () => {
  it("přepíše nahrávku a rovnou ji zanalyzuje", async () => {
    const seeded = await seed();
    const call = await completedCall(seeded);
    const providers = fakeProviders();

    // Stažení nahrávky jde na Twilio; v testu se nahradí odpovědí serveru.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      })) as typeof fetch;
    process.env.TWILIO_ACCOUNT_SID = "AC-test";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_API_KEY_SID = "SK-test";
    process.env.TWILIO_API_KEY_SECRET = "secret";
    process.env.TWILIO_TWIML_APP_SID = "AP-test";
    process.env.TWILIO_CALLER_ID = "+420222222222";

    try {
      // Jeden tick: přepis i analýza. Čekat na další by callerovi přidalo
      // minutu, ve které nemá co číst.
      const pass = await pipeline.processCallPipeline(providers);
      expect(pass.transcribed).toBe(1);
      expect(pass.analysed).toBe(1);

      const row = await calls.getCall(call.callId);
      expect(row?.transcript_status).toBe("done");
      expect(row?.transcript).toBe("Dobrý den, tady Jan.");
      expect(row?.transcript_language).toBe("cs");
      expect(row?.analysis_status).toBe("done");
      expect(row?.analysis?.summary).toBe("Firma expanduje, zajímá je nábor.");
      expect(row?.analysis?.objections).toEqual(["teď nemají čas"]);
      // Návrh výsledku je jen návrh - zapsat ho musí člověk.
      expect(row?.suggested_outcome).toBe("callback");
      expect(row?.call_activity_id).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("když dochází čas funkce, odloží analýzu na další tick", async () => {
    const seeded = await seed();
    const call = await completedCall(seeded);
    const providers = fakeProviders();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/mpeg" } })) as typeof fetch;
    try {
      // Rozpočet stačí na přepis, ne na analýzu.
      const first = await pipeline.processCallPipeline({ ...providers, deadline: Date.now() + 5_000 });
      expect(first.transcribed).toBe(1);
      expect(first.analysed).toBe(0);
      expect(first.deferred).toBe(1);
      // Přepis je uložený, nic se neztratilo.
      expect((await calls.getCall(call.callId))?.transcript_status).toBe("done");
      expect((await calls.getCall(call.callId))?.analysis_status).toBe("pending");

      const second = await pipeline.processCallPipeline(providers);
      expect(second.analysed).toBe(1);
      expect((await calls.getCall(call.callId))?.analysis_status).toBe("done");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("selhání přepisu nesmaže hovor ani nahrávku", async () => {
    const seeded = await seed();
    const call = await completedCall(seeded);
    const providers = fakeProviders({
      transcribe: async () => ({ ok: false as const, error: "provider je dole" }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/mpeg" } })) as typeof fetch;
    try {
      const result = await pipeline.processCallPipeline(providers);
      expect(result.failed).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const row = await calls.getCall(call.callId);
    expect(row?.transcript_status).toBe("failed");
    expect(row?.transcript_error).toContain("provider je dole");
    expect(row?.recording_status).toBe("available");
    expect(row?.duration_seconds).toBe(222);
    expect(row?.status).toBe("completed");
  });

  it("selhání analýzy nechá přepis na místě", async () => {
    const seeded = await seed();
    const call = await completedCall(seeded);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/mpeg" } })) as typeof fetch;
    try {
      await pipeline.processCallPipeline(
        fakeProviders({ analyse: async () => ({ ok: false as const, error: "model selhal" }) }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const row = await calls.getCall(call.callId);
    expect(row?.transcript_status).toBe("done");
    expect(row?.transcript).toBe("Dobrý den, tady Jan.");
    expect(row?.analysis_status).toBe("failed");
    expect(row?.analysis_error).toContain("model selhal");
  });

  it("dva ticky naráz přepíšou hovor jen jednou", async () => {
    const seeded = await seed();
    const call = await completedCall(seeded);
    let transcribeCalls = 0;
    let analyseCalls = 0;
    const providers = fakeProviders({
      transcribe: async () => {
        transcribeCalls++;
        return {
          ok: true as const,
          result: { text: "Dobrý den.", language: "cs", provider: "test" },
        };
      },
      analyse: async () => {
        analyseCalls++;
        return { ok: true as const, analysis: ANALYSIS };
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/mpeg" } })) as typeof fetch;
    try {
      // Cron může tick spustit znovu dřív, než doběhne ten předchozí.
      await Promise.all([
        pipeline.processCallPipeline(providers),
        pipeline.processCallPipeline(providers),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(transcribeCalls).toBe(1);
    expect(analyseCalls).toBe(1);
    const row = await calls.getCall(call.callId);
    expect(row?.transcript_status).toBe("done");
    expect(row?.analysis_status).toBe("done");
  });

  it("zaseknuté zpracování se vrátí do fronty", async () => {
    const seeded = await seed();
    const call = await completedCall(seeded);
    await sql`
      update calls set transcript_status = 'processing', updated_at = now() - interval '30 minutes'
       where id = ${call.callId}
    `;
    expect(await calls.resetStalePipeline()).toBe(1);
    expect((await calls.getCall(call.callId))?.transcript_status).toBe("pending");
  });

  it("uzavře hovor, který se nikdy nespojil s providerem", async () => {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    if (!started.ok) throw new Error(started.error);

    // Čerstvý hovor se neuklízí: může se právě teď vytáčet.
    expect(await calls.reapAbandonedCalls()).toBe(0);
    expect((await calls.getCall(started.call.callId))?.status).toBe("queued");

    await sql`
      update calls set started_at = now() - interval '1 hour' where id = ${started.call.callId}
    `;
    expect(await calls.reapAbandonedCalls()).toBe(1);

    const row = await calls.getCall(started.call.callId);
    expect(row?.status).toBe("failed");
    // Jinak by v historii navždy svítilo "nahrávka se zpracovává".
    expect(row?.recording_status).toBe("disabled");
    expect(row?.transcript_status).toBe("skipped");
  });

  it("bez klíčů nechá hovory ve frontě a neztratí je", async () => {
    const seeded = await seed();
    const call = await completedCall(seeded);
    const key = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await pipeline.processCallPipeline();
      expect(result.skipped).toContain("OPENAI_API_KEY");
      expect(result.picked).toBe(0);
    } finally {
      if (key) process.env.OPENAI_API_KEY = key;
    }
    expect((await calls.getCall(call.callId))?.transcript_status).toBe("pending");
  });
});

// --------------------------------------------- napojení na doménu hovoru
describe("napojení na výsledky a frontu", () => {
  it("spojí telefonát se zapsaným výsledkem", async () => {
    const seeded = await seed();
    const call = await completedCall(seeded);

    const logged = await calling.logCall({
      campaignContactId: seeded.campaignContactId,
      outcome: "callback",
      callerId: seeded.callerId,
      callbackAt: new Date(Date.now() + 3 * 86_400_000),
      callId: call.callId,
    });
    expect(logged.ok).toBe(true);

    const row = await calls.getCall(call.callId);
    expect(row?.call_activity_id).not.toBeNull();
    const [activity] = await sql<{ outcome: string }[]>`
      select outcome from call_activities where id = ${row!.call_activity_id!}
    `;
    expect(activity.outcome).toBe("callback");
  });

  it("výsledek z telefonátu normálně posune kadenci i frontu", async () => {
    const seeded = await seed();
    const call = await completedCall(seeded);
    await calling.logCall({
      campaignContactId: seeded.campaignContactId,
      outcome: "no_answer",
      callerId: seeded.callerId,
      callId: call.callId,
    });

    const [row] = await sql<{ call_attempts: number; next_call_at: Date | null }[]>`
      select call_attempts, next_call_at from campaign_contacts where id = ${seeded.campaignContactId}
    `;
    expect(row.call_attempts).toBe(1);
    expect(row.next_call_at).not.toBeNull();
    expect(await calling.listCallQueue(seeded.campaignId)).toHaveLength(0);
  });

  it("po konečném výsledku už kontakt nejde vytočit", async () => {
    const seeded = await seed();
    const call = await completedCall(seeded);
    await calling.logCall({
      campaignContactId: seeded.campaignContactId,
      outcome: "do_not_call",
      callerId: seeded.callerId,
      callId: call.callId,
    });

    expect(await calling.listCallQueue(seeded.campaignId)).toHaveLength(0);
    const again = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: seeded.callerId,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("suppressed");
  });

  it("nabídne poslední telefonát bez zapsaného výsledku", async () => {
    const seeded = await seed();
    const call = await completedCall(seeded);
    const pending = await calls.getUnloggedCall({ campaignContactId: seeded.campaignContactId });
    expect(pending?.id).toBe(call.callId);

    await calling.logCall({
      campaignContactId: seeded.campaignContactId,
      outcome: "not_interested",
      callerId: seeded.callerId,
      callId: call.callId,
    });
    expect(await calls.getUnloggedCall({ campaignContactId: seeded.campaignContactId })).toBeNull();
  });

  it("telefonáty se dají číst k firmě i ke kontaktu", async () => {
    const seeded = await seed();
    await completedCall(seeded);
    expect(await calls.listCallsForCompany(seeded.companyId)).toHaveLength(1);
    expect(await calls.listCallsForContact(seeded.contactIds[0])).toHaveLength(1);

    const telemetry = await calls.getCallTelemetry(7);
    expect(telemetry.calls).toBe(1);
    expect(telemetry.connected).toBe(1);
    expect(telemetry.talk_seconds).toBe(222);
  });
});
