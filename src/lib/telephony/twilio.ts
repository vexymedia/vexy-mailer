import twilio from "twilio";

/**
 * Serverová část Twilia.
 *
 * Všechno, co má definovaný drát - podpis webhooku, přístupový token
 * a TwiML - dělá oficiální balíček `twilio`. Ručně psané ekvivalenty tu
 * kdysi byly a fungovaly, ale u podpisu to Twilio výslovně nedoporučuje:
 * sada parametrů, které do podpisu vstupují, se časem mění a vlastní
 * implementace tiše zastará. Tady je cena chyby tichý průnik, ne
 * spadlý build, takže rozhoduje správnost, ne velikost závislosti.
 *
 * Tenhle modul je SERVER-ONLY. Prohlížeč používá @twilio/voice-sdk,
 * který je něco jiného a je v komponentách volání.
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

export interface AccessTokenOptions {
  identity: string;
  /** Platnost v sekundách. Twilio povoluje maximálně 24 hodin. */
  ttlSeconds?: number;
}

/**
 * Access Token pro Voice SDK.
 *
 * Podepisuje se TAJEMSTVÍM API KLÍČE, ne Auth Tokenem. To je důležité:
 * Auth Token je heslo k celému účtu a nikdy nesmí opustit server ani
 * v odvozené podobě, kdežto API klíč jde kdykoli zneplatnit.
 *
 * Příchozí hovory produkt neřeší, takže se grant pro ně vůbec nepřidává -
 * token pak na příchozí hovor nikoho neopravňuje.
 */
export function createVoiceAccessToken(
  config: TwilioConfig,
  options: AccessTokenOptions,
): { token: string; identity: string; expiresAt: number } {
  const ttl = Math.min(Math.max(options.ttlSeconds ?? 3600, 60), 24 * 3600);
  const { AccessToken } = twilio.jwt;

  const token = new AccessToken(config.accountSid, config.apiKeySid, config.apiKeySecret, {
    identity: options.identity,
    ttl,
  });
  token.addGrant(
    new AccessToken.VoiceGrant({
      outgoingApplicationSid: config.twimlAppSid,
      incomingAllow: false,
    }),
  );

  const jwt = token.toJwt();
  // Expiraci si čteme z tokenu, ne z vlastního výpočtu: platí to, co je
  // opravdu podepsané.
  const payload = JSON.parse(
    Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"),
  ) as { exp: number };

  return { token: jwt, identity: options.identity, expiresAt: payload.exp * 1000 };
}

// --------------------------------------------------------- podpis webhooku

/**
 * Ověření hlavičky X-Twilio-Signature oficiálním helperem.
 *
 * Ručně to Twilio dělat nedoporučuje - co přesně do podpisu vstupuje se
 * mění a vlastní implementace by o tom nevěděla.
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null,
): boolean {
  if (!signature) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}

// ---------------------------------------------------------------- TwiML

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
 *
 * Pozor na rozdíl, na kterém stojí párování webhooků:
 *   * statusCallback je na <Number>, tedy na PSTN větvi. Její události
 *     nesou CallSid té větve a ParentCallSid hovoru z prohlížeče.
 *   * recordingStatusCallback je na <Dial>, tedy na hovoru z prohlížeče.
 *     Jeho události nesou CallSid rodiče.
 * V databázi držíme SID rodiče, takže se obojí musí párovat na něj.
 */
export function dialTwiml(options: DialTwimlOptions): string {
  const response = new twilio.twiml.VoiceResponse();

  const dial = response.dial({
    callerId: options.callerId,
    timeout: Math.max(5, Math.min(options.timeoutSeconds ?? 30, 120)),
    answerOnBridge: true,
    ...(options.record
      ? {
          record: "record-from-answer-dual" as const,
          ...(options.recordingCallbackUrl
            ? {
                recordingStatusCallback: options.recordingCallbackUrl,
                recordingStatusCallbackEvent: ["completed", "absent"],
                recordingStatusCallbackMethod: "POST" as const,
              }
            : {}),
        }
      : {}),
  });

  dial.number(
    options.statusCallbackUrl
      ? {
          statusCallback: options.statusCallbackUrl,
          statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
          statusCallbackMethod: "POST" as const,
        }
      : {},
    options.to,
  );

  return response.toString();
}

/** TwiML, které hovor slušně ukončí. Používá se, když něco nesedí. */
export function rejectTwiml(reason: string): string {
  const response = new twilio.twiml.VoiceResponse();
  response.say({ language: "cs-CZ" }, reason);
  response.hangup();
  return response.toString();
}

// ------------------------------------------------------------------- REST

function restClient(config: TwilioConfig) {
  return twilio(config.accountSid, config.authToken);
}

/**
 * Stažení nahrávky kvůli přepisu.
 *
 * REST klient umí metadata, ale samotné audio se stahuje z media URL, na
 * kterou stačí basic auth. Odkaz se nikdy neposílá do prohlížeče.
 */
export async function fetchRecording(
  config: TwilioConfig,
  recordingUrl: string,
  format: "wav" | "mp3" = "wav",
): Promise<{ ok: true; audio: Buffer; contentType: string } | { ok: false; error: string }> {
  // WAV, ne MP3: hovor se nahrává dvoukanálově (každá větev zvlášť) a
  // převod do MP3 to smíchá do mona - tím se nenávratně ztratí informace
  // o tom, kdo mluví.
  const url = /\.(wav|mp3)$/i.test(recordingUrl) ? recordingUrl : `${recordingUrl}.${format}`;
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
      contentType:
        response.headers.get("content-type") ??
        (format === "wav" ? "audio/wav" : "audio/mpeg"),
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
  try {
    const call = await restClient(config).calls(callSid).fetch();
    return {
      ok: true,
      status: call.status ?? "unknown",
      duration: call.duration ? Number(call.duration) : null,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
