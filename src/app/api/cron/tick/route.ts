import { NextResponse, type NextRequest } from "next/server";
import { dispatchTick } from "@/lib/engine/dispatch";
import { pollReplies } from "@/lib/engine/replies";
import { processCallPipeline } from "@/lib/telephony/pipeline";
import { safeEqual } from "@/lib/crypto";
import { readSchemaState, schemaIsReady } from "@/lib/system-status";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The worker tick. One call does one dispatcher pass, at most every
 * REPLY_POLL_INTERVAL_MS per mailbox one IMAP poll, and one pass over
 * hovory čekající na přepis a analýzu.
 *
 * Designed to be driven by anything that can make an HTTP request once a
 * minute: Vercel Cron, cron-job.org, a GitHub Actions schedule, or a shell
 * loop. Every operation is idempotent, so an extra or a missed call is
 * harmless - it is safe to hammer this endpoint.
 */

/**
 * Jeden krok ticku, ohraničený v logu.
 *
 * Když request na produkci nedoběhne, z odpovědi se nic nedozvíte -
 * odpověď totiž nikdy nevznikne. Jediné, co zbude, je log. Proto se
 * začátek kroku loguje PŘED await: poslední řádek `>` bez odpovídajícího
 * `<` říká přesně, na kterém awaitu to stojí.
 *
 * Kroky se sbírají i do úspěšné odpovědi, aby šlo vidět, kde se čas tráví,
 * bez čtení logu.
 */
async function step<T>(
  name: string,
  steps: Record<string, number>,
  fn: () => Promise<T>,
): Promise<T> {
  const from = Date.now();
  console.log(`[cron] > ${name}`);
  try {
    return await fn();
  } finally {
    const ms = Date.now() - from;
    steps[name] = ms;
    console.log(`[cron] < ${name} ${ms}ms`);
  }
}

function authorise(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ") && safeEqual(header.slice(7), secret)) return true;

  // Convenience for external cron services that cannot set headers.
  const query = request.nextUrl.searchParams.get("secret");
  return Boolean(query && safeEqual(query, secret));
}

async function handle(request: NextRequest) {
  if (!authorise(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  /** Doba jednotlivých kroků. Do odpovědi i do logu. */
  const steps: Record<string, number> = {};

  // Zastaralé schéma = žádné skutečné akce.
  //
  // Když na produkci chybí migrace, dispatcher by psal do tabulek, kterým
  // nerozumí: v lepším případě spadne, v horším odešle e-mail a výsledek
  // nemá kam zapsat. Odesílání a volání se proto vůbec nerozjede a tick
  // vrátí, co přesně chybí. UI mezitím funguje dál, aby to administrátor
  // měl kde přečíst.
  //
  // Je to kontrola, ne oprava: nic se tu samo nemigruje.
  const schema = await step("schema", steps, () => readSchemaState());
  if (!schemaIsReady(schema)) {
    return NextResponse.json(
      {
        ok: false,
        skipped: "schema_out_of_date",
        error: schema.reachable
          ? "Databáze není připravená pro tuhle verzi aplikace — worker nic neodeslal."
          : "Databáze neodpovídá — worker nic neodeslal.",
        missingMigrations: schema.missingMigrations,
        schemaGaps: schema.gaps.map((gap) => `${gap.table}.${gap.columns.join(",")}`),
        steps,
      },
      { status: 503 },
    );
  }

  try {
    // Dispatch first: sending is time-sensitive, reply polling is not.
    const dispatch = await step("dispatch", steps, () => dispatchTick());
    const replies = await step("replies", steps, () => pollReplies());
    // Nahrávky a přepisy jsou na řadě poslední: e-mail i odpovědi jsou
    // časově citlivé. Dostanou, co ze šedesátivteřinového limitu funkce
    // zbylo, s rezervou na dokončení odpovědi.
    const calls = await step("calls", steps, () =>
      processCallPipeline({ deadline: started + 50_000 }),
    );
    const durationMs = Date.now() - started;
    console.log(`[cron] tick ok ${durationMs}ms`, steps);
    return NextResponse.json({ ok: true, durationMs, steps, dispatch, replies, calls });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron] tick failed", { steps, error });
    return NextResponse.json({ ok: false, error: message, steps }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
