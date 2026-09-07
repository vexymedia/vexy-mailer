import Link from "next/link";
import { getGlobalStats, listCampaignStats } from "@/lib/queries/dashboard";
import { formatSendDays, minutesToHHMM } from "@/lib/schedule";
import { PageHeader, Stat, StatusBadge, EmptyState, DateTime } from "@/components/ui";
import { RunWorkerButton } from "@/components/run-worker-button";

export const dynamic = "force-dynamic";

function replyRate(replies: number, sent: number): string {
  if (sent === 0) return "—";
  return `${((replies / sent) * 100).toFixed(1)}%`;
}

export default async function DashboardPage() {
  const [campaigns, stats] = await Promise.all([listCampaignStats(), getGlobalStats()]);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Every campaign, with its current numbers."
        actions={<RunWorkerButton />}
      />

      <div className="card mb-8 grid grid-cols-2 gap-6 p-6 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Campaigns" value={stats.campaigns} />
        <Stat label="Active" value={stats.active_campaigns} />
        <Stat label="Contacts" value={stats.contacts} />
        <Stat label="Emails sent" value={stats.sent_total} />
        <Stat label="Replies" value={stats.replies_total} tone="good" />
        <Stat
          label="Needs review"
          value={stats.needs_review}
          tone={stats.needs_review > 0 ? "danger" : undefined}
        />
      </div>

      {stats.needs_review > 0 ? (
        <div className="mb-8 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>{stats.needs_review} send(s) have an unknown outcome.</strong> The worker was
          interrupted mid-send, so we cannot tell whether those emails were delivered. They are
          never retried automatically — a duplicate would be worse than a miss. Review them under
          the affected campaign.
        </div>
      ) : null}

      {campaigns.length === 0 ? (
        <EmptyState
          title="No campaigns yet"
          description="Add a mailbox, import some contacts, then create your first campaign."
          action={{ href: "/campaigns/new", label: "Create a campaign" }}
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
                    {campaign.mailbox_name} · {formatSendDays(campaign.send_days)}{" "}
                    {minutesToHHMM(campaign.send_start_minute)}–{minutesToHHMM(campaign.send_end_minute)}{" "}
                    {campaign.timezone} · {campaign.sent_today}/{campaign.daily_limit} sent today
                  </p>
                </div>
                <StatusBadge status={campaign.status} />
              </div>

              <dl className="grid grid-cols-3 gap-4 sm:grid-cols-6">
                <Stat label="Contacts" value={campaign.contacts} />
                <Stat label="Sent" value={campaign.sent} />
                <Stat label="Replies" value={campaign.replies} tone={campaign.replies > 0 ? "good" : undefined} />
                <Stat label="Reply rate" value={replyRate(campaign.replies, campaign.sent)} />
                <Stat label="Failed" value={campaign.failed} tone={campaign.failed > 0 ? "danger" : undefined} />
                <Stat label="Remaining" value={campaign.remaining} />
              </dl>

              {campaign.status === "active" && campaign.next_slot_at ? (
                <p className="mt-4 text-xs text-zinc-500">
                  Next send no earlier than <DateTime value={campaign.next_slot_at} /> UTC
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
