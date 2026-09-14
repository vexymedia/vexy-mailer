import { plural } from "@/lib/plan";

/**
 * "23 / 76 zpracováno". Bez tohohle čísla člověk v pracovním režimu netuší,
 * jestli je za půlkou nebo na začátku - a to je rozdíl mezi "ještě to dám"
 * a "nemá to konec".
 */
export function WorkProgress({
  processed,
  total,
  metrics,
}: {
  processed: number;
  total: number;
  /**
   * Dnešní čísla callera. Počítá je stejná reporting service jako Přehled
   * a Tým - jinak by si caller a jeho vedoucí každý den odporovali.
   */
  metrics?: { attempts: number; connected: number; meetings: number };
}) {
  if (total === 0 && !metrics) return null;
  const percent = total === 0 ? 0 : Math.min(100, Math.round((processed / total) * 100));
  const remaining = Math.max(total - processed, 0);
  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium tabular-nums text-zinc-900">
          {processed} / {total} zpracováno
        </p>
        <p className="text-sm text-zinc-500">
          {remaining === 0 ? "Hotovo" : `Zbývá ${plural(remaining, "firma", "firmy", "firem")}`}
        </p>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
        <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${percent}%` }} />
      </div>
      {metrics ? (
        <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-500">
          <div className="flex gap-1.5">
            <dt>Pokusy</dt>
            <dd className="font-medium tabular-nums text-zinc-900">{metrics.attempts}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Spojené</dt>
            <dd className="font-medium tabular-nums text-zinc-900">{metrics.connected}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Schůzky</dt>
            <dd
              className={`font-medium tabular-nums ${
                metrics.meetings > 0 ? "text-emerald-700" : "text-zinc-900"
              }`}
            >
              {metrics.meetings}
            </dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}
