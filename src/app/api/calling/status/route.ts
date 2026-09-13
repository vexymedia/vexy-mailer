import { NextResponse, type NextRequest } from "next/server";
import { readSignedWebhook } from "@/lib/telephony/webhook";
import { lifecycleFromTwilio } from "@/lib/telephony/call-state";
import { recordCallStatus } from "@/lib/queries/calls";

export const dynamic = "force-dynamic";

const PATH = "/api/calling/status";

/**
 * Stav hovoru od Twilia.
 *
 * Chodí opakovaně, mimo pořadí a někdy nedorazí vůbec - zápis je proto
 * idempotentní a stav se nikdy nevrací zpátky (viz recordCallStatus).
 * Odpovídá se vždy 200, i když událost neznáme: Twilio by jinak
 * opakovaně doručovalo něco, s čím stejně nic neuděláme.
 */
export async function POST(request: NextRequest) {
  const webhook = await readSignedWebhook(request, PATH);
  if (!webhook.ok) {
    return NextResponse.json({ error: webhook.error }, { status: webhook.status });
  }

  const params = webhook.params;
  // U <Dial><Number> je ParentCallSid hovor z prohlížeče a CallSid je jeho
  // odchozí větev. Náš záznam je navázaný na ten rodičovský.
  const parentSid = params.ParentCallSid || params.CallSid || null;
  const status = lifecycleFromTwilio(params.CallStatus ?? params.DialCallStatus ?? "");
  if (!status || !parentSid) return NextResponse.json({ ok: true, ignored: true });

  const duration = params.CallDuration ?? params.DialCallDuration;
  const updated = await recordCallStatus({
    providerCallSid: parentSid,
    status,
    durationSeconds: duration ? Number(duration) : null,
    errorCode: params.ErrorCode || null,
    errorMessage: params.ErrorMessage || null,
  });

  return NextResponse.json({ ok: true, matched: Boolean(updated) });
}
