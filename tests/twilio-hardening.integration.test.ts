import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";

/**
 * Twilio: hardening, ne redesign.
 *
 * Doplňuje `calling-routes.integration.test.ts` o případy, které tam
 * nebyly: všechny konce hovoru, webhooky mimo pořadí a dvakrát, a to,
 * že se přes token ani přes chybu nedostane ven žádné tajemství.
 *
 * Skutečný hovor to netestuje a netváří se tak - Twilio je nahrazené
 * podepsanými požadavky, jak by je poslalo.
 */

const BASE = "https://vexy.test";
const AUTH_TOKEN = "test-auth-token";
const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_API_KEY_SID: "SK00000000000000000000000000000000",
  TWILIO_API_KEY_SECRET: "test-api-key-secret",
  TWILIO_TWIML_APP_SID: "AP00000000000000000000000000000000",
  TWILIO_CALLER_ID: "+420222222222",
  TWILIO_WEBHOOK_BASE_URL: BASE,
};

const SIGNED_IN_ADMIN = {
  id: "00000000-0000-0000-0000-0000000000ad",
  email: "admin@vexy.cz", name: "Admin", role: "admin" as const,
  caller_id: null, is_active: true, created_at: new Date(),
};
let selectedCaller: string | null = null;

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    isAuthenticated: async () => true,
    currentUser: async () => SIGNED_IN_ADMIN,
    requireAuth: async () => SIGNED_IN_ADMIN,
  };
});
vi.mock("@/lib/caller-session", () => ({
  getSelectedCallerId: async () => selectedCaller,
  setSelectedCallerId: async () => {},
  clearSelectedCaller: async () => {},
}));

let sql: typeof import("@/lib/db").sql;
let calls: typeof import("@/lib/queries/calls");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  calls = await import("@/lib/queries/calls");
  selectedCaller = null;
  Object.assign(process.env, TWILIO_ENV);
});

afterAll(async () => {
  await closeDatabase();
});

function signed(path: string, params: Record<string, string>): NextRequest {
  const url = `${BASE}${path}`;
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": getExpectedTwilioSignature(AUTH_TOKEN, url, params),
    },
    body: new URLSearchParams(params).toString(),
  });
}

/** Rozvolaný hovor s přiřazeným SID. */
async function callWithSid(sid = "CA-hard-1") {
  const seed = await seedCampaign({ contacts: [{ email: "a@acme.test" }] });
  await sql`update campaigns set calling_enabled = true where id = ${seed.campaignId}`;
  await sql`update contacts set phone = '+420777123456' where email = 'a@acme.test'`;
  const calling = await import("@/lib/queries/calling");
  const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
  const started = await calls.startCall({ campaignContactId: seed.campaignContactIds[0], callerId });
  if (!started.ok) throw new Error(started.error);
  await calls.attachProviderCall(started.call.callId, sid, "+420222222222");
  return { ...seed, callId: started.call.callId, callerId, sid };
}

async function callRow(callId: string) {
  const [row] = await sql<
    { status: string; duration_seconds: number | null; answered_at: Date | null;
      contact_id: string; company_id: string | null; caller_id: string | null;
      provider_call_sid: string | null }[]
  >`select status, duration_seconds, answered_at, contact_id, company_id, caller_id,
           provider_call_sid from calls where id = ${callId}`;
  return row;
}

// =========================================================== konce hovoru

