import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio bez SDK.
 *
 * Serverová část Voice je tři věci: podepsaný JWT pro prohlížeč, ověření
 * podpisu webhooku a kus XML. Dohromady to je zhruba tolik kódu, kolik má
 * náš CSV parser - a oproti balíčku `twilio` (desítky závislostí kvůli
 * celému REST API, které nepoužíváme) je to menší plocha, ne větší.
 *
 * Prohlížeč SDK samozřejmě potřebuje - WebRTC se ručně psát nedá.
 * To je @twilio/voice-sdk a běží jen na klientovi.
 */

// ------------------------------------------------------------ konfigurace

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  callerId: string;
}

export const TWILIO_ENV_VARS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_TWIML_APP_SID",
  "TWILIO_CALLER_ID",
] as const;

/** Co chybí, aby šlo volat. Prázdné pole = nakonfigurováno. */
export function missingTwilioEnv(): string[] {
  return TWILIO_ENV_VARS.filter((name) => !process.env[name]?.trim());
}

export function isTwilioConfigured(): boolean {
  return missingTwilioEnv().length === 0;
}

/**
 * Konfigurace, nebo výjimka. Čte se až při volání, ne při importu - `next
 * build` importuje moduly bez runtime env a nesmí na tom spadnout.
 */
export function twilioConfig(): TwilioConfig {
  const missing = missingTwilioEnv();
  if (missing.length > 0) {
    throw new Error(`Twilio není nakonfigurované: chybí ${missing.join(", ")}.`);
  }
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID!.trim(),
    authToken: process.env.TWILIO_AUTH_TOKEN!.trim(),
    apiKeySid: process.env.TWILIO_API_KEY_SID!.trim(),
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET!.trim(),
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID!.trim(),
    callerId: process.env.TWILIO_CALLER_ID!.trim(),
  };
}

// ------------------------------------------------------------ access token

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface AccessTokenOptions {
  identity: string;
  /** Platnost v sekundách. Twilio povoluje maximálně 24 hodin. */
  ttlSeconds?: number;
  now?: number;
}

/**
 * Access Token pro Voice SDK.
 *
 * Je to obyčejný HS256 JWT podepsaný TAJEMSTVÍM API KLÍČE - ne Auth
 * Tokenem. To je důležité: Auth Token je heslo k celému účtu a nikdy
 * nesmí opustit server ani v odvozené podobě, kdežto API klíč jde
 * kdykoli zneplatnit.
 */
