import { NextResponse } from "next/server";
import {
  readRuntimeConnection,
  readSchemaState,
  schemaIsReady,
  missingCoreEnv,
} from "@/lib/system-status";
import { READINESS_TIMEOUT_MS, withTimeout } from "@/lib/timeout";

export const dynamic = "force-dynamic";

/**
 * Readiness na vlastní cestě.
 *
 * `/api/health` je liveness - odpovídá `{"status":"ok"}` a schválně
 * nesahá na databázi, aby výpadek databáze nerozjel restart smyčku.
 * Readiness byl dosud jen `/api/health?ready=1`, což se snadno splete
 * s `/api/health/ready` a vrátí 404 - a to vypadá, jako by kontrola
 * chyběla. Obojí teď funguje a vrací totéž.
 *
 * Má vlastní časový strop: probe, který sám visí, je horší než probe,
 * který řekne „nevím". Bez něj by se čekalo, dokud se nevzdá spojení.
 *
 * Nevrací nic citlivého: žádný connection string, žádné údaje, jen
 * režim připojení, jména chybějících migrací a názvy chybějících
 * proměnných - to všechno je v repozitáři.
 */
export async function GET() {
  const missingEnv = missingCoreEnv();
  const headers = { "cache-control": "no-store" };

  try {
    const runtime = await withTimeout(readRuntimeConnection(), READINESS_TIMEOUT_MS);
    if (!runtime.ok) {
      return NextResponse.json(
        {
          status: "not_ready",
          runtime: { database: "unreachable", reason: runtime.error, mode: runtime.mode },
          missingEnv,
          checkedAt: new Date().toISOString(),
        },
        { status: 503, headers },
      );
    }

    const schema = await withTimeout(readSchemaState(), READINESS_TIMEOUT_MS);
    const schemaReady = schemaIsReady(schema);
    // Session pooler spojení otevře, ale při souběhu narazí na strop.
    const runtimeReady = runtime.mode !== "session";
    const ready = schemaReady && runtimeReady && missingEnv.length === 0;

    return NextResponse.json(
      {
        status: ready ? "ready" : "not_ready",
        runtime: {
          database: "ok",
          mode: runtime.mode,
          poolMax: runtime.poolMax,
          ...(runtimeReady
            ? {}
            : { warning: "DATABASE_URL vede přes session pooler (5432). Pro serverless patří 6543." }),
        },
        schema: {
          ready: schemaReady,
          migrations: {
            applied: schema.appliedCount,
            expected: schema.expectedCount,
            missing: schema.missingMigrations,
          },
          gaps: schema.gaps.map((gap) => `${gap.table}.${gap.columns.join(",")}`),
        },
        missingEnv,
        checkedAt: new Date().toISOString(),
      },
      { status: ready ? 200 : 503, headers },
    );
  } catch {
    // Timeout nebo neočekávaná chyba. Podrobnost do prohlížeče nejde:
    // chyba z postgres.js běžně nese hosta i uživatele.
    return NextResponse.json(
      {
        status: "not_ready",
        runtime: { database: "timeout", reason: `Databáze neodpověděla do ${READINESS_TIMEOUT_MS} ms.` },
        missingEnv,
        checkedAt: new Date().toISOString(),
      },
      { status: 503, headers },
    );
  }
}
