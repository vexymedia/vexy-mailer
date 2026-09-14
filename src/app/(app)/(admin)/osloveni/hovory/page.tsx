import Link from "next/link";
import { getCallMetrics, listCallReport } from "@/lib/queries/reporting";
import { listCallers } from "@/lib/queries/calling";
import { callOutcomeLabel, formatPercent } from "@/lib/calling";
import { callLifecycleLabel, formatDuration } from "@/lib/telephony/call-state";
import { PageHeader, EmptyState, Table, DateTime } from "@/components/ui";
import { OsloveniTabs } from "@/components/osloveni-tabs";

export const dynamic = "force-dynamic";

/**
 * Přehled volání.
 *
 * Obchodní čtení hovorů, ne BI modul: období, člověk, stav - a pod tím
 * jednotlivé hovory. Součty nad tabulkou počítá stejná reporting service
 * jako Přehled a Tým, takže se nemůžou rozejít.
 */

const STATUSES = [
  { key: "", label: "Vše" },
  { key: "connected", label: "Spojené" },
  { key: "missed", label: "Nedovolané" },
] as const;

/** Datum z URL. Neplatná hodnota se ignoruje, nepadá se na ní. */
function parseDate(value: string | undefined, endOfDay = false): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default async function CallReportPage({
  searchParams,
}: {
  searchParams: Promise<{ od?: string; do?: string; caller?: string; stav?: string }>;
}) {
  const params = await searchParams;

  // Bez zadání se ukazuje posledních 30 dní. Prázdná stránka po otevření
  // by nutila každého vyplnit dvě data, než vůbec něco uvidí.
  const defaultFrom = new Date(Date.now() - 30 * 86_400_000);
  const from = parseDate(params.od) ?? defaultFrom;
  const to = parseDate(params.do, true);
  const callerId = params.caller || null;
  const status = params.stav === "connected" || params.stav === "missed" ? params.stav : null;

  const [metrics, rows, team] = await Promise.all([
    getCallMetrics({ from, to, callerId }),
    listCallReport({ from, to, callerId, status, limit: 300 }),
    listCallers(),
  ]);

  return (
    <>
      <PageHeader
        title="Přehled volání"
        description="Kdo volal, komu, jak to dopadlo. Jeden klik na Zavolat je jeden pokus."
      />
      <OsloveniTabs active="/osloveni/hovory" />

      {/* ------------------------------------------------------ filtry */}
      <form className="mb-5 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="od">Od</label>
          <input id="od" name="od" type="date" defaultValue={params.od ?? isoDay(defaultFrom)}
                 className="input w-auto py-1.5 text-sm" />
        </div>
        <div>
          <label className="label" htmlFor="do">Do</label>
          <input id="do" name="do" type="date" defaultValue={params.do ?? ""}
                 className="input w-auto py-1.5 text-sm" />
        </div>
        <div>
          <label className="label" htmlFor="caller">Caller</label>
          <select id="caller" name="caller" defaultValue={callerId ?? ""}
                  className="input w-auto py-1.5 text-sm">
            <option value="">Všichni</option>
            {team.map((member) => (
              <option key={member.id} value={member.id}>{member.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="stav">Stav</label>
          <select id="stav" name="stav" defaultValue={status ?? ""}
                  className="input w-auto py-1.5 text-sm">
            {STATUSES.map((item) => (
              <option key={item.key} value={item.key}>{item.label}</option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn-secondary !py-1.5 text-sm">Filtrovat</button>
      </form>

      {/* ------------------------------------------------------ součty */}
      <dl className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Pokusy o volání" value={metrics.attempts} />
        <Stat label="Spojené hovory" value={metrics.connected} />
        <Stat label="Schůzky" value={metrics.meetings} accent={metrics.meetings > 0} />
        <Stat label="Dovolatelnost" value={formatPercent(metrics.reach_rate)} />
        <Stat label="Čas na telefonu" value={formatDuration(metrics.talk_seconds)} />
      </dl>

      {rows.length === 0 ? (
        <EmptyState
          title="V tomhle období se nevolalo"
          description="Zkuste širší rozsah dat nebo jiného callera."
        />
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Datum</th>
              <th className="th">Caller</th>
              <th className="th">Kontakt</th>
              <th className="th">Firma</th>
              <th className="th">Stav</th>
              <th className="th text-right">Délka</th>
              <th className="th">Výsledek</th>
              <th className="th"></th>
            </tr>
          }
        >
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-zinc-50">
              <td className="td whitespace-nowrap text-xs"><DateTime value={row.started_at} /></td>
              <td className="td text-sm">{row.caller_name ?? <span className="text-zinc-400">—</span>}</td>
              <td className="td text-sm">
                {row.contact_name}
                <div className="text-xs tabular-nums text-zinc-500">{row.destination}</div>
              </td>
              <td className="td text-sm">
                {row.company_id ? (
                  <Link href={`/firmy/${row.company_id}`} className="text-zinc-900 hover:underline">
                    {row.company_name}
                  </Link>
                ) : (
                  <span className="text-zinc-500">{row.company_name ?? "—"}</span>
                )}
              </td>
              <td className="td">
                {row.connected ? (
                  <span className="badge bg-emerald-50 text-emerald-700 ring-emerald-200">spojeno</span>
                ) : (
                  <span className="badge bg-zinc-50 text-zinc-600 ring-zinc-200">
                    {callLifecycleLabel(row.status)}
                  </span>
                )}
              </td>
              <td className="td text-right text-sm tabular-nums">
                {row.duration_seconds !== null ? formatDuration(row.duration_seconds) : "—"}
              </td>
              <td className="td text-sm">
                {row.outcome ? (
                  callOutcomeLabel(row.outcome)
                ) : (
                  <span className="badge bg-amber-50 text-amber-700 ring-amber-200">bez výsledku</span>
                )}
              </td>
              <td className="td text-right">
                {/* Nahrávka, přepis i rozbor jsou na detailu firmy. Vlastní
                    stránka hovoru neexistuje a vyrábět ji kvůli jednomu
                    odkazu by bylo víc práce než užitku. */}
                {row.company_id ? (
                  <Link
                    href={`/firmy/${row.company_id}`}
                    className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-900"
                  >
                    Detail
                  </Link>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="card p-4">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className={`mt-0.5 text-xl font-semibold tabular-nums ${accent ? "text-emerald-600" : "text-zinc-900"}`}>
        {value}
      </dd>
    </div>
  );
}
