import Link from "next/link";
import { getOverviewStats, getTodayWork, getWeekSummary } from "@/lib/queries/overview";
import { listActivity } from "@/lib/queries/dashboard";
import { PageHeader, StatCard, EmptyState, DateTime } from "@/components/ui";

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

  const kindLabel: Record<string, string> = {
    followup: "Follow-up",
    reply: "Nová odpověď",
    queue: "K oslovení",
  };

  return (
    <>
      <PageHeader title="Přehled" description="Co se děje a co dnes potřebuje pozornost." />

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

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="section-title">Dnes řešit</h2>
            <Link href="/osloveni" className="text-sm text-zinc-500 hover:text-zinc-900">
              Otevřít oslovení
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
                  <Link href={item.href} className="flex items-center gap-4 px-5 py-3.5 hover:bg-zinc-50">
                    <span
                      className={`badge shrink-0 ${
                        item.kind === "followup"
                          ? "bg-amber-50 text-amber-700 ring-amber-200"
                          : item.kind === "reply"
                            ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                            : "bg-zinc-50 text-zinc-600 ring-zinc-200"
                      }`}
                    >
                      {kindLabel[item.kind]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-zinc-900">{item.title}</span>
                      <span className="block truncate text-xs text-zinc-500">
                        {[item.subtitle, item.detail].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </span>
                    {item.due_at ? (
                      <span className="shrink-0 text-xs text-zinc-500">
                        <DateTime value={item.due_at} />
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
                <dt className="text-xs text-zinc-500">Hovorů</dt>
                <dd className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-900">{week.calls}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Dovolaných</dt>
                <dd className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-900">{week.connected}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Domluvené schůzky</dt>
                <dd
                  className={`mt-0.5 text-xl font-semibold tabular-nums ${
                    week.meetings_booked > 0 ? "text-emerald-600" : "text-zinc-900"
                  }`}
                >
                  {week.meetings_booked}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Odeslané e-maily</dt>
                <dd className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-900">{week.emails_sent}</dd>
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
                      {row.contact_email ?? row.campaign_name ?? "—"} · <DateTime value={row.created_at} />
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
