import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSelectedCallerId } from "@/lib/caller-session";
import { createVoiceAccessToken, missingTwilioEnv, twilioConfig } from "@/lib/telephony/twilio";

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
  const identity = callerId ? `caller_${callerId}` : "vexy_operator";

  const token = createVoiceAccessToken(config, { identity, ttlSeconds: 3600 });
  return NextResponse.json(
    { configured: true, ...token, callerId },
    { headers: { "cache-control": "no-store" } },
  );
}
