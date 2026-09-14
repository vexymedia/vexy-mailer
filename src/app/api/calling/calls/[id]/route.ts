import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getCall } from "@/lib/queries/calls";

export const dynamic = "force-dynamic";

/**
 * Stav jednoho hovoru. Cockpit se sem ptá, dokud běží zpracování nahrávky
 * a analýzy - je to jediné místo, kde se čeká, a čeká se po zavěšení, ne
 * během hovoru.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const call = await getCall(id);
  if (!call) return NextResponse.json({ error: "Hovor nebyl nalezen." }, { status: 404 });

  // Caller se ptá jen na svoje hovory. Nic dramatického by se neprozradilo,
  // ale uhodnuté id cizího hovoru mu nemá vracet vůbec nic - a stojí to
  // jedno porovnání.
  if (user.role === "caller" && call.caller_id !== user.caller_id) {
    return NextResponse.json({ error: "Hovor nebyl nalezen." }, { status: 404 });
  }

  // Odkaz na nahrávku se ven nepouští: je za basic auth Twilia a do
  // prohlížeče nemá co dělat. Stačí, že víme, jestli existuje.
  return NextResponse.json(
    {
      id: call.id,
      status: call.status,
      durationSeconds: call.duration_seconds,
      recordingStatus: call.recording_status,
      transcriptStatus: call.transcript_status,
      transcript: call.transcript,
      analysisStatus: call.analysis_status,
      analysis: call.analysis,
      analysisError: call.analysis_error,
      suggestedOutcome: call.suggested_outcome,
      loggedOutcome: Boolean(call.call_activity_id),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
