import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSelectedCallerId } from "@/lib/caller-session";
import {
  createVoiceAccessToken,
  maskSid,
  missingTwilioEnv,
  toVoiceIdentity,
  twilioConfig,
} from "@/lib/telephony/twilio";

export const dynamic = "force-dynamic";

/**
 * Access token pro softphone v prohlížeči.
 *
 * Token dostane jen přihlášená relace a platí hodinu. Auth Token Twilia
 * tenhle endpoint nikdy nevrací ani nepoužívá k podpisu - podepisuje se
 * tajemstvím API klíče, které jde zneplatnit bez výměny hesla k účtu.
 */
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const missing = missingTwilioEnv();
  if (missing.length > 0) {
    // 200, ne chyba: "není nastavené" je legitimní stav aplikace a UI na
    // něj umí reagovat lépe než na výjimku.
    return NextResponse.json({ configured: false, missing }, { status: 200 });
  }

  const config = twilioConfig();
  // Identita hovoru je caller ze směny, aby šlo v Twilio logu poznat, kdo
  // volal. Bez vybraného callera se identita odvodí od zařízení.
  const callerId = await getSelectedCallerId();
  // `callers.id` je uuid, tedy hodnota S POMLČKAMI. Twilio v identitě
  // povoluje jen A-Z a-z 0-9 _ a na pomlčce odmítne Device.connect()
  // chybou 31100 ještě dřív, než vznikne hovor. Viz toVoiceIdentity.
  const identity = toVoiceIdentity(callerId ? `caller_${callerId}` : "vexy_operator");

  const token = createVoiceAccessToken(config, { identity, ttlSeconds: 3600 });

  // Diagnostika: co je vidět v prohlížeči, ať se příště nehádá, čí token
  // to je a na kterou TwiML aplikaci míří. Token se neloguje NIKDY,
  // tajemství API klíče ani Auth Token endpoint nevrací vůbec.
  console.log(
    `[voice-token] identity=${token.identity} app=${maskSid(config.twimlAppSid)} ` +
      `caller=${callerId ? "ano" : "ne"} platnost=${new Date(token.expiresAt).toISOString()}`,
  );

  return NextResponse.json(
    { configured: true, ...token, callerId, twimlApp: maskSid(config.twimlAppSid) },
    { headers: { "cache-control": "no-store" } },
  );
}
