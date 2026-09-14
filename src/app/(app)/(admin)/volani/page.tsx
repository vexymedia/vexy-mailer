import Link from "next/link";
import { listCallingCampaigns } from "@/lib/queries/calling";
import { PageHeader, EmptyState, Table, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CallingPage() {
  const campaigns = await listCallingCampaigns();

  return (
    <>
      <PageHeader
        title="Volání"
        description="Kampaně, které mají zapnuté volání. Vyberte kampaň a začněte volat."
      />

      {campaigns.length === 0 ? (
        <EmptyState
          title="Žádná kampaň zatím nevolá"
          description="Volání se zapíná u konkrétní kampaně na záložce Volání. Kontakty potřebují telefonní číslo."
          action={{ href: "/campaigns", label: "Přejít na kampaně" }}
        />
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Kampaň</th>
              <th className="th">Stav</th>
              <th className="th text-right">Ve frontě</th>
              <th className="th text-right">Callbacky dnes</th>
              <th className="th"></th>
            </tr>
          }
        >
          {campaigns.map((campaign) => (
            <tr key={campaign.id} className="hover:bg-zinc-50">
              <td className="td">
                <Link href={`/campaigns/${campaign.id}?tab=volani`} className="font-medium text-zinc-900 hover:underline">
                  {campaign.name}
                </Link>
              </td>
              <td className="td"><StatusBadge status={campaign.status} /></td>
              <td className="td text-right tabular-nums">{campaign.queue_size}</td>
              <td className="td text-right tabular-nums">
                {campaign.callbacks_due > 0 ? (
                  <span className="font-semibold text-amber-700">{campaign.callbacks_due}</span>
                ) : (
                  0
                )}
              </td>
              <td className="td text-right">
                {campaign.queue_size > 0 ? (
                  <Link href={`/volani/${campaign.id}`} className="btn-go">Volat</Link>
                ) : (
                  <span className="text-xs text-zinc-400">fronta prázdná</span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
