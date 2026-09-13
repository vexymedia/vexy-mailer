import { NextResponse, type NextRequest } from "next/server";
import { readSignedWebhook } from "@/lib/telephony/webhook";
import { recordRecording } from "@/lib/queries/calls";

export const dynamic = "force-dynamic";

const PATH = "/api/calling/recording";

/**
 * Nahrávka je hotová (nebo se nepovedla).
 *
 * Přijde až po zavěšení, klidně o desítky sekund později - proto se na ni
 * nikde nečeká. Uloží se jen metadata a odkaz; samotné audio se stahuje až
 * ve chvíli přepisu, přes server s basic auth, aby odkaz na nahrávku
 * nikdy nemusel do prohlížeče.
 */
export async function POST(request: NextRequest) {
  const webhook = await readSignedWebhook(request, PATH);
  if (!webhook.ok) {
    return NextResponse.json({ error: webhook.error }, { status: webhook.status });
  }

  const params = webhook.params;
  const parentSid = params.CallSid || params.ParentCallSid || null;
  if (!parentSid) return NextResponse.json({ ok: true, ignored: true });

  const raw = (params.RecordingStatus ?? "").toLowerCase();
  const status = raw === "completed" ? "completed" : raw === "absent" ? "absent" : "failed";

  const updated = await recordRecording({
    providerCallSid: parentSid,
    recordingSid: params.RecordingSid || null,
    recordingUrl: params.RecordingUrl || null,
    durationSeconds: params.RecordingDuration ? Number(params.RecordingDuration) : null,
    status,
  });

  return NextResponse.json({ ok: true, matched: Boolean(updated) });
}
