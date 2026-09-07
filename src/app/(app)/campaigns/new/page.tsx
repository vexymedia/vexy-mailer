import { listSenderOptions } from "@/lib/queries/senders";
import { PageHeader } from "@/components/ui";
import { CampaignForm } from "@/components/campaign-form";

export const dynamic = "force-dynamic";

export default async function NewCampaignPage() {
  const mailboxes = await listSenderOptions();
  return (
    <>
      <PageHeader
        title="New campaign"
        description="Created as a draft — it will not send anything until you start it."
      />
      <div className="max-w-2xl">
        <CampaignForm
          mailboxes={mailboxes}
          values={{
            name: "",
            // Nothing pre-selected: choosing who a campaign sends as should be
            // a deliberate act, not a default.
            mailbox_ids: [],
            daily_limit: 50,
            send_days: [1, 2, 3, 4, 5],
            send_start: "08:00",
            send_end: "16:00",
            timezone: "Europe/Prague",
          }}
        />
      </div>
    </>
  );
}
