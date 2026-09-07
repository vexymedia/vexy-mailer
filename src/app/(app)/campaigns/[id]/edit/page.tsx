import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { listMailboxes } from "@/lib/queries/mailboxes";
import { minutesToHHMM } from "@/lib/schedule";
import { PageHeader } from "@/components/ui";
import { CampaignForm } from "@/components/campaign-form";
import type { Campaign } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [campaign] = await sql<Campaign[]>`select * from campaigns where id = ${id}`;
  if (!campaign) notFound();
  const mailboxes = await listMailboxes();

  return (
    <>
      <PageHeader title="Campaign settings" description={campaign.name} />
      <div className="max-w-2xl">
        <CampaignForm
          mailboxes={mailboxes}
          values={{
            id: campaign.id,
            name: campaign.name,
            mailbox_id: campaign.mailbox_id,
            daily_limit: campaign.daily_limit,
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
