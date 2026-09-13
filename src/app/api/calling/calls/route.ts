import { NextResponse, type NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSelectedCallerId } from "@/lib/caller-session";
import { startCall, logCallStarted } from "@/lib/queries/calls";
import { isTwilioConfigured } from "@/lib/telephony/twilio";
import { buildCockpitBriefing } from "@/lib/telephony/briefing";

export const dynamic = "force-dynamic";

/**
 * Založí hovor a vrátí jeho id.
 *
 * Prohlížeč nikdy neposílá telefonní číslo - jen id kontaktu. Číslo si
 * server dohledá sám a klientovi ho vrací pouze pro zobrazení; vytáčí se
 * podle databáze. Díky tomu nejde přes náš Twilio účet vytočit libovolné
 * číslo, ani kdyby někdo zprávu podstrčil.
 */
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isTwilioConfigured()) {
    return NextResponse.json(
      { error: "Volání není nastavené. Doplňte Twilio proměnné." },
      { status: 503 },
    );
  }

  let body: { contactId?: unknown; campaignContactId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Neplatný požadavek." }, { status: 400 });
  }

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const contactId = typeof body.contactId === "string" && uuid.test(body.contactId) ? body.contactId : null;
  const campaignContactId =
    typeof body.campaignContactId === "string" && uuid.test(body.campaignContactId)
      ? body.campaignContactId
      : null;
  if (!contactId && !campaignContactId) {
    return NextResponse.json({ error: "Chybí kontakt." }, { status: 400 });
  }

  const callerId = await getSelectedCallerId();
  const result = await startCall({ contactId, campaignContactId, callerId });
  if (!result.ok) {
    const status = result.code === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error, code: result.code }, { status });
  }

  await logCallStarted({
    callId: result.call.callId,
    contactId: result.call.contactId,
    destination: result.call.destination,
  });

  // Kontext se posílá spolu s hovorem: cockpit ho potřebuje hned, ne až
  // po dalším kole dotazů.
  const briefing = await buildCockpitBriefing({
    contactId: result.call.contactId,
    companyId: result.call.companyId,
    campaignContactId: result.call.campaignContactId,
  });

  return NextResponse.json(
    { call: result.call, briefing },
    { headers: { "cache-control": "no-store" } },
  );
}
