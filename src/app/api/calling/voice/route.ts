import { NextResponse, type NextRequest } from "next/server";
import { dialTwiml, rejectTwiml, twilioConfig } from "@/lib/telephony/twilio";
import { readSignedWebhook, webhookUrl } from "@/lib/telephony/webhook";
import { attachProviderCall, getCallForDial } from "@/lib/queries/calls";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const PATH = "/api/calling/voice";

function twiml(body: string, status = 200): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * TwiML pro odchozí hovor z prohlížeče.
 *
 * Twilio sem přijde v okamžiku, kdy softphone zavolá Device.connect().
 * Parametrem je POUZE id hovoru, které jsme sami vydali - číslo se čte
 * z databáze. Kdyby prohlížeč posílal číslo, byl by to otevřený dialer
 * placený z našeho účtu.
 */
export async function POST(request: NextRequest) {
  const webhook = await readSignedWebhook(request, PATH);
  if (!webhook.ok) {
    return twiml(rejectTwiml("Hovor nelze ověřit."), webhook.status);
  }

  const callId = webhook.params.callId ?? request.nextUrl.searchParams.get("callId") ?? "";
  const call = callId ? await getCallForDial(callId) : null;
  if (!call) {
    return twiml(rejectTwiml("Hovor nebyl nalezen."), 404);
  }

  const config = twilioConfig();
  const providerCallSid = webhook.params.CallSid ?? null;
  if (providerCallSid) {
    await attachProviderCall(call.id, providerCallSid, config.callerId);
  }

  // Nahrávání je globální přepínač. Když je vypnuté, hovor proběhne
  // normálně, jen z něj nevznikne nahrávka - a tedy ani přepis a analýza.
  const settings = await getSettings();
  const record = settings.call_recording_enabled;

  return twiml(
    dialTwiml({
      to: call.destination,
      callerId: config.callerId,
      record,
      statusCallbackUrl: webhookUrl(request, "/api/calling/status").split("?")[0],
      recordingCallbackUrl: record
        ? webhookUrl(request, "/api/calling/recording").split("?")[0]
        : null,
    }),
  );
}
