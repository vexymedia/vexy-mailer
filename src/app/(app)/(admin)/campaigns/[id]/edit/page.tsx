import { requireUuid } from "@/lib/route-params";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { getCampaignMailboxIds } from "@/lib/queries/campaigns";
import { listSenderOptions } from "@/lib/queries/senders";
import { minutesToHHMM } from "@/lib/schedule";
import { PageHeader } from "@/components/ui";
import { CampaignForm } from "@/components/campaign-form";
import type { Campaign } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Nesmyslné id z adresy je 404, ne pád na chybě typu v Postgresu.
  requireUuid(id);
  const [campaign] = await sql<Campaign[]>`select * from campaigns where id = ${id}`;
  if (!campaign) notFound();
  const [mailboxes, selected] = await Promise.all([
    listSenderOptions(id),
    getCampaignMailboxIds(id),
  ]);

  return (
    <>
      <PageHeader title="Nastavení kampaně" description={campaign.name} />
      <div className="max-w-2xl">
        <CampaignForm
          mailboxes={mailboxes}
          values={{
            id: campaign.id,
            name: campaign.name,
            mailbox_ids: selected,
            daily_limit: campaign.daily_limit,
            new_ratio: campaign.new_ratio,
            send_days: campaign.send_days,
            send_start: minutesToHHMM(campaign.send_start_minute),
            send_end: minutesToHHMM(campaign.send_end_minute),
            timezone: campaign.timezone,
          }}
        />
      </div>
    </>
  );
}