describe("všechny konce hovoru", () => {
  // Vnitřní stavy. Překlad z twilioích "no-answer" a "in-progress" hlídá
  // `lifecycleFromTwilio` a webhookové testy v calling-routes; tady jde
  // o to, že se každý konec skutečně uloží.
  const ENDINGS = ["busy", "no_answer", "canceled", "failed", "completed"] as const;

  for (const ending of ENDINGS) {
    it(`${ending} se uloží`, async () => {
      const call = await callWithSid(`CA-${ending}`);
      await calls.recordCallStatus({
        providerCallSid: call.sid,
        status: ending,
        durationSeconds: ending === "completed" ? 42 : null,
      });
      expect((await callRow(call.callId)).status).toBe(ending);
    });
  }

  it("spojený hovor si pamatuje délku i okamžik zvednutí", async () => {
    const call = await callWithSid("CA-answered");
    await calls.recordCallStatus({ providerCallSid: call.sid, status: "in_progress" });
    await calls.recordCallStatus({ providerCallSid: call.sid, status: "completed", durationSeconds: 95 });
    const row = await callRow(call.callId);
    expect(row.duration_seconds).toBe(95);
    expect(row.answered_at).not.toBeNull();
  });

  it("hovor drží kontakt, firmu, callera i SID", async () => {
    const call = await callWithSid("CA-attribution");
    const row = await callRow(call.callId);
    expect(row.contact_id).toBe(call.contactIds[0]);
    expect(row.caller_id).toBe(call.callerId);
    expect(row.provider_call_sid).toBe(call.sid);
  });
});

// ======================================================== idempotence

describe("webhooky jsou idempotentní", () => {
  it("stejná událost dvakrát nezmění výsledek", async () => {
    const call = await callWithSid("CA-twice");
    await calls.recordCallStatus({ providerCallSid: call.sid, status: "completed", durationSeconds: 30 });
    const first = await callRow(call.callId);
    await calls.recordCallStatus({ providerCallSid: call.sid, status: "completed", durationSeconds: 30 });
    const second = await callRow(call.callId);
    expect(second).toEqual(first);
  });

  it("opožděná dřívější událost nepřepíše konečný stav", async () => {
    const call = await callWithSid("CA-late");
    await calls.recordCallStatus({ providerCallSid: call.sid, status: "completed", durationSeconds: 60 });
    // "Vyzvání" dorazí až po ukončení - mimo pořadí.
    await calls.recordCallStatus({ providerCallSid: call.sid, status: "ringing" });
    expect((await callRow(call.callId)).status).toBe("completed");
  });

  it("dva různé konce: vyhrává ten, co dorazil první", async () => {
    const call = await callWithSid("CA-conflict");
    await calls.recordCallStatus({ providerCallSid: call.sid, status: "no_answer" });
    await calls.recordCallStatus({ providerCallSid: call.sid, status: "busy" });
    expect((await callRow(call.callId)).status).toBe("no_answer");
  });

  it("událost k neznámému SID nic nerozbije", async () => {
    await expect(
      calls.recordCallStatus({ providerCallSid: "CA-neexistuje", status: "completed" }),
    ).resolves.not.toThrow();
  });
});

// =========================================================== bezpečnost

