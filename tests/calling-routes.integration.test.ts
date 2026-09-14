import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";

/**
 * HTTP vrstva volání.
 *
 * Tohle je hranice, na které stojí bezpečnost celé funkce: token dostane
 * jen přihlášená relace a webhooky přijímají jen to, co podepsalo Twilio.
 * Testuje se proto přes skutečné handlery, ne přes pomocné funkce.
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

let authenticated = true;
let selectedCaller: string | null = null;

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return { ...actual, isAuthenticated: async () => authenticated, requireAuth: async () => {} };
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
  authenticated = true;
  selectedCaller = null;
  Object.assign(process.env, TWILIO_ENV);
});

afterEach(() => {
  for (const key of Object.keys(TWILIO_ENV)) delete process.env[key as keyof typeof TWILIO_ENV];
});

afterAll(async () => {
  await closeDatabase();
});

function signedRequest(path: string, params: Record<string, string>): NextRequest {
  const url = `${BASE}${path}`;
  const body = new URLSearchParams(params);
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": getExpectedTwilioSignature(AUTH_TOKEN, url, params),
    },
    body: body.toString(),
  });
}

function unsignedRequest(path: string, params: Record<string, string>, signature = "spatny"): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: new URLSearchParams(params).toString(),
  });
}

async function seed() {
  const result = await seedCampaign({
    contacts: [{ email: "sef@acme.test", first_name: "Ana", company: "Acme" }],
  });
  await sql`update campaigns set calling_enabled = true where id = ${result.campaignId}`;
  await sql`update contacts set phone = '+420777123456' where email = 'sef@acme.test'`;
  return { ...result, campaignContactId: result.campaignContactIds[0] };
}

// ------------------------------------------------------------------ token
describe("token endpoint", () => {
  it("nevydá token nepřihlášenému", async () => {
    authenticated = false;
    const { GET } = await import("@/app/api/calling/token/route");
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("vydá podepsaný token přihlášenému", async () => {
    const { GET } = await import("@/app/api/calling/token/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { configured: boolean; token: string };
    expect(body.configured).toBe(true);
    expect(body.token.split(".")).toHaveLength(3);
    // Token se nesmí ukládat do cache - je krátkodobý a osobní.
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("řekne, co chybí, místo aby spadl", async () => {
    delete process.env.TWILIO_API_KEY_SECRET;
    const { GET } = await import("@/app/api/calling/token/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { configured: boolean; missing: string[] };
    expect(body.configured).toBe(false);
    expect(body.missing).toContain("TWILIO_API_KEY_SECRET");
  });
});

// ------------------------------------------------------------ zahájení
describe("zahájení hovoru", () => {
  it("nepustí nepřihlášeného", async () => {
    authenticated = false;
    const seeded = await seed();
    const { POST } = await import("@/app/api/calling/calls/route");
    const response = await POST(
      new NextRequest(`${BASE}/api/calling/calls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ campaignContactId: seeded.campaignContactId }),
      }),
    );
    expect(response.status).toBe(401);
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from calls`;
    expect(count).toBe(0);
  });

  it("ignoruje číslo poslané klientem a vezme si ho z databáze", async () => {
    const seeded = await seed();
    // Hovor bez vybraného callera se od téhle verze nezaloží vůbec - viz
    // test níž. Tady jde o něco jiného, takže caller prostě vybraný je.
    selectedCaller = await (await import("@/lib/queries/calling")).createCaller({
      name: "Jan",
      email: null,
      phone: null,
    });
    const { POST } = await import("@/app/api/calling/calls/route");
    const response = await POST(
      new NextRequest(`${BASE}/api/calling/calls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Pokus vytočit si cokoli přes náš účet.
        body: JSON.stringify({
          campaignContactId: seeded.campaignContactId,
          destination: "+19001234567",
          phone: "+19001234567",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { call: { destination: string } };
    expect(body.call.destination).toBe("+420777123456");

    const [row] = await sql<{ destination: string }[]>`select destination from calls`;
    expect(row.destination).toBe("+420777123456");
  });

  it("bez vybraného callera hovor nezaloží", async () => {
    const seeded = await seed();
    selectedCaller = null;

    const { POST } = await import("@/app/api/calling/calls/route");
    const response = await POST(
      new NextRequest(`${BASE}/api/calling/calls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ campaignContactId: seeded.campaignContactId }),
      }),
    );

    // Hovor, který se nedá nikomu připsat, je pro reporting ztracený.
    // Radši se nezaloží, než aby vznikl bez majitele.
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("no_caller");

    const [row] = await sql<{ count: number }[]>`select count(*)::int as count from calls`;
    expect(row.count).toBe(0);
  });

  it("odmítne nesmyslné id", async () => {
    const { POST } = await import("@/app/api/calling/calls/route");
    const response = await POST(
      new NextRequest(`${BASE}/api/calling/calls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ campaignContactId: "'; drop table calls; --" }),
      }),
    );
    expect(response.status).toBe(400);
  });
});

// ------------------------------------------------------------------ TwiML
describe("TwiML endpoint", () => {
  it("bez platného podpisu nevytočí nic", async () => {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: null,
    });
    if (!started.ok) throw new Error(started.error);

    const { POST } = await import("@/app/api/calling/voice/route");
    const response = await POST(
      unsignedRequest("/api/calling/voice", { callId: started.call.callId, CallSid: "CA-x" }),
    );
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toContain("+420777123456");
  });

  it("s platným podpisem vytočí číslo z databáze", async () => {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: null,
    });
    if (!started.ok) throw new Error(started.error);

    const { POST } = await import("@/app/api/calling/voice/route");
    const response = await POST(
      signedRequest("/api/calling/voice", { callId: started.call.callId, CallSid: "CA-ok" }),
    );
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain("<Dial");
    expect(xml).toContain("+420777123456");
    expect(xml).toContain('callerId="+420222222222"');
    expect(xml).toContain('record="record-from-answer-dual"');

    // Hovor se spároval s hovorem u providera, takže na něj sednou webhooky.
    const stored = await calls.getCall(started.call.callId);
    expect(stored?.provider_call_sid).toBe("CA-ok");
  });

  it("nenahrává, když je nahrávání vypnuté", async () => {
    const seeded = await seed();
    await sql`update app_settings set call_recording_enabled = false where id = true`;
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: null,
    });
    if (!started.ok) throw new Error(started.error);

    const { POST } = await import("@/app/api/calling/voice/route");
    const xml = await (
      await POST(signedRequest("/api/calling/voice", { callId: started.call.callId, CallSid: "CA-nr" }))
    ).text();
    // Hovor proběhne, jen se nenahrává.
    expect(xml).toContain("<Dial");
    expect(xml).toContain("+420777123456");
    expect(xml).not.toContain("record=");
  });

  it("neznámý hovor nevytočí", async () => {
    const { POST } = await import("@/app/api/calling/voice/route");
    const response = await POST(
      signedRequest("/api/calling/voice", {
        callId: "00000000-0000-0000-0000-000000000000",
        CallSid: "CA-none",
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("<Hangup/>");
  });
});

// --------------------------------------------------------------- webhooky
describe("webhooky", () => {
  async function withCall() {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: null,
    });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, "CA-hook", "+420222222222");
    return started.call;
  }

  it("status: odmítne nepodepsaný požadavek a nic nezmění", async () => {
    const call = await withCall();
    const { POST } = await import("@/app/api/calling/status/route");
    const response = await POST(
      unsignedRequest("/api/calling/status", { CallSid: "CA-hook", CallStatus: "completed" }),
    );
    expect(response.status).toBe(403);
    expect((await calls.getCall(call.callId))?.status).toBe("queued");
  });

  it("status: podepsaný požadavek posune hovor", async () => {
    const call = await withCall();
    const { POST } = await import("@/app/api/calling/status/route");
    const response = await POST(
      signedRequest("/api/calling/status", {
        CallSid: "CA-hook",
        CallStatus: "completed",
        CallDuration: "132",
      }),
    );
    expect(response.status).toBe(200);
    const row = await calls.getCall(call.callId);
    expect(row?.status).toBe("completed");
    expect(row?.duration_seconds).toBe(132);
  });

  it("status: událost k neznámému hovoru nevrací chybu", async () => {
    const { POST } = await import("@/app/api/calling/status/route");
    const response = await POST(
      signedRequest("/api/calling/status", { CallSid: "CA-cizi", CallStatus: "completed" }),
    );
    // 200 schválně: opakované doručování něčeho, s čím nic neuděláme,
    // by jen zatěžovalo obě strany.
    expect(response.status).toBe(200);
    expect((await response.json()) as { matched: boolean }).toMatchObject({ matched: false });
  });

  it("recording: odmítne nepodepsaný požadavek", async () => {
    const call = await withCall();
    const { POST } = await import("@/app/api/calling/recording/route");
    const response = await POST(
      unsignedRequest("/api/calling/recording", {
        CallSid: "CA-hook",
        RecordingStatus: "completed",
        RecordingUrl: "https://zlo.example/nahravka",
      }),
    );
    expect(response.status).toBe(403);
    // Podstrčený odkaz na cizí nahrávku se nesmí uložit.
    expect((await calls.getCall(call.callId))?.recording_url).toBeNull();
  });

  it("recording: podepsaný požadavek uloží nahrávku", async () => {
    const call = await withCall();
    const { POST } = await import("@/app/api/calling/recording/route");
    const response = await POST(
      signedRequest("/api/calling/recording", {
        CallSid: "CA-hook",
        RecordingStatus: "completed",
        RecordingSid: "RE-1",
        RecordingUrl: "https://api.twilio.com/recordings/RE-1",
        RecordingDuration: "130",
      }),
    );
    expect(response.status).toBe(200);
    const row = await calls.getCall(call.callId);
    expect(row?.recording_status).toBe("available");
    expect(row?.recording_sid).toBe("RE-1");
    expect(row?.recording_duration_seconds).toBe(130);
  });
});

// ------------------------------------------- párování větví a idempotence
describe("párování webhooků na správný hovor", () => {
  async function withCall(sid = "CA-parent") {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: null,
    });
    if (!started.ok) throw new Error(started.error);
    // Rodičovský hovor je ten z prohlížeče; jeho SID přijde do TwiML
    // endpointu a ukládá se jako provider_call_sid.
    await calls.attachProviderCall(started.call.callId, sid, "+420222222222");
    return started.call;
  }

  it("status z PSTN větve sedne na hovor podle ParentCallSid", async () => {
    const call = await withCall();
    const { POST } = await import("@/app/api/calling/status/route");

    // Přesně to, co Twilio posílá u <Number statusCallback>: CallSid je
    // odchozí větev, ParentCallSid hovor z prohlížeče.
    for (const [status, extra] of [
      ["initiated", {}],
      ["ringing", {}],
      ["in-progress", {}],
      ["completed", { CallDuration: "222" }],
    ] as [string, Record<string, string>][]) {
      const response = await POST(
        signedRequest("/api/calling/status", {
          AccountSid: "AC00000000000000000000000000000000",
          CallSid: "CA-child-leg",
          ParentCallSid: "CA-parent",
          CallStatus: status,
          Direction: "outbound-dial",
          To: "+420777123456",
          From: "+420222222222",
          ...extra,
        }),
      );
      expect((await response.json()) as { matched: boolean }).toMatchObject({ matched: true });
    }

    const row = await calls.getCall(call.callId);
    expect(row?.status).toBe("completed");
    expect(row?.duration_seconds).toBe(222);
    expect(row?.answered_at).not.toBeNull();
    // Hovor si drží SID rodiče, ne odchozí větve.
    expect(row?.provider_call_sid).toBe("CA-parent");
  });

  it("označí hovor za spojený i když se událost o zvednutí ztratí", async () => {
    const call = await withCall("CA-lost");
    const { POST } = await import("@/app/api/calling/status/route");
    await POST(
      signedRequest("/api/calling/status", {
        CallSid: "CA-child",
        ParentCallSid: "CA-lost",
        CallStatus: "completed",
        CallDuration: "97",
      }),
    );
    const row = await calls.getCall(call.callId);
    expect(row?.answered_at).not.toBeNull();
    expect(row?.duration_seconds).toBe(97);
  });

  it("nedovolaný hovor spojený není", async () => {
    const call = await withCall("CA-noans");
    const { POST } = await import("@/app/api/calling/status/route");
    await POST(
      signedRequest("/api/calling/status", {
        CallSid: "CA-child",
        ParentCallSid: "CA-noans",
        CallStatus: "no-answer",
        CallDuration: "0",
      }),
    );
    const row = await calls.getCall(call.callId);
    expect(row?.status).toBe("no_answer");
    expect(row?.answered_at).toBeNull();
  });

  it("nahrávka z <Dial> sedne na hovor podle CallSid rodiče", async () => {
    const call = await withCall("CA-rec");
    const { POST } = await import("@/app/api/calling/recording/route");
    // U <Dial recordingStatusCallback> je CallSid ten hovor, ve kterém
    // <Dial> byl - tedy rodič.
    const response = await POST(
      signedRequest("/api/calling/recording", {
        AccountSid: "AC00000000000000000000000000000000",
        CallSid: "CA-rec",
        RecordingSid: "RE-1",
        RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE-1",
        RecordingStatus: "completed",
        RecordingDuration: "220",
        RecordingChannels: "2",
        RecordingSource: "DialVerb",
      }),
    );
    expect((await response.json()) as { matched: boolean }).toMatchObject({ matched: true });
    const row = await calls.getCall(call.callId);
    expect(row?.recording_status).toBe("available");
    expect(row?.recording_sid).toBe("RE-1");
  });

  it("stejná událost doručená vícekrát stav nepoškodí", async () => {
    const call = await withCall("CA-dup");
    const status = await import("@/app/api/calling/status/route");
    const recording = await import("@/app/api/calling/recording/route");

    const statusParams = {
      CallSid: "CA-child",
      ParentCallSid: "CA-dup",
      CallStatus: "completed",
      CallDuration: "150",
    };
    const recordingParams = {
      CallSid: "CA-dup",
      RecordingSid: "RE-dup",
      RecordingUrl: "https://api.twilio.com/recordings/RE-dup",
      RecordingStatus: "completed",
      RecordingDuration: "148",
    };

    // Twilio doručuje "alespoň jednou", takže trojité doručení není
    // teoretický případ.
    for (let i = 0; i < 3; i++) {
      await status.POST(signedRequest("/api/calling/status", statusParams));
      await recording.POST(signedRequest("/api/calling/recording", recordingParams));
    }

    const row = await calls.getCall(call.callId);
    expect(row?.status).toBe("completed");
    expect(row?.duration_seconds).toBe(150);
    expect(row?.recording_status).toBe("available");
    expect(row?.recording_duration_seconds).toBe(148);
    // A hlavně: pořád jeden hovor, ne tři.
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from calls`;
    expect(count).toBe(1);
  });

  it("opožděné 'vyzvání' po ukončení hovor neoživí", async () => {
    const call = await withCall("CA-late");
    const { POST } = await import("@/app/api/calling/status/route");
    await POST(
      signedRequest("/api/calling/status", {
        CallSid: "CA-child",
        ParentCallSid: "CA-late",
        CallStatus: "completed",
        CallDuration: "60",
      }),
    );
    await POST(
      signedRequest("/api/calling/status", {
        CallSid: "CA-child",
        ParentCallSid: "CA-late",
        CallStatus: "ringing",
      }),
    );
    const row = await calls.getCall(call.callId);
    expect(row?.status).toBe("completed");
    expect(row?.duration_seconds).toBe(60);
  });
});

// ------------------------------------------------------ jak hovor dopadl
describe("konce hovoru, jak je hlásí Twilio", () => {
  async function endWith(sid: string, params: Record<string, string>) {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: null,
    });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, sid, null);
    const { POST } = await import("@/app/api/calling/status/route");
    await POST(
      signedRequest("/api/calling/status", {
        CallSid: `${sid}-child`,
        ParentCallSid: sid,
        ...params,
      }),
    );
    return calls.getCall(started.call.callId);
  }

  it("nikdo to nezvedl", async () => {
    const row = await endWith("CA-a", { CallStatus: "no-answer", CallDuration: "0" });
    expect(row?.status).toBe("no_answer");
    expect(row?.answered_at).toBeNull();
    // Na nahrávku se nečeká, není co nahrát.
    expect(row?.recording_status).toBe("disabled");
  });

  it("obsazeno", async () => {
    const row = await endWith("CA-b", { CallStatus: "busy" });
    expect(row?.status).toBe("busy");
    expect(row?.answered_at).toBeNull();
    expect(row?.transcript_status).toBe("skipped");
  });

  it("odmítnuto (Twilio to hlásí jako canceled)", async () => {
    const row = await endWith("CA-c", { CallStatus: "canceled" });
    expect(row?.status).toBe("canceled");
    expect(row?.answered_at).toBeNull();
  });

  it("hlasová schránka nebo krátké zvednutí a zavěšení", async () => {
    // Záznamník se tváří jako zvednutý hovor a rozlišit ho neumíme.
    // Důležité je, že se chová jako spojený a nahrávka se čeká.
    const row = await endWith("CA-d", { CallStatus: "completed", CallDuration: "6" });
    expect(row?.status).toBe("completed");
    expect(row?.answered_at).not.toBeNull();
    expect(row?.duration_seconds).toBe(6);
    expect(row?.recording_status).toBe("pending");
  });

  it("normální spojený hovor", async () => {
    const row = await endWith("CA-e", { CallStatus: "completed", CallDuration: "245" });
    expect(row?.status).toBe("completed");
    expect(row?.answered_at).not.toBeNull();
    expect(row?.duration_seconds).toBe(245);
    expect(row?.recording_status).toBe("pending");
  });
});

// ------------------------------------------------------------ stav hovoru
describe("čtení stavu hovoru", () => {
  it("nepustí nepřihlášeného a neprozradí odkaz na nahrávku", async () => {
    const seeded = await seed();
    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactId,
      callerId: null,
    });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, "CA-read", null);
    await calls.recordRecording({
      providerCallSid: "CA-read",
      recordingSid: "RE-read",
      recordingUrl: "https://api.twilio.com/recordings/RE-read",
      durationSeconds: 10,
      status: "completed",
    });

    const { GET } = await import("@/app/api/calling/calls/[id]/route");
    authenticated = false;
    const denied = await GET(new Request(`${BASE}/x`), {
      params: Promise.resolve({ id: started.call.callId }),
    });
    expect(denied.status).toBe(401);

    authenticated = true;
    const allowed = await GET(new Request(`${BASE}/x`), {
      params: Promise.resolve({ id: started.call.callId }),
    });
    const body = (await allowed.json()) as Record<string, unknown>;
    expect(body.recordingStatus).toBe("available");
    // Nahrávka je za basic auth Twilia; její URL nemá v prohlížeči co dělat.
    expect(JSON.stringify(body)).not.toContain("api.twilio.com");
  });
});
