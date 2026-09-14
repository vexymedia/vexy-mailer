import Link from "next/link";
import { describeSenderPool, listCampaignStats } from "@/lib/queries/dashboard";
import { formatSendDays, minutesToHHMM } from "@/lib/schedule";
import { PageHeader, StatusBadge, Table, EmptyState } from "@/components/ui";
import { KomunikaceTabs } from "@/components/section-tabs";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const campaigns = await listCampaignStats();

  return (
    <>
      <PageHeader
        title="Kampaně"
        actions={
          <Link href="/campaigns/new" className="btn-primary">
            Nová kampaň
          </Link>
        }
      />
      <KomunikaceTabs active={"/campaigns"} />

      {campaigns.length === 0 ? (
        <EmptyState
          title="Zatím žádné kampaně"
          description="Kampaň spojuje odesílací schránku, seznam kontaktů a e-mailovou sekvenci — a volitelně i volání."
          action={{ href: "/campaigns/new", label: "Nová kampaň" }}
        />
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Kampaň</th>
              <th className="th">Stav</th>
              <th className="th">Okno</th>
              <th className="th text-right">Kontakty</th>
              <th className="th text-right">Odesláno</th>
              <th className="th text-right">Odpovědi</th>
              <th className="th text-right">Zbývá</th>
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
                    <span className="ml-1 text-zinc-400">({campaign.mailbox_names.length} odesílatelů)</span>
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