describe("tajemství nikam neunikají", () => {
  it("token endpoint nevrací Auth Token ani tajemství API klíče", async () => {
    const { GET } = await import("@/app/api/calling/token/route");
    const raw = await (await GET()).text();
    expect(raw).not.toContain(TWILIO_ENV.TWILIO_AUTH_TOKEN);
    expect(raw).not.toContain(TWILIO_ENV.TWILIO_API_KEY_SECRET);
  });

  it("chybějící konfigurace vrátí jména proměnných, ne hodnoty", async () => {
    delete process.env.TWILIO_API_KEY_SECRET;
    const { GET } = await import("@/app/api/calling/token/route");
    const body = (await (await GET()).json()) as { configured: boolean; missing: string[] };
    expect(body.configured).toBe(false);
    expect(body.missing).toContain("TWILIO_API_KEY_SECRET");
    expect(JSON.stringify(body)).not.toContain(TWILIO_ENV.TWILIO_AUTH_TOKEN);
  });

  it("chyba při zakládání hovoru nevypíše nic citlivého", async () => {
    selectedCaller = null;
    const seed = await seedCampaign({ contacts: [{ email: "a@acme.test" }] });
    const { POST } = await import("@/app/api/calling/calls/route");
    const response = await POST(
      new NextRequest(`${BASE}/api/calling/calls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ campaignContactId: seed.campaignContactIds[0] }),
      }),
    );
    const raw = await response.text();
    for (const secret of Object.values(TWILIO_ENV)) {
      if (secret.startsWith("http")) continue;
      expect(raw).not.toContain(secret);
    }
  });

  it("TwiML nevrací tajemství, jen číslo z databáze", async () => {
    const call = await callWithSid("CA-twiml");
    await sql`update calls set status = 'queued', provider_call_sid = null where id = ${call.callId}`;
    const { POST } = await import("@/app/api/calling/voice/route");
    const response = await POST(
      signed("/api/calling/voice", { callId: call.callId, CallSid: "CA-twiml-2" }),
    );
    const xml = await response.text();
    expect(xml).toContain("+420777123456");
    expect(xml).not.toContain(TWILIO_ENV.TWILIO_AUTH_TOKEN);
    expect(xml).not.toContain(TWILIO_ENV.TWILIO_API_KEY_SECRET);
  });

  it("nepodepsaný webhook neprojde", async () => {
    const { POST } = await import("@/app/api/calling/status/route");
    const response = await POST(
      new NextRequest(`${BASE}/api/calling/status`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "podvrh" },
        body: new URLSearchParams({ CallSid: "CA-x", CallStatus: "completed" }).toString(),
      }),
    );
    expect(response.status).toBe(403);
  });
});

// ======================================================== vstupní kontroly

describe("vstupy před vytočením", () => {
  it("kontakt bez čísla se nevytočí", async () => {
    const seed = await seedCampaign({ contacts: [{ email: "bez@acme.test" }] });
    const calling = await import("@/lib/queries/calling");
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    const result = await calls.startCall({ campaignContactId: seed.campaignContactIds[0], callerId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no_phone");
  });

  it("nesmyslné číslo se nevytočí", async () => {
    const seed = await seedCampaign({ contacts: [{ email: "spatne@acme.test" }] });
    await sql`update contacts set phone = 'zavolej mi' where email = 'spatne@acme.test'`;
    const calling = await import("@/lib/queries/calling");
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    const result = await calls.startCall({ campaignContactId: seed.campaignContactIds[0], callerId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no_phone");
  });

  it("dvojklik nenechá dva živé hovory jednoho callera", async () => {
    // Skutečný dvojklik: oba požadavky doběhnou dřív, než se kterýkoli
    // dostane k Twiliu. Druhý ten první uzavře, takže placené linky
    // nikdy nejsou dvě.
    const seed = await seedCampaign({ contacts: [{ email: "a@acme.test" }] });
    await sql`update contacts set phone = '+420777123456' where email = 'a@acme.test'`;
    const calling = await import("@/lib/queries/calling");
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });

    const first = await calls.startCall({ campaignContactId: seed.campaignContactIds[0], callerId });
    const second = await calls.startCall({ campaignContactId: seed.campaignContactIds[0], callerId });
    expect(first.ok && second.ok).toBe(true);

    const [row] = await sql<{ live: number }[]>`
      select count(*) filter (where status not in ('failed','completed','canceled'))::int as live
        from calls where caller_id = ${callerId}`;
    expect(row.live).toBe(1);
  });

  it("rozjednaný hovor zablokuje další pokus", async () => {
    const call = await callWithSid("CA-probiha");
    await calls.recordCallStatus({ providerCallSid: call.sid, status: "in_progress" });
    const second = await calls.startCall({
      campaignContactId: call.campaignContactIds[0], callerId: call.callerId,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("already_calling");
  });

  it("hovor na seznamu nevolat se nezaloží", async () => {
    const call = await callWithSid("CA-dnc");
    await sql`update calls set status = 'completed' where id = ${call.callId}`;
    await sql`insert into call_suppression (contact_id, reason) values (${call.contactIds[0]}, 'test')`;
    const result = await calls.startCall({
      campaignContactId: call.campaignContactIds[0], callerId: call.callerId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("suppressed");
  });
});
