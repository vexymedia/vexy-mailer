import Link from "next/link";
import { describeSenderPool, listCampaignStats } from "@/lib/queries/dashboard";
import { formatSendDays, minutesToHHMM } from "@/lib/schedule";
import { PageHeader, StatusBadge, Table, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const campaigns = await listCampaignStats();

  return (
    <>
      <PageHeader
        title="Campaigns"
        actions={
          <Link href="/campaigns/new" className="btn-primary">
            New campaign
          </Link>
        }
      />

      {campaigns.length === 0 ? (
        <EmptyState
          title="No campaigns yet"
          description="A campaign combines a sender mailbox, a contact list and an email sequence."
          action={{ href: "/campaigns/new", label: "New campaign" }}
        />
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Campaign</th>
              <th className="th">Status</th>
              <th className="th">Window</th>
              <th className="th text-right">Contacts</th>
              <th className="th text-right">Sent</th>
              <th className="th text-right">Replies</th>
              <th className="th text-right">Remaining</th>
            </tr>
          }
        >
          {campaigns.map((campaign) => (
            <tr key={campaign.id} className="hover:bg-zinc-50">
              <td className="td">
                <Link href={`/campaigns/${campaign.id}`} className="font-medium text-zinc-900 hover:underline">
                  {campaign.name}
                </Link>
                <div className="text-xs text-zinc-500">
                  {describeSenderPool(campaign.mailbox_names)}
                  {campaign.mailbox_names.length > 1 ? (
                    <span className="ml-1 text-zinc-400">({campaign.mailbox_names.length} senders)</span>
                  ) : null}
                </div>
              </td>
              <td className="td"><StatusBadge status={campaign.status} /></td>
              <td className="td text-xs text-zinc-600">
                {formatSendDays(campaign.send_days)}
                <br />
                {minutesToHHMM(campaign.send_start_minute)}–{minutesToHHMM(campaign.send_end_minute)} {campaign.timezone}
              </td>
              <td className="td text-right tabular-nums">{campaign.contacts}</td>
              <td className="td text-right tabular-nums">{campaign.sent}</td>
              <td className="td text-right tabular-nums">{campaign.replies}</td>
              <td className="td text-right tabular-nums">{campaign.remaining}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
