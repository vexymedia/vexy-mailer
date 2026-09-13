import Link from "next/link";
import { getOverviewStats, getTodayWork, getWeekSummary } from "@/lib/queries/overview";
import { listActivity } from "@/lib/queries/dashboard";
import { plural } from "@/lib/plan";
import { PageHeader, StatCard, EmptyState, DateTime } from "@/components/ui";
import { formatWhen } from "@/lib/datetime";
import { callRates, formatPercent } from "@/lib/calling";

export const dynamic = "force-dynamic";

/**
 * Přehled odpovídá na čtyři otázky a nic víc: máme připravenou práci, co
 * čeká na zpracování, co se tento týden stalo a co potřebuje pozornost.
 * Technické statistiky odesílání sem nepatří - jsou v Komunikaci.
 */
export default async function OverviewPage() {
  const [stats, week, todo, activity] = await Promise.all([
    getOverviewStats(),
    getWeekSummary(),
    getTodayWork(),
    listActivity({ limit: 8 }),
  ]);

  // Dovolatelnost a meeting rate z reálných zápisů hovorů za 7 dní.
  const rates = callRates({
    attempts: week.calls,
    connected: week.connected,
    meetings: week.meetings_booked,
  });

  const kindLabel: Record<string, string> = {
    overdue: "Po termínu",
    followup: "Follow-up",
    reply: "Nová odpověď",
    queue: "K oslovení",
    attention: "Bez dalšího kroku",
  };
  const kindStyle: Record<string, string> = {
    overdue: "bg-red-50 text-red-700 ring-red-200",
    followup: "bg-amber-50 text-amber-700 ring-amber-200",
    reply: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    queue: "bg-zinc-50 text-zinc-600 ring-zinc-200",
    attention: "bg-amber-50 text-amber-800 ring-amber-300",
  };

  return (
    <>
      <PageHeader
        title="Přehled"
        description="Co se děje a co dnes potřebuje pozornost."
        actions={
          <Link href="/osloveni" className="btn-go">
            Začít oslovovat
          </Link>
        }
      />

      <dl className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Připravené firmy" value={stats.companies_ready} hint="mají telefon a nejsou uzavřené" href="/firmy" />
        <StatCard label="Čeká na oslovení" value={stats.waiting} href="/osloveni/fronta" />
        <StatCard
          label="Follow-upy dnes"
          value={stats.followups_today}
          tone={stats.followups_today > 0 ? "warn" : undefined}
          href="/osloveni"
        />
        <StatCard
          label="Schůzky"
          value={stats.meetings}
          tone={stats.meetings > 0 ? "good" : undefined}
          href="/firmy?status=meeting"
        />
        <StatCard
          label="Nové odpovědi"
          value={stats.new_replies}
          tone={stats.new_replies > 0 ? "good" : undefined}
          href="/inbox"
        />
      </dl>

      {stats.without_next_step > 0 ? (
        <Link
          href="/firmy?krok=none"
          className="mb-8 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 hover:bg-amber-100"
        >
          <span className="font-medium">
            {plural(stats.without_next_step, "firma", "firmy", "firem")} bez dalšího kroku
          </span>
          <span className="text-amber-800">
            — aktivně je řešíme, ale nikdo nemá naplánováno, co se stane dál.
          </span>
        </Link>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="section-title">Dnes řešit</h2>
            <Link href="/firmy?krok=due" className="text-sm text-zinc-500 hover:text-zinc-900">
              Zobrazit jako seznam
            </Link>
          </div>

          {todo.length === 0 ? (
            <EmptyState
              title="Na dnešek není nic otevřeného"
              description="Jakmile připravíme nové firmy, přijde odpověď nebo nastane čas naplánovaného follow-upu, objeví se to tady."
              action={{ href: "/firmy", label: "Projít firmy" }}
            />
          ) : (
            <ul className="card divide-y divide-zinc-100">
              {todo.map((item, index) => (
                <li key={`${item.kind}-${index}`}>
                  {/* Na mobilu štítek nad textem: vedle sebe by se nevešly
                      a stránka by přetékala do strany. */}
                  <Link
                    href={item.href}
                    className="flex flex-col gap-1.5 px-5 py-3.5 hover:bg-zinc-50 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <span className={`badge w-fit shrink-0 ${kindStyle[item.kind]}`}>
                      {kindLabel[item.kind]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-zinc-900">{item.title}</span>
                      <span className="block truncate text-xs text-zinc-500">
                        {[item.subtitle, item.detail].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </span>
                    {item.due_at ? (
                      <span
                        className={`shrink-0 text-xs tabular-nums ${
                          item.kind === "overdue" ? "font-medium text-red-600" : "text-zinc-500"
                        }`}
                      >
                        {formatWhen(item.due_at)}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="space-y-6">
          <section className="card p-5">
            <h2 className="section-title mb-4">Posledních 7 dní</h2>
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-xs text-zinc-500">Pokusů o volání</dt>
                <dd className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-900">{week.calls}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Spojených hovorů</dt>
                <dd className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-900">{week.connected}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Schůzek</dt>
                <dd
                  className={`mt-0.5 text-xl font-semibold tabular-nums ${
                    week.meetings_booked > 0 ? "text-emerald-600" : "text-zinc-900"
                  }`}
                >
                  {week.meetings_booked}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Odeslaných e-mailů</dt>
                <dd className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-900">{week.emails_sent}</dd>
              </div>
            </dl>
            <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-zinc-100 pt-4">
              <div>
                <dt className="text-xs text-zinc-500">Dovolatelnost</dt>
                <dd className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-900">
                  {formatPercent(rates.reach_rate)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Meeting rate</dt>
                <dd className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-900">
                  {formatPercent(rates.meeting_rate)}
                </dd>
              </div>
            </dl>
          </section>

          <section>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="section-title">Poslední aktivita</h2>
              <Link href="/activity" className="text-sm text-zinc-500 hover:text-zinc-900">
                Vše
              </Link>
            </div>
            {activity.length === 0 ? (
              <p className="card px-5 py-8 text-center text-sm text-zinc-500">Zatím se nic nestalo.</p>
            ) : (
              <ul className="card divide-y divide-zinc-100">
                {activity.map((row) => (
                  <li key={row.id} className="px-5 py-3">
                    <p className="text-sm text-zinc-900">{row.action}</p>
                    <p className="mt-0.5 truncate text-xs text-zinc-500">
                      {row.contact_email ?? row.campaign_name ?? row.detail ?? "—"} · <DateTime value={row.created_at} />
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
