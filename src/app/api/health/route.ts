import { NextResponse, type NextRequest } from "next/server";
import {
  readRuntimeConnection,
  readSchemaState,
  schemaIsReady,
  missingCoreEnv,
} from "@/lib/system-status";

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

  // Dvě nezávislé otázky, hlášené zvlášť. Na produkci se rozešly: schéma
  // bylo v pořádku (15/15, žádné chybějící sloupce) a přesto padala každá
  // stránka, protože runtime nedokázal otevřít spojení. Jedno společné
  // „database: ok" by to zamlžilo.
  const runtime = await readRuntimeConnection();
  if (!runtime.ok) {
    return NextResponse.json(
      {
        status: "not_ready",
        runtime: {
          database: "unreachable",
          // Už pročištěná hláška, viz safeDbError. Host ani uživatel v ní nejsou.
          reason: runtime.error,
          // Jen režim, žádná část adresy.
          mode: runtime.mode,
          poolMax: runtime.poolMax,
        },
        missingEnv,
        checkedAt: new Date().toISOString(),
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const schema = await readSchemaState();
  const schemaReady = schemaIsReady(schema);
  // Session pooler spojení otevře, ale při souběhu narazí na strop
  // (EMAXCONNSESSION). Readiness to proto hlásí jako problém dřív, než se
  // objeví pod zátěží.
  const runtimeReady = runtime.mode !== "session";
  const ready = schemaReady && runtimeReady;

  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      runtime: {
        database: "ok",
        mode: runtime.mode,
        poolMax: runtime.poolMax,
        ...(runtimeReady
          ? {}
          : {
              warning:
                "DATABASE_URL vede přes session pooler (port 5432). Pro serverless " +
                "patří transaction pooler (port 6543).",
            }),
      },
      schema: {
        ready: schemaReady,
        migrations: {
          applied: schema.appliedCount,
          expected: schema.expectedCount,
          missing: schema.missingMigrations,
        },
        // Sloupce, které aplikace čte a v databázi nejsou. Jména tabulek
        // a sloupců jsou v repozitáři, takže tajná nejsou.
        gaps: schema.gaps.map((gap) => `${gap.table}.${gap.columns.join(",")}`),
      },
      missingEnv,
      checkedAt: new Date().toISOString(),
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
