import { NextResponse, type NextRequest } from "next/server";
import { pingDatabase, readSchemaState, schemaIsReady, missingCoreEnv } from "@/lib/system-status";

export const dynamic = "force-dynamic";

/**
 * Health a readiness pro monitoring nasazení.
 *
 *   GET /api/health        → žije proces vůbec? Nesahá na databázi.
 *   GET /api/health?ready=1 → je aplikace schopná obsluhovat provoz?
 *
 * Rozdíl je důležitý pro restart smyčku: „liveness" nesmí selhat kvůli
 * výpadku databáze, jinak by ji hosting začal restartovat a tím nic
 * nespraví. „Readiness" naopak selhat musí, aby se na takovou instanci
 * neposílal provoz.
 *
 * Nevrací NIC citlivého: žádný connection string, žádné údaje, žádné
 * tajné hodnoty. Jen názvy chybějících proměnných a jména chybějících
 * migrací - obojí je veřejné, je to v repozitáři.
 */
export async function GET(request: NextRequest) {
  const wantsReadiness = request.nextUrl.searchParams.has("ready");

  if (!wantsReadiness) {
    return NextResponse.json(
      { status: "ok", checkedAt: new Date().toISOString() },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const missingEnv = missingCoreEnv();
  const ping = await pingDatabase();
  if (!ping.ok) {
    return NextResponse.json(
      {
        status: "not_ready",
        database: "unreachable",
        // Už pročištěná hláška, viz safeDbError. Host ani uživatel v ní nejsou.
        reason: ping.error,
        missingEnv,
        checkedAt: new Date().toISOString(),
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const schema = await readSchemaState();
  const ready = schemaIsReady(schema);
  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      database: "ok",
      migrations: {
        applied: schema.appliedCount,
        expected: schema.expectedCount,
        missing: schema.missingMigrations,
      },
      // Sloupce, které aplikace čte a v databázi nejsou. Jména tabulek
      // a sloupců jsou v repozitáři, takže tajná nejsou.
      schemaGaps: schema.gaps.map((gap) => `${gap.table}.${gap.columns.join(",")}`),
      missingEnv,
      checkedAt: new Date().toISOString(),
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
