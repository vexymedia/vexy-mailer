import Link from "next/link";
import { describeSenderPool, getGlobalStats, listCampaignStats } from "@/lib/queries/dashboard";
import { explainNextSend, formatSendDays, minutesToHHMM } from "@/lib/schedule";
import { PageHeader, Stat, StatusBadge, EmptyState } from "@/components/ui";
import { RunWorkerButton } from "@/components/run-worker-button";

export const dynamic = "force-dynamic";

function replyRate(replies: number, sent: number): string {
  if (sent === 0) return "—";
  return `${((replies / sent) * 100).toFixed(1)} %`;
}

export default async function DashboardPage() {
  const [campaigns, stats] = await Promise.all([listCampaignStats(), getGlobalStats()]);

  return (
    <>
      <PageHeader
        title="Přehled"
        description="Všechny kampaně a jejich aktuální čísla."
        actions={<RunWorkerButton />}
      />

      <div className="card mb-8 grid grid-cols-2 gap-6 p-6 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Kampaně" value={stats.campaigns} />
        <Stat label="Běžící" value={stats.active_campaigns} />
        <Stat label="Kontakty" value={stats.contacts} />
        <Stat label="Odeslané e-maily" value={stats.sent_total} />
        <Stat label="Odpovědi" value={stats.replies_total} tone="good" />
        <Stat
          label="K prověření"
          value={stats.needs_review}
          tone={stats.needs_review > 0 ? "danger" : undefined}
        />
      </div>

      {stats.needs_review > 0 ? (
        <div className="mb-8 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>{stats.needs_review} odeslání má neznámý výsledek.</strong> Worker byl přerušen
          uprostřed odesílání, takže nevíme, jestli e-maily dorazily. Nikdy se neopakují automaticky —
          duplicita by byla horší než chybějící e-mail. Zkontrolujte je u dané kampaně.
        </div>
      ) : null}

      {campaigns.length === 0 ? (
        <EmptyState
          title="Zatím žádné kampaně"
          description="Přidejte schránku, naimportujte kontakty a založte první kampaň."
          action={{ href: "/campaigns/new", label: "Vytvořit kampaň" }}
        />
      ) : (
        <div className="space-y-4">
          {campaigns.map((campaign) => (
            <div key={campaign.id} className="card p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <Link
                    href={`/campaigns/${campaign.id}`}
                    className="text-base font-semibold text-zinc-900 hover:underline"
                  >
                    {campaign.name}
                  </Link>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {describeSenderPool(campaign.mailbox_names)} · {formatSendDays(campaign.send_days)}{" "}
                    {minutesToHHMM(campaign.send_start_minute)}–{minutesToHHMM(campaign.send_end_minute)}{" "}
                    {campaign.timezone} · dnes využito {campaign.sent_today}/{campaign.daily_limit}
                  </p>
                </div>
                <StatusBadge status={campaign.status} />
              </div>

              <dl className="grid grid-cols-3 gap-4 sm:grid-cols-6">
                <Stat label="Kontakty" value={campaign.contacts} />
                <Stat label="Odesláno" value={campaign.sent} />
                <Stat label="Odpovědi" value={campaign.replies} tone={campaign.replies > 0 ? "good" : undefined} />
                <Stat label="Míra odpovědí" value={replyRate(campaign.replies, campaign.sent)} />
                <Stat label="Chyby" value={campaign.failed} tone={campaign.failed > 0 ? "danger" : undefined} />
                <Stat label="Zbývá" value={campaign.remaining} />
              </dl>

              {campaign.status === "active" ? (() => {
                // Computed with the dispatcher's own primitives, and rendered in
                // the campaign's timezone. Showing a bare UTC instant is what
                // made a cursor left over from an old schedule unrecognisable.
                const explanation = explainNextSend(
                  {
                    sendDays: campaign.send_days,
                    sendStartMinute: campaign.send_start_minute,
                    sendEndMinute: campaign.send_end_minute,
                    timezone: campaign.timezone,
                  },
                  campaign.daily_limit,
                  campaign.sent_today,
                  campaign.next_slot_at,
                );
                return (
                  <p
                    className={`mt-4 text-xs ${
                      explanation.state === "cursor_stale" ? "text-amber-700" : "text-zinc-500"
                    }`}
                  >
                    {explanation.message}
                  </p>
                );
              })() : null}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
