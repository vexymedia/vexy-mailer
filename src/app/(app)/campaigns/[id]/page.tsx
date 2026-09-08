import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { checkCampaignReadiness } from "@/lib/queries/campaigns";
import { describeSenderPool, listActivity, listCampaignContacts, listCampaignStats } from "@/lib/queries/dashboard";
import { formatSendDays, minutesToHHMM } from "@/lib/schedule";
import { PageHeader, Stat, StatusBadge, Table, DateTime } from "@/components/ui";
import { CampaignControls } from "@/components/campaign-controls";
import { SequenceEditor, type StepValues } from "@/components/sequence-editor";
import { Readiness } from "@/components/readiness";
import { ImportForm } from "@/components/import-form";
import { ContactRowActions } from "@/components/contact-row-actions";
import type { Campaign } from "@/lib/types";

export const dynamic = "force-dynamic";

const TABS = ["overview", "contacts", "sequence", "activity"] as const;
type Tab = (typeof TABS)[number];

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: rawTab } = await searchParams;
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : "overview";

  const [campaign] = await sql<Campaign[]>`select * from campaigns where id = ${id}`;
  if (!campaign) notFound();

  const stats = (await listCampaignStats()).find((c) => c.id === id);
  const readonly = campaign.status === "active";

  return (
    <>
      <PageHeader
        title={campaign.name}
        description={
          <>
            <StatusBadge status={campaign.status} />{" "}
            <span className="ml-2">
              {describeSenderPool(stats?.mailbox_names ?? [])} · {formatSendDays(campaign.send_days)}{" "}
              {minutesToHHMM(campaign.send_start_minute)}–{minutesToHHMM(campaign.send_end_minute)}{" "}
              {campaign.timezone} · limit {campaign.daily_limit}/day
            </span>
          </>
        }
        actions={
          <>
            <Link href={`/campaigns/${id}/edit`} className="btn-secondary">
              Settings
            </Link>
            <CampaignControls id={id} status={campaign.status} />
          </>
        }
      />

      <div className="mb-6 flex gap-1 border-b border-zinc-200">
        {TABS.map((name) => (
          <Link
            key={name}
            href={`/campaigns/${id}?tab=${name}`}
            className={`-mb-px border-b-2 px-4 py-2 text-sm capitalize transition-colors ${
              tab === name
                ? "border-zinc-900 font-medium text-zinc-900"
                : "border-transparent text-zinc-500 hover:text-zinc-900"
            }`}
          >
            {name}
          </Link>
        ))}
      </div>

      {tab === "overview" ? <OverviewTab campaignId={id} stats={stats} /> : null}
      {tab === "contacts" ? <ContactsTab campaignId={id} /> : null}
      {tab === "sequence" ? <SequenceTab campaignId={id} readOnly={readonly} /> : null}
      {tab === "activity" ? <ActivityTab campaignId={id} /> : null}
    </>
  );
}

async function OverviewTab({
  campaignId,
  stats,
}: {
  campaignId: string;
  stats: Awaited<ReturnType<typeof listCampaignStats>>[number] | undefined;
}) {
  const readiness = await checkCampaignReadiness(campaignId);
  const replyRate = stats && stats.sent > 0 ? `${((stats.replies / stats.sent) * 100).toFixed(1)}%` : "—";

  return (
    <div className="space-y-6">
      <Readiness problems={readiness.problems} />

      <div className="card grid grid-cols-2 gap-6 p-6 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Contacts" value={stats?.contacts ?? 0} />
        <Stat label="Sent" value={stats?.sent ?? 0} />
        <Stat label="Replies" value={stats?.replies ?? 0} tone={stats?.replies ? "good" : undefined} />
        <Stat label="Reply rate" value={replyRate} />
        <Stat label="Failed" value={stats?.failed ?? 0} tone={stats?.failed ? "danger" : undefined} />
        <Stat label="Remaining" value={stats?.remaining ?? 0} />
      </div>

      {stats && stats.needs_review > 0 ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>{stats.needs_review} send(s) with an unknown outcome.</strong> The worker was
          interrupted mid-send. These are never retried automatically. Open the Contacts tab and
          either skip the step or handle those prospects by hand.
        </div>
      ) : null}
    </div>
  );
}

async function ContactsTab({ campaignId }: { campaignId: string }) {
  const contacts = await listCampaignContacts(campaignId);

  return (
    <div className="space-y-6">
      <ImportForm campaignId={campaignId} />

      {contacts.length === 0 ? (
        <p className="card px-6 py-10 text-center text-sm text-zinc-500">
          No contacts in this campaign yet.
        </p>
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Email</th>
              <th className="th">Name</th>
              <th className="th">Company</th>
              <th className="th">Status</th>
              <th className="th text-right">Sent</th>
              <th className="th">Last email</th>
              <th className="th">Next email</th>
              <th className="th"></th>
            </tr>
          }
        >
          {contacts.map((contact) => (
            <tr key={contact.id} className="hover:bg-zinc-50">
              <td className="td font-medium text-zinc-900">{contact.email}</td>
              <td className="td">{contact.first_name ?? "—"}</td>
              <td className="td">{contact.company ?? "—"}</td>
              <td className="td">
                <StatusBadge status={contact.status} />
                {contact.last_error ? (
                  <div className="mt-1 max-w-xs text-xs text-red-600">{contact.last_error}</div>
                ) : null}
              </td>
              <td className="td text-right tabular-nums">{contact.sends}</td>
              <td className="td text-xs"><DateTime value={contact.last_sent_at} /></td>
              <td className="td text-xs"><DateTime value={contact.next_send_at} /></td>
              <td className="td">
                <ContactRowActions
                  campaignContactId={contact.id}
                  email={contact.email}
                  canResume={contact.status === "failed"}
                />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

async function SequenceTab({ campaignId, readOnly }: { campaignId: string; readOnly: boolean }) {
  const steps = await sql<(StepValues & { id: string })[]>`
    select s.step_number, s.delay_days, s.subject, s.body, s.id,
           exists (select 1 from email_sends es where es.step_id = s.id) as locked
      from sequence_steps s
     where s.campaign_id = ${campaignId}
     order by s.step_number
  `;
  return <SequenceEditor campaignId={campaignId} initialSteps={steps} readOnly={readOnly} />;
}

async function ActivityTab({ campaignId }: { campaignId: string }) {
  const rows = await listActivity({ campaignId, limit: 300 });
  if (rows.length === 0) {
    return <p className="card px-6 py-10 text-center text-sm text-zinc-500">Nothing has happened yet.</p>;
  }
  return (
    <Table
      head={
        <tr>
          <th className="th">Time (UTC)</th>
          <th className="th">Contact</th>
          <th className="th">Action</th>
          <th className="th">Detail</th>
        </tr>
      }
    >
      {rows.map((row) => (
        <tr key={row.id} className={row.level === "error" ? "bg-red-50/50" : undefined}>
          <td className="td whitespace-nowrap text-xs"><DateTime value={row.created_at} /></td>
          <td className="td text-xs">{row.contact_email ?? "—"}</td>
          <td className="td font-medium text-zinc-900">{row.action}</td>
          <td className="td text-xs text-zinc-600">{row.detail ?? "—"}</td>
        </tr>
      ))}
    </Table>
  );
}