export function createVoiceAccessToken(
  config: TwilioConfig,
  options: AccessTokenOptions,
): { token: string; identity: string; expiresAt: number } {
  const ttl = Math.min(Math.max(options.ttlSeconds ?? 3600, 60), 24 * 3600);
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const exp = now + ttl;

  const header = { alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${config.apiKeySid}-${now}`,
    iss: config.apiKeySid,
    sub: config.accountSid,
    // Malý posun zpět: hodiny serveru a Twilia se o pár sekund liší a
    // token "z budoucnosti" je odmítnutý.
    nbf: now - 30,
    exp,
    grants: {
      identity: options.identity,
      voice: {
        outgoing: { application_sid: config.twimlAppSid },
        // Příchozí hovory tenhle produkt neřeší; povolit je by znamenalo
        // pustit na prohlížeč hovory, které nikdo nečeká.
        incoming: { allow: false },
      },
    },
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = base64url(
    createHmac("sha256", config.apiKeySecret).update(signingInput).digest(),
  );
  return { token: `${signingInput}.${signature}`, identity: options.identity, expiresAt: exp * 1000 };
}

// --------------------------------------------------------- podpis webhooku

/**
 * Podpis, který Twilio posílá v X-Twilio-Signature.
 *
 * Algoritmus: HMAC-SHA1 Auth Tokenem nad URL, na kterou se volalo, za
 * kterou se připojí všechny POST parametry seřazené podle jména jako
 * `klíčhodnota` bez oddělovačů.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null,
): boolean {
  if (!signature) return false;
  const expected = twilioSignature(authToken, url, params);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) {
    // Stejná práce jako při shodě, aby délka neprosákla v čase odpovědi.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- TwiML

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface DialTwimlOptions {
  to: string;
  callerId: string;
  /** Kam Twilio hlásí stav a nahrávku. Absolutní URL. */
  statusCallbackUrl?: string | null;
  recordingCallbackUrl?: string | null;
  record: boolean;
  /** Vteřiny vyzvánění, než se to vzdá. */
  timeoutSeconds?: number;
}

/**
 * TwiML, které spojí prohlížeč s telefonním číslem.
 *
 * `record-from-answer-dual` nahrává až od okamžiku spojení a každou stranu
 * do vlastní stopy - to je potřeba, aby šlo později rozlišit mluvčí.
 */
export function dialTwiml(options: DialTwimlOptions): string {
  const attrs = [
    `callerId="${escapeXml(options.callerId)}"`,
    `timeout="${Math.max(5, Math.min(options.timeoutSeconds ?? 30, 120))}"`,
    `answerOnBridge="true"`,
  ];
  if (options.record) {
    attrs.push(`record="record-from-answer-dual"`);
    if (options.recordingCallbackUrl) {
      attrs.push(`recordingStatusCallback="${escapeXml(options.recordingCallbackUrl)}"`);
      attrs.push(`recordingStatusCallbackEvent="completed absent"`);
    }
  }

  const numberAttrs = options.statusCallbackUrl
    ? ` statusCallback="${escapeXml(options.statusCallbackUrl)}"` +
      ` statusCallbackEvent="initiated ringing answered completed"` +
      ` statusCallbackMethod="POST"`
    : "";

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Dial ${attrs.join(" ")}>` +
    `<Number${numberAttrs}>${escapeXml(options.to)}</Number>` +
    `</Dial>` +
    `</Response>`
  );
}

/** TwiML, které hovor slušně ukončí. Používá se, když něco nesedí. */
export function rejectTwiml(reason: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Say language="cs-CZ">${escapeXml(reason)}</Say><Hangup/></Response>`
  );
}

// ------------------------------------------------------------------- REST

/**
 * Stažení nahrávky. Jde o jediné místo, kde se sahá na Twilio REST API -
 * a je to prosté GET s basic auth, takže se kvůli němu nevyplatí tahat
 * celé SDK.
 */
export async function fetchRecording(
  config: TwilioConfig,
  recordingUrl: string,
): Promise<{ ok: true; audio: Buffer; contentType: string } | { ok: false; error: string }> {
  // Twilio posílá URL bez přípony; .mp3 je menší než wav a přepisovačům stačí.
  const url = recordingUrl.endsWith(".mp3") ? recordingUrl : `${recordingUrl}.mp3`;
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
  try {
    const response = await fetch(url, { headers: { authorization: `Basic ${auth}` } });
    if (!response.ok) {
      return { ok: false, error: `Twilio vrátilo ${response.status} při stahování nahrávky.` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return { ok: false, error: "Nahrávka je prázdná." };
    return {
      ok: true,
      audio: buffer,
      contentType: response.headers.get("content-type") ?? "audio/mpeg",
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Stav hovoru u providera. Slouží jako záchrana, když se webhook ztratí -
 * na stav hovoru se nedá spoléhat jen z událostí, které dorazí.
 */
export async function fetchCallStatus(
  config: TwilioConfig,
  callSid: string,
): Promise<{ ok: true; status: string; duration: number | null } | { ok: false; error: string }> {
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls/${callSid}.json`;
  try {
    const response = await fetch(url, { headers: { authorization: `Basic ${auth}` } });
    if (!response.ok) return { ok: false, error: `Twilio vrátilo ${response.status}.` };
    const body = (await response.json()) as { status?: string; duration?: string };
    return {
      ok: true,
      status: body.status ?? "unknown",
      duration: body.duration ? Number(body.duration) : null,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
