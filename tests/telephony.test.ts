import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  createVoiceAccessToken,
  dialTwiml,
  twilioSignature,
  verifyTwilioSignature,
  type TwilioConfig,
} from "@/lib/telephony/twilio";
import {
  formatDuration,
  lifecycleFromTwilio,
  parseAnalysis,
  shouldAdvanceLifecycle,
  suggestedOutcomeFrom,
  toE164,
} from "@/lib/telephony/call-state";

/**
 * Serverová část Twilia je psaná ručně, takže musí být otestovaná proti
 * tomu, co Twilio skutečně očekává - ne proti tomu, co jsme si mysleli.
 */

const CONFIG: TwilioConfig = {
  accountSid: "AC00000000000000000000000000000000",
  authToken: "test-auth-token",
  apiKeySid: "SK00000000000000000000000000000000",
  apiKeySecret: "test-api-key-secret",
  twimlAppSid: "AP00000000000000000000000000000000",
  callerId: "+420222222222",
};

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
}

describe("access token", () => {
  const now = Date.UTC(2026, 8, 13, 10, 0, 0);
  const { token, expiresAt } = createVoiceAccessToken(CONFIG, { identity: "caller_1", now });

  it("is a JWT Twilio will accept", () => {
    const [header, payload, signature] = token.split(".");
    expect(decode(header)).toEqual({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" });

    const claims = decode(payload) as Record<string, unknown>;
    // Vydavatelem je API klíč, subjektem účet - obráceně to Twilio odmítne.
    expect(claims.iss).toBe(CONFIG.apiKeySid);
    expect(claims.sub).toBe(CONFIG.accountSid);
    expect(claims.exp).toBe(Math.floor(now / 1000) + 3600);
    expect(expiresAt).toBe((Math.floor(now / 1000) + 3600) * 1000);

    const grants = claims.grants as { identity: string; voice: Record<string, unknown> };
    expect(grants.identity).toBe("caller_1");
    expect(grants.voice.outgoing).toEqual({ application_sid: CONFIG.twimlAppSid });
    // Příchozí hovory produkt neřeší a token je nesmí povolit.
    expect(grants.voice.incoming).toEqual({ allow: false });

    const expected = createHmac("sha256", CONFIG.apiKeySecret)
      .update(`${header}.${payload}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(signature).toBe(expected);
  });

  it("is signed with the API key secret, never the account auth token", () => {
    const withAuthToken = createHmac("sha256", CONFIG.authToken)
      .update(token.split(".").slice(0, 2).join("."))
      .digest("base64");
    expect(token.split(".")[2]).not.toBe(withAuthToken);
  });

  it("keeps the lifetime inside Twilio's limits", () => {
    expect(decode(createVoiceAccessToken(CONFIG, { identity: "x", ttlSeconds: 5, now }).token.split(".")[1]).exp)
      .toBe(Math.floor(now / 1000) + 60);
    expect(decode(createVoiceAccessToken(CONFIG, { identity: "x", ttlSeconds: 999_999, now }).token.split(".")[1]).exp)
      .toBe(Math.floor(now / 1000) + 24 * 3600);
  });
});

describe("webhook signature", () => {
  const url = "https://vexy.example.com/api/calling/status";
  const params = { CallSid: "CA123", CallStatus: "completed", CallDuration: "42" };

  it("matches Twilio's documented algorithm", () => {
    // URL + parametry seřazené podle jména, slepené bez oddělovačů.
    const expected = createHmac("sha1", CONFIG.authToken)
      .update("https://vexy.example.com/api/calling/statusCallDuration42CallSidCA123CallStatuscompleted")
      .digest("base64");
    expect(twilioSignature(CONFIG.authToken, url, params)).toBe(expected);
  });

  it("accepts a correct signature", () => {
    const signature = twilioSignature(CONFIG.authToken, url, params);
    expect(verifyTwilioSignature(CONFIG.authToken, url, params, signature)).toBe(true);
  });

  it("rejects a tampered parameter, a wrong url and a missing signature", () => {
    const signature = twilioSignature(CONFIG.authToken, url, params);
    expect(
      verifyTwilioSignature(CONFIG.authToken, url, { ...params, CallStatus: "busy" }, signature),
    ).toBe(false);
    expect(verifyTwilioSignature(CONFIG.authToken, `${url}x`, params, signature)).toBe(false);
    expect(verifyTwilioSignature(CONFIG.authToken, url, params, null)).toBe(false);
    expect(verifyTwilioSignature("jiny-token", url, params, signature)).toBe(false);
  });
});

describe("TwiML", () => {
  it("dials the number from the server, with recording and callbacks", () => {
    const xml = dialTwiml({
      to: "+420777123456",
      callerId: CONFIG.callerId,
      record: true,
      statusCallbackUrl: "https://vexy.example.com/api/calling/status",
      recordingCallbackUrl: "https://vexy.example.com/api/calling/recording",
    });
    expect(xml).toContain(`callerId="${CONFIG.callerId}"`);
    expect(xml).toContain("<Number");
    expect(xml).toContain("+420777123456");
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain('statusCallbackEvent="initiated ringing answered completed"');
  });

  it("omits recording when it is switched off", () => {
    const xml = dialTwiml({ to: "+420777123456", callerId: CONFIG.callerId, record: false });
    expect(xml).not.toContain("record=");
    expect(xml).not.toContain("recordingStatusCallback");
  });

  it("escapes anything that could break out of the XML", () => {
    const xml = dialTwiml({ to: '+420777123456"/><Hangup/><x a="', callerId: "a&b", record: false });
    expect(xml).not.toContain("<Hangup/>");
    expect(xml).toContain("&amp;");
  });
});

describe("call lifecycle", () => {
  it("maps Twilio's vocabulary onto ours", () => {
    expect(lifecycleFromTwilio("initiated")).toBe("queued");
    expect(lifecycleFromTwilio("ringing")).toBe("ringing");
    expect(lifecycleFromTwilio("in-progress")).toBe("in_progress");
    expect(lifecycleFromTwilio("answered")).toBe("in_progress");
    expect(lifecycleFromTwilio("no-answer")).toBe("no_answer");
    expect(lifecycleFromTwilio("completed")).toBe("completed");
    expect(lifecycleFromTwilio("nesmysl")).toBeNull();
  });

  it("never moves a call backwards, whatever order the webhooks arrive in", () => {
    expect(shouldAdvanceLifecycle("queued", "ringing")).toBe(true);
    expect(shouldAdvanceLifecycle("in_progress", "ringing")).toBe(false);
    // Ukončený hovor je ukončený - opožděné "vyzvání" ho nesmí oživit.
    expect(shouldAdvanceLifecycle("completed", "ringing")).toBe(false);
    expect(shouldAdvanceLifecycle("completed", "failed")).toBe(false);
    expect(shouldAdvanceLifecycle("ringing", "no_answer")).toBe(true);
  });
});

describe("phone numbers", () => {
  it("accepts what people really type", () => {
    expect(toE164("+420 777 123 456")).toBe("+420777123456");
    expect(toE164("777 123 456")).toBe("+420777123456");
    expect(toE164("00420777123456")).toBe("+420777123456");
    expect(toE164("(777) 123-456")).toBe("+420777123456");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("refuses what cannot be dialled", () => {
    expect(toE164(null)).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164("nevím")).toBeNull();
    expect(toE164("123")).toBeNull();
    expect(toE164("+0777123456")).toBeNull();
  });
});

describe("analysis parsing", () => {
  it("keeps only what it understands", () => {
    const analysis = parseAnalysis({
      summary: "  Firma expanduje.  ",
      outcome: "callback",
      sentiment: "POSITIVE",
      pains: ["nestíhají nábor", "", 42],
      objections: "tohle není pole",
      budgetMentioned: "ano",
      importantQuotes: ["Zavolejte v pondělí."],
      neznamePole: "zahodit",
    });
    expect(analysis.summary).toBe("Firma expanduje.");
    expect(analysis.sentiment).toBe("positive");
    expect(analysis.pains).toEqual(["nestíhají nábor"]);
    expect(analysis.objections).toEqual([]);
    expect(analysis.budgetMentioned).toBeNull();
    expect(analysis.importantQuotes).toEqual(["Zavolejte v pondělí."]);
    expect("neznamePole" in analysis).toBe(false);
  });

  it("survives rubbish instead of throwing", () => {
    expect(parseAnalysis(null).summary).toBeNull();
    expect(parseAnalysis("ne").pains).toEqual([]);
    expect(parseAnalysis(123).sentiment).toBeNull();
  });
});

describe("suggested outcome", () => {
  it("accepts a value the domain knows", () => {
    expect(suggestedOutcomeFrom({ outcome: "meeting_booked" })).toBe("meeting_booked");
  });

  it("accepts the Czech label the model sometimes returns instead", () => {
    expect(suggestedOutcomeFrom({ outcome: "Nezastižen" })).toBe("no_answer");
  });

  it("refuses an outcome the application does not have", () => {
    // Kdyby si model vymyslel stav, rozbil by kadenci i frontu.
    expect(suggestedOutcomeFrom({ outcome: "super_hot_lead" })).toBeNull();
    expect(suggestedOutcomeFrom({ outcome: null })).toBeNull();
  });
});

describe("duration", () => {
  it("reads like a call timer", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(41)).toBe("00:41");
    expect(formatDuration(222)).toBe("03:42");
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(null)).toBe("—");
  });
});
